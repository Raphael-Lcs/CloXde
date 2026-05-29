import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentKind, Conversation, Project, Side, Task, TaskStatus } from '@shared/types'
import { Sidebar } from './components/Sidebar'
import { ConversationStream } from './components/ConversationStream'
import { Timeline } from './components/Timeline'
import { Composer } from './components/Composer'
import { SettingsDialog } from './components/SettingsDialog'
import { ArchivedDialog } from './components/ArchivedDialog'
import { NewConversationDialog } from './components/NewConversationDialog'
import { FileExplorer } from './components/FileExplorer'
import { TeamPanel } from './components/TeamPanel'
import { Logo } from './components/Logo'
import { TaskInspector } from './components/TaskInspector'
import { useConversation } from './hooks/useConversation'
import {
  usePresenceBanner,
  formatRelativeTs,
  presenceLabel
} from './hooks/usePresenceBanner'

export function App(): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([])
  const [conversationsByProject, setConversationsByProject] = useState<
    Record<string, Conversation[]>
  >({})
  const [archivedByProject, setArchivedByProject] = useState<
    Record<string, Conversation[]>
  >({})
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [archiveDialogProjectId, setArchiveDialogProjectId] = useState<string | null>(null)
  /** Which project (if any) currently has the "new conversation" dialog open. */
  const [newConvProjectId, setNewConvProjectId] = useState<string | null>(null)
  // Right-side drawer (mutually exclusive: only one of these is open at a
  // time, to keep horizontal real estate sane).
  const [rightPanel, setRightPanel] = useState<'files' | 'team' | null>(null)
  const fileExplorerOpen = rightPanel === 'files'
  const teamPanelOpen = rightPanel === 'team'
  const [showSystem, setShowSystem] = useState(true)
  const [taskInspectorOpen, setTaskInspectorOpen] = useState(false)

  const { view: conversation } = useConversation(activeConvId)
  // Cross-client awareness — banner appears when a paired tablet is also
  // touching this same conversation. Mirrors the tablet-side banner.
  const presence = usePresenceBanner(activeConvId)

  // --- Bootstrap ---------------------------------------------------------
  const refreshProjects = useCallback(async () => {
    const [active, archived] = await Promise.all([
      window.api.projects.list(),
      window.api.projects.listArchived()
    ])
    if (active.ok) setProjects(active.data)
    if (archived.ok) setArchivedProjects(archived.data)
  }, [])

  const refreshConversations = useCallback(async (projectId: string) => {
    const [active, archived] = await Promise.all([
      window.api.conversations.listByProject(projectId),
      window.api.conversations.listArchivedByProject(projectId)
    ])
    if (active.ok) {
      setConversationsByProject((curr) => ({ ...curr, [projectId]: active.data }))
    }
    if (archived.ok) {
      setArchivedByProject((curr) => ({ ...curr, [projectId]: archived.data }))
    }
  }, [])

  useEffect(() => {
    void refreshProjects()
    void window.api.app.getVersion().then((r) => {
      if (r.ok) setVersion(r.data)
    })
  }, [refreshProjects])

  useEffect(() => {
    const off = window.api.conversations.onUpdated((view) => {
      if (view.projectId === activeProjectId) {
        void refreshConversations(view.projectId)
      }
    })
    return off
  }, [activeProjectId, refreshConversations])

  // --- Project handlers --------------------------------------------------
  const handleOpenFolder = useCallback(async () => {
    const picked = await window.api.projects.pickDir()
    if (!picked.ok || !picked.data) return
    const created = await window.api.projects.create(picked.data)
    if (!created.ok) {
      window.alert(`创建项目失败：${created.error}`)
      return
    }
    await refreshProjects()
    setActiveProjectId(created.data.id)
    void refreshConversations(created.data.id)
  }, [refreshProjects, refreshConversations])

  const handleSelectProject = useCallback(
    async (id: string) => {
      setActiveProjectId(id)
      await window.api.projects.open(id)
      await refreshProjects()
      void refreshConversations(id)
    },
    [refreshProjects, refreshConversations]
  )

  const handleArchiveProject = useCallback(
    async (id: string) => {
      const res = await window.api.projects.archive(id)
      if (!res.ok) {
        window.alert(`归档项目失败：${res.error}`)
        return
      }
      // Refresh first so we can pick a sensible fallback active project
      // (the most recent remaining one). This keeps the workspace populated
      // — empty workspace breaks settings (project-scoped) and feels broken.
      const [active, archived] = await Promise.all([
        window.api.projects.list(),
        window.api.projects.listArchived()
      ])
      if (active.ok) setProjects(active.data)
      if (archived.ok) setArchivedProjects(archived.data)
      if (activeProjectId === id) {
        const remaining = active.ok ? active.data : []
        if (remaining.length > 0) {
          // Pick the next-best project (list is already ordered by
          // last_opened_at DESC) and open it as if the user clicked it.
          const next = remaining[0]
          setActiveProjectId(next.id)
          setActiveConvId(null)
          await window.api.projects.open(next.id)
          void refreshConversations(next.id)
        } else {
          // Truly nothing left — clear the workspace. Settings still works
          // because we relaxed the SettingsDialog mount gate below.
          setActiveProjectId(null)
          setActiveConvId(null)
        }
      }
    },
    [activeProjectId, refreshConversations]
  )

  const handleUnarchiveProject = useCallback(
    async (id: string) => {
      const res = await window.api.projects.unarchive(id)
      if (!res.ok) {
        window.alert(`恢复项目失败：${res.error}`)
        return
      }
      await refreshProjects()
      // Best-effort refresh of the just-revived project's conversation list
      // so the sidebar shows the cascaded-unarchived convs immediately.
      void refreshConversations(id)
    },
    [refreshProjects, refreshConversations]
  )

  const handleDeleteProject = useCallback(
    async (id: string) => {
      const res = await window.api.projects.delete(id)
      if (!res.ok) {
        window.alert(`删除项目失败：${res.error}`)
        return
      }
      if (activeProjectId === id) {
        setActiveProjectId(null)
        setActiveConvId(null)
      }
      await refreshProjects()
    },
    [activeProjectId, refreshProjects]
  )

  // --- Conversation handlers ---------------------------------------------
  /** Open the "新建协作会话" dialog (parent picker + summary preview). The
   *  actual conversation creation happens in handleConfirmNewConversation
   *  once the user submits the dialog. */
  const handleNewConversation = useCallback((projectId: string) => {
    setNewConvProjectId(projectId)
  }, [])

  const handleConfirmNewConversation = useCallback(
    async (
      projectId: string,
      input: {
        parentIds: string[]
        summaryOverride?: string
        pmKind?: AgentKind
      }
    ) => {
      const res = await window.api.conversations.create({
        projectId,
        parentIds: input.parentIds.length ? input.parentIds : undefined,
        summaryOverride: input.summaryOverride,
        pmKind: input.pmKind
      })
      if (!res.ok) {
        window.alert(`创建会话失败：${res.error}`)
        return
      }
      await refreshConversations(projectId)
      setActiveProjectId(projectId)
      setActiveConvId(res.data.id)
      setNewConvProjectId(null)
    },
    [refreshConversations]
  )

  // Deep-link routing. `cloxde://...` URLs are parsed by main and forwarded
  // here as one of three actions: open-project / open-conversation /
  // fork-conversation. We just translate them into existing handlers.
  useEffect(() => {
    const off = window.api.deeplink.on((link) => {
      switch (link.action) {
        case 'open-project':
          void handleSelectProject(link.projectId)
          break
        case 'open-conversation':
          void handleSelectProject(link.projectId).then(() => {
            setActiveConvId(link.conversationId)
          })
          break
        case 'fork-conversation':
          void handleSelectProject(link.projectId).then(() => {
            setNewConvProjectId(link.projectId)
            // Pre-checking the parent in the dialog needs API extension —
            // for now the user manually picks it after the dialog opens.
          })
          break
      }
    })
    return off
  }, [handleSelectProject])

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      const res = await window.api.conversations.delete(id)
      if (!res.ok) {
        window.alert(`删除会话失败：${res.error}`)
        return
      }
      if (activeConvId === id) setActiveConvId(null)
      if (activeProjectId) void refreshConversations(activeProjectId)
    },
    [activeConvId, activeProjectId, refreshConversations]
  )

  const handleArchiveConversation = useCallback(
    async (id: string) => {
      const res = await window.api.conversations.archive(id)
      if (!res.ok) {
        window.alert(`归档失败：${res.error}`)
        return
      }
      if (activeConvId === id) setActiveConvId(null)
      if (activeProjectId) void refreshConversations(activeProjectId)
    },
    [activeConvId, activeProjectId, refreshConversations]
  )

  const handleUnarchiveConversation = useCallback(
    async (id: string) => {
      const res = await window.api.conversations.unarchive(id)
      if (!res.ok) {
        window.alert(`恢复失败：${res.error}`)
        return
      }
      if (activeProjectId) void refreshConversations(activeProjectId)
    },
    [activeProjectId, refreshConversations]
  )

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConvId(id)
  }, [])

  // --- Composer actions --------------------------------------------------
  const handleSend = useCallback(
    async (
      text: string,
      target: Side,
      attachments?: { data: string; mimeType: string }[]
    ) => {
      if (!activeConvId) return
      const res = await window.api.conversations.sendUserMessage(
        activeConvId,
        text,
        target,
        attachments
      )
      if (!res.ok) window.alert(`发送失败：${res.error}`)
    },
    [activeConvId]
  )

  const handleCancel = useCallback(() => {
    if (activeConvId) void window.api.conversations.cancel(activeConvId)
  }, [activeConvId])

  const handleTogglePrimarySide = useCallback(() => {
    if (!conversation) return
    const next: Side = conversation.primarySide === 'architect' ? 'executor' : 'architect'
    void window.api.conversations.setPrimarySide(conversation.id, next)
  }, [conversation])

  const handleToggleAutopilot = useCallback(() => {
    if (!conversation) return
    void window.api.conversations.setAutopilot(conversation.id, !conversation.autopilot)
  }, [conversation])

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  )

  // Count only the system messages the stream would actually show — i.e.
  // strip the adapter-noise patterns the renderer hides unconditionally.
  // Keep in sync with NOISE_PATTERNS in ConversationStream.tsx.
  const NOISE_RE = useMemo(
    () =>
      /adapter stderr|Handled error during turn|Reconnecting\.{3}\s*\d+\/\d+|stream disconnected|windows sandbox:\s*spawn|codex_core::tools::router|codex_acp::thread|ResponseStreamDisconnected/i,
    []
  )
  const systemMessageCount = useMemo(() => {
    if (!conversation) return 0
    let n = 0
    for (const m of conversation.messages) {
      if (m.role !== 'system') continue
      const text = m.blocks
        .filter((b) => b.type === 'text')
        .map((b) => ('text' in b ? b.text : ''))
        .join('\n')
      if (NOISE_RE.test(text)) continue
      n += 1
    }
    return n
  }, [conversation, NOISE_RE])

  // Body grid columns:
  //   • base               280px sidebar | 1fr main
  //   • explorer open      + 320px explorer panel on the right
  // Body grid: sidebar | main | (optional right drawer 320px)
  const bodyClass =
    activeProject && rightPanel !== null
      ? 'body body-with-panel'
      : 'body'

  return (
    <div className="app">
      <div className={`titlebar platform-${window.api.platform}`}>
        <div className="brand">
          <Logo size={18} />
          <span>CloXde</span>
        </div>
        <div className="spacer" />
        {activeProject && conversation?.pm && (
          <button
            className={`titlebar-icon ${teamPanelOpen ? 'active' : ''}`}
            onClick={() => setRightPanel((p) => (p === 'team' ? null : 'team'))}
            title="工作组进程（架构师 + 执行者）"
            aria-label="工作组进程"
          >
            <TeamIcon />
          </button>
        )}
        {activeProject && (
          <button
            className={`titlebar-icon ${fileExplorerOpen ? 'active' : ''}`}
            onClick={() => setRightPanel((p) => (p === 'files' ? null : 'files'))}
            title="项目文件浏览器"
            aria-label="项目文件浏览器"
          >
            <FolderIcon />
          </button>
        )}
      </div>
      <div className={bodyClass}>
        <Sidebar
          projects={projects}
          conversationsByProject={conversationsByProject}
          archivedByProject={archivedByProject}
          activeProjectId={activeProjectId}
          activeConversationId={activeConvId}
          onSelectProject={(id) => void handleSelectProject(id)}
          onSelectConversation={handleSelectConversation}
          onNewConversation={(pid) => void handleNewConversation(pid)}
          onArchiveConversation={(id) => void handleArchiveConversation(id)}
          onArchiveProject={(id) => void handleArchiveProject(id)}
          onOpenArchive={(pid) => setArchiveDialogProjectId(pid)}
          onNewProject={() => void handleOpenFolder()}
          onOpenSettings={() => setSettingsOpen(true)}
          versionLabel={version ? `CloXde · v${version}` : ''}
        />
        <main className="main">
          {!activeProject ? (
            <EmptyHero onOpen={() => void handleOpenFolder()} />
          ) : !conversation ? (
            <EmptyProject
              project={activeProject}
              onNew={() => void handleNewConversation(activeProject.id)}
            />
          ) : (
            <>
              <div className="conv-pair-header">
                {conversation.pm ? (
                  <>
                    <span
                      className={`pair-agent side-pm ${conversation.busySide === 'pm' ? 'busy' : ''}`}
                    >
                      <span className="pair-dot" />
                      产品经理 · {conversation.pm.name}
                    </span>
                    <button
                      className={`pair-team-hint ${
                        conversation.busySide === 'architect' ||
                        conversation.busySide === 'executor'
                          ? 'busy'
                          : ''
                      }`}
                      onClick={() =>
                        setRightPanel((p) => (p === 'team' ? null : 'team'))
                      }
                      title="查看工作组进程"
                    >
                      <span className="pair-team-dot side-architect" />
                      <span className="pair-team-dot side-executor" />
                      <span>
                        工作组 · {conversation.architect.name} / {conversation.executor.name}
                      </span>
                    </button>
                  </>
                ) : (
                  <>
                    <span
                      className={`pair-agent side-architect ${conversation.busySide === 'architect' ? 'busy' : ''}`}
                    >
                      <span className="pair-dot" />
                      架构师 · {conversation.architect.name}
                    </span>
                    <span className="pair-divider">↔</span>
                    <span
                      className={`pair-agent side-executor ${conversation.busySide === 'executor' ? 'busy' : ''}`}
                    >
                      <span className="pair-dot" />
                      执行者 · {conversation.executor.name}
                    </span>
                  </>
                )}
                <span style={{ flex: 1 }} />
                {conversation.activeTask && (
                  <TaskStatePill
                    task={conversation.activeTask}
                    onClick={() => setTaskInspectorOpen((v) => !v)}
                    active={taskInspectorOpen}
                  />
                )}
                {conversation.parentIds && conversation.parentIds.length > 0 && (
                  <ParentChainHint
                    parentIds={conversation.parentIds}
                    activeConvs={conversationsByProject[activeProject!.id] ?? []}
                    archivedConvs={archivedByProject[activeProject!.id] ?? []}
                    onJump={(id) => setActiveConvId(id)}
                  />
                )}
              </div>
              <Timeline
                conversation={conversation}
                filterKinds={
                  conversation.pm ? ['architect', 'executor'] : ['user', 'architect', 'executor']
                }
                onStepClick={(messageId) => {
                  const el = document.querySelector(`[data-msg-id="${messageId}"]`)
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }}
              />
              {presence ? (
                <div className="presence-banner">
                  <span className="presence-dot" />
                  <span className="presence-text">
                    {presence.client.kind === 'tablet'
                      ? `${presence.client.label}`
                      : '另一端'}
                    {' · '}
                    {formatRelativeTs(presence.ts)} 在使用
                    {presenceLabel(presence.kind)}
                  </span>
                </div>
              ) : null}
              <ConversationStream
                messages={conversation.messages}
                showSystem={showSystem}
                threeAgent={!!conversation.pm}
              />
              <Composer
                status={conversation.status}
                primarySide={conversation.primarySide}
                threeAgent={!!conversation.pm}
                projectId={conversation.projectId}
                autopilot={conversation.autopilot}
                autoTurnsUsed={conversation.autoTurnsUsed}
                systemMessageCount={systemMessageCount}
                showSystem={showSystem}
                onSend={handleSend}
                onCancel={handleCancel}
                onTogglePrimarySide={handleTogglePrimarySide}
                onToggleAutopilot={handleToggleAutopilot}
                onToggleShowSystem={() => setShowSystem((v) => !v)}
              />
            </>
          )}
        </main>
        {activeProject && fileExplorerOpen && (
          <FileExplorer project={activeProject} />
        )}
        {activeProject && teamPanelOpen && conversation?.pm && (
          <TeamPanel conversation={conversation} />
        )}
      </div>

      <SettingsDialog
        project={activeProject}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        archivedProjects={archivedProjects}
        onUnarchiveProject={(id) => void handleUnarchiveProject(id)}
        onDeleteProject={(id) => void handleDeleteProject(id)}
      />
      {archiveDialogProjectId && (() => {
        const proj = projects.find((p) => p.id === archiveDialogProjectId)
        if (!proj) return null
        return (
          <ArchivedDialog
            project={proj}
            archived={archivedByProject[proj.id] ?? []}
            open={true}
            onClose={() => setArchiveDialogProjectId(null)}
            onUnarchive={(id) => void handleUnarchiveConversation(id)}
            onDelete={(id) => void handleDeleteConversation(id)}
          />
        )
      })()}
      {newConvProjectId && (() => {
        const proj = projects.find((p) => p.id === newConvProjectId)
        if (!proj) return null
        return (
          <NewConversationDialog
            project={proj}
            active={conversationsByProject[proj.id] ?? []}
            archived={archivedByProject[proj.id] ?? []}
            open={true}
            onClose={() => setNewConvProjectId(null)}
            onCreate={(input) =>
              handleConfirmNewConversation(proj.id, input)
            }
          />
        )
      })()}
      {conversation?.activeTask && (
        <TaskInspector
          task={conversation.activeTask}
          open={taskInspectorOpen}
          onClose={() => setTaskInspectorOpen(false)}
        />
      )}
    </div>
  )
}

function FolderIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.379a1.5 1.5 0 0 1 1.06.44l1.182 1.181a1.5 1.5 0 0 0 1.06.44H19.5A1.5 1.5 0 0 1 21 9.56v8.94A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5v-11z" />
    </svg>
  )
}

function TeamIcon(): JSX.Element {
  // Two stacked silhouettes — quick read as "a small team".
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M14.5 15.5h2.5a3.5 3.5 0 0 1 3.5 3.5V20" />
    </svg>
  )
}

function EmptyHero({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <div className="empty-hero">
      <h1>欢迎使用 CloXde</h1>
      <p>
        通过 ACP 协议让 Claude Code 与 Codex 互相协作。先打开一个文件夹作为项目即可开始。
      </p>
      <button className="primary" onClick={onOpen}>
        打开文件夹作为项目
      </button>
    </div>
  )
}

function EmptyProject({
  project,
  onNew
}: {
  project: Project
  onNew: () => void
}): JSX.Element {
  return (
    <div className="empty-hero">
      <h1>{project.name}</h1>
      <p style={{ color: 'var(--fg-dim)' }}>{project.rootDir}</p>
      <p>该项目还没有协作会话。</p>
      <button className="primary" onClick={onNew}>
        + 新建协作会话
      </button>
    </div>
  )
}

/**
 * Pill that appears at the right of conv-pair-header when the current
 * conversation declares parents. Lists each parent's title; clicking jumps
 * to that conversation. Helps the user trace where the inherited context
 * came from.
 */
function ParentChainHint({
  parentIds,
  activeConvs,
  archivedConvs,
  onJump
}: {
  parentIds: string[]
  activeConvs: Conversation[]
  archivedConvs: Conversation[]
  onJump: (id: string) => void
}): JSX.Element {
  const lookup = (id: string): Conversation | undefined => {
    return activeConvs.find((c) => c.id === id) ?? archivedConvs.find((c) => c.id === id)
  }
  return (
    <span className="parent-chain-hint" title="该会话继承自以下父会话">
      <span className="parent-chain-icon">↳</span>
      <span className="parent-chain-label">继承自</span>
      {parentIds.map((pid, i) => {
        const c = lookup(pid)
        const label = c?.title ?? `会话 ${pid.slice(0, 6)}`
        const isArchived = !!c && !!c.archivedAt
        const clickable = !!c && !isArchived
        return (
          <span key={pid}>
            {i > 0 && <span className="parent-chain-sep">·</span>}
            <button
              className={`parent-chain-item ${isArchived ? 'archived' : ''}`}
              onClick={() => clickable && onJump(pid)}
              disabled={!clickable}
              title={
                isArchived
                  ? '父会话已归档，先恢复才能跳转'
                  : c
                    ? '跳到这个父会话'
                    : '父会话已删除'
              }
            >
              {label}
            </button>
          </span>
        )
      })}
    </span>
  )
}

/**
 * Compact pill showing the active task's status. Click to open the
 * TaskInspector popover with full brief / plan / report. The colored dot
 * maps to which role currently owns the task.
 */
function TaskStatePill({
  task,
  onClick,
  active
}: {
  task: Task
  onClick: () => void
  active: boolean
}): JSX.Element {
  const label = STATUS_LABELS[task.status]
  return (
    <button
      type="button"
      className={`task-pill status-${task.status} owner-${task.owner} ${active ? 'active' : ''}`}
      title={`任务 ${task.id.slice(0, 6)} · ${label}\n负责人：${task.owner}\nbrief：${task.brief || '（未设置）'}\n（点击查看详情）`}
      onClick={onClick}
    >
      <span className={`task-pill-dot owner-${task.owner}`} />
      <span className="task-pill-label">{label}</span>
      <span className="task-pill-id">#{task.id.slice(0, 6)}</span>
    </button>
  )
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  briefing: 'PM 收集需求',
  planning: '架构师分析',
  executing: '执行者动手',
  review: '架构师审查',
  done: '已完成',
  failed: '失败'
}
