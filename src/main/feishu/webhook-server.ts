import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, createHmac } from 'node:crypto'
import { handleWebhookEvent } from './channel'

const DEFAULT_PORT = 8089

interface WebhookServerOptions {
  port?: number
  verificationToken?: string
  encryptKey?: string
}

interface WebhookChallenge {
  challenge: string
  token: string
  type: 'url_verification'
}

interface WebhookEvent {
  schema: string
  header: {
    event_id: string
    event_type: string
    create_time: string
    token: string
    app_id: string
    tenant_key: string
  }
  event: any
}

let server: ReturnType<typeof createServer> | null = null

/**
 * 启动飞书 Webhook HTTP 服务器
 */
export function startWebhookServer(options: WebhookServerOptions = {}): number {
  if (server) {
    console.warn('[feishu-webhook] server already running')
    return options.port ?? DEFAULT_PORT
  }

  const port = options.port ?? DEFAULT_PORT
  const verificationToken = options.verificationToken
  const encryptKey = options.encryptKey

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
      return
    }

    try {
      const body = await readBody(req)
      const event = JSON.parse(body) as WebhookChallenge | WebhookEvent

      // URL 验证
      if ('challenge' in event && event.type === 'url_verification') {
        if (verificationToken && event.token !== verificationToken) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid token' }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ challenge: event.challenge }))
        console.log('[feishu-webhook] URL verification passed')
        return
      }

      // 事件处理
      if ('header' in event) {
        console.log('[feishu-webhook] received event:', event.header.event_type)

        // 验证签名（如果配置了 encryptKey）
        if (encryptKey) {
          const timestamp = req.headers['x-lark-request-timestamp'] as string
          const nonce = req.headers['x-lark-request-nonce'] as string
          const signature = req.headers['x-lark-signature'] as string

          if (!verifySignature(timestamp, nonce, encryptKey, body, signature)) {
            console.error('[feishu-webhook] signature verification failed')
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid signature' }))
            return
          }
        }

        // 异步处理事件
        void handleWebhookEvent(event).catch((e) => {
          console.error('[feishu-webhook] handle event failed:', e)
        })

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
        console.log('[feishu-webhook] event handled, responded 200')
        return
      }

      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid event' }))
    } catch (error) {
      console.error('[feishu-webhook] request failed:', error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal server error' }))
    }
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[feishu-webhook] server listening on http://0.0.0.0:${port}/webhook`)
  })

  return port
}

/**
 * 停止 Webhook 服务器
 */
export function stopWebhookServer(): void {
  if (server) {
    server.close()
    server = null
    console.log('[feishu-webhook] server stopped')
  }
}

/**
 * 验证飞书请求签名
 */
function verifySignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  body: string,
  signature: string
): boolean {
  const content = `${timestamp}${nonce}${encryptKey}${body}`
  const hash = createHash('sha256').update(content).digest('hex')
  return hash === signature
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
