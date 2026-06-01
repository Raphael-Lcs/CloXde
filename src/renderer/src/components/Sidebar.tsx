import { useState } from 'react'
import type { Conversation, ConversationStatus, Project } from '@shared/types'
import { TwoClickButton } from './TwoClickButton'

interface SidebarProps {
  projects: Project[]
  conversationsByProject: Record<string, Conversation[]>
  archivedByProject: Record<string, Conversation[]>
  activeProjectId: string | null
  activeConversationId: string | null
  onSelectProject: (id: string) => void
  onSelectConversation: (id: string) => void
  onNewConversation: (projectId: string) => void
  onArchiveConversation: (id: string) => void
  onArchiveProject: (id: string) => void
  onOpenArchive: (projectId: string) => void
  onNewProject: () => void
  onOpenSettings: () => void
  versionLabel: string
  /** When true, show a simplified assistant-centric view with team status. */
  assistantMode?: boolean
}

export function Sidebar({
  projects,
  conversationsByProject,
  archivedByProject,
  activeProjectId,
  activeConversationId,
  onSelectProject,
  onSelectConversation,
  onNewConversation,
  onArchiveConversation,
  onArchiveProject,
  onOpenArchive,
  onNewProject,
  onOpenSettings,
  versionLabel,
  assistantMode = false
}: SidebarProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<ConversationStatus | 'all'>('all')

  const toggle = (id: string): void => {
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const q = query.trim().toLowerCase()
  const filterActive = q.length > 0 || statusFilter !== 'all'
  const filterConvs = (convs: Conversation[]): Conversation[] =>
    convs.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (q && !(c.title ?? c.id).toLowerCase().includes(q)) return false
      return true
    })
  const noMatches =
    filterActive &&
    projects.every((p) => filterConvs(conversationsByProject[p.id] ?? []).length === 0)

  return (
    <aside className="sidebar">
      <div className="section">
        <h3>{assistantMode ? '工作组' : '项目'}</h3>
        {!assistantMode && (
          <button className="sidebar-primary" onClick={onNewProject}>
            + 新建项目
          </button>
        )}
        {assistantMode && projects.length === 0 && (
          <div className="sidebar-hint">助理会自动创建工作组</div>
        )}
      </div>
      {projects.length > 0 && (
        <div className="sidebar-filter">
          <input
            className="sidebar-search"
            type="text"
            placeholder="搜索会话…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="sidebar-status-chips">
            {(
              [
                ['all', '全部'],
                ['awaiting-user', '等待'],
                ['thinking', '进行中'],
                ['idle', '空闲']
              ] as Array<[ConversationStatus | 'all', string]>
            ).map(([value, label]) => (
              <button
                key={value}
                className={`status-chip ${statusFilter === value ? 'active' : ''}`}
                onClick={() => setStatusFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="project-list">
        {projects.length === 0 && !assistantMode && (
          <div className="sidebar-empty">暂无项目</div>
        )}
        {noMatches && <div className="sidebar-empty">无匹配会话</div>}
        {projects.map((p) => {
          const isActive = p.id === activeProjectId
          const isCollapsed = filterActive ? false : collapsed.has(p.id) && !isActive
          const convs = filterConvs(conversationsByProject[p.id] ?? [])
          if (filterActive && convs.length === 0) return null
          const archivedCount = (archivedByProject[p.id] ?? []).length

          // Assistant mode: simplified team status view
          if (assistantMode) {
            // Priority: thinking > awaiting-user > paused > idle/ended
            const thinkingConv = convs.find(c => c.status === 'thinking')
            const awaitingConv = convs.find(c => c.status === 'awaiting-user')
            const pausedConv = convs.find(c => c.status === 'paused')

            let statusLabel: string
            let statusClass: string

            if (thinkingConv) {
              statusLabel = '工作中'
              statusClass = 'thinking'
            } else if (awaitingConv) {
              statusLabel = '等待输入'
              statusClass = 'awaiting-user'
            } else if (pausedConv) {
              statusLabel = '已暂停'
              statusClass = 'paused'
            } else if (convs.length > 0) {
              statusLabel = '空闲'
              statusClass = 'idle'
            } else {
              statusLabel = '无会话'
              statusClass = 'idle'
            }

            return (
              <div
                key={p.id}
                className={`team-status-item ${isActive ? 'active' : ''}`}
                onClick={() => onSelectProject(p.id)}
                title={`${p.name} - ${p.rootDir}`}
              >
                <span className={`team-status-dot ${statusClass}`} />
                <div className="team-status-meta">
                  <div className="team-name">{p.name}</div>
                  <div className="team-status">{statusLabel}</div>
                </div>
                {convs.length > 0 && (
                  <span className="team-conv-count">{convs.length}</span>
                )}
              </div>
            )
          }

          // Normal mode: full project tree
          return (
            <div key={p.id}>
              <div
                className={`project-item ${isActive ? 'active' : ''}`}
                onClick={() => onSelectProject(p.id)}
                title={p.rootDir}
              >
                <span
                  className="caret"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(p.id)
                  }}
                >
                  {isCollapsed ? '▶' : '▼'}
                </span>
                <div className="project-meta">
                  <div className="name">{p.name}</div>
                  <div className="path">{p.rootDir}</div>
                </div>
                <TwoClickButton
                  className="archive-btn project-archive-btn"
                  defaultLabel={<ArchiveIcon />}
                  confirmLabel={<span className="confirm-text">确认?</span>}
                  defaultTitle="归档项目（含全部会话）"
                  confirmTitle="再点一次确认归档整个项目"
                  onConfirm={() => onArchiveProject(p.id)}
                />
              </div>
              {!isCollapsed && (
                <div className="conv-tree">
                  <button
                    className="conv-new"
                    onClick={() => onNewConversation(p.id)}
                  >
                    + 新建协作会话
                  </button>
                  {convs.map((c) => (
                    <div
                      key={c.id}
                      className={`conv-tree-item ${c.id === activeConversationId ? 'active' : ''}`}
                      onClick={() => onSelectConversation(c.id)}
                    >
                      <span className={`dot ${c.status}`} />
                      <span className="title">
                        {c.title ?? `会话 ${c.id.slice(0, 6)}`}
                      </span>
                      <TwoClickButton
                        className="archive-btn"
                        defaultLabel={<ArchiveIcon />}
                        confirmLabel={<span className="confirm-text">确认?</span>}
                        defaultTitle="归档"
                        confirmTitle="再点一次确认归档"
                        onConfirm={() => onArchiveConversation(c.id)}
                      />
                    </div>
                  ))}

                  {archivedCount > 0 && (
                    <button
                      className="archived-link"
                      onClick={() => onOpenArchive(p.id)}
                      title="查看已归档会话"
                    >
                      <ArchiveIcon />
                      <span>已归档 {archivedCount}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="sidebar-footer">
        <button className="footer-btn" onClick={onOpenSettings}>
          <SettingsIcon />
          <span>设置</span>
        </button>
        {versionLabel && <span className="footer-version">{versionLabel}</span>}
      </div>
    </aside>
  )
}

function ArchiveIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="4" width="20" height="5" rx="1" />
      <path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9" />
      <line x1="10" y1="13" x2="14" y2="13" />
    </svg>
  )
}

function SettingsIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
