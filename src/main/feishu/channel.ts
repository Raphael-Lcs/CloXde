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
import { FeishuClient, type FeishuMessage } from './feishu-client'

const FEISHU_TEXT_MAX_LENGTH = 4096

interface ChannelState {
  running: boolean
  client: FeishuClient | null
  stopPolling: (() => void) | null
  reportUnsubscribe: (() => void) | null
  activeConversations: Set<string>
}

const state: ChannelState = {
  running: false,
  client: null,
  stopPolling: null,
  reportUnsubscribe: null,
  activeConversations: new Set()
}

/**
 * Start the Feishu channel with saved credential
 */
export function start(): void {
  if (state.running) {
    console.warn('[feishu] channel already running')
    return
  }

  const credential = loadCredential()
  if (credential) {
    console.log('[feishu] restoring session from saved credential')
    startPolling(credential.appId, credential.appSecret)
  } else {
    console.log('[feishu] no saved credential, waiting for setup')
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
  state.client = null
  state.activeConversations.clear()
  state.running = false
  console.log('[feishu] channel stopped')
}

/**
 * 配置飞书应用凭证并启动
 */
export async function setup(appId: string, appSecret: string): Promise<void> {
  saveCredential(appId, appSecret)
  startPolling(appId, appSecret)
  console.log('[feishu] setup completed')
}

export function logout(): void {
  state.stopPolling?.()
  state.stopPolling = null
  state.client = null
  state.activeConversations.clear()
  clearStoredCredential()
  console.log('[feishu] logged out')
}

export function getStatus(): {
  configured: boolean
  appId: string | null
} {
  const credential = loadCredential()
  return {
    configured: credential !== null,
    appId: credential?.appId ?? null
  }
}

/**
 * 处理来自 Webhook 的消息事件
 * 外部 HTTP server 需要调用此函数
 */
export async function handleWebhookEvent(event: any): Promise<void> {
  if (!state.client) {
    console.warn('[feishu] webhook received but client not initialized')
    return
  }

  const credential = loadCredential()
  if (!credential) return

  const message = state.client.handleWebhookEvent(event, credential.appId)
  if (!message) return

  // 群聊中只响应 @提及
  if (event.event.message.chat_type === 'group' && !message.isMentioned) {
    console.log('[feishu] 群聊消息未@机器人，忽略')
    return
  }

  await handleInboundMessage(message)
}

function startPolling(appId: string, appSecret: string): void {
  state.stopPolling?.()
  state.client = new FeishuClient({ appId, appSecret })

  const { stop: stopFn } = state.client.startEventStream((msg: FeishuMessage) => {
    void handleInboundMessage(msg)
  })

  state.stopPolling = stopFn
  console.log('[feishu] polling started')
}

async function handleInboundMessage(msg: FeishuMessage): Promise<void> {
  console.log('[feishu] inbound message from', msg.senderId)
  state.activeConversations.add(msg.chatId)

  persistUserMessage(assistantMessageRepo, msg.text)

  try {
    const turn = await getAssistantBrain().think({
      kind: 'user-message',
      text: msg.text,
      attachments: []
    })

    persistTurnOutputs(assistantMessageRepo, turn)

    if (turn.raw.trim() && state.client) {
      await sendTextWithSplit(state.client, msg.chatId, turn.raw)
    }
  } catch (e) {
    const errorMsg = (e as Error).message
    console.error('[feishu] think failed:', errorMsg)
    persistErrorMessage(assistantMessageRepo, errorMsg)

    try {
      if (state.client) {
        await sendTextWithSplit(state.client, msg.chatId, `处理失败：${errorMsg}`)
      }
    } catch (sendError) {
      console.error('[feishu] send error message failed:', sendError)
    }
  }
}

function subscribeToReports(): () => void {
  const handler = (report: AssistantReport): void => {
    if (state.activeConversations.size === 0 || !state.client) return

    for (const chatId of state.activeConversations) {
      sendTextWithSplit(state.client, chatId, report.message).catch((e) =>
        console.error('[feishu] send report failed:', e)
      )
    }
  }

  assistantBus.on('report', handler)
  return () => assistantBus.off('report', handler)
}

async function sendTextWithSplit(
  client: FeishuClient,
  chatId: string,
  text: string
): Promise<void> {
  const chunks: string[] = []
  const cleanText = text.trim()
  if (!cleanText) return

  for (let i = 0; i < cleanText.length; i += FEISHU_TEXT_MAX_LENGTH) {
    chunks.push(cleanText.slice(i, i + FEISHU_TEXT_MAX_LENGTH))
  }

  for (const chunk of chunks) {
    await client.sendMessage(chatId, chunk)
  }
}
