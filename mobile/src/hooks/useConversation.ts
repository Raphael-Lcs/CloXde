// Hook: load + live-update a single conversation. Mirrors the desktop's
// useConversation but uses HTTP+WS instead of IPC.
//
// Pagination — long conversations are heavy to fetch and render whole.
// On mount we request only the latest PAGE_SIZE messages and expose
// `loadEarlier()` so the UI can pull older history on demand. `hasMore`
// is a heuristic: if the server returned exactly PAGE_SIZE, we assume
// there's more; once a fetch returns fewer, we stop showing the button.
//
// WS strategy:
//   • conversation:updated  → MERGE non-message fields; KEEP local messages
//                              so paginated history isn't blown away by a
//                              status / autopilot / busySide change.
//   • message:appended      → push the new message (de-duped by id)
//   • message:patched       → shallow-merge

import { useCallback, useEffect, useRef, useState } from 'react'
import { conversations as convApi } from '../api/client'
import type {
  ConversationView,
  Message,
  Side
} from '../types'
import { useWsEvents } from './useWsEvents'
import type { WsEvent as ClientWsEvent } from '../api/client'

const PAGE_SIZE = 60

export interface UseConversationResult {
  view: ConversationView | null
  loading: boolean
  error: string
  /** True when there's likely older history that hasn't been fetched yet. */
  hasMore: boolean
  /** True while a loadEarlier() call is in flight. */
  loadingEarlier: boolean
  reload: () => Promise<void>
  loadEarlier: () => Promise<void>
  send: (
    text: string,
    target?: Side,
    attachments?: { data: string; mimeType: string }[]
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  cancel: () => Promise<void>
  setAutopilot: (v: boolean) => Promise<void>
  setPrimarySide: (s: Side) => Promise<void>
}

export function useConversation(conversationId: string): UseConversationResult {
  const [view, setView] = useState<ConversationView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>('')
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  // Latest view ref so the loadEarlier closure doesn't capture stale state.
  const viewRef = useRef<ConversationView | null>(null)
  viewRef.current = view
  // Latest conversationId. The screen is kept mounted across conversation
  // switches (only route.params changes), so an HTTP fetch for the previous
  // conversation can resolve AFTER we've switched — without this guard its
  // setState would splice the old conversation's messages onto the new view.
  const currentIdRef = useRef(conversationId)
  currentIdRef.current = conversationId

  const reload = useCallback(async () => {
    try {
      const r = await convApi.get(conversationId, { limit: PAGE_SIZE })
      // Bail if we've switched conversations while this fetch was in flight.
      if (currentIdRef.current !== conversationId) return
      if (!r.ok) {
        setError(r.error)
        return
      }
      setError('')
      setView(r.data)
      setHasMore((r.data?.messages.length ?? 0) >= PAGE_SIZE)
    } catch (e) {
      if (currentIdRef.current !== conversationId) return
      // Defensive — fetch() and JSON.parse() are wrapped already, but a
      // misbehaving polyfill (URLSearchParams etc.) can still surface here.
      // Show the error to the user rather than spinning forever.
      setError(`加载异常：${String(e)}`)
    }
  }, [conversationId])

  useEffect(() => {
    setHasMore(false)
    void (async () => {
      setLoading(true)
      try {
        await reload()
      } finally {
        setLoading(false)
      }
    })()
  }, [reload])

  const loadEarlier = useCallback(async () => {
    const curr = viewRef.current
    if (!curr || curr.messages.length === 0) return
    setLoadingEarlier(true)
    try {
      const earliest = curr.messages[0]
      const r = await convApi.get(conversationId, {
        limit: PAGE_SIZE,
        before: earliest.ts
      })
      // Dropped if we switched conversations mid-fetch — otherwise we'd prepend
      // the previous conversation's history onto the new one.
      if (currentIdRef.current !== conversationId) return
      if (!r.ok || !r.data) return
      const older = r.data.messages
      setView((prev) =>
        prev ? { ...prev, messages: [...older, ...prev.messages] } : prev
      )
      setHasMore(older.length >= PAGE_SIZE)
    } finally {
      setLoadingEarlier(false)
    }
  }, [conversationId])

  const onEvent = useCallback(
    (e: ClientWsEvent) => {
      if (e.type === 'conversation:updated') {
        if (e.payload.id === conversationId) {
          // Merge non-message fields; KEEP existing messages so the
          // paginated history isn't reset on every status / autopilot /
          // busySide tick. Real message delta comes via message:appended /
          // message:patched.
          setView((prev) => {
            if (!prev) return e.payload
            return { ...e.payload, messages: prev.messages }
          })
        }
      } else if (e.type === 'message:appended') {
        if (e.payload.conversationId !== conversationId) return
        setView((prev) => {
          if (!prev) return prev
          // De-dupe — engines occasionally emit the same id twice when the
          // appended message gets immediately patched.
          if (prev.messages.some((m) => m.id === e.payload.message.id)) {
            return {
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === e.payload.message.id ? e.payload.message : m
              )
            }
          }
          return { ...prev, messages: [...prev.messages, e.payload.message] }
        })
      } else if (e.type === 'message:patched') {
        if (e.payload.conversationId !== conversationId) return
        setView((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === e.payload.messageId
                ? mergeMessage(m, e.payload.patch)
                : m
            )
          }
        })
      }
    },
    [conversationId]
  )

  useWsEvents(onEvent)

  const send = useCallback<UseConversationResult['send']>(
    async (text, target, attachments) => {
      const r = await convApi.sendUserMessage(conversationId, text, target, attachments)
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true }
    },
    [conversationId]
  )

  const cancel = useCallback(async () => {
    await convApi.cancel(conversationId)
  }, [conversationId])

  const setAutopilot = useCallback(
    async (v: boolean) => {
      await convApi.setAutopilot(conversationId, v)
    },
    [conversationId]
  )

  const setPrimarySide = useCallback(
    async (s: Side) => {
      await convApi.setPrimarySide(conversationId, s)
    },
    [conversationId]
  )

  return {
    view,
    loading,
    error,
    hasMore,
    loadingEarlier,
    reload,
    loadEarlier,
    send,
    cancel,
    setAutopilot,
    setPrimarySide
  }
}

function mergeMessage(m: Message, patch: Partial<Message>): Message {
  // Shallow merge is enough — the patches the engine emits are top-level
  // (stopReason, blocks reassignment). Block-level diffs would need a more
  // careful merge but the desktop currently doesn't send those.
  return { ...m, ...patch }
}
