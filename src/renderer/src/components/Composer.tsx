import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationStatus, Side } from '@shared/types'

interface ComposerProps {
  status: ConversationStatus
  primarySide: Side
  threeAgent: boolean
  /** Project the conversation belongs to — backs @file autocomplete. */
  projectId?: string
  autopilot: boolean
  autoTurnsUsed: number
  maxAutoTurns: number
  systemMessageCount: number
  showSystem: boolean
  onSend: (
    text: string,
    target: Side,
    attachments?: { data: string; mimeType: string }[]
  ) => Promise<void>
  onCancel: () => void
  onTogglePrimarySide: () => void
  onToggleAutopilot: () => void
  onToggleShowSystem: () => void
}

/** Local-only attachment representation. `dataUrl` is what we render in the
 *  thumbnail strip; `data` (no prefix) is what we ship to the engine. */
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

/**
 * Bottom-of-page input bar. User input always preempts the running side, so we
 * also surface a Cancel button for explicit early stop without typing.
 *
 * Image input: paste from clipboard or drag-drop onto the textarea/strip.
 * Each attachment shows as a thumbnail above the textarea with a × to remove.
 */
export function Composer({
  status,
  primarySide,
  threeAgent,
  projectId,
  autopilot,
  autoTurnsUsed,
  maxAutoTurns,
  systemMessageCount,
  showSystem,
  onSend,
  onCancel,
  onTogglePrimarySide,
  onToggleAutopilot,
  onToggleShowSystem
}: ComposerProps): JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const target = primarySide
  const attachIdRef = useRef(0)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // --- @file autocomplete -------------------------------------------------
  const [files, setFiles] = useState<string[]>([])
  const filesFetchedRef = useRef(false)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [mentionClosed, setMentionClosed] = useState(false)
  const [menuIndex, setMenuIndex] = useState(0)
  // Caret position to apply after a programmatic text replacement (insert).
  const pendingCaretRef = useRef<number | null>(null)

  // Reset the file cache when the conversation's project changes.
  useEffect(() => {
    filesFetchedRef.current = false
    setFiles([])
  }, [projectId])

  // Lazily fetch the project file list the first time the user opens an @menu.
  useEffect(() => {
    if (!mention || filesFetchedRef.current || !projectId) return
    filesFetchedRef.current = true
    void window.api.fs.listFiles(projectId).then((res) => {
      if (res.ok) setFiles(res.data)
    })
  }, [mention, projectId])

  // Apply a pending caret position after a controlled-value replacement.
  useEffect(() => {
    if (pendingCaretRef.current == null || !taRef.current) return
    const c = pendingCaretRef.current
    pendingCaretRef.current = null
    taRef.current.focus()
    taRef.current.setSelectionRange(c, c)
  }, [text])

  const suggestions = useMemo(() => {
    if (!mention || mentionClosed) return []
    return scoreFiles(files, mention.query).slice(0, 50)
  }, [mention, mentionClosed, files])
  const menuOpen = suggestions.length > 0

  const updateMention = (value: string, caret: number): void => {
    const m = detectMention(value, caret)
    setMention(m)
    setMenuIndex(0)
  }

  const acceptMention = (path: string): void => {
    if (!mention) return
    const el = taRef.current
    const caret = el?.selectionStart ?? text.length
    const before = text.slice(0, mention.start)
    const after = text.slice(caret)
    const insert = `@${path} `
    pendingCaretRef.current = before.length + insert.length
    setText(before + insert + after)
    setMention(null)
  }

  const addBlob = async (blob: Blob): Promise<void> => {
    if (!blob.type.startsWith('image/')) return
    if (blob.size > MAX_ATTACHMENT_BYTES) {
      window.alert(
        `图片太大（${(blob.size / 1024 / 1024).toFixed(1)} MB），上限 10 MB。`
      )
      return
    }
    const dataUrl = await blobToDataUrl(blob)
    const data = dataUrl.split(',', 2)[1] ?? ''
    const id = `att-${++attachIdRef.current}`
    setAttachments((curr) => [
      ...curr,
      { id, dataUrl, data, mimeType: blob.type, sizeBytes: blob.size }
    ])
  }

  const removeAttachment = (id: string): void => {
    setAttachments((curr) => curr.filter((a) => a.id !== id))
  }

  const submit = async (): Promise<void> => {
    const t = text.trim()
    if (!t && attachments.length === 0) return
    if (busy) return
    // Clear optimistically — the engine acks as soon as the user input is
    // queued, so the user can immediately type their next message instead of
    // waiting for the (possibly long) agent cascade to finish.
    const pending = attachments.map(({ data, mimeType }) => ({ data, mimeType }))
    setText('')
    setAttachments([])
    setBusy(true)
    try {
      await onSend(t, target, pending.length ? pending : undefined)
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // When the @file menu is open, arrow/enter/tab/esc drive the menu.
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMenuIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMenuIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        acceptMention(suggestions[menuIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionClosed(true)
        return
      }
    }
    // Enter sends, Shift+Enter inserts newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
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
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (!files) return
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        void addBlob(f)
      }
    }
  }

  const statusText = (() => {
    switch (status) {
      case 'idle':
        return '空闲'
      case 'thinking':
        return '运行中'
      case 'awaiting-user':
        return '等待输入'
      case 'paused':
        return '已暂停'
      case 'ended':
        return '已结束'
    }
  })()

  return (
    <div
      className={`composer ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="composer-row composer-meta">
        <span className={`composer-status ${status}`}>{statusText}</span>
        {threeAgent ? (
          <span className="composer-target-static">
            对话方：<strong>产品经理</strong>
          </span>
        ) : (
          <button onClick={onTogglePrimarySide} title="切换默认对话方">
            对话方：{target === 'architect' ? '架构师' : '执行者'}
          </button>
        )}
        <button
          className={autopilot ? 'primary' : ''}
          onClick={onToggleAutopilot}
          title="开启后，一方说完会自动接力给另一方"
        >
          自动接力 {autopilot ? '开' : '关'}
        </button>
        {maxAutoTurns > 0 ? (
          <span
            className="composer-autoturns"
            title={`自动接力 ${autoTurnsUsed} / ${maxAutoTurns} 轮`}
          >
            <span className="composer-autoturns-bar">
              <span
                className={`composer-autoturns-fill ${autoTurnsUsed >= maxAutoTurns ? 'full' : ''}`}
                style={{ width: `${Math.min(100, (autoTurnsUsed / maxAutoTurns) * 100)}%` }}
              />
            </span>
            <span className="composer-autoturns-text">
              {autoTurnsUsed}/{maxAutoTurns}
            </span>
          </span>
        ) : (
          <span className="composer-budget">已自动接力 {autoTurnsUsed} 轮</span>
        )}
        {systemMessageCount > 0 && (
          <button
            className={showSystem ? 'primary' : ''}
            onClick={onToggleShowSystem}
            title={showSystem ? '隐藏系统/诊断消息' : '显示系统/诊断消息'}
          >
            🛠 {showSystem ? '隐藏系统' : '显示系统'} {systemMessageCount}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {(status === 'thinking' || status === 'paused') && (
          <button className="danger" onClick={onCancel}>
            打断
          </button>
        )}
      </div>
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <div key={a.id} className="composer-attachment">
              <img src={a.dataUrl} alt="" />
              <button
                className="composer-attachment-remove"
                onClick={() => removeAttachment(a.id)}
                title="移除"
              >
                ×
              </button>
              <span className="composer-attachment-size">
                {formatBytes(a.sizeBytes)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row composer-input-row">
        {menuOpen && (
          <div className="composer-mention-menu" role="listbox">
            {suggestions.map((path, i) => (
              <div
                key={path}
                role="option"
                aria-selected={i === menuIndex}
                className={`composer-mention-item ${i === menuIndex ? 'active' : ''}`}
                onMouseDown={(e) => {
                  // Keep textarea focus so our caret restore lands.
                  e.preventDefault()
                  acceptMention(path)
                }}
                onMouseEnter={() => setMenuIndex(i)}
              >
                <span className="mention-base">{basenameOf(path)}</span>
                <span className="mention-dir">{dirnameOf(path)}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          className="composer-input"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setMentionClosed(false)
            updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }}
          onKeyDown={onKey}
          onSelect={(e) =>
            updateMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
          }
          onPaste={onPaste}
          rows={2}
          placeholder={`输入会发送给${threeAgent ? '产品经理' : target === 'architect' ? '架构师' : '执行者'}，回车发送 · Shift+回车换行 · 可粘贴 / 拖入图片 · @ 引用文件`}
          spellCheck={false}
        />
        <button
          className="primary composer-send"
          onClick={() => void submit()}
          disabled={(!text.trim() && attachments.length === 0) || busy}
        >
          {busy ? '发送中…' : '发送'}
        </button>
      </div>
      {dragOver && <div className="composer-drag-hint">松开以附加图片</div>}
    </div>
  )
}

// --- Helpers ----------------------------------------------------------------

function blobToDataUrl(blob: Blob): Promise<string> {
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

/** Find an in-progress `@token` ending at the caret. The `@` must sit at the
 *  start of the input or right after whitespace, and the token itself must be
 *  whitespace-free. Returns the `@` index and the text typed after it. */
function detectMention(text: string, caret: number): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') {
      const prev = i > 0 ? text[i - 1] : ''
      if (i === 0 || /\s/.test(prev)) return { start: i, query: text.slice(i + 1, caret) }
      return null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

function dirnameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function isSubsequence(hay: string, needle: string): boolean {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++
  }
  return i === needle.length
}

/** Rank files against an @-query: basename prefix beats basename substring
 *  beats full-path substring beats subsequence; ties break on shorter path. */
function scoreFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase()
  if (!q) return files.slice(0, 50)
  const scored: { path: string; score: number }[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    const base = basenameOf(lower)
    let score = -1
    if (base.startsWith(q)) score = 0
    else if (base.includes(q)) score = 1
    else if (lower.includes(q)) score = 2
    else if (isSubsequence(lower, q)) score = 3
    if (score >= 0) scored.push({ path, score })
  }
  scored.sort(
    (a, b) =>
      a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path)
  )
  return scored.map((s) => s.path)
}
