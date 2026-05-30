import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message, MessageBlock, Side, TurnMetrics } from '@shared/types'

/**
 * Whether a finalized assistant message has something the user actually
 * needs to read.
 *
 *   • 'awaiting'   — PM finished a turn without dispatching the team, OR (in
 *                    legacy 2-agent mode) the architect finished without
 *                    delegating and without DONE → talking to the user.
 *   • 'dispatched' — PM finished its turn AND dispatched the team via
 *                    <<HANDOFF>>. The prose around the HANDOFF is the PM's
 *                    小结 to the user — it must stay visible (auto-expanded),
 *                    only the internal HANDOFF brief is stripped.
 *   • 'done'       — architect declared completion (2-agent mode) — the
 *                    summary the user wants to see. In 3-agent mode this is
 *                    consumed by the PM and not shown directly.
 *   • null         — internal traffic (executor work, intermediate
 *                    delegate, cancelled / failed turns).
 */
type UserFacingMode = 'awaiting' | 'dispatched' | 'done' | null

function userFacingMode(message: Message): UserFacingMode {
  if (message.role !== 'assistant') return null
  if (message.stopReason !== 'end_turn') return null
  const text = message.blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  if (message.side === 'pm') {
    // PM speaks directly to the user. Whether it dispatched the team or not,
    // its prose is a summary the user should read — only the badge differs.
    if (/<<HANDOFF>>/i.test(text)) return 'dispatched'
    return 'awaiting'
  }
  if (message.side === 'architect') {
    // In 3-agent mode the user never sees architect directly, so badges
    // are only meaningful in legacy 2-agent conversations.
    if (/<<DONE>>/i.test(text)) return 'done'
    if (/<<DELEGATE>>/i.test(text)) return null
    return 'awaiting'
  }
  return null
}

// Internal CloXde协议 tags that drive the PM/architect/executor hand-offs.
// They're plumbing, not prose — strip them out of the text the user sees so
// the PM's 小结 reads cleanly instead of leaking `<<HANDOFF>>…` markers.
// 闭合标签可选：与 state-machine 的解析保持一致——LLM 常只发开标签就接正文，
// 此时正文取到下一个标签或文本结尾，避免未闭合标签残留到界面。
const PROTOCOL_TAG_RE =
  /<<(HANDOFF|DELEGATE|REPORT|PLAN|FAIL)>>[\s\S]*?(?:<<\/\1>>|(?=<<\/?[A-Za-z])|$)|<<DONE>>/gi

function stripProtocolTags(text: string): string {
  return text.replace(PROTOCOL_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Markdown text renderer used inside text blocks, user pills, routing bodies,
 * and thought block bodies. Anywhere agent/user content lands.
 *
 * We deliberately keep it dependency-light: no syntax highlighter for code
 * blocks (saves ~200KB and a layer of dependency drama) — `pre > code` just
 * gets a monospace block styled to fit the dark theme.
 */
function MarkdownText({ text, className }: { text: string; className?: string }): JSX.Element {
  return (
    <div className={className ? `md ${className}` : 'md'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

interface ConversationStreamProps {
  messages: Message[]
  showSystem: boolean
  /** True when the conversation has a PM agent. In that case the stream
   *  hides architect + executor work (the team operates behind the PM) and
   *  only renders user ↔ PM exchanges. */
  threeAgent: boolean
}

/**
 * Single-column chronological view, Codex Desktop style.
 *
 *   • Your input          → small right-aligned pill ("你")
 *   • Agent reply         → left-aligned flow, no bubble border, author label
 *                            color-coded by side
 *   • Forwarded delegate  → compact one-line routing marker
 *   • System / diagnostic → dim inline note (toggled by Composer)
 *
 * Adapter noise (codex stderr, transient stream reconnects) is filtered out
 * unconditionally — those messages exist in the DB from earlier runs but
 * carry no actionable signal.
 */

// Patterns we always strip from the conversation stream — keep in sync with
// the engine-side suppressor in src/main/conversation/engine.ts.
const NOISE_PATTERNS: RegExp[] = [
  /adapter stderr/i,
  /Handled error during turn/i,
  /Reconnecting\.{3}\s*\d+\/\d+/,
  /stream disconnected/i,
  /windows sandbox:\s*spawn/i,
  /codex_core::tools::router/i,
  /codex_acp::thread/i,
  /ResponseStreamDisconnected/i
]

function isAdapterNoise(message: Message): boolean {
  if (message.role !== 'system') return false
  const text = message.blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  return NOISE_PATTERNS.some((re) => re.test(text))
}

/** The inheritance summary is stored as a `system` role message but it's
 *  the most important context in the conversation — definitely not "noise"
 *  the user should be allowed to hide. Detect by the leading marker we put
 *  there in summarizer.ts. */
function isInheritanceSummary(message: Message): boolean {
  if (message.role !== 'system') return false
  const text = message.blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  return /CloXde 继承上下文/.test(text)
}

export function ConversationStream({
  messages,
  showSystem,
  threeAgent
}: ConversationStreamProps): JSX.Element {
  const visible = useMemo(
    () =>
      messages.filter((m) => {
        if (isAdapterNoise(m)) return false
        // Inheritance summary is always shown, regardless of 隐藏系统.
        if (isInheritanceSummary(m)) return true
        if (m.role === 'system') return showSystem
        // 3-agent mode: team work lives in the dedicated TeamPanel, not in
        // the main stream. Hide architect / executor messages and their
        // routing markers entirely so the user sees a clean PM ↔ user log.
        if (threeAgent) {
          if (m.side === 'architect' || m.side === 'executor') return false
        }
        return true
      }),
    [messages, showSystem, threeAgent]
  )

  // Pin-to-bottom scrolling: auto-scroll only while the user is already at
  // (or very near) the bottom. The moment they scroll up to read past
  // content, stop auto-scrolling so they can finish reading in peace.
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const onScroll = (): void => {
    const el = scrollerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedRef.current = distFromBottom < 60
  }
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [visible])

  return (
    <div className="conv-stream" ref={scrollerRef} onScroll={onScroll}>
      <div className="conv-stream-inner">
        {visible.length === 0 && (
          <div className="conv-empty">等待输入…</div>
        )}
        {visible.map((m) => (
          <MessageRow key={m.id} message={m} threeAgent={threeAgent} />
        ))}
      </div>
    </div>
  )
}

// --- Routing -----------------------------------------------------------------

function MessageRow({
  message,
  threeAgent
}: {
  message: Message
  threeAgent: boolean
}): JSX.Element {
  // Compact class flags assistant rows that are "team internal" — i.e.
  // architect / executor working under a PM. CSS dims them so the PM ↔ user
  // conversation stays visually dominant, but they're still clickable to
  // expand for inspection.
  const isTeamRow =
    threeAgent &&
    message.role === 'assistant' &&
    (message.side === 'architect' || message.side === 'executor')
  return (
    <div
      data-msg-id={message.id}
      className={`msg-row-wrap ${isTeamRow ? 'team-row' : ''}`}
    >
      <MessageRowInner message={message} />
    </div>
  )
}

function MessageRowInner({ message }: { message: Message }): JSX.Element {
  if (message.role === 'system') return <SystemRow message={message} />
  if (message.role === 'user' && !message.forwardedFromMessageId) {
    return <UserPill message={message} />
  }
  if (message.role === 'user') return <RoutingMarker message={message} />
  return <AssistantFlow message={message} />
}

// --- System -----------------------------------------------------------------

type SystemKind = 'done' | 'info' | 'warning' | 'error' | 'note'

function classifySystem(text: string): SystemKind {
  if (/<<DONE>>|任务完成|宣告.*完成|已完成/.test(text)) return 'done'
  if (/上下文.*恢复|context.*restored/i.test(text)) return 'info'
  if (/上限|暂停|cancelled|已取消|超时/.test(text)) return 'warning'
  if (/退出|失败|错误|error|exit code/i.test(text)) return 'error'
  return 'note'
}

const SYSTEM_ICON: Record<SystemKind, string> = {
  done: '✓',
  info: '↻',
  warning: '⚠',
  error: '✕',
  note: '·'
}

function SystemRow({ message }: { message: Message }): JSX.Element {
  const text = message.blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  const kind = classifySystem(text)

  return (
    <div className={`msg-row msg-row-system kind-${kind}`}>
      <div className={`msg-system-note kind-${kind}`}>
        <span className="sys-icon">{SYSTEM_ICON[kind]}</span>
        <span className="sys-text">{text}</span>
      </div>
    </div>
  )
}

// --- User (real input) -------------------------------------------------------

function UserPill({ message }: { message: Message }): JSX.Element {
  const text = message.blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  const images = message.blocks.filter(
    (b): b is Extract<MessageBlock, { type: 'image' }> => b.type === 'image'
  )
  return (
    <div className="msg-row msg-row-incoming">
      <div className="msg-pill msg-pill-user">
        {text && <MarkdownText text={text} />}
        {images.length > 0 && (
          <div className="msg-pill-images">
            {images.map((b, i) => (
              <a
                key={i}
                href={`data:${b.mimeType};base64,${b.data}`}
                target="_blank"
                rel="noopener noreferrer"
                title="点击在新窗口查看原图"
              >
                <img
                  className="msg-pill-image"
                  src={`data:${b.mimeType};base64,${b.data}`}
                  alt={`附件 ${i + 1}`}
                />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Forwarded between sides (CloXde plumbing) -------------------------------

function RoutingMarker({ message }: { message: Message }): JSX.Element {
  // message.side = the receiver column. Sender is the other side.
  const receiver: Side = message.side === 'architect' ? 'architect' : 'executor'
  const sender: Side = receiver === 'architect' ? 'executor' : 'architect'
  const sLabel = sender === 'architect' ? '架构师' : '执行者'
  const rLabel = receiver === 'architect' ? '架构师' : '执行者'
  const kind = receiver === 'executor' ? '指令' : '回报'

  const [open, setOpen] = useState(false)

  return (
    <div className="msg-row msg-row-routing">
      <div className={`msg-routing ${open ? 'open' : ''}`}>
        <button
          className="routing-head"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="routing-arrow">↳</span>
          <span className={`routing-side side-${sender}`}>{sLabel}</span>
          <span className="routing-to">→</span>
          <span className={`routing-side side-${receiver}`}>{rLabel}</span>
          <span className="routing-kind">{kind}</span>
          <span className="routing-caret">{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div className="routing-body">
            {message.blocks.map((b, i) => (
              <BlockView key={i} block={b} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Assistant (codex-style flow, no bubble) ---------------------------------

function AssistantFlow({ message }: { message: Message }): JSX.Element {
  const side =
    message.side === 'pm' ? 'pm'
    : message.side === 'architect' ? 'architect'
    : 'executor'
  const streaming = !message.stopReason
  const mode = userFacingMode(message)
  // Default expansion policy:
  //   • Any user-facing PM message (mode 'awaiting' or 'dispatched')
  //     auto-expands — its 小结 is the entire point of running PM.
  //   • Everything else stays folded; the user opens what they want.
  const userFacing = mode === 'awaiting' || mode === 'dispatched'
  const [expanded, setExpanded] = useState<boolean>(() => userFacing)
  // Promote to expanded on stream → finalized transition if it became
  // user-facing. Doesn't override manual user collapse later because the
  // ref only fires on the streaming→finalized edge.
  const wasStreaming = useRef<boolean>(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming && userFacing) {
      setExpanded(true)
    }
    wasStreaming.current = streaming
  }, [streaming, userFacing])

  const author =
    side === 'pm' ? '产品经理'
    : side === 'architect' ? '架构师'
    : '执行者'
  const status = statusLabel(message.stopReason)
  // PM prose carries internal HANDOFF/协议 tags that are plumbing, not
  // content — strip them everywhere the user reads PM output (preview + body).
  const strip = side === 'pm'
  const preview = useMemo(() => previewOf(message.blocks, strip), [message.blocks, strip])
  const blockCount = message.blocks.length

  return (
    <div className={`msg-row msg-row-outgoing side-${side} ${mode ? `mode-${mode}` : ''}`}>
      <div className="msg-assistant">
        <div
          className="msg-assistant-meta"
          onClick={() => setExpanded((v) => !v)}
        >
          <span className={`msg-side-dot side-${side}`} />
          <span className="msg-meta-author">{author}</span>
          {mode === 'awaiting' && (
            <span className="msg-mode-badge mode-awaiting">等你回复</span>
          )}
          {mode === 'dispatched' && (
            <span className="msg-mode-badge mode-dispatched">已派给团队 →</span>
          )}
          {mode === 'done' && (
            <span className="msg-mode-badge mode-done">已完成 ✓</span>
          )}
          {streaming ? (
            <span className="msg-meta-status streaming">
              <span className="meta-dot" />
              思考中
            </span>
          ) : (
            !mode && status && <span className="msg-meta-status">{status}</span>
          )}
          {!streaming && <MetricsChip metrics={message.metrics} />}
          {!expanded && (
            <span className="msg-meta-preview">
              {preview}
              {blockCount > 1 && (
                <span className="msg-meta-count"> · {blockCount} 块</span>
              )}
            </span>
          )}
          <span className="msg-meta-caret">{expanded ? '▾' : '▸'}</span>
        </div>
        {expanded && (
          <div className="msg-assistant-body">
            {message.blocks.length === 0 && streaming && (
              <div className="msg-typing">
                <span />
                <span />
                <span />
              </div>
            )}
            <AssistantBody blocks={message.blocks} strip={strip} />
          </div>
        )}
      </div>
    </div>
  )
}

// --- Helpers ----------------------------------------------------------------

/**
 * Renders an assistant message's blocks. When `strip` is set (PM output) the
 * internal协议 tags are removed from text blocks. If stripping a PM turn
 * leaves no prose at all (it only emitted a HANDOFF brief), we show a friendly
 * placeholder instead of an empty body so the user isn't left staring at a
 * blank summary.
 */
function AssistantBody({
  blocks,
  strip
}: {
  blocks: MessageBlock[]
  strip: boolean
}): JSX.Element {
  const rendered = blocks.map((b, i) => <BlockView key={i} block={b} strip={strip} />)
  if (strip) {
    const hasVisibleText = blocks.some(
      (b) => b.type === 'text' && stripProtocolTags(b.text).length > 0
    )
    const hasOtherContent = blocks.some((b) => b.type !== 'text' && b.type !== 'thought')
    if (!hasVisibleText && !hasOtherContent) {
      return (
        <>
          {rendered}
          <div className="msg-dispatch-note">已把任务交给团队，进度见上方「工作组」。</div>
        </>
      )
    }
  }
  return <>{rendered}</>
}

function statusLabel(stopReason: Message['stopReason']): string | null {
  if (!stopReason) return null
  switch (stopReason) {
    case 'end_turn':
      return null
    case 'cancelled':
      return '已打断'
    case 'max_tokens':
      return 'token 上限'
    case 'refusal':
      return '拒绝'
    case 'max_turn_requests':
      return '轮次上限'
    default:
      return stopReason
  }
}

/** Compact token count: 1234 → "1.2k", 980 → "980". */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}

/** Human duration: <1s → "420ms", else "1.4s" / "1m12s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s - m * 60)}s`
}

/** Inline per-turn metrics: elapsed time + token usage. Renders nothing when
 *  there's no data (older messages, or adapters that don't report usage and
 *  somehow lack timing). The token figure prefers totalTokens, falling back
 *  to in+out. A full breakdown shows on hover via `title`. */
function MetricsChip({ metrics }: { metrics?: TurnMetrics }): JSX.Element | null {
  if (!metrics) return null
  const parts: string[] = []
  if (typeof metrics.durationMs === 'number') parts.push(formatDuration(metrics.durationMs))
  const total =
    metrics.totalTokens ??
    (metrics.inputTokens != null || metrics.outputTokens != null
      ? (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0)
      : undefined)
  if (typeof total === 'number') parts.push(`${formatTokens(total)} tok`)
  if (parts.length === 0) return null

  const detail: string[] = []
  if (typeof metrics.durationMs === 'number') detail.push(`耗时 ${formatDuration(metrics.durationMs)}`)
  if (typeof metrics.inputTokens === 'number') detail.push(`输入 ${metrics.inputTokens}`)
  if (typeof metrics.outputTokens === 'number') detail.push(`输出 ${metrics.outputTokens}`)
  if (typeof metrics.cachedTokens === 'number') detail.push(`缓存读 ${metrics.cachedTokens}`)
  if (typeof metrics.totalTokens === 'number') detail.push(`合计 ${metrics.totalTokens}`)

  return (
    <span className="msg-meta-metrics" title={detail.join(' · ')}>
      {parts.join(' · ')}
    </span>
  )
}

function previewOf(blocks: MessageBlock[], strip = false): string {
  for (const b of blocks) {
    if (b.type === 'text') {
      const source = strip ? stripProtocolTags(b.text) : b.text
      const t = source
        .split(/\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0)
      if (t) return t.length > 100 ? t.slice(0, 100) + '…' : t
    } else if (b.type === 'tool_call') {
      return `工具：${b.title}`
    } else if (b.type === 'plan') {
      return `计划（${b.entries.length} 条）`
    } else if (b.type === 'thought') {
      return '思考过程…'
    }
  }
  return strip ? '已把任务交给团队' : '（无内容）'
}

function BlockView({ block, strip = false }: { block: MessageBlock; strip?: boolean }): JSX.Element {
  switch (block.type) {
    case 'text': {
      const text = strip ? stripProtocolTags(block.text) : block.text
      if (!text) return <></>
      return <MarkdownText text={text} className="block-text" />
    }
    case 'thought':
      return (
        <details className="block-thought">
          <summary>思考过程</summary>
          <MarkdownText text={block.text} className="block-thought-body" />
        </details>
      )
    case 'tool_call':
      return (
        <div className={`block-tool tool-${block.status}`}>
          <div className="tool-head">
            <span className="tool-kind">{block.kind}</span>
            <span className="tool-title">{block.title}</span>
            <span className="tool-status">{toolStatusLabel(block.status)}</span>
          </div>
          {block.locations && block.locations.length > 0 && (
            <div className="tool-locations">{block.locations.join(' · ')}</div>
          )}
          {block.output && (
            <details className="tool-output">
              <summary>输出</summary>
              <pre>{block.output}</pre>
            </details>
          )}
        </div>
      )
    case 'plan':
      return (
        <div className="block-plan">
          <div className="plan-head">执行计划</div>
          <ol>
            {block.entries.map((e, i) => (
              <li key={i} className={`plan-entry plan-${e.status}`}>
                <span className={`plan-prio prio-${e.priority}`}>{e.priority}</span>
                <span>{e.content}</span>
              </li>
            ))}
          </ol>
        </div>
      )
    case 'permission_request':
      return (
        <div className="block-permission">
          <div>
            权限请求：{block.title}
            {block.chosenOptionId && <span className="tag"> · 已自动放行</span>}
          </div>
        </div>
      )
    case 'image':
      return (
        <a
          href={`data:${block.mimeType};base64,${block.data}`}
          target="_blank"
          rel="noopener noreferrer"
          title="点击在新窗口查看原图"
        >
          <img
            className="block-image"
            src={`data:${block.mimeType};base64,${block.data}`}
            alt=""
          />
        </a>
      )
    default:
      return <div />
  }
}

function toolStatusLabel(s: string): string {
  switch (s) {
    case 'pending':
      return '待执行'
    case 'in_progress':
      return '执行中'
    case 'completed':
      return '完成'
    case 'failed':
      return '失败'
    default:
      return s
  }
}
