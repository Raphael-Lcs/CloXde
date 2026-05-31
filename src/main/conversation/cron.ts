// Pure cron / interval math for the scheduler. No DB, no Electron, no timers —
// kept isolated so the unit test (scripts/test-scheduler.ts) can import it
// without dragging in storage/db → paths → electron (which the CI test job,
// running with ELECTRON_SKIP_BINARY_DOWNLOAD, can't load).
//
// Cron is 5-field (min hour dom mon dow), evaluated in LOCAL time, with the
// standard dom/dow OR semantics.

import type { ScheduleTrigger } from '@shared/types'

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
