import { useCallback, useEffect, useState } from 'react'
import type { ConversationView, Message } from '@shared/types'

/**
 * Subscribes to the live ConversationView for a given conversation.
 * - Hydrates with `conversations.get`
 * - Patches messages on `onMessageAppended` / `onMessagePatched`
 * - Replaces the entire view on `onUpdated` (status / autopilot / etc.)
 */
export function useConversation(conversationId: string | null): {
  view: ConversationView | null
  loading: boolean
  refresh: () => Promise<void>
} {
  const [view, setView] = useState<ConversationView | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setView(null)
      return
    }
    setLoading(true)
    try {
      const res = await window.api.conversations.get(conversationId)
      if (res.ok) setView(res.data ?? null)
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!conversationId) return
    const offUpdated = window.api.conversations.onUpdated((next) => {
      if (next.id !== conversationId) return
      setView((curr) => {
        // Keep the local message list (patches come via the dedicated
        // channels) but always trust the new conversation-level state,
        // including the runtime-only `busySide` field.
        if (!curr) return next
        return { ...next, messages: curr.messages }
      })
    })
    const offAppended = window.api.conversations.onMessageAppended(
      ({ conversationId: cid, message }) => {
        if (cid !== conversationId) return
        setView((curr) => {
          if (!curr) return curr
          if (curr.messages.some((m) => m.id === message.id)) return curr
          return { ...curr, messages: [...curr.messages, message] }
        })
      }
    )
    const offPatched = window.api.conversations.onMessagePatched(
      ({ conversationId: cid, messageId, patch }) => {
        if (cid !== conversationId) return
        setView((curr) => {
          if (!curr) return curr
          return {
            ...curr,
            messages: curr.messages.map((m) =>
              m.id === messageId ? ({ ...m, ...patch } as Message) : m
            )
          }
        })
      }
    )
    return () => {
      offUpdated()
      offAppended()
      offPatched()
    }
  }, [conversationId])

  return { view, loading, refresh }
}
