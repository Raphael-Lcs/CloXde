import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistantReport } from '@shared/types'

// The standalone assistant view: a direct chat with the user-scoped assistant
// (the layer above the team). The user talks to it here; it decides, delegates
// to teams, and reports back. Proactive reports from the review loop also land
// here, even when the user didn't just send anything.

interface Entry {
  id: number
  role: 'user' | 'assistant' | 'system'
  text: string
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

let nextId = 1

// The brain is a long-lived singleton in the main process — one ACP session
// that survives the panel mounting/unmounting (e.g. toggling assistant mode).
// The chat history must persist the same way, so we hold it at module scope
// instead of in component state, which would reset on every remount and make it
// look like a brand-new session. An explicit /new is the only thing that clears
// it (and resets the session).
let savedEntries: Entry[] = []

export function AssistantPanel(): JSX.Element {
  const [entries, setEntries] = useState<Entry[]>(savedEntries)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [sending, setSending] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const attachIdRef = useRef(0)

  const append = useCallback((role: Entry['role'], text: string) => {
    setEntries((curr) => {
      const next = [...curr, { id: nextId++, role, text }]
      savedEntries = next
      return next
    })
  }, [])

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
      append('assistant', report.message)
    })
    return off
  }, [append])

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
      savedEntries = []
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
        append('system', `已为「${d.name}」创建项目并派出团队开始工作。`)
      }
      if (turn.remembered > 0) {
        append('system', `记下了 ${turn.remembered} 条记忆。`)
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
      </div>
      <div className="assistant-stream" ref={scrollRef}>
        {entries.length === 0 ? (
          <div className="assistant-empty">
            和助理说点什么吧。它不会自己写代码——它会判断、决定，然后把活派给团队。
            <br />
            输入 /new 可开启全新会话。
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className={`assistant-msg role-${e.role}`}>
              {e.text}
            </div>
          ))
        )}
        {sending && <div className="assistant-msg role-system">助理思考中…</div>}
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
