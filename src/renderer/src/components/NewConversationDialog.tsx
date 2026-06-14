import { useEffect, useMemo, useState } from 'react'
import type { AgentKind, Conversation, Project } from '@shared/types'

interface NewConversationDialogProps {
  project: Project
  /** Active conversations in this project (candidates for "parent"). */
  active: Conversation[]
  /** Archived conversations in this project (still pickable as parents). */
  archived: Conversation[]
  open: boolean
  onClose: () => void
  /** Caller actually creates the conversation. We only return the chosen
   *  config (parent ids, summary override, PM kind) so wiring stays in App. */
  onCreate: (input: {
    parentIds: string[]
    summaryOverride?: string
    pmKind?: AgentKind
    architectKind?: AgentKind
    executorKind?: AgentKind
  }) => Promise<void>
}

/**
 * Modal launched from "+ 新建协作会话". Two columns:
 *
 *   • LEFT: option list — blank-start vs inherit-from-N-parents (multi-select)
 *   • RIGHT: live preview of the mechanical inheritance summary (editable)
 *
 * The summary is fetched from the main process whenever the parent picks
 * change. The user can edit it in place; their edits become the
 * `summaryOverride` passed back to App.
 */
export function NewConversationDialog({
  project,
  active,
  archived,
  open,
  onClose,
  onCreate
}: NewConversationDialogProps): JSX.Element | null {
  const [showInheritance, setShowInheritance] = useState(false)
  const [pickedParents, setPickedParents] = useState<Set<string>>(new Set())
  const [summary, setSummary] = useState('')
  const [summaryDirty, setSummaryDirty] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [pmKind, setPmKind] = useState<AgentKind>(project.defaultPm)
  const [architectKind, setArchitectKind] = useState<AgentKind>(project.defaultArchitect)
  const [executorKind, setExecutorKind] = useState<AgentKind>(project.defaultExecutor)
  const [busy, setBusy] = useState(false)

  // Reset state every time the dialog opens fresh.
  useEffect(() => {
    if (!open) return
    setShowInheritance(false)
    setPickedParents(new Set())
    setSummary('')
    setSummaryDirty(false)
    setPmKind(project.defaultPm)
    setArchitectKind(project.defaultArchitect)
    setExecutorKind(project.defaultExecutor)
    setBusy(false)
  }, [open, project.defaultPm, project.defaultArchitect, project.defaultExecutor])

  const parentIdList = useMemo(() => Array.from(pickedParents), [pickedParents])

  // Whenever the picked parents change AND the user hasn't manually edited
  // the summary, refresh the preview from the engine.
  useEffect(() => {
    if (!open) return
    if (summaryDirty) return
    if (parentIdList.length === 0) {
      setSummary('')
      return
    }
    let cancelled = false
    setPreviewBusy(true)
    void window.api.conversations
      .previewInheritedSummary(parentIdList)
      .then((res) => {
        if (cancelled) return
        if (res.ok) setSummary(res.data)
      })
      .finally(() => !cancelled && setPreviewBusy(false))
    return () => {
      cancelled = true
    }
  }, [open, parentIdList, summaryDirty])

  const toggleParent = (id: string): void => {
    setPickedParents((curr) => {
      const next = new Set(curr)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    // Re-enable auto-preview now that the parent set changed.
    setSummaryDirty(false)
  }

  const handleCreate = async (): Promise<void> => {
    setBusy(true)
    try {
      await onCreate({
        parentIds: parentIdList,
        summaryOverride: summaryDirty && summary.trim() ? summary : undefined,
        pmKind,
        architectKind,
        executorKind
      })
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const totalParents = active.length + archived.length

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal new-conv-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>新建协作会话 — {project.name}</span>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="new-conv-body">
          <div className="new-conv-col new-conv-col-pickers">
            <div className="new-conv-section">
              <div className="new-conv-label">PM 角色</div>
              <div className="new-conv-pm-tabs">
                {(['claude', 'codex', 'hermes'] as AgentKind[]).map((k) => (
                  <button
                    key={k}
                    className={`toggle-btn kind-${k} ${pmKind === k ? 'active' : ''}`}
                    onClick={() => setPmKind(k)}
                  >
                    {k === 'claude' ? 'Claude Code'
                      : k === 'codex' ? 'Codex'
                      : 'Hermes'}
                  </button>
                ))}
              </div>
              <div className="settings-hint" style={{ marginTop: 4 }}>
                Hermes 需要 tool 授权 UI 才能稳定使用，目前推荐 Claude Code。
              </div>
            </div>

            <div className="new-conv-section">
              <div className="new-conv-label">架构师角色</div>
              <div className="new-conv-pm-tabs">
                {(['claude', 'codex', 'hermes'] as AgentKind[]).map((k) => (
                  <button
                    key={k}
                    className={`toggle-btn kind-${k} ${architectKind === k ? 'active' : ''}`}
                    onClick={() => setArchitectKind(k)}
                  >
                    {k === 'claude' ? 'Claude Code'
                      : k === 'codex' ? 'Codex'
                      : 'Hermes'}
                  </button>
                ))}
              </div>
            </div>

            <div className="new-conv-section">
              <div className="new-conv-label">执行者角色</div>
              <div className="new-conv-pm-tabs">
                {(['claude', 'codex', 'hermes'] as AgentKind[]).map((k) => (
                  <button
                    key={k}
                    className={`toggle-btn kind-${k} ${executorKind === k ? 'active' : ''}`}
                    onClick={() => setExecutorKind(k)}
                  >
                    {k === 'claude' ? 'Claude Code'
                      : k === 'codex' ? 'Codex'
                      : 'Hermes'}
                  </button>
                ))}
              </div>
            </div>

            <div className="new-conv-section">
              <div className="new-conv-label">
                继承自（可选 · 多选）
                {pickedParents.size > 0 && (
                  <span className="new-conv-count">{pickedParents.size}</span>
                )}
              </div>
              {totalParents === 0 ? (
                <div className="new-conv-empty">
                  该项目暂无可继承的会话。直接创建空白会话即可。
                </div>
              ) : (
                <div className="new-conv-parent-list">
                  {active.map((c) => (
                    <ParentRow
                      key={c.id}
                      conv={c}
                      checked={pickedParents.has(c.id)}
                      onToggle={() => toggleParent(c.id)}
                      groupLabel="活跃"
                    />
                  ))}
                  {archived.length > 0 && (
                    <div className="new-conv-divider">已归档</div>
                  )}
                  {archived.map((c) => (
                    <ParentRow
                      key={c.id}
                      conv={c}
                      checked={pickedParents.has(c.id)}
                      onToggle={() => toggleParent(c.id)}
                      groupLabel="归档"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="new-conv-col new-conv-col-preview">
            <div className="new-conv-label">
              继承摘要预览
              {previewBusy && <span className="new-conv-count">生成中…</span>}
              {summaryDirty && <span className="new-conv-count warm">已手改</span>}
            </div>
            {parentIdList.length === 0 ? (
              <div className="new-conv-empty">
                未选择父会话，新会话从空白开始。
              </div>
            ) : (
              <textarea
                className="new-conv-summary"
                value={summary}
                onChange={(e) => {
                  setSummary(e.target.value)
                  setSummaryDirty(true)
                }}
                spellCheck={false}
                placeholder="（继承摘要会自动生成，可在此手改）"
              />
            )}
            {summaryDirty && (
              <button
                className="new-conv-regen"
                onClick={() => setSummaryDirty(false)}
                title="放弃手改，重新自动生成"
              >
                ↺ 恢复自动生成
              </button>
            )}
          </div>
        </div>
        <div className="new-conv-actions">
          <button onClick={onClose} disabled={busy}>取消</button>
          <button
            className="primary"
            onClick={() => void handleCreate()}
            disabled={busy}
          >
            {busy ? '创建中…' : '创建会话'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ParentRow({
  conv,
  checked,
  onToggle,
  groupLabel
}: {
  conv: Conversation
  checked: boolean
  onToggle: () => void
  groupLabel: string
}): JSX.Element {
  const title = conv.title ?? `会话 ${conv.id.slice(0, 6)}`
  return (
    <label className={`new-conv-parent-row ${checked ? 'checked' : ''}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="new-conv-parent-title">{title}</span>
      <span className="new-conv-parent-group">{groupLabel}</span>
    </label>
  )
}
