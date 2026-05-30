import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitChange, GitStatus, Project } from '@shared/types'

interface ChangesPanelProps {
  project: Project
}

/**
 * Right-side "改动" drawer — the working-tree diff of the project repo.
 * In a 3-agent run this is effectively "what the executor changed": the
 * agents' working directory IS the project root, so git's status reflects
 * their edits. Click a file to expand its unified diff.
 *
 * Refreshes on the same fs:watch broadcast the file explorer uses, so it
 * tracks edits live as the executor writes files. Degrades to a hint when
 * the root isn't a git repository.
 */
export function ChangesPanel({ project }: ChangesPanelProps): JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [openPath, setOpenPath] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await window.api.fs.gitStatus(project.id)
      if (!res.ok) {
        setError(res.error)
        setStatus(null)
        return
      }
      setError(null)
      setStatus(res.data)
    } catch (e) {
      // A rejected invoke means the main-process handler isn't registered —
      // almost always a stale main process in dev. Surface it instead of
      // leaving the panel stuck on "加载中…".
      setError(
        `调用失败：${(e as Error).message}（若刚改过代码，请完整重启应用让主进程重新注册）`
      )
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [project.id])

  useEffect(() => {
    setOpenPath(null)
    void refresh()
  }, [project.id, refresh])

  // Live refresh on filesystem changes (debounced by the watcher).
  useEffect(() => {
    const off = window.api.fs.onChanged(({ projectId }) => {
      if (projectId === project.id) void refresh()
    })
    return off
  }, [project.id, refresh])

  return (
    <aside className="changes-panel">
      <div className="changes-header">
        <div className="changes-title">
          <span>改动</span>
          <button className="changes-refresh" onClick={() => void refresh()} title="刷新">
            ↻
          </button>
        </div>
        <div className="changes-sub">
          {status?.isRepo
            ? `${status.changes.length} 个文件已改动`
            : status
              ? '非 git 仓库'
              : ''}
        </div>
      </div>
      <div className="changes-list">
        {loading && !status && <div className="changes-hint">加载中…</div>}
        {error && <div className="changes-error">读取失败：{error}</div>}
        {status && !status.isRepo && (
          <div className="changes-hint">
            该项目根目录不是 git 仓库，无法显示改动。
          </div>
        )}
        {status?.isRepo && status.changes.length === 0 && (
          <div className="changes-hint">工作区干净，没有未提交的改动。</div>
        )}
        {status?.isRepo &&
          status.changes.map((c) => (
            <ChangeRow
              key={c.path}
              projectId={project.id}
              change={c}
              open={openPath === c.path}
              onToggle={() =>
                setOpenPath((p) => (p === c.path ? null : c.path))
              }
            />
          ))}
      </div>
    </aside>
  )
}

const STATUS_META: Record<GitChange['status'], { label: string; cls: string }> = {
  modified: { label: 'M', cls: 'modified' },
  added: { label: 'A', cls: 'added' },
  deleted: { label: 'D', cls: 'deleted' },
  renamed: { label: 'R', cls: 'renamed' },
  untracked: { label: 'U', cls: 'untracked' }
}

function ChangeRow({
  projectId,
  change,
  open,
  onToggle
}: {
  projectId: string
  change: GitChange
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const [diff, setDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || diff !== null || loading) return
    setLoading(true)
    void window.api.fs
      .gitDiff(projectId, change.path)
      .then((res) => {
        if (res.ok) setDiff(res.data)
        else setError(res.error)
      })
      .catch((e: Error) => setError(`调用失败：${e.message}`))
      .finally(() => setLoading(false))
  }, [open, diff, loading, projectId, change.path])

  // Drop the cached diff whenever the panel re-opens after a refresh would
  // have changed the file. Simplest correct behavior: refetch on each open by
  // clearing when collapsed.
  useEffect(() => {
    if (!open) {
      setDiff(null)
      setError(null)
    }
  }, [open])

  const meta = STATUS_META[change.status]
  const name = change.path.split('/').pop() ?? change.path
  const dir = change.path.slice(0, change.path.length - name.length)

  return (
    <div className={`change-row ${open ? 'open' : ''}`}>
      <button className="change-head" onClick={onToggle} title={change.path}>
        <span className="change-caret">{open ? '▾' : '▸'}</span>
        <span className={`change-badge st-${meta.cls}`}>{meta.label}</span>
        <span className="change-name">{name}</span>
        {dir && <span className="change-dir">{dir}</span>}
      </button>
      {open && (
        <div className="change-diff">
          {loading && <div className="changes-hint">加载 diff…</div>}
          {error && <div className="changes-error">{error}</div>}
          {diff !== null && diff.trim() === '' && (
            <div className="changes-hint">（无文本 diff）</div>
          )}
          {diff && diff.trim() !== '' && <DiffView text={diff} />}
        </div>
      )}
    </div>
  )
}

/** Render a unified diff with per-line coloring. Hunk headers, +/- lines and
 *  file headers each get their own class. Kept dumb on purpose — no syntax
 *  highlighting, just the diff structure. */
function DiffView({ text }: { text: string }): JSX.Element {
  const lines = useMemo(() => text.split('\n'), [text])
  return (
    <pre className="diff-pre">
      {lines.map((line, i) => {
        let cls = 'diff-ctx'
        if (line.startsWith('@@')) cls = 'diff-hunk'
        else if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-fileh'
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'diff-meta'
        else if (line.startsWith('+')) cls = 'diff-add'
        else if (line.startsWith('-')) cls = 'diff-del'
        return (
          <div key={i} className={`diff-line ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}
