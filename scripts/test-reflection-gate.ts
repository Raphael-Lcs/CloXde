// Assertion harness for the assistant reflection gate (shouldReflect).
//
// The gate decides when the low-frequency self-distillation pass may wake the
// brain. Two conditions must BOTH hold: enough time elapsed AND the user has had
// new turns since the last reflection. The turn-delta guard is what stops a
// reflection turn from re-triggering itself on an idle machine — the bug this
// test pins down.
//
// Pure function only — no DB, no timers.
//
// Run with:  npx tsx scripts/test-reflection-gate.ts
// Exit code = number of failures.

import { shouldReflect, REFLECT_INTERVAL_MS_FOR_TEST as IVL } from '../src/main/assistant/review'

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

function section(name: string): void {
  console.log(`\n— ${name} —`)
}

const now = 1_000_000_000_000

section('shouldReflect — interval gate')
// Last reflected just now; not enough time elapsed → never reflect, even with
// lots of new turns.
assert(shouldReflect(now, now, 0, 99, IVL) === false, 'too soon -> false despite new turns')
// Exactly at the boundary is still "< interval" false (strictly elapsed).
assert(shouldReflect(now, now - IVL + 1, 0, 5, IVL) === false, 'one ms short -> false')
// Interval fully elapsed and there are new turns → reflect.
assert(shouldReflect(now, now - IVL, 0, 5, IVL) === true, 'interval elapsed + new turns -> true')

section('shouldReflect — turn-delta gate (anti self-perpetuation)')
// Interval elapsed but NO new user turns since last reflection → skip. This is
// the case that would otherwise let a reflection turn re-trigger itself forever.
assert(shouldReflect(now, now - 2 * IVL, 7, 7, IVL) === false, 'no new turns -> false')
// Fewer turns than recorded (shouldn't happen, but guard is >) → skip.
assert(shouldReflect(now, now - 2 * IVL, 7, 6, IVL) === false, 'turns went backwards -> false')
// One new turn past the recorded count → reflect.
assert(shouldReflect(now, now - 2 * IVL, 7, 8, IVL) === true, 'one new turn -> true')

console.log('\n' + '='.repeat(60))
console.log(`通过: ${passed}    失败: ${failed}`)
if (failed > 0) {
  console.log('\n失败明细:')
  for (const f of failures) console.log('  • ' + f)
}
console.log('='.repeat(60))
process.exit(failed > 0 ? 1 : 0)
