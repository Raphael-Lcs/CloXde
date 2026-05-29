import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DirEntry, Project } from '@shared/types'

interface FileExplorerProps {
  project: Project
}

interface NodeState {
  entries: DirEntry[]
  expanded: boolean
  loaded: boolean
  loading: boolean
  error?: string
}

/** Right-side project file inspector. Lazy tree, fs.watch-driven refresh. */
export function FileExplorer({ project }: FileExplorerProps): JSX.Element {
  // path '' = project root. Other paths are forward-slash relative.
  const [nodes, setNodes] = useState<Record<string, NodeState>>({
    '': { entries: [], expanded: true, loaded: false, loading: false }
  })
  const [refreshTick, setRefreshTick] = useState(0)

  const loadPath = useCallback(
    async (relPath: string): Promise<void> => {
      setNodes((s) => ({
        ...s,
        [relPath]: {
          ...(s[relPath] ?? { entries: [], expanded: true, loaded: false, loading: false }),
          loading: true
        }
      }))
      const res = await window.api.fs.listDir(project.id, relPath)
      setNodes((s) => {
        const prev = s[relPath] ?? {
          entries: [],
          expanded: true,
          loaded: false,
          loading: false
        }
        if (!res.ok) {
          return {
            ...s,
            [relPath]: { ...prev, loading: false, loaded: true, error: res.error }
          }
        }
        return {
          ...s,
          [relPath]: {
            entries: res.data,
            expanded: prev.expanded,
            loaded: true,
            loading: false
          }
        }
      })
    },
    [project.id]
  )

  // Initial load + reload when project changes.
  useEffect(() => {
    setNodes({ '': { entries: [], expanded: true, loaded: false, loading: false } })
    void loadPath('')
  }, [project.id, loadPath])

  // fs.watch broadcasts → invalidate all *loaded* nodes for this project.
  useEffect(() => {
    const off = window.api.fs.onChanged(({ projectId }) => {
      if (projectId !== project.id) return
      setRefreshTick((t) => t + 1)
    })
    return off
  }, [project.id])

  useEffect(() => {
    if (refreshTick === 0) return
    // Refresh every currently-loaded node. Cheap because they only refetch
    // metadata, and we throttle via the watcher's 250ms debounce.
    setNodes((curr) => {
      for (const [path, state] of Object.entries(curr)) {
        if (state.loaded || state.expanded) {
          // Fire async refresh — don't await inside setState.
          void loadPath(path)
        }
      }
      return curr
    })
  }, [refreshTick, loadPath])

  const toggle = useCallback(
    (path: string): void => {
      setNodes((s) => {
        const prev = s[path] ?? {
          entries: [],
          expanded: false,
          loaded: false,
          loading: false
        }
        const next: NodeState = { ...prev, expanded: !prev.expanded }
        return { ...s, [path]: next }
      })
      const state = nodes[path]
      if (state && !state.loaded && !state.loading) {
        void loadPath(path)
      } else if (!state) {
        void loadPath(path)
      }
    },
    [loadPath, nodes]
  )

  const openFile = useCallback(
    (path: string): void => {
      void window.api.fs.openPath(project.id, path).then((res) => {
        if (!res.ok) window.alert(`打开失败：${res.error}`)
      })
    },
    [project.id]
  )

  const rootState = nodes[''] ?? null

  return (
    <aside className="explorer">
      <div className="explorer-header">
        <div className="explorer-title">
          <span>项目文件</span>
          <button
            className="explorer-refresh"
            onClick={() => void loadPath('')}
            title="刷新"
          >
            ↻
          </button>
        </div>
        <div className="explorer-path" title={project.rootDir}>
          {project.rootDir}
        </div>
      </div>
      <div className="explorer-tree">
        {!rootState?.loaded && rootState?.loading && (
          <div className="explorer-hint">加载中…</div>
        )}
        {rootState?.error && (
          <div className="explorer-error">读取失败：{rootState.error}</div>
        )}
        {rootState?.loaded && rootState.entries.length === 0 && (
          <div className="explorer-hint">（空目录）</div>
        )}
        {rootState?.loaded && (
          <TreeChildren
            entries={rootState.entries}
            nodes={nodes}
            depth={0}
            onToggle={toggle}
            onOpenFile={openFile}
          />
        )}
      </div>
    </aside>
  )
}

function TreeChildren({
  entries,
  nodes,
  depth,
  onToggle,
  onOpenFile
}: {
  entries: DirEntry[]
  nodes: Record<string, NodeState>
  depth: number
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
}): JSX.Element {
  return (
    <>
      {entries.map((e) => (
        <TreeNode
          key={e.path}
          entry={e}
          nodes={nodes}
          depth={depth}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  )
}

function TreeNode({
  entry,
  nodes,
  depth,
  onToggle,
  onOpenFile
}: {
  entry: DirEntry
  nodes: Record<string, NodeState>
  depth: number
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
}): JSX.Element {
  const childState = nodes[entry.path]
  const isDir = entry.kind === 'directory'
  const expanded = !!childState?.expanded

  const sizeText = useMemo(() => {
    if (entry.kind !== 'file' || entry.size === undefined) return ''
    const s = entry.size
    if (s < 1024) return `${s} B`
    if (s < 1024 * 1024) return `${(s / 1024).toFixed(1)} KB`
    return `${(s / 1024 / 1024).toFixed(1)} MB`
  }, [entry])

  return (
    <>
      <div
        className={`tree-row ${isDir ? 'dir' : 'file'}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (isDir ? onToggle(entry.path) : onOpenFile(entry.path))}
        title={entry.path}
      >
        <span className="tree-icon">
          {isDir ? (expanded ? '▾' : '▸') : '·'}
        </span>
        <span className="tree-name">{entry.name}</span>
        {!isDir && <span className="tree-size">{sizeText}</span>}
        {isDir && (
          // Folder → "在资源管理器中打开"。单击行还是展开/折叠（更高频），
          // 这个图标按钮是显式入口，不会被误触。
          <button
            className="tree-open-btn"
            onClick={(e) => {
              e.stopPropagation()
              onOpenFile(entry.path)
            }}
            title="在系统文件管理器中打开"
            aria-label="在系统文件管理器中打开"
          >
            <OpenInOsIcon />
          </button>
        )}
      </div>
      {isDir && expanded && childState?.loaded && (
        <TreeChildren
          entries={childState.entries}
          nodes={nodes}
          depth={depth + 1}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      )}
      {isDir && expanded && childState?.loading && !childState?.loaded && (
        <div className="tree-hint" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
          加载中…
        </div>
      )}
    </>
  )
}

function OpenInOsIcon(): JSX.Element {
  // "Open externally" arrow — small upper-right out-of-box glyph. The same
  // visual idea browsers use for "open in new tab".
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M20 14v6H4V4h6" />
    </svg>
  )
}
