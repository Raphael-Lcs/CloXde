// Mechanical summarizer: builds a deterministic markdown digest of one or
// more parent conversations to inject as the seed of a new ("继承自") child
// conversation. No LLM call — we just pull the most informative artifacts
// the user has already explicitly produced or seen.
//
// What we surface, per parent, in this order:
//   • the title (or short id when missing)
//   • the latest non-empty `plan` block (with completion glyphs)
//   • the last ≤3 user inputs (verbatim, truncated)
//   • the last ≤3 finalized assistant messages (preview text only —
//     never full bodies, which would explode context for the child)
//   • any "<<DONE>>" / "宣告完成" markers seen recently
//
// The output is plain markdown. The new conversation injects it as a single
// system message at ts = createdAt-1ms so it sorts strictly before any real
// user input.

import type { Conversation, Message, MessageBlock, PlanEntry } from '@shared/types'
import { conversationRepo, messageRepo } from '../storage/db'

const MAX_USER_PREVIEW = 3
const MAX_ASSISTANT_PREVIEW = 3
const MAX_TEXT_LEN = 200
// How many of each parent's most-recent messages we pull. Every extractor
// here reverse-scans for a handful of recent artifacts (latest plan, last ≤3
// inputs/replies/done-markers), so a bounded tail covers the realistic cases
// without loading + JSON-parsing the full history of a long parent. A plan or
// done-marker buried >200 messages back won't surface — acceptable for a
// mechanical seed digest.
const SUMMARY_WINDOW = 200

/** Public entry point used by the IPC handler. Returns '' when no usable
 *  parents could be loaded. Never throws — bad parent ids are just skipped. */
export function buildInheritedSummary(parentIds: string[]): string {
  const sections: string[] = []
  for (const pid of parentIds) {
    const conv = conversationRepo.get(pid)
    if (!conv) continue
    const messages = messageRepo.listRecentByConversation(pid, SUMMARY_WINDOW)
    sections.push(renderParentSection(conv, messages))
  }
  if (sections.length === 0) return ''
  return [
    '> **CloXde 继承上下文**（自动抽取，机械汇总）',
    '',
    sections.join('\n\n---\n\n'),
    '',
    '_用户的真实输入从下一条消息开始。_'
  ].join('\n')
}

function renderParentSection(conv: Conversation, messages: Message[]): string {
  const head = `### 来自会话「${conv.title ?? `会话 ${conv.id.slice(0, 6)}`}」 \`${conv.id}\``
  const created = `创建于 ${formatTs(conv.createdAt)}`

  const plan = latestPlan(messages)
  const planBlock = plan
    ? `**最新计划（${plan.entries.length} 条）**\n${plan.entries
        .map((e) => `- ${statusGlyph(e.status)} ${e.content}`)
        .join('\n')}`
    : null

  const userInputs = recentUserInputs(messages, MAX_USER_PREVIEW)
  const userBlock = userInputs.length
    ? `**最近用户输入**\n${userInputs.map((t) => `> ${truncate(t)}`).join('\n')}`
    : null

  const assistantPreviews = recentAssistantPreviews(messages, MAX_ASSISTANT_PREVIEW)
  const assistantBlock = assistantPreviews.length
    ? `**最近 Agent 回应**\n${assistantPreviews
        .map((p) => `- _${p.author}_: ${truncate(p.preview)}`)
        .join('\n')}`
    : null

  const doneMarkers = findDoneMarkers(messages)
  const doneBlock = doneMarkers.length
    ? `**完成标记**\n${doneMarkers.map((d) => `- ✓ ${truncate(d)}`).join('\n')}`
    : null

  return [head, created, planBlock, userBlock, assistantBlock, doneBlock]
    .filter((x): x is string => !!x)
    .join('\n\n')
}

// --- Extractors --------------------------------------------------------------

function latestPlan(messages: Message[]): { entries: PlanEntry[] } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    for (const b of m.blocks) {
      if (b.type === 'plan' && b.entries.length > 0) {
        return { entries: b.entries }
      }
    }
  }
  return null
}

function recentUserInputs(messages: Message[], limit: number): string[] {
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (m.forwardedFromMessageId) continue // skip routing markers
    const text = collectText(m.blocks).trim()
    if (text) out.push(text)
  }
  return out.reverse()
}

interface AssistantPreview {
  author: string
  preview: string
}
function recentAssistantPreviews(messages: Message[], limit: number): AssistantPreview[] {
  const out: AssistantPreview[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    if (m.stopReason !== 'end_turn') continue // only finalized turns
    const text = collectText(m.blocks).trim()
    if (!text) continue
    out.push({
      author:
        m.side === 'pm' ? '产品经理'
        : m.side === 'architect' ? '架构师'
        : m.side === 'executor' ? '执行者'
        : 'assistant',
      preview: firstNonEmptyLine(text)
    })
  }
  return out.reverse()
}

function findDoneMarkers(messages: Message[]): string[] {
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < 3; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const text = collectText(m.blocks)
    if (/<<DONE>>|宣告完成|任务完成|已完成/.test(text)) {
      out.push(firstNonEmptyLine(text))
    }
  }
  return out.reverse()
}

// --- Helpers -----------------------------------------------------------------

function collectText(blocks: MessageBlock[]): string {
  return blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\n+/)) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

function truncate(text: string, max = MAX_TEXT_LEN): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max - 1) + '…'
}

function statusGlyph(status: PlanEntry['status']): string {
  switch (status) {
    case 'completed':
      return '✓'
    case 'in_progress':
      return '▶'
    case 'pending':
      return '○'
  }
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
