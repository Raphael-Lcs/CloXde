import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationView, Message, MessageBlock } from '@shared/types'

interface TimelineProps {
  conversation: ConversationView
  /** Optional whitelist — when set, only steps of these kinds are rendered.
   *  Used to split a 3-agent timeline into user ↔ PM (main page) and
   *  architect ↔ executor (team panel). */
  filterKinds?: StepKind[]
  onStepClick?: (messageId: string) => void
}

/**
 * Horizontal A2A pipeline. Each card = one turn (user input, architect, or
 * executor). Arrows between cards show the handoff direction; the active
 * card pulses so the user can tell at a glance who's working.
 *
 * Replaces the single-line ProgressStrip — now the user sees not just
 * "what's happening" but the whole flow of the collaboration.
 */
export function Timeline({ conversation, filterKinds, onStepClick }: TimelineProps): JSX.Element | null {
  const steps = useMemo(() => {
    const all = buildSteps(conversation)
    if (!filterKinds || filterKinds.length === 0) return all
    const allowed = new Set(filterKinds)
    return all.filter((s) => allowed.has(s.kind))
  }, [conversation, filterKinds])
  const trackRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll to the right edge when steps grow (latest turn always visible).
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' })
  }, [steps.length, steps[steps.length - 1]?.status])

  // Empty-state policy:
  //   • When called with a `filterKinds` whitelist (3-agent main page = team
  //     only; team panel = team only), we ALWAYS render the strip — even if
  //     the filtered set is empty — so the structural slot stays visible
  //     ("the team progress bar lives here, just nothing happening yet").
  //   • When called without a filter (legacy 2-agent), the old behaviour of
  //     returning null on empty stays: first user input creates a step, so
  //     "no steps" only means a brand-new conversation with no messages.
  if (steps.length === 0 && (!filterKinds || filterKinds.length === 0)) {
    return null
  }

  const emptyLabel = describeEmpty(filterKinds)

  return (
    <div className="timeline">
      <div className="timeline-track" ref={trackRef}>
        {steps.length === 0 ? (
          <div className="timeline-empty">{emptyLabel}</div>
        ) : (
          steps.map((s, i) => (
            <Fragment key={s.id}>
              <StepCard step={s} onClick={() => onStepClick?.(s.id)} />
              {i < steps.length - 1 && (
                <StepArrow
                  active={s.status === 'done' && steps[i + 1]?.status === 'running'}
                  fromKind={s.kind}
                  toKind={steps[i + 1].kind}
                />
              )}
            </Fragment>
          ))
        )}
      </div>
    </div>
  )
}

// Choose the placeholder text based on what kinds are whitelisted — the
// main page in 3-agent mode wants "工作组待命中"; nothing else really uses
// the empty state right now, but pick a sensible generic for safety.
function describeEmpty(filterKinds: StepKind[] | undefined): string {
  if (!filterKinds || filterKinds.length === 0) return '暂无进度'
  const set = new Set(filterKinds)
  const teamOnly =
    !set.has('user') && !set.has('pm') &&
    (set.has('architect') || set.has('executor'))
  if (teamOnly) return '工作组待命中 · 等待 PM 派单'
  return '暂无进度'
}

// --- Step model ------------------------------------------------------------

type StepKind = 'user' | 'pm' | 'architect' | 'executor'
type StepStatus = 'running' | 'done' | 'failed' | 'cancelled'

interface Step {
  id: string
  kind: StepKind
  status: StepStatus
  title: string
  activity: string
  startedAt: number
  finishedAt?: number
}

function buildSteps(conv: ConversationView): Step[] {
  const out: Step[] = []
  for (let i = 0; i < conv.messages.length; i++) {
    const m = conv.messages[i]
    if (m.role === 'system') continue
    // Skip the routing-plumbing user messages (architect→executor delegates
    // and executor→architect reports). The assistant turn around them
    // already represents that work.
    if (m.role === 'user' && m.forwardedFromMessageId) continue

    if (m.role === 'user') {
      const text = textOf(m).split(/\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? ''
      out.push({
        id: m.id,
        kind: 'user',
        status: 'done',
        title: '用户',
        activity: text.length > 40 ? text.slice(0, 40) + '…' : text || '空消息',
        startedAt: m.ts,
        finishedAt: m.ts
      })
      continue
    }

    const status: StepStatus = !m.stopReason
      ? 'running'
      : m.stopReason === 'end_turn'
        ? 'done'
        : m.stopReason === 'cancelled'
          ? 'cancelled'
          : 'failed'

    const kind: StepKind =
      m.side === 'pm' ? 'pm'
      : m.side === 'architect' ? 'architect'
      : 'executor'

    // Find the next non-system message's ts to use as finishedAt approximation
    // when stopReason was set but ts isn't tracked. We don't store a real
    // finishedAt — use the next message's start, or now if none.
    let finishedAt: number | undefined
    if (status !== 'running') {
      const next = conv.messages.slice(i + 1).find((x) => x.role !== 'system')
      finishedAt = next?.ts ?? m.ts
    }

    out.push({
      id: m.id,
      kind,
      status,
      title: kind === 'pm' ? '产品经理' : kind === 'architect' ? '架构师' : '执行者',
      activity: summariseActivity(m, status),
      startedAt: m.ts,
      finishedAt
    })
  }
  return out
}

function textOf(m: Message): string {
  return m.blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

function summariseActivity(m: Message, status: StepStatus): string {
  const blocks = m.blocks
  if (status === 'running') {
    // Pick the most informative recent block.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b.type === 'tool_call') {
        const verb =
          b.status === 'pending' ? '准备调用' :
          b.status === 'in_progress' ? '执行' :
          b.status === 'failed' ? '失败' : '完成'
        return `${verb}: ${b.title}`
      }
      if (b.type === 'plan') return `更新计划 (${b.entries.length})`
      if (b.type === 'permission_request') return `等待权限`
      if (b.type === 'thought') return '思考中…'
    }
    return '准备中…'
  }
  // Finalized — describe what got done.
  const text = textOf(m)
  if (/<<DONE>>/i.test(text)) return '宣告完成'
  if (/<<HANDOFF>>/i.test(text)) return '派给团队'
  if (/<<DELEGATE>>/i.test(text)) return '派给执行者'
  const toolCount = blocks.filter((b) => b.type === 'tool_call').length
  if (toolCount > 0) return `${toolCount} 次工具调用`
  if (status === 'cancelled') return '已打断'
  if (status === 'failed') return '失败'
  return '回复'
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// --- Cards & arrows --------------------------------------------------------

function StepCard({
  step,
  onClick
}: {
  step: Step
  onClick?: () => void
}): JSX.Element {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (step.status !== 'running') return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [step.status, step.id])

  const elapsed = formatDuration(
    (step.finishedAt ?? now) - step.startedAt
  )

  return (
    <button
      className={`step-card kind-${step.kind} status-${step.status}`}
      onClick={onClick}
      title={step.activity}
    >
      <div className="step-head">
        <span className="step-dot" />
        <span className="step-title">{step.title}</span>
        <StatusGlyph status={step.status} />
      </div>
      <div className="step-activity">{step.activity}</div>
      <div className="step-footer">
        <span className="step-time">{elapsed}</span>
      </div>
    </button>
  )
}

function StatusGlyph({ status }: { status: StepStatus }): JSX.Element {
  switch (status) {
    case 'running':
      return <span className="step-status status-running"><span className="run-dot" /></span>
    case 'done':
      return <span className="step-status status-done">✓</span>
    case 'failed':
      return <span className="step-status status-failed">✕</span>
    case 'cancelled':
      return <span className="step-status status-cancelled">⊘</span>
  }
}

function StepArrow({
  active,
  fromKind,
  toKind
}: {
  active: boolean
  fromKind: StepKind
  toKind: StepKind
}): JSX.Element {
  return (
    <div
      className={`step-arrow ${active ? 'active' : ''} from-${fromKind} to-${toKind}`}
      aria-hidden
    >
      <svg width="36" height="14" viewBox="0 0 36 14" fill="none">
        <line x1="0" y1="7" x2="34" y2="7" strokeWidth="1.5" />
        <path d="M 28 2 L 34 7 L 28 12" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        {active && <circle className="arrow-bead" cx="0" cy="7" r="3" />}
      </svg>
    </div>
  )
}
