# CloXde 飞书集成快速开始

> 让你的团队在飞书中直接 @CloXde，像使用 Claude Tag 一样流畅。

## ⚡ 5 分钟快速配置

### 1. 创建飞书应用

访问 [飞书开放平台](https://open.feishu.cn/) → 开发者后台 → 创建企业自建应用

记录：
- **App ID**: `cli_xxxxx`
- **App Secret**: `xxxxx`

### 2. 配置应用

**启用功能：**
- 应用功能 → 机器人 → 启用

**添加权限：**
- `im:message`
- `im:message:send_as_bot`

**订阅事件：**
- 事件与回调 → Webhook → 添加事件
- 添加：`im.message.receive_v1`
- 请求地址：`http://your-ip:8089/webhook`

### 3. CloXde 配置

方式 1: UI 配置（推荐，UI 开发中）
```
设置 → 飞书集成 → 输入 App ID 和 App Secret
```

方式 2: 手动配置
```json
// %USERPROFILE%\AppData\Roaming\cloxde\feishu-credential.json
{
  "appId": "cli_xxxxx",
  "appSecret": "xxxxx"
}
```

重启 CloXde，完成！

### 4. 测试

- **单聊**：搜索机器人名称，发送 `你好`
- **群聊**：添加机器人到群，发送 `@CloXde 你好`

---

## 🌐 内网穿透方案

如果 CloXde 运行在内网，需要公网地址接收 Webhook：

**frp（推荐）：**
```ini
[feishu]
type = http
local_port = 8089
custom_domains = your-domain.com
```

**ngrok：**
```bash
ngrok http 8089
```

将生成的 URL 填入飞书事件订阅。

---

## 📖 完整文档

详细配置和故障排查：[docs/feishu-integration.md](docs/feishu-integration.md)

---

## ❓ 常见问题

**Q: 群聊中机器人不回复？**  
A: 必须 @提及 机器人才会响应（设计如此，避免误触发）

**Q: Webhook 验证失败？**  
A: 确保端口 8089 外网可访问，用 `curl` 测试

**Q: Token 刷新失败？**  
A: 检查 App Secret 是否正确，删除凭证文件重新配置

---

## 🎯 对比微信 Bot

| 特性 | 微信 iLink | 飞书 |
|------|----------|------|
| API 稳定性 | ⚠️ 非官方 | ✅ 官方 |
| @提及支持 | ❌ | ✅ |
| 消息类型 | 文本 | 文本/富文本/卡片 |
| 实时性 | 轮询（延迟） | Webhook（实时） |
| 开发难度 | 高 | 低 |

**推荐使用飞书作为主要集成方案。**
