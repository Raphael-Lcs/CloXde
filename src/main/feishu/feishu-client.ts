import { randomBytes } from 'node:crypto'

const DEFAULT_BASE_URL = 'https://open.feishu.cn/open-apis'
const EVENT_STREAM_TIMEOUT_MS = 65_000

export interface FeishuMessage {
  chatId: string
  senderId: string
  text: string
  messageId: string
  mentions: Array<{ id: string; name: string }>
  isMentioned: boolean
}

export interface FeishuCredential {
  appId: string
  appSecret: string
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>
  body?: Record<string, unknown>
  timeoutMs?: number
  signal?: AbortSignal
}

type JsonObject = Record<string, unknown>

interface TenantAccessTokenResponse {
  tenant_access_token: string
  expire: number
}

interface EventStreamMessage {
  schema: string
  header: {
    event_id: string
    event_type: string
    create_time: string
    token: string
    app_id: string
    tenant_key: string
  }
  event: {
    sender: {
      sender_id: {
        user_id: string
        open_id: string
      }
      sender_type: string
      tenant_key: string
    }
    message: {
      message_id: string
      root_id?: string
      parent_id?: string
      create_time: string
      chat_id: string
      chat_type: 'p2p' | 'group'
      message_type: 'text' | 'image' | 'file' | 'audio' | 'media' | 'sticker' | 'interactive' | 'share_chat' | 'share_user'
      content: string
      mentions?: Array<{
        key: string
        id: {
          user_id?: string
          open_id?: string
        }
        name: string
        tenant_key: string
      }>
    }
  }
}

export class FeishuClient {
  private readonly baseUrl: string
  private readonly appId: string
  private readonly appSecret: string
  private accessToken: string | null = null
  private tokenExpiry: number = 0

  constructor(credential: FeishuCredential, baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.appId = credential.appId
    this.appSecret = credential.appSecret
  }

  /**
   * 获取 tenant_access_token，自动刷新
   */
  async getTenantAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.accessToken && this.tokenExpiry > now + 60_000) {
      return this.accessToken
    }

    const json = await this.requestJson('POST', '/auth/v3/tenant_access_token/internal', {
      body: {
        app_id: this.appId,
        app_secret: this.appSecret
      }
    })

    if (json.code !== 0) {
      throw new Error(`获取 tenant_access_token 失败: ${json.msg || json.code}`)
    }

    const data = json as unknown as TenantAccessTokenResponse & { code: number; msg?: string }
    this.accessToken = data.tenant_access_token
    this.tokenExpiry = now + data.expire * 1000

    return this.accessToken
  }

  /**
   * 启动长连接事件流，接收消息
   */
  startEventStream(
    onMessage: (msg: FeishuMessage) => void
  ): { stop: () => void } {
    let stopped = false
    let abortController: AbortController | null = null

    const stream = async (): Promise<void> => {
      while (!stopped) {
        try {
          const token = await this.getTenantAccessToken()
          abortController = new AbortController()

          // 飞书长连接基于 Server-Sent Events (SSE) 协议
          // 但实际实现中，飞书推荐使用 Webhook 或轮询 + WebSocket
          // 这里我们采用轮询方式，实际生产环境建议配置 Webhook
          console.log('[feishu] 注意：当前使用轮询模式，建议配置 Webhook 以获得实时推送')

          await this.pollEvents(token, onMessage, abortController.signal)

        } catch (error) {
          abortController = null
          if (!stopped) {
            console.warn('[feishu] event stream error:', error)
            await delay(5_000) // 错误后等待 5 秒重试
          }
        }
      }
    }

    void stream()

    return {
      stop: () => {
        stopped = true
        abortController?.abort()
      }
    }
  }

  /**
   * 轮询模式（临时方案）
   * 注意：飞书官方推荐使用 Webhook 接收事件
   */
  private async pollEvents(
    token: string,
    onMessage: (msg: FeishuMessage) => void,
    signal: AbortSignal
  ): Promise<void> {
    // 由于飞书不提供类似微信 getupdates 的轮询接口
    // 这里只是占位实现，实际需要配置 Webhook
    // 或使用飞书的 WebSocket 长连接（需要额外配置）
    console.warn('[feishu] 轮询模式未实现，请配置 Webhook 接收事件')

    // 等待信号中止
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve())
    })
  }

  /**
   * 发送文本消息
   */
  async sendMessage(
    chatId: string,
    text: string,
    msgType: 'text' | 'post' = 'text'
  ): Promise<void> {
    const token = await this.getTenantAccessToken()

    let content: string
    if (msgType === 'text') {
      content = JSON.stringify({ text })
    } else {
      // post 类型支持富文本（Markdown）
      content = JSON.stringify({
        zh_cn: {
          title: '',
          content: [[{ tag: 'text', text }]]
        }
      })
    }

    const json = await this.requestJson('POST', '/im/v1/messages', {
      query: { receive_id_type: 'chat_id' },
      body: {
        receive_id: chatId,
        msg_type: msgType,
        content
      }
    }, token)

    if (json.code !== 0) {
      throw new Error(`发送消息失败: ${json.msg || json.code}`)
    }
  }

  /**
   * 发送富文本消息（支持 Markdown）
   */
  async sendRichText(chatId: string, markdown: string): Promise<void> {
    const token = await this.getTenantAccessToken()

    const json = await this.requestJson('POST', '/im/v1/messages', {
      query: { receive_id_type: 'chat_id' },
      body: {
        receive_id: chatId,
        msg_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            title: '',
            content: this.parseMarkdownToFeishuPost(markdown)
          }
        })
      }
    }, token)

    if (json.code !== 0) {
      throw new Error(`发送富文本消息失败: ${json.msg || json.code}`)
    }
  }

  /**
   * 处理 Webhook 事件（外部调用）
   */
  handleWebhookEvent(event: EventStreamMessage, appId: string): FeishuMessage | null {
    if (event.header.event_type !== 'im.message.receive_v1') {
      return null
    }

    const { sender, message } = event.event
    if (message.message_type !== 'text') {
      console.log('[feishu] 忽略非文本消息:', message.message_type)
      return null
    }

    let text = ''
    try {
      const content = JSON.parse(message.content) as { text?: string }
      text = content.text || ''
    } catch {
      text = message.content
    }

    const mentions = message.mentions || []
    const isMentioned = mentions.some(
      (m) => m.id.user_id === appId || m.id.open_id === appId
    )

    return {
      chatId: message.chat_id,
      senderId: sender.sender_id.user_id || sender.sender_id.open_id,
      text,
      messageId: message.message_id,
      mentions: mentions.map((m) => ({
        id: m.id.user_id || m.id.open_id || '',
        name: m.name
      })),
      isMentioned
    }
  }

  /**
   * 将简单 Markdown 转换为飞书富文本格式
   */
  private parseMarkdownToFeishuPost(markdown: string): Array<Array<{ tag: string; text: string }>> {
    // 简化实现：将每行作为一个段落
    // 生产环境应使用完整的 Markdown 解析器
    const lines = markdown.split('\n').filter(l => l.trim())
    return lines.map(line => [{ tag: 'text', text: line }])
  }

  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    options: RequestOptions = {},
    token?: string
  ): Promise<JsonObject> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = options.signal ? null : new AbortController()
    const timeout = controller
      ? setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
      : null

    try {
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      const response = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
        signal: options.signal ?? controller?.signal
      })

      const text = await response.text()
      const json = parseJsonObject(text)

      if (!response.ok) {
        throw new Error(`飞书 API ${method} ${path} 失败: HTTP ${response.status} ${compactJson(json)}`)
      }

      return json
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

function parseJsonObject(text: string): JsonObject {
  if (!text.trim()) return {}
  const parsed = JSON.parse(text) as unknown
  if (!isObject(parsed)) {
    throw new Error(`响应不是对象: ${text.slice(0, 200)}`)
  }
  return parsed
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compactJson(value: unknown): string {
  return JSON.stringify(value).slice(0, 500)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
