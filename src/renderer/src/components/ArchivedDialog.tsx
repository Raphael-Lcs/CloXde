import type { Conversation, Project } from '@shared/types'
import { TwoClickButton } from './TwoClickButton'

interface ArchivedDialogProps {
  project: Project
  archived: Conversation[]
  open: boolean
  onClose: () => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
}

function formatDate(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Per-project archived conversations manager. Reached via the small
 *  "已归档 N" button at the bottom of each project's conv tree. */
export function ArchivedDialog({
  project,
  archived,
  open,
  onClose,
  onUnarchive,
  onDelete
}: ArchivedDialogProps): JSX.Element | null {
  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: '90vw' }}
      >
        <div className="modal-header">
          <span>已归档会话 — {project.name}</span>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-body" style={{ gap: 0, padding: 0 }}>
          {archived.length === 0 ? (
            <div className="archived-empty">没有已归档的会话</div>
          ) : (
            <div className="archived-list">
              {archived.map((c) => (
                <div className="archived-item" key={c.id}>
                  <div className="archived-meta">
                    <div className="archived-title">
                      {c.title ?? `会话 ${c.id.slice(0, 6)}`}
                    </div>
                    <div className="archived-when">
                      归档于 {formatDate(c.archivedAt)} · 创建于 {formatDate(c.createdAt)}
                    </div>
                  </div>
                  <button
                    className="archived-action"
                    onClick={() => onUnarchive(c.id)}
                    title="恢复到活跃列表"
                  >
                    ↺ 恢复
                  </button>
                  <TwoClickButton
                    className="archived-action danger"
                    defaultLabel="× 删除"
                    confirmLabel="确认删除?"
                    defaultTitle="永久删除（不可恢复）"
                    confirmTitle="再点一次彻底删除"
                    onConfirm={() => onDelete(c.id)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
