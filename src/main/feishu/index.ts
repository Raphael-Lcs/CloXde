/**
 * 飞书 Bot 集成模块
 *
 * 功能特性：
 * - 支持单聊和群聊
 * - 群聊中只响应 @提及
 * - 基于 Webhook 接收消息（实时推送）
 * - 支持富文本消息
 * - 自动 token 刷新
 *
 * 使用方式：
 * 1. 飞书开放平台创建应用
 * 2. 启用机器人能力
 * 3. 订阅事件：im.message.receive_v1
 * 4. 配置 Webhook URL: http://your-server:8089/webhook
 * 5. 调用 setup(appId, appSecret) 配置凭证
 * 6. 调用 start() 启动通道
 */

export { start, stop, setup, logout, getStatus } from './channel'
export { startWebhookServer, stopWebhookServer } from './webhook-server'
export type { FeishuMessage, FeishuCredential } from './feishu-client'
