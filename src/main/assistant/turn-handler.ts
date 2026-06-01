import type { AssistantTurn } from '../../shared/types'
import type { assistantMessageRepo } from '../storage/db'

export type AssistantMessageRepo = Pick<typeof assistantMessageRepo, 'insert'>

/**
 * Persist the user's message into the assistant thread.
 */
export function persistUserMessage(repo: AssistantMessageRepo, text: string): void {
  try {
    repo.insert({ role: 'user', text })
  } catch (e) {
    console.error('[assistant] persist user msg failed:', (e as Error).message)
  }
}

/**
 * Persist the visible outputs from one AssistantTurn into the assistant thread.
 */
export function persistTurnOutputs(repo: AssistantMessageRepo, turn: AssistantTurn): void {
  try {
    if (turn.reports.length === 0 && turn.raw.trim()) {
      repo.insert({ role: 'assistant', text: turn.raw })
    }

    for (const d of turn.dispatched) {
      repo.insert({
        role: 'system',
        text: `已为「${d.name}」创建项目并派出团队开始工作。`,
        projectId: d.projectId,
        conversationId: d.conversationId
      })
    }

    for (const c of turn.continued) {
      repo.insert({
        role: 'system',
        text: `已向「${c.name}」团队追加了新指示。`,
        projectId: c.projectId,
        conversationId: c.conversationId
      })
    }

    if (turn.remembered > 0) {
      repo.insert({ role: 'system', text: `记下了 ${turn.remembered} 条记忆。` })
    }
    if (turn.forgotten > 0) {
      repo.insert({ role: 'system', text: `撤回了 ${turn.forgotten} 条过时记忆。` })
    }
    if (turn.updated > 0) {
      repo.insert({ role: 'system', text: `改进了 ${turn.updated} 条已有记忆/技能。` })
    }

    if (turn.scheduled > 0) {
      repo.insert({ role: 'system', text: `设了 ${turn.scheduled} 个提醒，到点我会自己回来处理。` })
    }
  } catch (e) {
    console.error('[assistant] persist turn outputs failed:', (e as Error).message)
  }
}

/**
 * Persist a failed assistant turn into the assistant thread.
 */
export function persistErrorMessage(repo: AssistantMessageRepo, errorMsg: string): void {
  try {
    repo.insert({ role: 'system', text: `出错：${errorMsg}` })
  } catch (e) {
    console.error('[assistant] persist error msg failed:', (e as Error).message)
  }
}
