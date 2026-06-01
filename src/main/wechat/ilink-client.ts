import { randomBytes } from 'node:crypto'

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const BOT_AGENT = 'cloxde-wechat-channel'
const GET_UPDATES_HOLD_MS = 40_000
const POLL_RETRY_MS = 2_000

export interface WeChatMessage {
  from: string
  text: string
  contextToken: string
  messageId: string
}

export type QrcodeStatus = 'pending' | 'scanned' | 'confirmed'

interface RequestOptions {
  token?: string
  query?: Record<string, string | number | undefined>
  body?: Record<string, unknown>
  timeoutMs?: number
}

type JsonObject = Record<string, unknown>

export class IlinkClient {
  private readonly baseUrl: string

  constructor(baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async getBotQrcode(): Promise<{ qrcodeUrl: string; qrcodeId: string }> {
    const json = await this.requestJson('GET', '/ilink/bot/get_bot_qrcode', {
      query: { bot_type: 1 }
    })
    const data = unwrapData(json)
    const qrcodeUrl = pickString(data, ['qrcodeUrl', 'qrcode_url', 'qrCodeUrl', 'url'])
    const qrcodeId = pickString(data, ['qrcodeId', 'qrcode_id', 'qrCodeId', 'id'])

    if (!qrcodeUrl || !qrcodeId) {
      throw new Error(`iLink qrcode response missing qrcodeUrl/qrcodeId: ${compactJson(json)}`)
    }
    return { qrcodeUrl, qrcodeId }
  }

  async pollQrcodeStatus(
    qrcodeId: string
  ): Promise<{ status: QrcodeStatus; token?: string; accountId?: string }> {
    const json = await this.requestJson('GET', '/ilink/bot/get_qrcode_status', {
      query: { qrcode_id: qrcodeId, qrcodeId }
    })
    const data = unwrapData(json)
    const token = pickString(data, ['token', 'accessToken', 'access_token', 'botToken', 'bot_token'])
    const accountId = pickString(data, [
      'accountId',
      'account_id',
      'openid',
      'openId',
      'userId',
      'user_id'
    ])
    const status = normalizeQrcodeStatus(pickValue(data, ['status', 'qrcodeStatus', 'qrcode_status']), token)

    return { status, token, accountId }
  }

  startPolling(
    token: string,
    onMessage: (msg: WeChatMessage) => void
  ): { stop: () => void } {
    let stopped = false
    let getUpdatesBuf = ''
    let abortController: AbortController | null = null

    const poll = async (): Promise<void> => {
      while (!stopped) {
        try {
          abortController = new AbortController()
          const json = await this.requestJson('POST', '/ilink/bot/getupdates', {
            token,
            body: {
              token,
              get_updates_buf: getUpdatesBuf
            },
            timeoutMs: GET_UPDATES_HOLD_MS,
            signal: abortController.signal
          })
          abortController = null

          const data = unwrapData(json)
          const nextBuf = pickString(data, [
            'get_updates_buf',
            'getUpdatesBuf',
            'next_buf',
            'nextBuf',
            'buf'
          ])
          if (nextBuf !== undefined) getUpdatesBuf = nextBuf

          for (const message of extractMessages(data)) {
            if (stopped) break
            try {
              onMessage(message)
            } catch (error) {
              console.warn('[wechat] inbound message handler failed', error)
            }
          }
        } catch (error) {
          abortController = null
          if (!stopped) {
            console.warn('[wechat] getupdates failed', error)
            await delay(POLL_RETRY_MS)
          }
        }
      }
    }

    void poll()

    return {
      stop: () => {
        stopped = true
        abortController?.abort()
      }
    }
  }

  async sendMessage(
    token: string,
    to: string,
    text: string,
    contextToken?: string
  ): Promise<void> {
    const clientId = randomBytes(16).toString('hex')
    const json = await this.requestJson('POST', '/ilink/bot/sendmessage', {
      token,
      body: {
        token,
        to,
        receiver: to,
        content: text,
        text,
        context_token: contextToken ?? '',
        client_id: clientId,
        message_type: 'text',
        message_state: 'sent'
      }
    })

    assertNoIlinkError(json, 'sendmessage')
  }

  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    options: RequestOptions & { signal?: AbortSignal } = {}
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
      const response = await fetch(url, {
        method,
        headers: this.headers(options.token),
        body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
        signal: options.signal ?? controller?.signal
      })

      const text = await response.text()
      const json = parseJsonObject(text)
      if (!response.ok) {
        throw new Error(`iLink ${method} ${path} failed: HTTP ${response.status} ${compactJson(json)}`)
      }
      assertNoIlinkError(json, path)
      return json
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private headers(token?: string): HeadersInit {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-WECHAT-UIN': makeWechatUin(),
      bot_agent: BOT_AGENT
    }
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }
}

export const ilinkClient = new IlinkClient()

function makeWechatUin(): string {
  const uin = String(randomBytes(4).readUInt32BE(0))
  return Buffer.from(uin, 'utf8').toString('base64')
}

function parseJsonObject(text: string): JsonObject {
  if (!text.trim()) return {}
  const parsed = JSON.parse(text) as unknown
  if (!isObject(parsed)) throw new Error(`iLink response is not an object: ${text.slice(0, 200)}`)
  return parsed
}

function unwrapData(json: JsonObject): JsonObject {
  const data = json.data
  return isObject(data) ? data : json
}

function assertNoIlinkError(json: JsonObject, operation: string): void {
  const data = unwrapData(json)
  const code = pickValue(json, ['errcode', 'errCode', 'errorCode', 'code']) ??
    pickValue(data, ['errcode', 'errCode', 'errorCode', 'code'])
  const message =
    pickString(json, ['errmsg', 'errMsg', 'message', 'error']) ??
    pickString(data, ['errmsg', 'errMsg', 'message', 'error'])

  if (typeof code === 'number' && code !== 0) {
    throw new Error(`iLink ${operation} returned code ${code}${message ? `: ${message}` : ''}`)
  }
  if (typeof code === 'string' && code && code !== '0' && code.toLowerCase() !== 'ok') {
    throw new Error(`iLink ${operation} returned code ${code}${message ? `: ${message}` : ''}`)
  }
  const success = pickValue(json, ['success', 'ok']) ?? pickValue(data, ['success', 'ok'])
  if (success === false) {
    throw new Error(`iLink ${operation} returned success=false${message ? `: ${message}` : ''}`)
  }
}

function normalizeQrcodeStatus(rawStatus: unknown, token?: string): QrcodeStatus {
  if (token) return 'confirmed'
  const status = String(rawStatus ?? '').toLowerCase()
  if (['confirmed', 'confirm', 'success', 'authorized', 'logged_in', '2', '3'].includes(status)) {
    return 'confirmed'
  }
  if (['scanned', 'scan', 'qrcode_scanned', '1'].includes(status)) return 'scanned'
  if (['expired', 'cancelled', 'canceled', 'failed', '-1', '4'].includes(status)) {
    throw new Error(`iLink qrcode login failed or expired: ${status}`)
  }
  return 'pending'
}

function extractMessages(data: JsonObject): WeChatMessage[] {
  const source =
    pickValue(data, ['updates', 'messages', 'messageList', 'message_list', 'items', 'list']) ?? []
  const items = Array.isArray(source) ? source : [source]
  const messages: WeChatMessage[] = []

  for (const item of items) {
    if (!isObject(item)) continue
    const from = pickString(item, ['from', 'fromUser', 'from_user', 'sender', 'senderId', 'sender_id'])
    const text =
      pickString(item, ['text', 'content', 'message']) ??
      (isObject(item.text) ? pickString(item.text, ['content', 'text']) : undefined)
    const contextToken = pickString(item, [
      'contextToken',
      'context_token',
      'conversationContext',
      'conversation_context'
    ])
    const messageId =
      pickString(item, ['messageId', 'message_id', 'msgId', 'msg_id', 'id', 'clientId']) ??
      randomBytes(8).toString('hex')

    if (!from || !text) continue
    messages.push({ from, text, contextToken: contextToken ?? '', messageId })
  }

  return messages
}

function pickValue(obj: JsonObject, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
  }
  return undefined
}

function pickString(obj: JsonObject, keys: string[]): string | undefined {
  const value = pickValue(obj, keys)
  return typeof value === 'string' && value.length > 0 ? value : undefined
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
