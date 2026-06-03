import type { AssistantReport } from '../../shared/types'
import { assistantBus } from '../assistant/actions'
import { getAssistantBrain } from '../assistant/brain'
import {
  persistErrorMessage,
  persistTurnOutputs,
  persistUserMessage
} from '../assistant/turn-handler'
import { assistantMessageRepo } from '../storage/db'
import {
  clearCredential as clearStoredCredential,
  loadCredential,
  saveCredential
} from './credential-store'
import { ilinkClient, type WeChatMessage } from './ilink-client'

const LOGIN_MAX_ATTEMPTS = 10
const ILINK_TEXT_MAX_LENGTH = 4096

interface ChannelState {
  running: boolean
  accountId: string | null
  token: string | null
  stopPolling: (() => void) | null
  reportUnsubscribe: (() => void) | null
  activeConversations: Set<string>
  lastContextTokens: Map<string, string>
}

const state: ChannelState = {
  running: false,
  accountId: null,
  token: null,
  stopPolling: null,
  reportUnsubscribe: null,
  activeConversations: new Set(),
  lastContextTokens: new Map()
}

/**
 * Start the WeChat channel. If a credential was saved previously, polling is
 * restored immediately; otherwise the channel waits for an explicit login flow.
 */
export function start(): void {
  if (state.running) {
    console.warn('[wechat] channel already running')
    return
  }

  const credential = loadCredential()
  if (credential) {
    console.log('[wechat] restoring session from saved credential')
    startPolling(credential.token, credential.accountId)
  } else {
    console.log('[wechat] no saved credential, waiting for login')
  }

  state.reportUnsubscribe = subscribeToReports()
  state.running = true
}

export function stop(): void {
  if (!state.running) return

  state.stopPolling?.()
  state.reportUnsubscribe?.()
  state.stopPolling = null
  state.reportUnsubscribe = null
  state.accountId = null
  state.token = null
  state.activeConversations.clear()
  state.lastContextTokens.clear()
  state.running = false
  console.log('[wechat] channel stopped')
}

export async function startLogin(): Promise<{
  qrcodeUrl: string
  loginPromise: Promise<{ accountId: string }>
}> {
  const { qrcodeUrl, qrcodeId } = await ilinkClient.getBotQrcode()

  const loginPromise = (async (): Promise<{ accountId: string }> => {
    // iLink 的 get_qrcode_status 每次等待约30秒返回
    // 需要持续轮询直到成功或超时
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      console.log(`[wechat] polling attempt ${i + 1}/${LOGIN_MAX_ATTEMPTS}`)
      const { status, token, accountId } = await ilinkClient.pollQrcodeStatus(qrcodeId)

      if (status === 'confirmed' && token && accountId) {
        saveCredential(token, accountId)
        startPolling(token, accountId)
        console.log('[wechat] login successful:', accountId)
        return { accountId }
      }

      if (status === 'scanned') {
        console.log('[wechat] qrcode scanned, waiting for confirmation')
      }
    }

    throw new Error('登录超时，请重新扫码')
  })()

  return { qrcodeUrl, loginPromise }
}

export function logout(): void {
  state.stopPolling?.()
  state.stopPolling = null
  state.accountId = null
  state.token = null
  state.activeConversations.clear()
  state.lastContextTokens.clear()
  clearStoredCredential()
  console.log('[wechat] logged out')
}

export function getStatus(): {
  loggedIn: boolean
  accountId: string | null
} {
  return {
    loggedIn: state.accountId !== null,
    accountId: state.accountId
  }
}

function startPolling(token: string, accountId: string): void {
  state.stopPolling?.()
  state.accountId = accountId
  state.token = token

  const { stop: stopFn } = ilinkClient.startPolling(token, (msg: WeChatMessage) => {
    void handleInboundMessage(token, msg)
  })

  state.stopPolling = stopFn
  console.log('[wechat] polling started for account', accountId)
}

async function handleInboundMessage(token: string, msg: WeChatMessage): Promise<void> {
  console.log('[wechat] inbound message from', msg.from)
  state.activeConversations.add(msg.from)
  if (msg.contextToken) state.lastContextTokens.set(msg.from, msg.contextToken)

  persistUserMessage(assistantMessageRepo, msg.text)

  try {
    const turn = await getAssistantBrain().think({
      kind: 'user-message',
      text: msg.text,
      attachments: []
    })

    persistTurnOutputs(assistantMessageRepo, turn)

    if (turn.raw.trim()) {
      await sendTextWithSplit(token, msg.from, turn.raw, msg.contextToken)
    }
  } catch (e) {
    const errorMsg = (e as Error).message
    console.error('[wechat] think failed:', errorMsg)
    persistErrorMessage(assistantMessageRepo, errorMsg)

    try {
      await sendTextWithSplit(token, msg.from, `处理失败：${errorMsg}`, msg.contextToken)
    } catch (sendError) {
      console.error('[wechat] send error message failed:', sendError)
    }
  }
}

function subscribeToReports(): () => void {
  const handler = (report: AssistantReport): void => {
    const token = state.token ?? loadCredential()?.token
    if (state.activeConversations.size === 0 || !state.accountId || !token) return

    for (const conversationId of state.activeConversations) {
      const contextToken = state.lastContextTokens.get(conversationId)
      sendTextWithSplit(token, conversationId, report.message, contextToken).catch((e) =>
        console.error('[wechat] send report failed:', e)
      )
    }
  }

  assistantBus.on('report', handler)
  return () => assistantBus.off('report', handler)
}

async function sendTextWithSplit(
  token: string,
  to: string,
  text: string,
  contextToken?: string
): Promise<void> {
  const chunks: string[] = []
  const cleanText = text.trim()
  if (!cleanText) return

  for (let i = 0; i < cleanText.length; i += ILINK_TEXT_MAX_LENGTH) {
    chunks.push(cleanText.slice(i, i + ILINK_TEXT_MAX_LENGTH))
  }

  for (const chunk of chunks) {
    await ilinkClient.sendMessage(token, to, chunk, contextToken)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
