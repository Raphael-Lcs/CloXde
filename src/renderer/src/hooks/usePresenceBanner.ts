// usePresenceBanner — desktop counterpart of the tablet hook. Shows when a
// paired tablet just operated this same conversation, so the desktop user
// sees a banner before they start typing into someone else's session.

import { useCallback, useEffect, useState } from 'react'
import type { PresenceActivity } from '@shared/types'

const TTL_MS = 60_000

export function usePresenceBanner(
  conversationId: string | null
): PresenceActivity | null {
  const [latest, setLatest] = useState<PresenceActivity | null>(null)
  const [, setTick] = useState(0)

  // Reset on conversation switch.
  useEffect(() => {
    setLatest(null)
  }, [conversationId])

  const onActivity = useCallback(
    (rec: PresenceActivity) => {
      if (!conversationId) return
      if (rec.conversationId !== conversationId) return
      // Filter out our own activity — we don't banner ourselves.
      if (rec.client.kind === 'desktop') return
      setLatest(rec)
    },
    [conversationId]
  )

  useEffect(() => {
    // Defensive — when the preload bundle is stale (e.g. electron-vite dev
    // watcher missed the rebuild after `presence` was added) `window.api`
    // won't have this namespace yet, and calling .onActivity would throw.
    // A throw here propagates to React and blanks the whole window. So we
    // no-op until the next reload picks up the fresh preload.
    const presence = (
      window.api as {
        presence?: { onActivity?: (cb: (rec: PresenceActivity) => void) => () => void }
      }
    ).presence
    if (!presence || typeof presence.onActivity !== 'function') {
      console.warn('[presence] window.api.presence not available — preload bundle may be stale')
      return
    }
    return presence.onActivity(onActivity)
  }, [onActivity])

  useEffect(() => {
    if (!latest) return
    const id = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(id)
  }, [latest])

  if (!latest) return null
  if (Date.now() - latest.ts > TTL_MS) return null
  return latest
}

export function formatRelativeTs(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  if (diff < 5_000) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1_000)} 秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  return `${Math.floor(diff / 3_600_000)} 小时前`
}

/** Map a presence activity kind to a short Chinese verb for the banner. */
export function presenceLabel(kind: PresenceActivity['kind']): string {
  switch (kind) {
    case 'send-message': return '（刚发了消息）'
    case 'cancel': return '（刚停止了一轮）'
    case 'autopilot': return '（切换了自动接力）'
    case 'primary-side': return '（切换了主侧）'
    case 'archive': return '（归档了会话）'
    case 'unarchive': return '（取消归档）'
    case 'delete': return '（删除了会话）'
    default: return ''
  }
}
