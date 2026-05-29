// usePresenceBanner — subscribes to the WS `presence:activity` stream and
// keeps the LATEST other-side activity for one conversation. Returns null
// when:
//   • nobody else has acted recently
//   • the latest activity is *us* (we don't banner our own taps)
//   • the activity is older than the configured TTL
//
// Re-renders every 10s while a banner is showing so the "X 秒前" label
// counts up smoothly.

import { useCallback, useEffect, useState } from 'react'
import { presenceApi } from '../api/client'
import type { PresenceActivity } from '../types'
import { useWsEvents } from './useWsEvents'

const TTL_MS = 60_000

interface Options {
  conversationId: string
  /** Our own client identity — incoming activities matching this are
   *  filtered out. On the tablet this is the connection's `label`. */
  selfLabel: string
}

export function usePresenceBanner({
  conversationId,
  selfLabel
}: Options): PresenceActivity | null {
  const [latest, setLatest] = useState<PresenceActivity | null>(null)
  // Tick counter forces a re-render so the relative time label updates.
  const [, setTick] = useState(0)

  // Seed from the snapshot endpoint on mount / conversation switch — this
  // catches activity that happened before we connected.
  useEffect(() => {
    let cancelled = false
    void presenceApi.snapshot().then((res) => {
      if (cancelled || !res.ok) return
      const m = res.data.find((r) => r.conversationId === conversationId)
      if (m) setLatest(m)
    })
    return () => {
      cancelled = true
    }
  }, [conversationId])

  const onEvent = useCallback(
    (e: { type: string; payload: unknown }) => {
      if (e.type !== 'presence:activity') return
      const p = e.payload as PresenceActivity
      if (p.conversationId !== conversationId) return
      // Filter out our own activity — we don't banner ourselves.
      if (p.client.kind === 'tablet' && p.client.label === selfLabel) return
      setLatest(p)
    },
    [conversationId, selfLabel]
  )
  useWsEvents(onEvent)

  // Re-render every 10s while a banner is showing so the relative-time
  // label updates.
  useEffect(() => {
    if (!latest) return
    const id = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(id)
  }, [latest])

  if (!latest) return null
  if (Date.now() - latest.ts > TTL_MS) return null
  return latest
}

/** Format an activity timestamp as a friendly "刚刚 / 12 秒前 / 1 分钟前". */
export function formatRelativeTs(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  if (diff < 5_000) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1_000)} 秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  return `${Math.floor(diff / 3_600_000)} 小时前`
}
