// Pure reducer that folds a single ACP `SessionNotification` update into a
// message's block list. Extracted from the engine's handleUpdate so the
// (chunky) translation between ACP's streaming update shapes and CloXde's
// MessageBlock model lives apart from the orchestration logic.
//
// Contract: `blocks` and `toolBlockIndex` are mutated in place. `blocks`
// should be a fresh copy owned by the caller (the engine clones the
// streaming mirror before calling). Returns whether anything changed, so
// the caller can skip a persist + emit when the update was a no-op.

import type { SessionNotification, ToolCallContent } from '@agentclientprotocol/sdk'
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
      const block: Extract<MessageBlock, { type: 'tool_call' }> = {
        type: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title ?? update.kind ?? 'tool',
        kind: update.kind ?? 'other',
        status: update.status ?? 'pending',
        locations: update.locations?.map((l) => l.path),
        rawInput: update.rawInput
      }
      // Output can already be present on create (rare, but spec-allowed). The
      // standard carrier is `content`; `rawOutput` is a non-standard fallback.
      const out = pickToolOutput(update.content, update.rawOutput)
      if (out !== null) block.output = out
      blocks.push(block)
      toolBlockIndex.set(update.toolCallId, idx)
      return true
    }
    case 'tool_call_update': {
      let idx = toolBlockIndex.get(update.toolCallId)
      // Lazy upsert: some adapters emit a tool_call_update without a preceding
      // tool_call (or one arrives after we cleared the index on compaction).
      // Treat an unknown id as a create so the call still surfaces and settles
      // rather than being silently dropped — the update type carries every
      // field create needs (title/kind/status are all optional there too).
      if (idx === undefined || blocks[idx]?.type !== 'tool_call') {
        idx = blocks.length
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
      }
      const block = blocks[idx] as Extract<MessageBlock, { type: 'tool_call' }>
      if (update.status) block.status = update.status
      if (update.title) block.title = update.title
      if (update.kind) block.kind = update.kind
      if (update.locations) block.locations = update.locations.map((l) => l.path)
      const out = pickToolOutput(update.content, update.rawOutput)
      if (out !== null) block.output = out
      return true
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

/** Pick a short, renderable output string for a tool call. Prefers the ACP
 *  `content` array (the standard output carrier — text, file diffs, terminal
 *  refs) and falls back to the non-standard `rawOutput`. Returns null when
 *  there's nothing to show, so callers only overwrite an existing output when
 *  we actually have new content. */
function pickToolOutput(
  content: ToolCallContent[] | null | undefined,
  rawOutput: unknown
): string | null {
  const fromContent = extractToolContent(content)
  if (fromContent !== null) return fromContent
  if (rawOutput === undefined) return null
  return clip(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput))
}

function extractToolContent(content: ToolCallContent[] | null | undefined): string | null {
  if (!content || content.length === 0) return null
  const parts: string[] = []
  for (const c of content) {
    if (c.type === 'content') {
      const b = c.content
      parts.push(b.type === 'text' ? b.text : `[${b.type}]`)
    } else if (c.type === 'diff') {
      parts.push(`--- ${c.path}\n${c.newText}`)
    } else if (c.type === 'terminal') {
      parts.push(`[terminal ${c.terminalId}]`)
    }
  }
  const joined = parts.join('\n').trim()
  return joined ? clip(joined) : null
}

function clip(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}
