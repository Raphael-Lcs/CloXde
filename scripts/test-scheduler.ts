// Lightweight assertion harness for the timed-automation scheduler.
//
// Pure functions only — no DB, no Electron, no timers. Verifies:
//   • parseCron field expansion + validation
//   • matchesCron via nextCronFire (minute-by-minute scan)
//   • dom/dow OR semantics
//   • computeNextFire for both interval and cron triggers
//
// All cron times are LOCAL — tests build Date objects with local fields so they
// are timezone-agnostic (they compare against the same local clock the
// scheduler uses).
//
// Run with:  npx tsx scripts/test-scheduler.ts
// Exit code = number of failures.

import { computeNextFire, nextCronFire, parseCron } from '../src/main/conversation/scheduler'

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  failures.push(label)
  console.log(`  ✕ ${label}`)
}

function eq<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`
  )
}

function throws(fn: () => unknown, label: string): void {
  try {
    fn()
    failed++
    failures.push(label)
    console.log(`  ✕ ${label}  (expected throw, got none)`)
  } catch {
    passed++
  }
}

function section(name: string): void {
  console.log(`\n— ${name} —`)
}

/** Build a LOCAL-time epoch-ms from y/m(1-12)/d h:min. */
function localMs(y: number, mon: number, d: number, h: number, min: number): number {
  return new Date(y, mon - 1, d, h, min, 0, 0).getTime()
}

// =============================================================================
//                                  TESTS
// =============================================================================

section('parseCron — field expansion')
eq(parseCron('* * * * *').minutes.length, 60, '* minutes -> 60 entries')
eq(parseCron('* * * * *').hours.length, 24, '* hours -> 24 entries')
eq(parseCron('0 9 * * *').minutes, [0], 'literal minute 0')
eq(parseCron('0 9 * * *').hours, [9], 'literal hour 9')
eq(parseCron('0,30 * * * *').minutes, [0, 30], 'list 0,30')
eq(parseCron('0 9-17 * * *').hours, [9, 10, 11, 12, 13, 14, 15, 16, 17], 'range 9-17')
eq(parseCron('*/15 * * * *').minutes, [0, 15, 30, 45], 'step */15')
eq(parseCron('0-30/10 * * * *').minutes, [0, 10, 20, 30], 'range with step 0-30/10')
eq(parseCron('0 0 * * 1-5').daysOfWeek, [1, 2, 3, 4, 5], 'dow range 1-5')

section('parseCron — validation throws')
throws(() => parseCron('* * * *'), '4 fields rejected')
throws(() => parseCron('* * * * * *'), '6 fields rejected')
throws(() => parseCron('60 * * * *'), 'minute 60 out of range')
throws(() => parseCron('* 24 * * *'), 'hour 24 out of range')
throws(() => parseCron('* * 0 * *'), 'dom 0 out of range')
throws(() => parseCron('* * * 13 *'), 'month 13 out of range')
throws(() => parseCron('* * * * 7'), 'dow 7 out of range')
throws(() => parseCron('*/0 * * * *', ), 'step 0 rejected')
throws(() => parseCron('abc * * * *'), 'non-numeric rejected')
throws(() => parseCron('5-1 * * * *'), 'reversed range rejected')

section('nextCronFire — daily at 09:00')
// from 2026-06-01 08:00 local -> next is same day 09:00
eq(
  nextCronFire('0 9 * * *', localMs(2026, 6, 1, 8, 0)),
  localMs(2026, 6, 1, 9, 0),
  'before 9 -> today 9:00'
)
// from 2026-06-01 09:30 local -> next is tomorrow 09:00
eq(
  nextCronFire('0 9 * * *', localMs(2026, 6, 1, 9, 30)),
  localMs(2026, 6, 2, 9, 0),
  'after 9 -> tomorrow 9:00'
)
// strictly-after: at exactly 09:00 the next fire is tomorrow, not now
eq(
  nextCronFire('0 9 * * *', localMs(2026, 6, 1, 9, 0)),
  localMs(2026, 6, 2, 9, 0),
  'exactly 9:00 -> tomorrow (strictly after)'
)

section('nextCronFire — every 15 minutes')
eq(
  nextCronFire('*/15 * * * *', localMs(2026, 6, 1, 10, 7)),
  localMs(2026, 6, 1, 10, 15),
  '10:07 -> 10:15'
)
eq(
  nextCronFire('*/15 * * * *', localMs(2026, 6, 1, 10, 45)),
  localMs(2026, 6, 1, 11, 0),
  '10:45 -> 11:00'
)

section('nextCronFire — dom/dow OR semantics')
// "0 0 1 * 1" = midnight on the 1st OR any Monday (both restricted -> OR).
// 2026-06-01 is a Monday. From 2026-06-02 00:00, next Monday is 2026-06-08,
// and next "1st" is 2026-07-01 — OR picks the earlier (Monday 06-08).
eq(
  nextCronFire('0 0 1 * 1', localMs(2026, 6, 2, 0, 0)),
  localMs(2026, 6, 8, 0, 0),
  'dom=1 OR dow=Mon -> next Monday wins'
)

section('nextCronFire — weekday mornings 0 9 * * 1-5')
// 2026-06-06 is a Saturday; from Fri 2026-06-05 09:30 the next weekday-9am is
// Monday 2026-06-08 09:00 (skips Sat+Sun).
eq(
  nextCronFire('0 9 * * 1-5', localMs(2026, 6, 5, 9, 30)),
  localMs(2026, 6, 8, 9, 0),
  'Fri after 9 -> Mon 9:00 (skips weekend)'
)

section('nextCronFire — impossible date returns null')
// Feb 30 never exists.
eq(nextCronFire('0 0 30 2 *', localMs(2026, 1, 1, 0, 0)), null, 'Feb 30 -> null')

section('computeNextFire — interval')
eq(
  computeNextFire({ kind: 'interval', everyMs: 3_600_000 }, 1_000_000),
  1_000_000 + 3_600_000,
  'interval adds everyMs'
)
eq(
  computeNextFire({ kind: 'interval', everyMs: 0 }, 1_000_000),
  null,
  'zero interval -> null'
)
eq(
  computeNextFire({ kind: 'interval', everyMs: -5 }, 1_000_000),
  null,
  'negative interval -> null'
)

section('computeNextFire — cron delegates to nextCronFire')
eq(
  computeNextFire({ kind: 'cron', expr: '0 9 * * *' }, localMs(2026, 6, 1, 8, 0)),
  localMs(2026, 6, 1, 9, 0),
  'cron trigger -> next 9:00'
)

// =============================================================================
//                                 SUMMARY
// =============================================================================

console.log('\n' + '='.repeat(60))
console.log(`通过: ${passed}    失败: ${failed}`)
if (failed > 0) {
  console.log('\n失败明细:')
  for (const f of failures) console.log('  • ' + f)
}
console.log('='.repeat(60))
process.exit(failed > 0 ? 1 : 0)
