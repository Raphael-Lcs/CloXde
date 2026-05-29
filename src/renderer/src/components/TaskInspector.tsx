import type { Task } from '@shared/types'

interface TaskInspectorProps {
  task: Task
  /** Side it's anchored to — used to position the popover under the pill. */
  open: boolean
  onClose: () => void
}

const STATUS_LABELS: Record<Task['status'], string> = {
  briefing: 'PM 收集需求',
  planning: '架构师分析',
  executing: '执行者动手',
  review: '架构师审查',
  done: '已完成',
  failed: '失败'
}

const OWNER_LABELS: Record<Task['owner'], string> = {
  pm: '产品经理',
  architect: '架构师',
  executor: '执行者'
}

/**
 * Popover that shows everything we know about the active task: brief, plan
 * steps (as a checklist), executor's latest report, failure reason. Anchored
 * to the task pill — click the pill to open, click outside or × to close.
 *
 * Read-only for now. Future: edit brief, manually mark plan-step done,
 * cancel task.
 */
export function TaskInspector({ task, open, onClose }: TaskInspectorProps): JSX.Element | null {
  if (!open) return null

  return (
    <>
      <div className="task-inspector-backdrop" onClick={onClose} />
      <div className="task-inspector" onClick={(e) => e.stopPropagation()}>
        <div className="task-inspector-head">
          <div className="task-inspector-title">
            <span className={`task-pill-dot owner-${task.owner}`} />
            <span>{STATUS_LABELS[task.status]}</span>
            <span className="task-inspector-id">#{task.id.slice(0, 8)}</span>
          </div>
          <button className="task-inspector-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="task-inspector-body">
          <Section title="负责人">
            <span className={`task-owner-tag owner-${task.owner}`}>
              {OWNER_LABELS[task.owner]}
            </span>
          </Section>
          <Section title="Brief">
            <div className="task-inspector-text">
              {task.brief.trim() || <em className="muted">（未设置）</em>}
            </div>
          </Section>
          {task.plan && task.plan.length > 0 && (
            <Section title={`计划（${task.plan.length} 条）`}>
              <ol className="task-inspector-plan">
                {task.plan.map((step, i) => (
                  <li key={i} className={`plan-step status-${step.status}`}>
                    <span className="plan-step-marker">
                      {step.status === 'completed' ? '✓'
                        : step.status === 'in_progress' ? '▶'
                        : step.status === 'skipped' ? '−'
                        : '○'}
                    </span>
                    <span>{step.description}</span>
                  </li>
                ))}
              </ol>
            </Section>
          )}
          {task.result && (
            <Section title="执行者最新报告">
              <div className="task-inspector-text muted-block">{task.result}</div>
            </Section>
          )}
          {task.failureReason && (
            <Section title="失败原因" tone="danger">
              <div className="task-inspector-text">{task.failureReason}</div>
            </Section>
          )}
          <Section title="时间">
            <div className="task-inspector-meta">
              创建：{fmt(task.createdAt)} · 更新：{fmt(task.updatedAt)}
            </div>
          </Section>
        </div>
      </div>
    </>
  )
}

function Section({
  title,
  tone,
  children
}: {
  title: string
  tone?: 'danger'
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className={`task-inspector-section ${tone ? `tone-${tone}` : ''}`}>
      <div className="task-inspector-section-title">{title}</div>
      {children}
    </div>
  )
}

function fmt(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
