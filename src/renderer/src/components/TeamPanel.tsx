import { useEffect, useMemo, useRef } from 'react'
import type { ConversationView, Message } from '@shared/types'

interface TeamPanelProps {
  conversation: ConversationView
}

/**
 * Right-side drawer showing the engineering team's internal work
 * (architect + executor). The main conversation stream only shows
 * user ↔ PM; the team operates "below the surface" and this panel is
 * where the user peeks at what they're doing.
 *
 * Layout:
 *   • scrollable stream of team messages, default expanded
 *
 * Note: the architect/executor Timeline now lives at the top of the main
 * page in 3-agent mode (it replaces what used to be a redundant user↔PM
 * progress strip). This panel is purely the message detail view.
 */
export function TeamPanel({ conversation }: TeamPanelProps): JSX.Element {
  const teamMessages = useMemo(
    () =>
      conversation.messages.filter(
        (m) =>
          m.role !== 'system' &&
          (m.side === 'architect' || m.side === 'executor') &&
          // Hide internal routing markers — only show real assistant turns.
          !(m.role === 'user' && m.forwardedFromMessageId)
      ),
    [conversation.messages]
  )

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
  }, [teamMessages])

  return (
    <aside className="team-panel">
      <div className="team-panel-header">
        <div className="team-panel-title">工作组活动</div>
        <div className="team-panel-sub">
          <span className="side-architect">架构师</span>
          <span className="team-panel-sep">↔</span>
          <span className="side-executor">执行者</span>
        </div>
      </div>
      <div className="team-panel-stream" ref={scrollerRef} onScroll={onScroll}>
        <div className="team-panel-inner">
          {teamMessages.length === 0 && (
            <div className="team-panel-empty">工作组暂无活动</div>
          )}
          {teamMessages.map((m) => (
            <TeamMessageItem key={m.id} message={m} />
          ))}
        </div>
      </div>
    </aside>
  )
}

// Compact "always-readable" team message — no fold, just shows author,
// status, and content. The user opens the panel deliberately to see this,
// so we don't waste their click on another expand step.
function TeamMessageItem({ message }: { message: Message }): JSX.Element {
  const side = message.side === 'architect' ? 'architect' : 'executor'
  const label = side === 'architect' ? '架构师' : '执行者'
  const streaming = !message.stopReason
  const stop = message.stopReason
  const status = streaming
    ? '运行中'
    : stop === 'end_turn'
      ? '完成'
      : stop === 'cancelled'
        ? '已打断'
        : stop ?? ''

  return (
    <div
      data-msg-id={message.id}
      className={`team-msg side-${side} ${streaming ? 'streaming' : ''}`}
    >
      <div className="team-msg-head">
        <span className={`team-msg-dot side-${side}`} />
        <span className="team-msg-author">{label}</span>
        <span className="team-msg-status">{status}</span>
      </div>
      <div className="team-msg-blocks">
        {message.blocks.map((b, i) => (
          <TeamBlock key={i} block={b} />
        ))}
        {streaming && message.blocks.length === 0 && (
          <div className="team-msg-typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </div>
  )
}

function TeamBlock({
  block
}: {
  block: Message['blocks'][number]
}): JSX.Element {
  switch (block.type) {
    case 'text':
      return <div className="team-block-text">{block.text}</div>
    case 'thought':
      return (
        <details className="team-block-thought">
          <summary>思考过程</summary>
          <div>{block.text}</div>
        </details>
      )
    case 'tool_call':
      return (
        <div className={`team-block-tool tool-${block.status}`}>
          <span className="team-tool-kind">{block.kind}</span>
          <span className="team-tool-title">{block.title}</span>
          <span className="team-tool-status">{block.status}</span>
        </div>
      )
    case 'plan':
      return (
        <div className="team-block-plan">
          <div className="team-plan-head">执行计划</div>
          <ol>
            {block.entries.map((e, i) => (
              <li key={i} className={`plan-${e.status}`}>
                {e.content}
              </li>
            ))}
          </ol>
        </div>
      )
    default:
      return <div />
  }
}
