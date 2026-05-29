// Pure reducer that folds a single ACP `SessionNotification` update into a
// message's block list. Extracted from the engine's handleUpdate so the
// (chunky) translation between ACP's streaming update shapes and CloXde's
// MessageBlock model lives apart from the orchestration logic.
//
// Contract: `blocks` and `toolBlockIndex` are mutated in place. `blocks`
// should be a fresh copy owned by the caller (the engine clones the
// streaming mirror before calling). Returns whether anything changed, so
// the caller can skip a persist + emit when the update was a no-op.

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { MessageBlock, PlanEntry } from '@shared/types'

export function applyUpdate(
  blocks: MessageBlock[],
  update: SessionNotification['update'],
  toolBlockIndex: Map<string, number>
): boolean {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const text =
        update.content.type === 'text' ? update.content.text : `[${update.content.type}]`
      const targetType = update.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'text'
      const last = blocks[blocks.length - 1]
      if (last && last.type === targetType) {
        ;(last as { text: string }).text += text
      } else {
        blocks.push({ type: targetType, text } as MessageBlock)
      }
      return true
    }
    case 'tool_call': {
      const idx = blocks.length
      blocks.push({
        type: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title ?? update.kind ?? 'tool',
        kind: update.kind ?? 'other',
        status: update.status ?? 'pending',
        locations: update.locations?.map((l) => l.path),
        rawInput: update.rawInput
      })
      toolBlockIndex.set(update.toolCallId, idx)
      return true
    }
    case 'tool_call_update': {
      const idx = toolBlockIndex.get(update.toolCallId)
      if (idx !== undefined && blocks[idx]?.type === 'tool_call') {
        const block = blocks[idx] as Extract<MessageBlock, { type: 'tool_call' }>
        if (update.status) block.status = update.status
        if (update.title) block.title = update.title
        if (update.kind) block.kind = update.kind
        if (update.locations) block.locations = update.locations.map((l) => l.path)
        if (update.rawOutput !== undefined) {
          const out =
            typeof update.rawOutput === 'string'
              ? update.rawOutput
              : JSON.stringify(update.rawOutput).slice(0, 4000)
          block.output = out
        }
        return true
      }
      return false
    }
    case 'plan': {
      const planBlock: MessageBlock = {
        type: 'plan',
        entries: (update.entries as PlanEntry[]) ?? []
      }
      const existingIdx = blocks.findIndex((b) => b.type === 'plan')
      if (existingIdx >= 0) blocks[existingIdx] = planBlock
      else blocks.push(planBlock)
      return true
    }
    default:
      return false
  }
}
