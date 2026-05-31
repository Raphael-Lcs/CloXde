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

// --- Cron parsing (pure, unit-tested) --------------------------------------

interface CronFields {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
}

const CRON_RANGES = {
  minutes: [0, 59],
  hours: [0, 23],
  daysOfMonth: [1, 31],
  months: [1, 12],
  daysOfWeek: [0, 6] // 0 = Sunday
} as const

/** Expand one cron field (e.g. "*", "1,15", "9-17", "*\/5", "0-30/10") into the
 *  sorted set of matching integers, bounded by [min,max]. Throws on garbage. */
function expandField(field: string, min: number, max: number): number[] {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    if (!part) throw new Error(`empty cron field segment in "${field}"`)
    let range = part
    let step = 1
    const slash = part.indexOf('/')
    if (slash !== -1) {
      range = part.slice(0, slash)
      step = Number(part.slice(slash + 1))
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`invalid cron step in "${part}"`)
      }
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = Number(range)
      hi = lo
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`non-integer cron value in "${part}"`)
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron value out of range in "${part}" (expected ${min}-${max})`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${parts.length}: "${expr}"`)
  }
  return {
    minutes: expandField(parts[0], ...CRON_RANGES.minutes),
    hours: expandField(parts[1], ...CRON_RANGES.hours),
    daysOfMonth: expandField(parts[2], ...CRON_RANGES.daysOfMonth),
    months: expandField(parts[3], ...CRON_RANGES.months),
    daysOfWeek: expandField(parts[4], ...CRON_RANGES.daysOfWeek)
  }
}

/** Whether a given Date matches the cron fields. Day-of-month and day-of-week
 *  follow the standard cron OR semantics: when BOTH are restricted (not "*"),
 *  the date matches if EITHER matches. We approximate "restricted" as "doesn't
 *  cover its full range". */
function matchesCron(d: Date, c: CronFields): boolean {
  const domRestricted = c.daysOfMonth.length !== 31
  const dowRestricted = c.daysOfWeek.length !== 7
  const minOk = c.minutes.includes(d.getMinutes())
  const hourOk = c.hours.includes(d.getHours())
  const monOk = c.months.includes(d.getMonth() + 1)
  const domOk = c.daysOfMonth.includes(d.getDate())
  const dowOk = c.daysOfWeek.includes(d.getDay())
  if (!minOk || !hourOk || !monOk) return false
  if (domRestricted && dowRestricted) return domOk || dowOk
  return domOk && dowOk
}

/** Next cron fire strictly after `from` (local time), scanning minute by
 *  minute. Bounded to ~366 days ahead; returns null if nothing matches (e.g.
 *  Feb 30). */
export function nextCronFire(expr: string, from: number): number | null {
  const c = parseCron(expr)
  // Start at the next whole minute after `from` (cron has minute resolution).
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = from + 366 * 24 * 60 * 60 * 1000
  while (d.getTime() <= limit) {
    if (matchesCron(d, c)) return d.getTime()
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}

/** Compute the next fire time for any trigger, strictly after `from`. */
export function computeNextFire(trigger: ScheduleTrigger, from: number): number | null {
  if (trigger.kind === 'interval') {
    if (!Number.isFinite(trigger.everyMs) || trigger.everyMs <= 0) return null
    return from + trigger.everyMs
  }
  return nextCronFire(trigger.expr, from)
}

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
