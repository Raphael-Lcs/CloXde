import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  AssistantActivity,
  AssistantMemory,
  AssistantMessageRecord,
  AssistantReport,
  MemoryKind,
  Project,
  Conversation,
  Task
} from '@shared/types'
import { isAssistantSoundEnabled, playAssistantChime } from '../lib/sound'

// The standalone assistant view: a direct chat with the user-scoped assistant
// (the layer above the team). The user talks to it here; it decides, delegates
// to teams, and reports back. Proactive reports from the review loop also land
// here, even when the user didn't just send anything.

interface AssistantPanelProps {
  /** Jump into a team conversation the assistant dispatched/continued, closing
   *  the panel. Wired to App's jumpToConversation. */
  onNavigate: (projectId: string, conversationId: string) => void
  /** All projects for displaying team status. */
  projects: Project[]
  /** Conversations by project for displaying team status. */
  conversationsByProject: Record<string, Conversation[]>
}

type ActiveConversation = Conversation & {
  busySide?: 'pm' | 'architect' | 'executor' | null
  activeTask?: Task
}

interface Entry {
  id: string
  role: 'user' | 'assistant' | 'system' | 'report'
  text: string
  /** Set on dispatch/continue/report rows so the entry can deep-link to the
   *  team that produced it. */
  projectId?: string
  conversationId?: string
  /** Image attachments sent with this message (user messages only). */
  attachments?: { dataUrl: string }[]
}

interface Attachment {
  id: string
  /** `data:image/png;base64,...` — direct src for <img>. */
  dataUrl: string
  /** Base64 without prefix — what ACP wants. */
  data: string
  mimeType: string
  /** Original byte size, for the "1.2 MB" hint. */
  sizeBytes: number
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 // 10 MB / image, hard cap

// The composer draft is mirrored here so an in-progress message survives a full
// renderer reload (HMR in dev, or any future cause) — not just a panel remount.
// Plain React state lives in module memory, which a page reload wipes; the chat
// thread re-hydrates from the DB but an unsent draft has nowhere else to live.
const DRAFT_STORAGE_KEY = 'cloxde.assistant.draft'

let entrySeq = 1
/** Monotonic local id for optimistic entries. DB-hydrated entries carry their
 *  uuid; this only needs to be unique within the session. */
function localId(): string {
  return `local-${entrySeq++}`
}

// The brain is a long-lived singleton in the main process, but the canonical
// chat thread now lives in the DB (it must survive an app restart, not just a
// panel remount). We keep a module-scope cache so a remount paints instantly,
// then re-hydrate from the DB on mount so the panel reflects anything that
// landed while it was closed (e.g. a proactive report).
let cachedEntries: Entry[] = []

function recordToEntry(r: AssistantMessageRecord): Entry {
  return {
    id: r.id,
    role: r.role,
    text: r.text,
    projectId: r.projectId,
    conversationId: r.conversationId
  }
}

export function AssistantPanel({ onNavigate, projects, conversationsByProject }: AssistantPanelProps): JSX.Element {
  const [entries, setEntries] = useState<Entry[]>(cachedEntries)
  const [draft, setDraft] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_STORAGE_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [sending, setSending] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  // Live turn status: the latest activity line from the brain + when the turn
  // started, so we can show "💭 …（12s）" instead of a dead spinner.
  const [liveStatus, setLiveStatus] = useState<string>('')
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  // The brain's reasoning, ACCUMULATED across the turn's thought chunks (not
  // overwritten — overwriting made the status line flicker through fragments
  // like a slideshow). Default-collapsed: the live line just says "思考中…";
  // the user expands to read the running thought stream if they want.
  const [thoughtLog, setThoughtLog] = useState('')
  const [thoughtOpen, setThoughtOpen] = useState(false)
  // Memory drawer: the assistant's long-term memory, browsable so the user can
  // see what it remembers and pin/forget entries.
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [memories, setMemories] = useState<AssistantMemory[]>([])
  const [memoryLoading, setMemoryLoading] = useState(false)
  // Manual add-memory form (inside the drawer).
  const [addOpen, setAddOpen] = useState(false)
  const [addKind, setAddKind] = useState<MemoryKind>('fact')
  const [addText, setAddText] = useState('')
  // Inline two-step delete confirm, keyed by memory id. window.confirm() doesn't
  // reliably surface a dialog in this Electron renderer (it silently returns
  // false), which made the 忘记 button look dead — so we confirm in-UI instead.
  const [confirmForget, setConfirmForget] = useState<string | null>(null)
  // Persona drawer (SOUL.md): the user-editable character/tone/boundaries the
  // brain reads each turn. Background facility, opened on demand via /persona.
  const [soulOpen, setSoulOpen] = useState(false)
  const [soulText, setSoulText] = useState('')
  const [soulLoading, setSoulLoading] = useState(false)
  const [soulSaving, setSoulSaving] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const attachIdRef = useRef(0)
  const thoughtLogRef = useRef<HTMLDivElement>(null)

  // Active teams: only show projects with conversations that are actively working
  // (thinking or awaiting-user), not idle/ended ones.
  const activeTeams = projects
    .map((p) => {
      const convs = conversationsByProject[p.id] ?? []
      const activeConv = convs.find(
        (c) => c.status === 'thinking' || c.status === 'awaiting-user'
      )
      if (!activeConv) return null
      return { project: p, conversation: activeConv }
    })
    .filter((t): t is NonNullable<typeof t> => t !== null)

  const append = useCallback(
    (
      role: Entry['role'],
      text: string,
      nav?: { projectId?: string; conversationId?: string; attachments?: { dataUrl: string }[] }
    ) => {
      setEntries((curr) => {
        const next = [
          ...curr,
          {
            id: localId(),
            role,
            text,
            projectId: nav?.projectId,
            conversationId: nav?.conversationId,
            attachments: nav?.attachments
          }
        ]
        cachedEntries = next
        return next
      })
    },
    []
  )

  // Hydrate the thread from the DB — authoritative source that survives a
  // restart. Called on mount and after /new, so the panel reflects exactly
  // what's persisted (incl. reports that arrived while it was closed).
  const loadThread = useCallback(async () => {
    if (!window.api.assistant?.listMessages) return
    const res = await window.api.assistant.listMessages(500)
    if (!res.ok) return
    const next = res.data.map(recordToEntry)
    cachedEntries = next
    setEntries(next)
  }, [])

  useEffect(() => {
    void loadThread()
  }, [loadThread])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  // Proactive reports (review loop) arrive unsolicited. Guard against an older
  // preload that predates the assistant API (e.g. an app instance still running
  // from before this layer shipped): a missing api should degrade gracefully,
  // not blank the whole view via a thrown effect.
  useEffect(() => {
    if (!window.api.assistant) {
      append('system', '助理接口尚未就绪——请完全退出并重启应用（HMR 不会重载 preload/主进程）。')
      return
    }
    const off = window.api.assistant.onReport((report: AssistantReport) => {
      append('report', report.message, {
        projectId: report.projectId,
        conversationId: report.conversationId
      })
      if (isAssistantSoundEnabled()) playAssistantChime()
    })
    return off
  }, [append])

  // Live turn progress — proves the brain is actually working (thinking / using
  // a tool / blocked) instead of leaving a dead "thinking…" spinner.
  useEffect(() => {
    if (!window.api.assistant?.onActivity) return
    const off = window.api.assistant.onActivity((a: AssistantActivity) => {
      switch (a.phase) {
        case 'start':
          setTurnStartedAt(Date.now())
          setLiveStatus('思考中…')
          setThoughtLog('')
          break
        case 'thought':
          // Accumulate the reasoning stream; keep the collapsed line stable at
          // "思考中…" so it stops strobing through fragments. The full text is
          // available on expand.
          setThoughtLog((prev) => prev + a.text)
          setLiveStatus('思考中…')
          break
        case 'tool':
          setLiveStatus(`🔧 ${oneLine(a.text)}`)
          break
        case 'blocked':
          setLiveStatus(`⛔ ${oneLine(a.text)}`)
          break
        case 'done':
        case 'error':
          setTurnStartedAt(null)
          setLiveStatus('')
          setThoughtLog('')
          setThoughtOpen(false)
          break
      }
    })
    return off
  }, [])

  // Tick the elapsed-seconds counter while a turn is in flight.
  useEffect(() => {
    if (turnStartedAt == null) {
      setElapsed(0)
      return
    }
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - turnStartedAt) / 1000)), 500)
    return () => clearInterval(id)
  }, [turnStartedAt])

  // Keep the expanded thought stream pinned to its tail as chunks append.
  useEffect(() => {
    if (!thoughtOpen) return
    const el = thoughtLogRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thoughtLog, thoughtOpen])

  // Mirror the draft to localStorage so a reload doesn't lose an unsent message.
  // Every clear path goes through setDraft(''), which removes the key here.
  useEffect(() => {
    try {
      if (draft) localStorage.setItem(DRAFT_STORAGE_KEY, draft)
      else localStorage.removeItem(DRAFT_STORAGE_KEY)
    } catch {
      /* storage disabled/full — draft persistence is best-effort */
    }
  }, [draft])

  const cancel = useCallback(() => {
    void window.api.assistant?.cancel()
  }, [])

  const loadMemories = useCallback(async () => {
    if (!window.api.assistant?.listMemories) return
    setMemoryLoading(true)
    try {
      const res = await window.api.assistant.listMemories(200)
      if (res.ok) setMemories(res.data)
    } finally {
      setMemoryLoading(false)
    }
  }, [])

  // Open the memory drawer on demand (via the /memory command). Memory is a
  // background facility — the assistant just remembers, like a person would, so
  // it's not surfaced as a permanent header button; you open it deliberately
  // only when you want to peek.
  const openMemoryDrawer = useCallback(() => {
    setMemoryOpen(true)
    void loadMemories()
  }, [loadMemories])

  // Open the persona editor on demand (via /persona). Loads the current SOUL.md
  // so edits round-trip; like memory, it's not a permanent header button.
  const openPersonaDrawer = useCallback(async () => {
    setSoulOpen(true)
    if (!window.api.assistant?.getSoul) return
    setSoulLoading(true)
    try {
      const res = await window.api.assistant.getSoul()
      if (res.ok) setSoulText(res.data)
    } finally {
      setSoulLoading(false)
    }
  }, [])

  const savePersona = useCallback(async () => {
    if (!window.api.assistant?.setSoul) return
    setSoulSaving(true)
    try {
      const res = await window.api.assistant.setSoul(soulText)
      if (res.ok) {
        setSoulOpen(false)
        append('system', '已更新助理人格，下一轮起生效。')
      } else {
        window.alert(`保存失败：${res.error}`)
      }
    } finally {
      setSoulSaving(false)
    }
  }, [soulText, append])

  const pinMemory = useCallback(
    async (m: AssistantMemory) => {
      if (!window.api.assistant?.pinMemory) return
      const res = await window.api.assistant.pinMemory(m.id, !m.pinned)
      if (res.ok) {
        setMemories((curr) =>
          curr.map((x) => (x.id === m.id ? { ...x, pinned: !m.pinned } : x))
        )
      }
    },
    []
  )

  // Two-step forget: first click arms the confirm, second click deletes. No
  // window.confirm — it doesn't render reliably here, which is what made the
  // button feel broken.
  const forgetMemory = useCallback(async (m: AssistantMemory) => {
    if (!window.api.assistant?.forgetMemory) return
    const res = await window.api.assistant.forgetMemory(m.id)
    if (res.ok) setMemories((curr) => curr.filter((x) => x.id !== m.id))
    setConfirmForget(null)
  }, [])

  const submitAddMemory = useCallback(async () => {
    const content = addText.trim()
    if (!content || !window.api.assistant?.addMemory) return
    const res = await window.api.assistant.addMemory(addKind, content)
    if (res.ok) {
      setAddText('')
      setAddOpen(false)
      // The new memory is pinned + full-confidence; surface it at the top.
      setMemories((curr) => [res.data, ...curr.filter((m) => m.id !== res.data.id)])
    } else {
      window.alert(`添加失败：${res.error}`)
    }
  }, [addText, addKind])

  const addBlob = useCallback(async (blob: Blob) => {
    if (!blob.type.startsWith('image/')) return
    if (blob.size > MAX_ATTACHMENT_BYTES) {
      window.alert(`图片太大（${(blob.size / 1024 / 1024).toFixed(1)} MB），上限 10 MB。`)
      return
    }
    try {
      const dataUrl = await readAsDataURL(blob)
      const data = dataUrl.split(',', 2)[1] ?? ''
      setAttachments((prev) => [
        ...prev,
        {
          id: `att-${attachIdRef.current++}`,
          dataUrl,
          data,
          mimeType: blob.type,
          sizeBytes: blob.size
        }
      ])
    } catch {
      // skip unreadable blob
    }
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text && attachments.length === 0) return
    if (sending) return
    if (!window.api.assistant) {
      append('system', '助理接口尚未就绪——请完全退出并重启应用。')
      return
    }

    // /memory — peek at what the assistant remembers. Deliberately a command,
    // not a permanent button: memory lives in the background, you only open it
    // when you actually want to look.
    if (text === '/memory') {
      setDraft('')
      openMemoryDrawer()
      return
    }

    // /persona — edit the assistant's character/tone/boundaries (SOUL.md). Like
    // /memory, a deliberate command rather than always-visible chrome.
    if (text === '/persona' || text === '/soul') {
      setDraft('')
      void openPersonaDrawer()
      return
    }

    // /new — explicit session reset. The brain keeps one session across mode
    // toggles; this is the only way to start over.
    if (text === '/new') {
      setDraft('')
      setAttachments([])
      const res = await window.api.assistant.resetSession()
      cachedEntries = []
      setEntries([])
      if (res.ok) {
        append('system', '已开启新会话——助理已忘记之前的上下文。')
      } else {
        append('system', `重置失败：${res.error}`)
      }
      return
    }

    setDraft('')
    const pending = attachments.map(({ data, mimeType }) => ({ data, mimeType }))
    const attachmentsForDisplay = attachments.map(({ dataUrl }) => ({ dataUrl }))
    setAttachments([])
    append('user', text, { attachments: attachmentsForDisplay })
    setSending(true)
    try {
      const res = await window.api.assistant.sendMessage(text, pending)
      if (!res.ok) {
        append('system', `出错：${res.error}`)
        return
      }
      const turn = res.data
      // Reports are already appended via the onReport listener (which fires as
      // the brain emits them). turn.reports is just a summary for logging/UI
      // badges; appending them here would duplicate every message. Fall back to
      // raw only if the brain produced output but emitted no tagged reports.
      if (turn.reports.length === 0 && turn.raw) {
        append('assistant', turn.raw)
        if (isAssistantSoundEnabled()) playAssistantChime()
      }
      for (const d of turn.dispatched) {
        append('system', `已为「${d.name}」创建项目并派出团队开始工作。`, {
          projectId: d.projectId,
          conversationId: d.conversationId
        })
      }
      for (const c of turn.continued) {
        append('system', `已向「${c.name}」团队追加了新指示。`, {
          projectId: c.projectId,
          conversationId: c.conversationId
        })
      }
      if (turn.remembered > 0) {
        append('system', `记下了 ${turn.remembered} 条记忆。`)
      }
      if (turn.forgotten > 0) {
        append('system', `撤回了 ${turn.forgotten} 条过时记忆。`)
      }
      if (turn.updated > 0) {
        append('system', `改进了 ${turn.updated} 条已有记忆/技能。`)
      }
      if (turn.scheduled > 0) {
        append('system', `设了 ${turn.scheduled} 个提醒，到点我会自己回来处理。`)
      }
      // Never leave the user staring at silence: if this turn produced no
      // visible output at all (no prose, no report, no dispatch), say so
      // explicitly instead of looking hung.
      const producedSomething =
        (turn.reports.length === 0 && turn.raw) ||
        turn.reports.length > 0 ||
        turn.dispatched.length > 0 ||
        turn.continued.length > 0 ||
        turn.remembered > 0 ||
        turn.forgotten > 0 ||
        turn.updated > 0 ||
        turn.scheduled > 0
      if (!producedSomething) {
        append('system', '助理这一轮没有给出可见回应（可能在内部用工具忙活）。可以再说一句或换个说法。')
      }
    } catch (e) {
      append('system', `出错：${(e as Error).message}`)
    } finally {
      setSending(false)
    }
  }, [draft, attachments, sending, append, openMemoryDrawer, openPersonaDrawer])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void send()
      }
    },
    [send]
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      let consumed = false
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const blob = item.getAsFile()
          if (blob) {
            consumed = true
            void addBlob(blob)
          }
        }
      }
      if (consumed) e.preventDefault()
    },
    [addBlob]
  )

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragOver(false)
      const files = e.dataTransfer?.files
      if (!files) return
      for (const f of files) {
        if (f.type.startsWith('image/')) void addBlob(f)
      }
    },
    [addBlob]
  )

  return (
    <div className="assistant-panel">
      <div className="assistant-head">
        <strong>助理</strong>
        <span className="assistant-sub">
          你的私人助理 · 会判断该做什么、创建项目并指挥团队，再向你回报
        </span>
      </div>
      {memoryOpen && (
        <div className="assistant-memory-drawer">
          <div className="assistant-memory-drawer-head">
            <strong>长期记忆</strong>
            <span className="assistant-memory-count">
              {memoryLoading ? '加载中…' : `${memories.length} 条`}
            </span>
            <button onClick={() => setAddOpen((v) => !v)} title="手动添加一条记忆">
              {addOpen ? '取消' : '+ 添加'}
            </button>
            <button onClick={() => void loadMemories()} title="刷新" disabled={memoryLoading}>
              刷新
            </button>
            <button onClick={() => setMemoryOpen(false)} title="收起记忆">
              关闭
            </button>
          </div>
          {addOpen && (
            <div className="assistant-memory-add">
              <select
                value={addKind}
                onChange={(e) => setAddKind(e.target.value as MemoryKind)}
              >
                <option value="preference">偏好</option>
                <option value="fact">事实</option>
                <option value="project">项目</option>
                <option value="person">人物</option>
                <option value="pattern">习惯</option>
                <option value="episodic">事件</option>
                <option value="skill">技能</option>
              </select>
              <input
                type="text"
                value={addText}
                placeholder="让助理记住的一句话…"
                onChange={(e) => setAddText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitAddMemory()
                }}
              />
              <button className="primary" onClick={() => void submitAddMemory()} disabled={!addText.trim()}>
                记住
              </button>
            </div>
          )}
          <div className="assistant-memory-list">
            {memories.length === 0 && !memoryLoading ? (
              <div className="assistant-memory-empty">助理还没有记住任何东西。</div>
            ) : (
              memories.map((m) => (
                <div key={m.id} className={`assistant-memory-item${m.pinned ? ' pinned' : ''}`}>
                  <div className="assistant-memory-item-top">
                    <span className="assistant-memory-kind">{memoryKindLabel(m.kind)}</span>
                    <span className="assistant-memory-conf" title="助理对这条记忆的信心">
                      {Math.round(m.confidence * 100)}%
                    </span>
                    <span className="assistant-memory-actions">
                      <button
                        onClick={() => void pinMemory(m)}
                        title={m.pinned ? '取消固定（可被自动遗忘）' : '固定（永不自动遗忘）'}
                      >
                        {m.pinned ? '📌 已固定' : '固定'}
                      </button>
                      {confirmForget === m.id ? (
                        <>
                          <button
                            className="danger"
                            onClick={() => void forgetMemory(m)}
                            title="确认永久删除"
                          >
                            确认忘记
                          </button>
                          <button onClick={() => setConfirmForget(null)} title="取消">
                            取消
                          </button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmForget(m.id)} title="永久删除这条记忆">
                          忘记
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="assistant-memory-content">{m.content}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      {soulOpen && (
        <div className="assistant-memory-drawer">
          <div className="assistant-memory-drawer-head">
            <strong>助理人格</strong>
            <span className="assistant-memory-count">
              {soulLoading ? '加载中…' : '性格 · 语气 · 边界'}
            </span>
            <button
              className="primary"
              onClick={() => void savePersona()}
              disabled={soulSaving || soulLoading}
              title="保存，下一轮起生效"
            >
              {soulSaving ? '保存中…' : '保存'}
            </button>
            <button onClick={() => setSoulOpen(false)} title="收起">
              关闭
            </button>
          </div>
          <div className="assistant-persona-body">
            <textarea
              className="assistant-persona-text"
              value={soulText}
              disabled={soulLoading}
              placeholder={
                '为助理设定性格、语气和边界，例如：\n- 说话简短直接，别绕弯子\n- 遇到拿不准的事先问我再动手\n- 用轻松的口吻，但别用表情符号\n\n留空则使用默认风格。'
              }
              onChange={(e) => setSoulText(e.target.value)}
            />
          </div>
        </div>
      )}
      {/* Active teams status - minimal status bar style */}
      {activeTeams.length > 0 && (
        <div className="assistant-status-bar">
          {activeTeams.map(({ project, conversation }) => {
            const isThinking = conversation.status === 'thinking'
            const statusText = isThinking ? '工作中' : '等待输入'
            const statusIcon = isThinking ? '⚙️' : '⏸️'

            return (
              <div
                key={project.id}
                className="status-bar-item"
                onClick={() => onNavigate(project.id, conversation.id)}
                title={`${project.name} - ${statusText}\n点击查看详情`}
              >
                <span className="status-bar-icon">{statusIcon}</span>
                <span className="status-bar-name">{project.name}</span>
                <span className={`status-bar-pulse ${isThinking ? 'active' : ''}`} />
              </div>
            )
          })}
        </div>
      )}
      <div className="assistant-stream" ref={scrollRef}>
        <div className="assistant-stream-inner">
        {entries.length === 0 ? (
          <div className="assistant-empty">
            <div className="assistant-welcome-title">👋 你好，我是你的助理</div>
            <div className="assistant-welcome-text">
              我负责理解你的需求、做决策，然后把具体工作派给专业团队。
              <br />
              你只需要告诉我想做什么，我会处理剩下的一切。
            </div>
            <div className="assistant-welcome-tips">
              <div className="tip-title">💡 快速开始：</div>
              <div className="tip-item">• 直接说出你的需求，比如"帮我优化这个项目的性能"</div>
              <div className="tip-item">• 输入 <code>/new</code> 开启全新会话</div>
              <div className="tip-item">• 输入 <code>/memory</code> 查看我记住的事情</div>
              <div className="tip-item">• 输入 <code>/persona</code> 调整我的性格和行为</div>
            </div>
          </div>
        ) : (
          entries.map((e) => {
            const canNav = !!e.conversationId && !!e.projectId
            const useMarkdown = e.role === 'assistant' || e.role === 'report'
            return (
              <div
                key={e.id}
                className={`assistant-msg role-${e.role}${canNav ? ' navigable' : ''}${useMarkdown ? ' md' : ''}`}
                onClick={canNav ? () => onNavigate(e.projectId!, e.conversationId!) : undefined}
                title={canNav ? '点击查看这个团队' : undefined}
              >
                {useMarkdown ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{e.text}</ReactMarkdown>
                ) : (
                  e.text
                )}
                {e.attachments && e.attachments.length > 0 && (
                  <div className="assistant-msg-attachments">
                    {e.attachments.map((att, i) => (
                      <img key={i} src={att.dataUrl} alt="" className="assistant-msg-attachment-thumb" />
                    ))}
                  </div>
                )}
                {canNav && <span className="assistant-msg-jump">↗ 打开团队</span>}
              </div>
            )
          })
        )}
        {sending && (
          <>
            <div className="assistant-live">
              <span className="assistant-live-dot" />
              <span
                className={`assistant-live-text${thoughtLog ? ' has-thought' : ''}`}
                onClick={thoughtLog ? () => setThoughtOpen((v) => !v) : undefined}
                title={thoughtLog ? '展开/收起思考过程' : undefined}
              >
                {thoughtLog ? (thoughtOpen ? '▾ ' : '▸ ') : ''}
                {liveStatus || '助理思考中…'}
                {turnStartedAt != null && elapsed > 0 ? `（${elapsed}s）` : ''}
              </span>
              <button className="assistant-live-cancel" onClick={cancel} title="打断这一轮">
                打断
              </button>
            </div>
            {thoughtOpen && thoughtLog && (
              <div className="assistant-thought-log" ref={thoughtLogRef}>
                {thoughtLog}
              </div>
            )}
          </>
        )}
        </div>
      </div>
      <div
        className={`assistant-composer ${dragOver ? 'drag-over' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer?.types.includes('Files')) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {attachments.length > 0 && (
          <div className="assistant-attachments">
            {attachments.map((a) => (
              <div key={a.id} className="assistant-attachment">
                <img src={a.dataUrl} alt="" />
                <button
                  className="assistant-attachment-remove"
                  onClick={() => removeAttachment(a.id)}
                  title="移除"
                >
                  ×
                </button>
                <span className="assistant-attachment-size">{formatBytes(a.sizeBytes)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="assistant-composer-row">
          <textarea
            value={draft}
            placeholder="对助理说…（Enter 发送，Shift+Enter 换行 · 可粘贴/拖入图片 · /new 新会话 · /memory 看记忆 · /persona 调性格）"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={2}
          />
          <button
            className="primary"
            onClick={() => void send()}
            disabled={sending || (!draft.trim() && attachments.length === 0)}
          >
            发送
          </button>
        </div>
        {dragOver && <div className="assistant-drag-hint">松开以附加图片</div>}
      </div>
    </div>
  )
}

function readAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Collapse a streamed chunk to a single trimmed line for the status strip. */
function oneLine(s: string | undefined): string {
  if (!s) return ''
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

/** Human-readable Chinese label for a memory kind. */
function memoryKindLabel(kind: MemoryKind): string {
  switch (kind) {
    case 'preference':
      return '偏好'
    case 'fact':
      return '事实'
    case 'project':
      return '项目'
    case 'person':
      return '人物'
    case 'pattern':
      return '习惯'
    case 'episodic':
      return '事件'
    case 'skill':
      return '技能'
    default:
      return kind
  }
}
