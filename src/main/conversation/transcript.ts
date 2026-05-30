// Pure text helpers for the conversation engine: extracting/wrapping the
// CloXde协议 tags that drive hand-offs, classifying adapter noise, and
// flattening message blocks. All stateless — split out so they can be
// reasoned about (and unit-tested) independently of the engine's runtime
// state.

import type { MessageBlock } from '@shared/types'

const HANDOFF_RE = /<<HANDOFF>>([\s\S]*?)<<\/HANDOFF>>/i
const DELEGATE_RE = /<<DELEGATE>>([\s\S]*?)<<\/DELEGATE>>/i
const DONE_RE = /<<DONE>>/i

export function extractHandoff(text: string): string | null {
  const m = HANDOFF_RE.exec(text)
  return m ? m[1].trim() : null
}
export function extractDelegate(text: string): string | null {
  const m = DELEGATE_RE.exec(text)
  return m ? m[1].trim() : null
}
export function hasDone(text: string): boolean {
  return DONE_RE.test(text)
}
export function wrapDelegate(text: string): string {
  return `<<DELEGATE>>\n${text}\n<</DELEGATE>>`
}
export function wrapExecutorReport(text: string): string {
  return `[执行者回报]\n\n${text.trim()}\n\n[结束回报]`
}
export function wrapTeamReport(text: string): string {
  // Global flag — agent occasionally emits multiple <<DONE>> markers for
  // emphasis. Strip all of them, not just the first.
  const cleaned = text.replace(/<<DONE>>/gi, '').trim()
  return `[团队反馈]\n\n${cleaned}\n\n[结束反馈]`
}

// Adapter noise: errors / stderr / transient stream failures we don't want
// dumped into the conversation. We still console.error them for debugging.
const NOISE_PATTERNS: RegExp[] = [
  /adapter stderr/i,
  /Handled error during turn/i,
  /Reconnecting\.{3}\s*\d+\/\d+/,
  /stream disconnected/i,
  /windows sandbox:\s*spawn/i,
  /codex_core::tools::router/i,
  /codex_acp::thread/i,
  /ResponseStreamDisconnected/i,
  // Our own teardown sentinel: dispose() rejects an in-flight prompt to
  // unblock the caller. That's intentional shutdown, not an agent failure,
  // so keep it out of the conversation.
  /runtime disposed/i,
  // Crash-mid-turn: the runtime rejects the pending prompt so the turn loop
  // recovers, but the 'exit' handler already posts a user-facing "adapter
  // 退出" message — suppress this one to avoid a duplicate.
  /adapter exited mid-turn/i
]
export function isAdapterNoise(text: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(text))
}

/** Context-window overflow: the session history grew past what the model
 *  accepts, so prompt() rejects deterministically. Unlike a stream hiccup
 *  this will NOT recover on retry — every subsequent turn on the same
 *  session is equally doomed. The engine treats these as fatal-no-retry and
 *  surfaces an actionable message rather than burning the retry budget. */
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i,
  /context (?:window|length|limit)/i,
  /too many tokens/i,
  /maximum context length/i,
  /exceeds? .*(?:token|context)/i
]
export function isContextOverflow(text: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(text))
}

/** Shrink a multi-line error to a one-liner suitable for a status pill. */
export function condenseError(text: string): string {
  const firstLine = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? text
  return firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine
}

export function blocksToPlainText(blocks: MessageBlock[]): string {
  const parts: string[] = []
  for (const b of blocks) if (b.type === 'text') parts.push(b.text)
  return parts.join('').trim()
}
