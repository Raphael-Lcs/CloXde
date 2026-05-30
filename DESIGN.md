# CloXde 设计文档

> Cl(aude) + (c)o(de)X + de(sktop)
> 一个本地桌面控制台，通过 **ACP（Agent Client Protocol）** 编排多个可插拔的编码 Agent（Claude Code / Codex / Hermes 等）以「产品经理 → 架构师 → 执行者」三角色协作完成软件工程任务，并配套一个局域网移动端伴侣 App。

> 本文档描述的是当前真实实现（v0.6.x）。早期基于 pty/xterm 接管 CLI 的设计已废弃，不再适用。

---

## 1. 项目定位

### 1.1 一句话定义
CloXde 不再「接管终端」，而是把每个 Agent 当作一个实现了 **ACP** 的子进程适配器拉起，用结构化的协议消息（而非 ANSI 文本流）驱动它们。桌面端负责编排、持久化与展示；移动端通过桌面暴露的局域网服务远程查看 / 接管同一批会话。

### 1.2 目标用户
同时使用多个编码 Agent CLI 的开发者，希望：
- 让多个 Agent 以明确的角色分工协作，而不是各自单兵作战
- 用一套对话式工作流把「想清楚需求 → 出方案 → 落地 → 审查」串起来
- 留下可追溯、可继承的任务历史
- 离开电脑时也能用平板/手机查看进度、追加指令

### 1.3 核心价值（按优先级）
| 优先级 | 能力 | 说明 |
|---|---|---|
| P0 | ACP 多智能体编排 | 一个会话内拉起多个 Agent 适配器，按状态机路由轮次 |
| P0 | 三角色协作流 | PM（产品经理）↔ 架构师 ↔ 执行者，职责与权限分明 |
| P0 | 任务状态机 + 权限闸门 | 在协议层强制角色边界（如架构师不能直接改文件）|
| P1 | 自动驾驶（autopilot）| 角色间自动转发轮次，带上限防止无限 ping-pong |
| P1 | 上下文继承 | 新会话可「继承自」若干父会话，注入其摘要作为种子 |
| P1 | 局域网移动端伴侣 | 桌面起 HTTP+WS 服务，平板扫码配对后远程接管 |
| P2 | 响应式上下文压缩 | ACP 会话上下文溢出时，丢弃臃肿会话并用 DB 摘要重建 |

### 1.4 非目标（明确不做）
- 不重新实现各 Agent 的能力，只做编排层
- 不再做 pty/xterm 终端接管 —— 改用 ACP 结构化协议
- 不做云端同步 / 团队多人协作（移动端只是同一桌面的远程视图）
- 不替代 IDE，定位是「任务驾驶舱」

---

## 2. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 壳层 | **Electron** ^33 | 文件 / 进程 / Shell 访问无障碍 |
| 构建 | **electron-vite** | 主 / 渲染 / preload 三层一站式 + HMR |
| 渲染层 | **React 18 + TypeScript** | 生态广 |
| 状态 | **Zustand**（桌面 & 移动） | 轻量 |
| 持久化 | **better-sqlite3** ^11 | 本地落盘，同步 API 简单 |
| Agent 协议 | **ACP**（`@agentclientprotocol/sdk`） | 结构化 Agent ↔ 客户端协议，替代裸文本流 |
| Claude 适配器 | `@agentclientprotocol/claude-agent-acp` | 把 Claude Code 包成 ACP server |
| Codex 适配器 | `@zed-industries/codex-acp` | 把 Codex 包成 ACP server |
| Hermes 适配器 | 外部 Python 二进制 | 通过 command 覆盖指向 |
| 局域网服务 | **Express 5 + ws** | REST + WebSocket，移动端接入 |
| 配对 | **qrcode** + 6 位 PIN + bearer token | 桌面出二维码，平板扫码配对 |
| Markdown | react-markdown + remark-gfm | 消息渲染 |
| 移动端 | **React Native**（`mobile/`，npm + jest） | 平板/手机伴侣 |
| 包管理 | **pnpm**（桌面）/ **npm**（移动） | — |

---

## 3. 系统架构

```
┌───────────────────────────────────────────────────────────────┐
│                     Renderer (React UI)                       │
│   会话列表 · 三栏对话视图(PM/架构师/执行者) · 文件/改动/设置    │
│                          │ IPC (window.api)                    │
└──────────────────────────┼────────────────────────────────────┘
                           │
┌──────────────────────────┼────────────────────────────────────┐
│                   Main Process (Node.js)                      │
│  ┌──────────────────┐  ┌─────────────────┐  ┌──────────────┐  │
│  │ ConversationEngine│  │ 状态机(pure)    │  │ Storage      │  │
│  │ 编排 / 轮次路由   │◄─┤ state-machine.ts│  │ (sqlite)     │  │
│  └────────┬──────────┘  └─────────────────┘  └──────────────┘  │
│           │ 每个角色一个 AcpRuntime                            │
│           ▼                                                    │
│  ┌──────────┐  ┌────────────┐  ┌────────────┐                 │
│  │ PM Runtime│  │架构师Runtime│  │执行者Runtime│  ← 各自一个   │
│  │ (adapter) │  │ (adapter)  │  │ (adapter)  │    ACP 子进程  │
│  └──────────┘  └────────────┘  └────────────┘                 │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ LAN Server: Express + WS  (port 7878 / CLOXDE_LAN_PORT)   │ │
│  │   /api/* REST · /ws 推送 · QR+PIN+token 配对              │ │
│  └─────────────────────────────────────────────────────────┘ │
└────────────────────────────────────┬───────────────────────────┘
                                      │ 局域网
                            ┌─────────▼─────────┐
                            │ Mobile (React     │
                            │ Native) 伴侣 App  │
                            └───────────────────┘
```

### 3.1 进程划分
- **Main**：所有特权操作（spawn ACP 适配器、文件、DB、局域网服务）。编排逻辑全在主进程。
- **Renderer**：纯 UI，通过 `window.api`（preload 白名单 IPC）调用。
- **Preload**：定义 IPC 通道并共享 TS 类型。

### 3.2 ACP 模型
- 一个 `AcpRuntime` = 一个适配器子进程 = 一个 ACP session（对应一个角色一侧）。
- 三角色会话会拉起最多三个 runtime（PM / 架构师 / 执行者），各自独立持有上下文。
- ACP session id 持久化到 DB，CloXde 重开时调 `session/load` 恢复 Agent 自己的上下文；失败则 `session/new` 重建。
- 工具调用、计划、思考、权限请求都是 ACP 结构化事件，映射成 `MessageBlock`（见 §6）。

---

## 4. 核心模块

### 4.1 ConversationEngine（`src/main/conversation/engine.ts`）
编排的心脏。职责：
- 持有每个活跃会话的 `ActiveConversation`（含各侧 `AcpRuntime`）。
- 接收用户消息 → 决定派给哪个角色 → 组装 prompt → 发起 ACP `session/prompt`。
- 消费 ACP 事件流，落库并通过 IPC / WS 广播增量。
- 维护会话级 `status`（见 §5.3）与每侧 `streamingMessageId`（作为该侧「忙 / 当前轮次」令牌）。
- 自动驾驶：一侧 `end_turn` 后，按状态机把轮次转发给下一个 owner，直到达上限或被叫停。
- 响应式上下文压缩：ACP 报告上下文溢出时 `restartFresh()`，丢弃臃肿 session，用 DB 重建摘要重新播种。

关键辅助：
- `allSides(slot)` → `slot.pm ? [pm, architect, executor] : [architect, executor]`
- `settleStatus(slot)` → 任一侧仍在流式则 `thinking`，否则 `awaiting-user`（解决多侧并发时的状态收敛）。
- `dispose(id)` → `Promise.allSettled` 关闭各侧 runtime，避免单侧卡住拖垮退出。

### 4.2 任务状态机（`src/main/conversation/state-machine.ts`，纯函数）
Path-C 设计：每个三角色会话同时只驱动**一个** active task。引擎按 task 的 `(status, owner)` 决定下一轮归谁，而不是「扫描上一条消息找标签」。状态机是纯函数，可独立单测。

**任务状态**（`TaskStatus`）：
```
briefing → planning → executing → review → done
              ▲           │          │
              └───────────┴──────────┘  (review 可 DELEGATE 回 executing)
   任何状态 ──FAIL──> failed
   任何状态 ──HANDOFF（PM）──> planning
```
- `briefing`：PM 跟用户对齐需求，团队尚未唤起
- `planning`：架构师只读分析
- `executing`：执行者全权动手
- `review`：架构师审查执行者的报告
- `done` / `failed`：PM 跟用户收尾 / 解释

**交接标签**（Agent 在轮次末尾输出，引擎抽取后驱动转移）：
| 标签 | 谁发 | 含义 / 转移 |
|---|---|---|
| `<<HANDOFF>>` | PM | 把 brief 派给团队 → `planning`（可从任何状态发起）|
| `<<PLAN>>` | 架构师 | 列/更新计划，仍停在 `planning` |
| `<<DELEGATE>>` | 架构师 | 派单给执行者 → `executing` |
| `<<REPORT>>` | 执行者 | 汇报一段工作 → `review` |
| `<<DONE>>` | 架构师 | 宣告任务完成 → `done`（内容回传给 PM）|
| `<<FAIL>>` | 任何角色 | 放弃 → `failed`（PM 介入）|

> `extractAction()` 取文本中**最后一个**被允许的标签 —— Agent 常先用散文描述「我接下来要 X」再真正发标签，取最后一个避免误触发。

**权限闸门**（`isToolAllowed(status, role, category)`）：在 ACP 协议层拦截工具调用。
- PM 永不调工具（只对话派单）。
- 架构师在 `planning` / `review` 只能 `read` 类工具；`Edit/Write/Bash` 被拒绝。
- 执行者仅在 `executing` 拥有全权。
- 这样架构师无法绕过 `<<DELEGATE>>` 直接自己改文件 —— 边界由协议层强制，而非靠提示词自律。

### 4.3 角色系统提示词（`src/main/conversation/prompts.ts`）
PM / 架构师 / 执行者各有固定中文 system prompt，明确「能做什么、能发什么标签、禁止什么」。每一轮还会前置一段 `[CLOXDE-TASK]` 任务态前言（`formatTaskPreamble`），把当前 status、本角色允许的动作、禁止项写进去，让 Agent 严格按表行动。

### 4.4 AcpRuntime（`src/main/acp/runtime.ts`）
封装一个 Agent 适配器子进程的生命周期：
- `bringUp()`：spawn 适配器 → 建立 ACP client/connection → `handshake()`（initialize + `session/load` 或 `session/new`）。握手用 `withInitTimeout`（60s）包裹，超时则 kill 子进程并抛错，避免卡死。
- `restartFresh()`：上下文压缩时丢弃旧 session 重建；会 `removeAllListeners()` 摘掉被遗弃子进程的监听，防内存泄漏，再 kill。
- 权限策略回调：把 ACP 的工具调用请求交给状态机的 `isToolAllowed` 裁决，拒绝时回带可读理由（`describeForbidden`）让 Agent 学会改用正确动作。

### 4.5 Storage（`src/main/storage/`）
`better-sqlite3`，迁移见 §7。pre-1.0 采用「单版本 + 加列式」迁移，运行时按 `_migrations` 表跳过已应用版本。

### 4.6 局域网服务（`src/main/server/`）
- `http-server.ts`：Express REST（`/api/*`）+ `ws` WebSocket（`/ws`）。默认端口 7878，可用 `CLOXDE_LAN_PORT` 覆盖。监听前挂 `error` 钩子捕获 `EADDRINUSE`（暴露给设置面板而非崩溃）；`stopHttpServer` 用 `terminate()` + `closeAllConnections()` + 2s 兜底，保证退出不卡死。
- `auth.ts`：配对鉴权。桌面出二维码 + 6 位 PIN，平板提交 PIN 换 bearer token；token 落盘（原子写 `tmp`→`rename`，避免文件损坏踢掉所有已配对设备）。
- `presence.ts`：跨客户端在场感知（桌面 / 平板谁在看哪个会话）。
- `net.ts`：局域网地址探测（远程/Tailscale 公网访问已于 2026-05-29 暂缓，LAN 优先，但底子留在这里）。

### 4.7 文件检查器（`src/main/fs/`）
- `inspector.ts`：列目录、读文件预览（文本内联 / 图片 base64 / 二进制提示），供移动端在 App 内查看而不必在桌面弹窗。
- `git.ts`：工作区 git status + 单文件 unified diff，支撑「改动」面板。

---

## 5. 会话与并发模型

### 5.1 角色与 Side
- `Role = 'pm' | 'architect' | 'executor'`
- `Side = 'architect' | 'executor'`（遗留概念，用于 primarySide / 自动配对开关等只涉及双方的场景）
- 三角色模式（`pmProfileId` 非空）下，用户输入恒定发给 PM；`primarySide` 被忽略。

> 现状：实际只有三角色模式在跑（`withPm` 默认 true）。遗留的两角色「用户直连架构师」分支在 DB / 类型层保留以兼容老会话，但不是当前主路径。

### 5.2 一个会话的角色编排
```
Project (1) ── (N) Conversation ── (1 active) Task
                      │
                      ├─ PM        Runtime/Session（可选，三角色模式）
                      ├─ architect Runtime/Session
                      └─ executor  Runtime/Session
```

### 5.3 会话状态（`ConversationStatus`）
`idle | thinking | awaiting-user | paused | ended`
- 单一 `conversation.status` 字段，但同时可能有最多三侧在跑。
- 每侧用 `streamingMessageId` 作为「忙 / 当前轮次」令牌。
- `settleStatus` 收敛：任一侧仍在流式 → `thinking`；全部空闲 → `awaiting-user`。

### 5.4 自动驾驶（autopilot）
- 一侧 `end_turn` 后自动把轮次转发给状态机指定的下一个 owner。
- `maxAutoTurns`（默认 200）+ `autoTurnsUsed` 计数，`bump()` / `overCap()` 防无限 ping-pong；用户每次新输入重置计数。
- 编排是「有界自动重试」：对中途 halt 自动续跑直到上限，而非一遇阻碍就停。

### 5.5 上下文继承（「继承自」）
- 新会话可声明零个或多个父会话（多对多，`conversation_parents`）。
- 创建时把每个父会话的生成摘要拼成种子，作为新会话首条上下文注入，免去 ACP session forking。
- 渲染后的摘要缓存在子会话行（`inherited_summary`），避免每次打开重抽。

---

## 6. 消息模型

`Message` 的 `blocks: MessageBlock[]` 直接对齐 ACP 事件：
- `text` / `thought`：正文 / 思考
- `tool_call`：工具调用（kind: edit/read/execute/search/think/fetch/other，status，locations，output 摘要）
- `plan`：计划条目（priority + status + content）
- `permission_request`：权限请求（options + 用户/自动策略选择）
- `image`：内联图片（base64 + mimeType，用户粘贴截图 / 拖拽 / 未来 Agent 图片输出）

`MessageSide = 'user' | 'system' | Role`；`stopReason` 取自 ACP（end_turn / cancelled / max_tokens / refusal / …）；`metrics`（TurnMetrics：durationMs / tokens）在轮次收敛时挂到 assistant 消息上（源自 ACP `PromptResponse.usage`，实验性，缺省可空）。

---

## 7. 存储 Schema（SQLite，迁移 v1–v9）

| 版本 | 名称 | 内容 |
|---|---|---|
| 1 | v0.6-init | `projects`、`agent_profiles`(UNIQUE(project_id,kind))、`conversations`、`messages` |
| 2 | persist-acp-session-ids | conversations 增 `architect_acp_session_id` / `executor_acp_session_id`（供 `session/load` 恢复）|
| 3 | raise-max-auto-turns | 把 `max_auto_turns < 50` 的旧行抬到 200 |
| 4 | conversations-archived-at | 会话软归档 |
| 5 | conversations-pm-profile | 可选 PM 层：`pm_profile_id` / `pm_acp_session_id`（NULL = 遗留两角色）|
| 6 | projects-archived-at | 项目软归档 |
| 7 | conversation-parents | 多对多「继承自」表 + 子行缓存 `inherited_summary` |
| 8 | tasks-state-machine | `tasks` 表（brief/status/owner/plan_json/result_text/failure_reason）+ conversations.`active_task_id`（NULL = 遗留自由模式）|
| 9 | messages-metrics | messages 增 `metrics_json`（per-turn tokens + 耗时，可空 JSON）|

核心表关系：
```
projects ─┬─ agent_profiles  (一项目每种 kind 一个 profile)
          └─ conversations ─┬─ messages
                            ├─ tasks (active_task_id 指向当前任务)
                            └─ conversation_parents (child↔parent 多对多)
```

`agent_profiles` 承载 ccswitch / API base url / model / 命令覆盖 / 环境变量 —— 即原本要写进 shell 环境的一切，在 spawn 适配器时合并到进程 env。

---

## 8. 移动端伴侣（`mobile/`，React Native）

单实例模式：用户配对一台桌面，连接信息（baseUrl + token）存进 Zustand store 并持久化到 AsyncStorage，各屏幕共用 `client` 发请求。

- `src/api/client.ts`：REST 封装 + `WsClient`。WS 带身份守卫（替换 socket 后的迟到 close 不误伤新连接）、指数退避重连（2s→30s 封顶）、`reconnectNow()` 应对前台恢复时的半开 socket。
- `src/store/connection.ts`：连接 store；`AppState` 后台→前台切换时强制 `reconnectNow()`（OS 挂起会让 socket 静默半开却不触发 onclose）。
- `src/hooks/useConversation.ts`：分页加载（PAGE_SIZE=60）+ WS 增量（updated 合并非消息字段 / appended 去重 / patched 浅合并）；带 `currentIdRef` 守卫，防止切会话时旧请求把历史拼到新会话上。
- 屏幕：会话列表、对话（三角色消息流）、文件预览、改动 diff、设置/配对。

服务端每 30s ping 一次 WS 客户端保活。

---

## 9. 目录结构（真实）

```
CloXde/
├── DESIGN.md / README.md
├── package.json            # pnpm, v0.6.0, scripts: dev/build/typecheck/test
├── electron.vite.config.ts
├── tsconfig.{json,node,web}.json
├── .github/workflows/ci.yml  # 桌面(typecheck+test) + 移动(typecheck+lint+jest)
├── scripts/                # test-state-machine.ts, test-transcript.ts, build-icon …
├── src/
│   ├── main/               # 主进程
│   │   ├── index.ts
│   │   ├── ipc.ts          # IPC 处理
│   │   ├── paths.ts
│   │   ├── acp/
│   │   │   └── runtime.ts          # AcpRuntime：适配器子进程 + ACP session
│   │   ├── conversation/
│   │   │   ├── engine.ts           # 编排核心
│   │   │   ├── state-machine.ts    # 纯任务状态机 + 标签解析 + 权限
│   │   │   ├── prompts.ts          # 角色系统提示词 + 任务前言
│   │   │   ├── summarizer.ts       # 上下文/继承摘要
│   │   │   ├── update-reducer.ts   # ACP 事件 → MessageBlock 增量
│   │   │   └── transcript.ts
│   │   ├── fs/
│   │   │   ├── inspector.ts        # 目录/文件预览
│   │   │   └── git.ts              # status + diff
│   │   ├── server/
│   │   │   ├── http-server.ts      # Express + WS
│   │   │   ├── auth.ts             # PIN + token 配对（原子写）
│   │   │   ├── presence.ts         # 跨客户端在场
│   │   │   └── net.ts              # 局域网地址探测
│   │   └── storage/
│   │       ├── db.ts
│   │       └── migrations.ts       # v1–v9
│   ├── preload/
│   │   └── index.ts                # window.api 白名单
│   ├── renderer/src/               # React UI (App.tsx, components/, …)
│   └── shared/
│       ├── types.ts                # 主/渲染共享领域类型
│       └── ipc-channels.ts
└── mobile/                 # React Native 伴侣 (npm + jest)
    └── src/{api,store,hooks,screens}/
```

---

## 10. 测试与 CI

- **桌面**：`pnpm typecheck`（node + web 两套 tsconfig）+ `pnpm test`（`test-state-machine.ts` 状态机用例 + `test-transcript.ts` 转录用例，纯 `tsx` 跑，无需 Electron）。
- **移动**：`npm typecheck` + `lint` + `jest`。
- **CI**：`.github/workflows/ci.yml` 两个 job 分别覆盖桌面与移动。
- 状态机是纯函数，转移表 / 标签解析 / 权限闸门都可脱离 ACP 真实会话单独验证 —— 这是把编排正确性「钉死」的主要手段。

---

## 11. 已确认的关键决策

1. **协议层而非提示词层强制边界**：架构师能否改文件由 `isToolAllowed` 在 ACP 拦截决定，不依赖 Agent 自律。
2. **三角色为当前唯一活跃模式**：`withPm` 默认 true；两角色分支仅为兼容老会话保留。
3. **有界自动重试**优于「一遇阻碍就停」，以保证连续性；上限 `maxAutoTurns` 防失控。
4. **稳定性 / 连续性优先**：握手超时、监听摘除、退出兜底、原子写鉴权、WS 半开重连、切会话竞态守卫等，都是围绕「不崩、不卡、不丢上下文」的硬化。
5. **远程公网访问暂缓**（2026-05-29）：LAN 优先，Tailscale/公网底子留在 `net.ts`。
6. 本地 sqlite 明文存储，不引入 sqlcipher。
7. 品牌名 CloXde 保留。
