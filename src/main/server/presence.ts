// Cross-client presence tracker for the LAN companion server.
//
// Why this exists: with the desktop and one or more tablets all sharing the
// same conversations + LAN server, two humans can be operating the same
// session at once. We don't (yet) hard-lock — soft awareness is plenty
// for a home setup. This module keeps a per-conversation "last activity"
// record and broadcasts it so the OTHER clients can show a banner like
// "桌面端 12 秒前在使用".
//
// Activities tracked: any user-driven mutation. We deliberately do NOT
// record purely-passive things like /api/conversations/:id (read).
//
// Lifecycle: in-memory only. Restart of the desktop clears the map. That
// matches the WS lifecycle — clients reconnect and re-sync.

import { EventEmitter } from 'node:events'

/** Identifies *which* connected human is acting. The desktop process is
 *  always 'desktop'; LAN clients are 'tablet' (label is the device name
 *  the user picked at pair time, e.g. "iPad - 客厅"). */
export interface ClientId {
  kind: 'desktop' | 'tablet'
  label: string
}

export interface ActivityRecord {
  conversationId: string
  client: ClientId
  /** Last activity timestamp (Date.now()) */
  ts: number
  /** Tag of what they did. Useful for debugging; UI typically just cares
   *  about ts + label. */
  kind: ActivityKind
}

export type ActivityKind =
  | 'send-message'
  | 'cancel'
  | 'autopilot'
  | 'primary-side'
  | 'archive'
  | 'unarchive'
  | 'delete'
  | 'create'

/** Records survive this long without an update before being pruned.
 *  Practically: longer than the UI's "stale" threshold so the banner can
 *  count up to "1 分钟前" before disappearing. */
const TTL_MS = 5 * 60 * 1000

class Presence extends EventEmitter {
  /** conversationId → last activity. Only the latest is kept; we don't
   *  care about full history for cross-client awareness. */
  private latest = new Map<string, ActivityRecord>()

  record(
    conversationId: string,
    client: ClientId,
    kind: ActivityKind
  ): ActivityRecord {
    const rec: ActivityRecord = {
      conversationId,
      client,
      kind,
      ts: Date.now()
    }
    this.latest.set(conversationId, rec)
    this.pruneStale()
    this.emit('activity', rec)
    return rec
  }

  /** Latest activity for a conversation, or null if none recently. */
  get(conversationId: string): ActivityRecord | null {
    const r = this.latest.get(conversationId)
    if (!r) return null
    if (Date.now() - r.ts > TTL_MS) {
      this.latest.delete(conversationId)
      return null
    }
    return r
  }

  /** Snapshot of all currently-fresh activity (for new WS connections). */
  snapshot(): ActivityRecord[] {
    this.pruneStale()
    return Array.from(this.latest.values())
  }

  private pruneStale(): void {
    const cutoff = Date.now() - TTL_MS
    for (const [id, r] of this.latest) {
      if (r.ts < cutoff) this.latest.delete(id)
    }
  }
}

export const presence = new Presence()
