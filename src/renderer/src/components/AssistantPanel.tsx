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

let nextId = 1

export function AssistantPanel(): JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const append = useCallback((role: Entry['role'], text: string) => {
    setEntries((curr) => [...curr, { id: nextId++, role, text }])
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  // Proactive reports (review loop) arrive unsolicited.
  useEffect(() => {
    const off = window.api.assistant.onReport((report: AssistantReport) => {
      append('assistant', report.message)
    })
    return off
  }, [append])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    append('user', text)
    setSending(true)
    try {
      const res = await window.api.assistant.sendMessage(text)
      if (!res.ok) {
        append('system', `出错：${res.error}`)
        return
      }
      const turn = res.data
      // Prefer the assistant's explicit reports; fall back to its raw reply so
      // the user always sees something.
      if (turn.reports.length > 0) {
        for (const r of turn.reports) append('assistant', r)
      } else if (turn.raw) {
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
  }, [draft, sending, append])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void send()
      }
    },
    [send]
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
      <div className="assistant-composer">
        <textarea
          value={draft}
          placeholder="对助理说…（Enter 发送，Shift+Enter 换行）"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
        />
        <button className="primary" onClick={() => void send()} disabled={sending || !draft.trim()}>
          发送
        </button>
      </div>
    </div>
  )
}
