import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AssistantActivity,
  AssistantMemory,
  AssistantMessageRecord,
  AssistantReport,
  MemoryKind
} from '@shared/types'

// The standalone assistant view: a direct chat with the user-scoped assistant
// (the layer above the team). The user talks to it here; it decides, delegates
// to teams, and reports back. Proactive reports from the review loop also land
// here, even when the user didn't just send anything.

interface AssistantPanelProps {
  /** Jump into a team conversation the assistant dispatched/continued, closing
   *  the panel. Wired to App's jumpToConversation. */
  onNavigate: (projectId: string, conversationId: string) => void
}

interface Entry {
  id: string
  role: 'user' | 'assistant' | 'system' | 'report'
  text: string
  /** Set on dispatch/continue/report rows so the entry can deep-link to the
   *  team that produced it. */
  projectId?: string
  conversationId?: string
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

export function AssistantPanel({ onNavigate }: AssistantPanelProps): JSX.Element {
  const [entries, setEntries] = useState<Entry[]>(cachedEntries)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [sending, setSending] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  // Live turn status: the latest activity line from the brain + when the turn
  // started, so we can show "💭 …（12s）" instead of a dead spinner.
  const [liveStatus, setLiveStatus] = useState<string>('')
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  // Memory drawer: the assistant's long-term memory, browsable so the user can
  // see what it remembers and pin/forget entries.
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [memories, setMemories] = useState<AssistantMemory[]>([])
  const [memoryLoading, setMemoryLoading] = useState(false)
  // Manual add-memory form (inside the drawer).
  const [addOpen, setAddOpen] = useState(false)
  const [addKind, setAddKind] = useState<MemoryKind>('fact')
  const [addText, setAddText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const attachIdRef = useRef(0)

  const append = useCallback(
    (role: Entry['role'], text: string, nav?: { projectId?: string; conversationId?: string }) => {
      setEntries((curr) => {
        const next = [
          ...curr,
          { id: localId(), role, text, projectId: nav?.projectId, conversationId: nav?.conversationId }
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
          break
        case 'thought':
          setLiveStatus(`💭 ${oneLine(a.text)}`)
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

  const toggleMemoryDrawer = useCallback(() => {
    setMemoryOpen((open) => {
      const next = !open
      if (next) void loadMemories()
      return next
    })
  }, [loadMemories])

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

  const forgetMemory = useCallback(async (m: AssistantMemory) => {
    if (!window.api.assistant?.forgetMemory) return
    if (!window.confirm(`确定让助理忘记这条记忆吗？\n\n${m.content}`)) return
    const res = await window.api.assistant.forgetMemory(m.id)
    if (res.ok) setMemories((curr) => curr.filter((x) => x.id !== m.id))
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
    setAttachments([])
    append('user', text)
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
      }
      for (const d of turn.dispatched) {
        append('system', `已为「${d.name}」创建项目并派出团队开始工作。`, {
          projectId: d.projectId,
          conversationId: d.conversationId
        })
      }
      for (const c of turn.continued) {
        append('system', `已向「${c.name}」团队追加了新指示。`, {
          conversationId: c.conversationId
        })
      }
      if (turn.remembered > 0) {
        append('system', `记下了 ${turn.remembered} 条记忆。`)
      }
      // Never leave the user staring at silence: if this turn produced no
      // visible output at all (no prose, no report, no dispatch), say so
      // explicitly instead of looking hung.
      const producedSomething =
        (turn.reports.length === 0 && turn.raw) ||
        turn.reports.length > 0 ||
        turn.dispatched.length > 0 ||
        turn.continued.length > 0 ||
        turn.remembered > 0
      if (!producedSomething) {
        append('system', '助理这一轮没有给出可见回应（可能在内部用工具忙活）。可以再说一句或换个说法。')
      }
    } catch (e) {
      append('system', `出错：${(e as Error).message}`)
    } finally {
      setSending(false)
    }
  }, [draft, attachments, sending, append])

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
        <button
          className="assistant-memory-toggle"
          onClick={toggleMemoryDrawer}
          title="查看助理记住的东西"
        >
          {memoryOpen ? '关闭记忆' : '记忆'}
        </button>
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
                      <button onClick={() => void forgetMemory(m)} title="永久删除这条记忆">
                        忘记
                      </button>
                    </span>
                  </div>
                  <div className="assistant-memory-content">{m.content}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <div className="assistant-stream" ref={scrollRef}>
        {entries.length === 0 ? (
          <div className="assistant-empty">
            和助理说点什么吧。它不会自己写代码——它会判断、决定，然后把活派给团队。
            <br />
            输入 /new 可开启全新会话。
          </div>
        ) : (
          entries.map((e) => {
            const canNav = !!e.conversationId && !!e.projectId
            return (
              <div
                key={e.id}
                className={`assistant-msg role-${e.role}${canNav ? ' navigable' : ''}`}
                onClick={canNav ? () => onNavigate(e.projectId!, e.conversationId!) : undefined}
                title={canNav ? '点击查看这个团队' : undefined}
              >
                {e.text}
                {canNav && <span className="assistant-msg-jump">↗ 打开团队</span>}
              </div>
            )
          })
        )}
        {sending && (
          <div className="assistant-live">
            <span className="assistant-live-dot" />
            <span className="assistant-live-text">
              {liveStatus || '助理思考中…'}
              {turnStartedAt != null && elapsed > 0 ? `（${elapsed}s）` : ''}
            </span>
            <button className="assistant-live-cancel" onClick={cancel} title="打断这一轮">
              打断
            </button>
          </div>
        )}
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
            placeholder="对助理说…（Enter 发送，Shift+Enter 换行 · 可粘贴/拖入图片 · /new 新会话）"
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
    default:
      return kind
  }
}
