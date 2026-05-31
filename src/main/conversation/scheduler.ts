// Timed automation. A single process-wide ticker scans enabled schedules and,
// when one is due, injects its prompt into the target conversation as if the
// user had typed it (same path: conversationEngine.sendUserMessage → PM).
//
// Two trigger kinds:
//   • interval — fire every N ms; nextFireAt = lastFire + everyMs
//   • cron     — 5-field cron (min hour dom mon dow), evaluated in LOCAL time
//
// Catch-up policy: when a schedule was due while the app was closed (or the
// machine slept), we fire it ONCE on the next tick and recompute forward from
// "now" — we never backfill every missed slot. This keeps a daily job that
// missed a week from firing seven times on launch.

import type { Schedule, ScheduleTrigger } from '@shared/types'
import { scheduleRepo, conversationRepo } from '../storage/db'
import { computeNextFire } from './cron'

// Cron / interval math lives in ./cron (pure, no DB) so the unit test can
// import it without dragging in storage → electron. Re-export the pure
// helpers here for callers that already import from the scheduler.
export { parseCron, nextCronFire, computeNextFire } from './cron'

// --- Ticker -----------------------------------------------------------------

type InjectFn = (conversationId: string, text: string) => Promise<void>

const TICK_MS = 30_000

let timer: ReturnType<typeof setInterval> | null = null
let inject: InjectFn | null = null

/** Recompute nextFireAt for any schedule whose stored time is in the past or
 *  missing — collapses every missed slot into a single "fire on next tick".
 *  Called on startup so the app doesn't backfill while it was closed. */
function reconcileOnStart(now: number): void {
  for (const s of scheduleRepo.listEnabled()) {
    if (s.nextFireAt <= now) {
      const next = computeNextFire(s.trigger, now)
      // Past-due → fire on the very next tick (set to now), then recompute
      // forward after it fires. Disabled-trigger (null) → just push out.
      scheduleRepo.patch(s.id, { nextFireAt: next === null ? now + TICK_MS : now })
    }
  }
}

async function fireDue(now: number): Promise<void> {
  if (!inject) return
  for (const s of scheduleRepo.listEnabled()) {
    if (s.nextFireAt > now) continue
    // Recompute the next slot BEFORE injecting so a slow/failed turn can't
    // wedge the schedule into refiring every tick.
    const next = computeNextFire(s.trigger, now)
    scheduleRepo.patch(s.id, {
      lastFiredAt: now,
      nextFireAt: next ?? now + 24 * 60 * 60 * 1000,
      // A cron with no future match (or a degenerate interval) self-disables.
      ...(next === null ? { enabled: false } : {})
    })
    // Skip orphaned schedules whose conversation was deleted.
    if (!conversationRepo.get(s.conversationId)) {
      scheduleRepo.delete(s.id)
      continue
    }
    try {
      await inject(s.conversationId, s.prompt)
    } catch (e) {
      console.error(`[scheduler] inject failed for ${s.id}:`, e)
    }
  }
}

export function startScheduler(injectFn: InjectFn): void {
  if (timer) return
  inject = injectFn
  reconcileOnStart(Date.now())
  timer = setInterval(() => {
    void fireDue(Date.now())
  }, TICK_MS)
  // Don't keep the event loop alive solely for the ticker.
  if (typeof timer.unref === 'function') timer.unref()
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  inject = null
}

/** Create a schedule with its first fire time computed from now. Returns the
 *  persisted row. Exposed for the IPC layer. */
export function createSchedule(input: {
  conversationId: string
  name: string
  trigger: ScheduleTrigger
  prompt: string
  enabled?: boolean
}): Schedule {
  const now = Date.now()
  const next = computeNextFire(input.trigger, now)
  if (next === null) {
    throw new Error('trigger never fires — check the cron expression or interval')
  }
  return scheduleRepo.create({ ...input, nextFireAt: next })
}

/** Patch a schedule. When the trigger changes (or it's re-enabled), recompute
 *  nextFireAt from now so the new cadence takes effect immediately. */
export function updateSchedule(
  id: string,
  patch: {
    name?: string
    trigger?: ScheduleTrigger
    prompt?: string
    enabled?: boolean
  }
): void {
  const existing = scheduleRepo.get(id)
  if (!existing) throw new Error('schedule not found')
  const needsRecompute =
    patch.trigger !== undefined || (patch.enabled === true && !existing.enabled)
  let nextFireAt: number | undefined
  if (needsRecompute) {
    const trigger = patch.trigger ?? existing.trigger
    const next = computeNextFire(trigger, Date.now())
    if (next === null) throw new Error('trigger never fires')
    nextFireAt = next
  }
  scheduleRepo.patch(id, { ...patch, ...(nextFireAt !== undefined ? { nextFireAt } : {}) })
}
