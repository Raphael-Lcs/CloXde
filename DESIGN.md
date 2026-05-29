# CloXde 设计文档

> Cl(aude) + (c)o(de)X + de(sktop)
> 一个本地桌面控制台，用于编排 Claude Code CLI 与 Codex CLI 协作完成软件工程任务。

---

## 1. 项目定位

### 1.1 一句话定义
一个 Electron 桌面应用，把本地已安装的 `claude` 与 `codex` 两个 CLI 通过伪终端（pty）接管，提供统一的会话管理、任务编排、协作与对比能力。

### 1.2 目标用户
同时使用 Claude Code 和 Codex CLI 的开发者。希望：
- 不用反复切窗口切目录
- 让两个 Agent 互相协作而不是单兵作战
- 留下可追溯的任务历史和决策记录

### 1.3 核心价值（按优先级）
| 优先级 | 能力 | 说明 |
|---|---|---|
| P0 | 多会话管理 | 同时开多个 claude / codex 会话，分屏 / Tab 切换 |
| P0 | 伪终端接管 | 通过 node-pty 保留原生交互、颜色、流式输出 |
| P1 | 架构师 + 执行者 | 一个出方案（一般 Claude），一个执行（一般 Codex） |
| P1 | 双人互评审 | A 写完，B review；冲突时人工裁决 |
| P2 | 并行竞赛 | 同任务双跑，人工择优 |
| P3 | 可视化工作流 | 节点拖拽编排 claude/codex 调用顺序与条件 |

### 1.4 非目标（明确不做）
- 不重新实现 Claude / Codex 的能力，只做编排层
- 不做云端同步、团队协作（至少 v1 不做）
- 不替代 IDE，定位是"任务驾驶舱"而非编辑器
- v1 不做 Agent 插件化（claude / codex 两个写死枚举）

---

## 2. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 壳层 | **Electron** | 用户指定；生态成熟，文件 / 进程 / Shell 访问无障碍 |
| 构建 | **electron-vite** | Electron + Vite + TS 一站式，HMR 流畅 |
| 渲染层 | **React + TypeScript** | 生态广，组件库齐全 |
| UI 库 | **shadcn/ui + Tailwind** | 轻、可定制；深色优先适合开发者 |
| 终端组件 | **xterm.js** + **xterm-addon-fit** | 浏览器端终端事实标准 |
| 伪终端 | **node-pty** | 主流程跑在主进程，与 xterm 双向桥接 |
| 状态 | **Zustand** | 轻量，适合中等复杂度 |
| 持久化 | **better-sqlite3** | 任务、消息、配置本地落盘；同步 API 简单 |
| 进程隔离 | Electron `contextBridge` + IPC | 严格遵循 contextIsolation |
| 打包 | **electron-builder** | Windows / macOS / Linux 全平台 |
| 包管理 | **pnpm** | 快，磁盘友好 |

---

## 3. 系统架构

```
┌──────────────────────────────────────────────────────────┐
│                    Renderer (React UI)                   │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────────┐  │
│  │ Sidebar    │ │ Terminal   │ │ Orchestrator Panel   │  │
│  │ (Sessions) │ │ (xterm.js) │ │ (任务/流程/对比视图) │  │
│  └────────────┘ └─────┬──────┘ └──────────┬───────────┘  │
│                       │ IPC               │              │
└───────────────────────┼───────────────────┼──────────────┘
                        │                   │
┌───────────────────────┼───────────────────┼──────────────┐
│                Main Process (Node.js)                    │
│  ┌──────────────────┐ ┌─────────────────┐ ┌───────────┐  │
│  │ PTY Manager      │ │ Orchestrator    │ │ Storage   │  │
│  │ (node-pty pool)  │◄┤ Engine          │►│ (sqlite)  │  │
│  └────────┬─────────┘ └────────┬────────┘ └───────────┘  │
│           │                    │                          │
│           ▼                    ▼                          │
│      ┌────────┐           ┌─────────┐                     │
│      │ claude │           │  codex  │       ← 用户已安装  │
│      │  CLI   │           │  CLI    │         的本地二进制│
│      └────────┘           └─────────┘                     │
└──────────────────────────────────────────────────────────┘
```

### 3.1 进程划分
- **Main**：所有特权操作（spawn、文件、DB、CLI 检测）
- **Renderer**：纯 UI，禁用 nodeIntegration，通过 `window.api` 调用 IPC
- **Preload**：定义白名单 IPC 通道，TS 类型共享

---

## 4. 核心模块

### 4.1 PTY Manager（主进程）
职责：管理 N 个伪终端会话的生命周期。

```ts
interface PtySession {
  id: string;            // uuid
  projectId: string;     // 归属项目（v1 强制）
  agent: 'claude' | 'codex';
  cwd: string;           // 默认 = Project.rootDir，可临时覆盖
  pty: IPty;             // node-pty 实例
  buffer: RingBuffer;    // 最近 N KB 输出，供回放
  status: 'spawning' | 'running' | 'idle' | 'exited';
  exitCode?: number;
  createdAt: number;
}

interface SpawnOpts {
  projectId: string;
  agent: 'claude' | 'codex';
  cwd?: string;          // 缺省继承 project.rootDir
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

class PtyManager {
  spawn(opts: SpawnOpts): PtySession
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string, signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void
  onData(id: string, cb: (chunk: string) => void): Disposer
  onExit(id: string, cb: (code: number) => void): Disposer
  list(projectId?: string): PtySession[]
}
```

要点：
- 通过 `CliDetector.resolve(agent)` 拿到二进制路径再 spawn，不依赖 PATH
- Windows 用 `node-pty` 的 ConPTY 后端（Win10 1809+）
- Ring buffer（默认 256 KB）保证切换 Tab / 重连 xterm 后立即看到最近输出
- 数据流通过 `webContents.send('pty:data', {id, chunk})` 推送
- 空闲检测：若 X 秒无输出且无活动子进程，状态置 `idle`，供 Orchestrator 判断"是否完成"

### 4.2 CLI Detector（启动 + 配置时执行）
职责：解析 `claude` / `codex` 的可执行文件路径与版本，结果缓存到 `~/.cloxde/config.json`。

```ts
interface CliInfo {
  agent: 'claude' | 'codex';
  path: string;          // 绝对路径
  version: string;       // 解析自 --version
  source: 'PATH' | 'manual' | 'cached';
  lastVerifiedAt: number;
}

class CliDetector {
  detect(agent: 'claude' | 'codex'): Promise<CliInfo | null>
  setManualPath(agent, path): Promise<CliInfo>   // 用户手动指定时用
  resolve(agent): CliInfo                        // PtyManager spawn 前调用
}
```

探测策略（按优先级）：
1. 读 `~/.cloxde/config.json` 中已缓存路径，文件仍存在则直接用
2. Windows：`where.exe <agent>`；POSIX：`which <agent>`
3. 兜底候选路径（实测本机有效）：
   - claude: `%USERPROFILE%\bin\claude.cmd`
   - codex: `%USERPROFILE%\.npm-global\codex.cmd`、`%APPDATA%\npm\codex.cmd`
4. 全部失败 → 弹"未检测到 X CLI"对话框，提供：
   - 手动选择可执行文件
   - 一键运行 `npm i -g @openai/codex`（仅 codex）
   - 跳转官方安装文档

每次 spawn 前用 `--version` 快速验活，失败则重新探测。

### 4.3 Orchestrator Engine（编排引擎）
核心抽象：**Step → Plan → Run**

```ts
type StepKind =
  | { type: 'agent';  agent: 'claude' | 'codex'; prompt: string }
  | { type: 'review'; reviewer: 'claude' | 'codex'; target: StepRef }
  | { type: 'race';   agents: ('claude' | 'codex')[]; prompt: string }
  | { type: 'human';  message: string }

interface Plan {
  id: string;
  name: string;
  steps: Step[];
  edges: Edge[];   // 支持非线性（条件、并行）
}
```

执行模式：
1. **Architect-Executor**：固定模板，claude 拆任务 → codex 写代码
2. **Cross-Review**：A 完成后把 diff 喂给 B review
3. **Race**：双 spawn，输出并排展示，人工 pick
4. **Visual Workflow**：v2 引入节点编辑器（react-flow），先把数据结构留好

### 4.4 Storage Schema（SQLite）
```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_dir TEXT NOT NULL UNIQUE,
  default_architect TEXT NOT NULL DEFAULT 'claude',
  default_executor  TEXT NOT NULL DEFAULT 'codex',
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,           -- 'claude' | 'codex'
  cwd TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX idx_sessions_project ON sessions(project_id);

CREATE TABLE transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  direction TEXT NOT NULL,       -- 'in' | 'out'
  data TEXT NOT NULL             -- stripAnsi 后的纯文本，原始流不入库
);
CREATE INDEX idx_transcripts_session ON transcripts(session_id, ts);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL,       -- 序列化的 Plan 定义
  created_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL,          -- pending|running|done|failed|cancelled
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  status TEXT NOT NULL,
  output TEXT
);
```
CREATE TABLE run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  step_index INTEGER,
  session_id TEXT,
  status TEXT,
  output TEXT
);
```

---

## 5. UI 设计

### 5.1 主窗口布局
```
┌──────────────────────────────────────────────────────────────┐
│ Title bar:  [▼ Project: my-app]   · Plan: Architect-Executor │
├──────────┬───────────────────────────────────┬───────────────┤
│ Sidebar  │   Workspace                       │  Inspector    │
│          │  ┌──────────────┬──────────────┐  │               │
│ ▼ my-app │  │  claude #1   │  codex #1    │  │  当前 Step    │
│   ├ ses1 │  │  (architect) │  (executor)  │  │  Diff / 日志  │
│   ├ ses2 │  │              │              │  │  Token 用量   │
│   └ ses3 │  └──────────────┴──────────────┘  │  CLI 路径状态 │
│ ▶ other  │   [Plan Bar: ▶ ⏸ ⟳  step 2/5]    │               │
│ ─────────│                                    │               │
│ + 新项目 │                                    │               │
└──────────┴───────────────────────────────────┴───────────────┘
```

### 5.2 关键交互
- **首次启动**：无项目时引导"打开文件夹作为新项目"
- **项目切换**：Title bar 下拉切换，或 Sidebar 折叠列表
- **新建会话**：在某项目下点 `+ Session` → 选 Agent（claude/codex），cwd 默认继承项目根目录
- **运行 Plan**：在当前项目内选模板（Architect / Review / Race）→ 填初始 prompt → 自动驱动两个终端
- **人工介入**：任何一步可暂停，直接在终端打字
- **对比视图**：Race 模式下双栏 diff，可一键采纳某一方输出
- **快捷键**：`Ctrl+1/2` 切换左右终端焦点，`Ctrl+Tab` 切换会话，`Ctrl+Shift+P` 命令面板

---

## 6. 关键技术风险

| 风险 | 影响 | 应对 |
|---|---|---|
| node-pty 在 Windows 上需要 native build | 安装失败 | 预编译 prebuilds；electron-rebuild |
| 两个 CLI 都是交互式 TUI，自动化喂 prompt 难 | 编排不稳 | v1 只编排"提示注入 + 完成检测"，复杂场景留人工 |
| 完成检测无标准信号 | Plan 不知道何时进入下一步 | 多策略：进程 idle 时间 + 输出正则 + 用户标记 |
| CLI 输出含 ANSI 控制字符 | DB 存储/diff 麻烦 | 双轨：原始流给 xterm，stripAnsi 后入库 |
| 不同项目 cwd 切换 | 误操作风险 | 每个会话锁 cwd，UI 显式展示 |

---

## 7. 路线图

### v0.1 Skeleton（地基）
- [ ] electron-vite + React + TS 工程骨架
- [ ] 主/渲染/preload 三层 IPC 跑通
- [ ] CLI Detector：识别 claude / codex 版本，缺失时引导
- [ ] sqlite 初始化 + `projects` 表 + "打开文件夹为项目"流程

### v0.2 Single Terminal（先做 1 个会话）
- [ ] PTY Manager（单会话）
- [ ] xterm.js 接入，双向数据流通
- [ ] 会话持久化到 sqlite

### v0.3 Multi-Session（多会话）
- [ ] 多 Tab / 分屏
- [ ] Sidebar 会话列表、cwd 切换
- [ ] Ring buffer + 回放

### v0.4 Orchestrator MVP（编排起点）
- [ ] Architect-Executor 模板（硬编码流程）
- [ ] Plan / Run / Step 数据模型与执行器
- [ ] 完成检测策略 v1（idle + 用户确认）

### v0.5 Cross-Review & Race
- [ ] Review 模板：把 A 的 diff 发给 B
- [ ] Race 模板：双栏对比 + 采纳

### v1.0 Visual Workflow
- [ ] react-flow 节点编辑器
- [ ] 条件分支、循环、人工节点

---

## 8. 目录结构（建议）

```
CloXde/
├── DESIGN.md
├── README.md
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── src/
│   ├── main/                  # 主进程
│   │   ├── index.ts
│   │   ├── pty/
│   │   │   ├── manager.ts
│   │   │   └── ring-buffer.ts
│   │   ├── orchestrator/
│   │   │   ├── engine.ts
│   │   │   ├── templates/
│   │   │   │   ├── architect-executor.ts
│   │   │   │   ├── cross-review.ts
│   │   │   │   └── race.ts
│   │   │   └── completion-detector.ts
│   │   ├── storage/
│   │   │   ├── db.ts
│   │   │   └── migrations/
│   │   ├── cli-detector.ts
│   │   └── ipc.ts
│   ├── preload/
│   │   └── index.ts
│   ├── renderer/
│   │   ├── index.html
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── components/
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── TerminalView.tsx
│   │   │   │   ├── PlanBar.tsx
│   │   │   │   └── Inspector.tsx
│   │   │   ├── stores/
│   │   │   │   ├── sessions.ts
│   │   │   │   └── plans.ts
│   │   │   └── pages/
│   │   └── tsconfig.json
│   └── shared/                # 主/渲染共用类型
│       ├── ipc-channels.ts
│       └── types.ts
├── resources/                 # 图标等
└── build/                     # 打包资源
```

---

## 9. 已确认的决策（v1 范围）

1. **CLI 路径**（实测本机）
   - `claude` → `C:\Users\L\bin\claude.cmd`（v2.1.123）
   - `codex`  → `C:\Users\L\.npm-global\codex.cmd`（v0.130.0，通过 `npm i -g @openai/codex` 安装）
   - 策略：启动时用 `where` / `Get-Command` 自动探测 PATH；探测失败弹窗让用户手动指定路径，结果存入 `~/.cloxde/config.json`。
2. **项目作为一级抽象**：引入 Project（见 §10），一个 Project 下挂多个 Session、多个 Plan。所有会话强制归属某个 Project，cwd 默认继承自 Project 根目录。
3. **Agent 范围**：v1 只支持 `claude` 与 `codex`，**写死枚举**，不做插件化，避免过度设计。后续若要扩展再重构。
4. **数据加密**：本地 sqlite 默认明文存储，不引入 sqlcipher。
5. **品牌名**：CloXde，保留。

---

## 10. 数据模型：Project 作为一级抽象

### 10.1 概念关系
```
Project (1) ─┬─ (N) Session       一个项目下挂多个 claude/codex 终端会话
             ├─ (N) Plan           编排模板（架构师/评审/竞赛 等）
             └─ (N) Run            Plan 的一次具体执行实例
```

### 10.2 Project 结构
```ts
interface Project {
  id: string;               // uuid
  name: string;             // 显示名（默认目录名）
  rootDir: string;          // 绝对路径，所有 Session 默认 cwd
  defaultArchitect: 'claude' | 'codex';   // 默认架构师角色
  defaultExecutor:  'claude' | 'codex';   // 默认执行者角色
  createdAt: number;
  lastOpenedAt: number;
}
```

### 10.3 Schema
具体 SQL 见 §4.4。要点：
- `projects` 表是新引入的根表
- `sessions` / `plans` / `runs` 全部带 `project_id NOT NULL` 外键，`ON DELETE CASCADE`
- 删除项目即清理其下所有会话、计划、运行记录
- 不再支持"游离会话"（即不属于任何项目的会话）

### 10.4 UI 影响
- Sidebar 顶部为"项目切换器"（最近打开项目 + 新建项目）
- 创建 Session 时不再选 cwd，自动用 Project.rootDir（可临时覆盖）
- Plan 与 Run 历史按 Project 隔离展示
- 首次启动若无项目，引导"打开文件夹作为新项目"
