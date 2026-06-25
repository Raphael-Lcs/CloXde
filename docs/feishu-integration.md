# 飞书 Bot 集成指南

CloXde 已完整支持飞书机器人集成，让团队可以在飞书群聊或私聊中 @CloXde 触发 AI 助理。

## 🎯 功能特性

- ✅ **单聊响应**：私聊中所有消息自动触发
- ✅ **群聊 @提及**：群聊中只响应 @机器人 的消息（类似 Claude Tag）
- ✅ **实时推送**：基于 Webhook，消息实时到达
- ✅ **富文本支持**：支持文本和富文本消息
- ✅ **主动报告**：Assistant 可主动向活跃会话推送 report
- ✅ **自动重连**：Token 自动刷新，凭证持久化

---

## 📋 前置条件

1. 拥有飞书企业管理员权限（或自建应用权限）
2. CloXde Desktop 已安装并运行
3. 网络环境可访问飞书开放平台

---

## 🚀 配置步骤

### 1. 创建飞书应用

1. 访问 [飞书开放平台](https://open.feishu.cn/)
2. 点击右上角 **开发者后台**
3. 创建企业自建应用（或商店应用）
4. 记录应用的 **App ID** 和 **App Secret**

### 2. 启用机器人能力

1. 进入应用详情页
2. 左侧导航 → **应用功能** → **机器人**
3. 点击 **启用机器人能力**
4. 配置机器人信息：
   - 名称：`CloXde`
   - 头像：上传品牌 Logo
   - 描述：`AI 编程助理，基于 Claude 驱动`

### 3. 配置权限

进入 **权限管理**，开启以下权限：

- ✅ `im:message` - 获取与发送单聊、群组消息
- ✅ `im:message:send_as_bot` - 以应用身份发消息
- ✅ `im:message.receive_v1` - 接收消息事件（事件订阅）

### 4. 配置事件订阅

1. 左侧导航 → **事件与回调** → **事件配置**
2. **订阅方式** 选择：**Webhook**
3. **请求地址** 填写：
   ```
   http://your-server-ip:8089/webhook
   ```
   > 注意：需要外网可访问的地址。如果 CloXde 运行在内网，需配置内网穿透（frp/ngrok）或公网服务器转发

4. 点击 **添加事件**，搜索并添加：
   - `im.message.receive_v1` - 接收消息

5. 点击 **保存**，完成 URL 验证

### 5. 发布应用

1. 左侧导航 → **版本管理与发布**
2. 创建版本并发布（测试版或正式版）
3. 等待审核通过（自建应用一般秒过）

### 6. CloXde 配置

在 CloXde 中配置飞书凭证（通过 IPC 或 UI 调用）：

```typescript
// 示例：通过 Electron IPC 配置
ipcRenderer.invoke('feishu:setup', 'your-app-id', 'your-app-secret')
```

或手动编辑配置文件：
```json
// %USERPROFILE%\AppData\Roaming\cloxde\feishu-credential.json
{
  "appId": "cli_xxx",
  "appSecret": "xxx"
}
```

---

## 🧪 测试验证

### 单聊测试

1. 在飞书中搜索机器人名称 `CloXde`
2. 发送消息：`你好`
3. 机器人应回复 AI 生成的内容

### 群聊测试

1. 创建测试群，添加机器人
2. 发送消息：`@CloXde 帮我分析下这段代码...`
3. 机器人应回复（未 @提及的消息会被忽略）

### Webhook 验证

查看 CloXde 日志：
```bash
[feishu-webhook] server listening on http://0.0.0.0:8089/webhook
[feishu] inbound message from ou_xxx
[feishu] think completed, sending response
```

---

## ⚙️ 高级配置

### 自定义 Webhook 端口

设置环境变量：
```bash
set CLOXDE_FEISHU_PORT=9000
```

### 内网穿透方案

**选项 1: frp**
```ini
# frpc.ini
[feishu-webhook]
type = http
local_ip = 127.0.0.1
local_port = 8089
custom_domains = your-domain.com
```

**选项 2: ngrok**
```bash
ngrok http 8089
```

将生成的公网 URL 配置到飞书事件订阅中。

### 签名验证（推荐）

修改 [src/main/index.ts](../src/main/index.ts#L269)：
```typescript
feishuChannel.startWebhookServer({ 
  port: feishuPort,
  verificationToken: 'your-verification-token',
  encryptKey: 'your-encrypt-key'
})
```

从飞书开放平台 **事件与回调** 页面获取这两个值。

---

## 🔍 故障排查

### 机器人收不到消息

**检查清单：**
- ✅ 应用已发布并通过审核
- ✅ 事件订阅包含 `im.message.receive_v1`
- ✅ Webhook URL 外网可访问（用 `curl` 测试）
- ✅ CloXde Webhook 服务器已启动（查看日志）
- ✅ 机器人已加入群聊（群聊场景）

**调试步骤：**
1. 查看飞书开放平台 **事件与回调** → **事件推送记录**
2. 查看 CloXde 日志：`%USERPROFILE%\AppData\Roaming\cloxde\logs\`
3. 手动测试 Webhook：
   ```bash
   curl -X POST http://localhost:8089/webhook \
     -H "Content-Type: application/json" \
     -d '{"type":"url_verification","challenge":"test","token":"xxx"}'
   ```

### 群聊消息无响应

**原因：** 群聊中必须 @提及 机器人才会响应（设计如此）。

**解决：** 发送消息时输入 `@CloXde` 或在输入框点击 @ 按钮选择机器人。

### Token 刷新失败

**错误：** `获取 tenant_access_token 失败: invalid app_secret`

**解决：**
1. 检查 App ID 和 App Secret 是否正确
2. 删除凭证文件重新配置：
   ```bash
   del %USERPROFILE%\AppData\Roaming\cloxde\feishu-credential.json
   ```
3. 重启 CloXde

---

## 📊 架构说明

```
飞书用户
   ↓ (发送消息)
飞书开放平台
   ↓ (Webhook 推送)
CloXde Webhook Server (http://0.0.0.0:8089/webhook)
   ↓ (解析事件)
feishu/channel.ts (handleWebhookEvent)
   ↓ (调用)
assistant/brain.ts (think)
   ↓ (返回)
feishu-client.ts (sendMessage)
   ↓ (POST /im/v1/messages)
飞书开放平台
   ↓ (推送消息)
飞书用户
```

---

## 🔗 相关资源

- [飞书开放平台文档](https://open.feishu.cn/document/)
- [机器人概述](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-overview)
- [接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
- [发送消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/create)

---

## 🎉 使用场景

### 场景 1: 代码审查
```
用户: @CloXde 帮我审查下这个 PR 的代码质量
CloXde: 我会分析这个 PR 的代码...
```

### 场景 2: 需求分析
```
用户: @CloXde 帮我拆解下「用户登录」功能的实现步骤
CloXde: 好的，我会进行需求分析...
```

### 场景 3: 主动报告（Assistant Review）
```
CloXde: [主动推送]
📊 项目进展报告：feat/assistant-layer 分支已完成 3 个核心功能...
```

---

## 🛡️ 安全建议

1. **不要泄露 App Secret**：凭证文件权限设为仅当前用户可读
2. **启用签名验证**：生产环境务必配置 `encryptKey`
3. **限制 IP 白名单**：飞书开放平台可配置 IP 白名单
4. **定期轮换凭证**：每季度更新 App Secret

---

## 📝 开发说明

核心文件：
- [src/main/feishu/channel.ts](../src/main/feishu/channel.ts) - 通道逻辑
- [src/main/feishu/feishu-client.ts](../src/main/feishu/feishu-client.ts) - API 客户端
- [src/main/feishu/webhook-server.ts](../src/main/feishu/webhook-server.ts) - Webhook 服务器
- [src/main/feishu/credential-store.ts](../src/main/feishu/credential-store.ts) - 凭证存储

IPC 接口：
- `feishu:setup` - 配置凭证
- `feishu:get-status` - 获取状态
- `feishu:logout` - 登出

扩展开发：
- 支持富文本卡片：修改 `feishu-client.ts` 的 `sendMessage` 方法
- 支持图片/文件：添加 `sendImage` / `sendFile` 方法
- 支持消息卡片交互：在 Webhook 中处理 `card.action.trigger` 事件
