// Assertion harness for the assistant instability gate (shouldReportInstability).
//
// The review loop drains adapter-instability events (a team's ACP process
// crashed/disconnected) and only wakes the brain when the batch is worth it:
// any *exhausted* retry (a turn actually failed over) escalates immediately; a
// burst of recovered hiccups escalates once it's clearly not a one-off. A single
// recovered hiccup stays quiet — "全自动" is supposed to survive a socket blip.
//
// Pure function only — no engine, no DB, no model.
//
// Run with:  npx tsx scripts/test-instability-gate.ts
// Exit code = number of failures.

import { shouldReportInstability } from '../src/main/assistant/review'
import type { InstabilityEvent } from '../src/main/conversation/engine'

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

function ev(over: Partial<InstabilityEvent>): InstabilityEvent {
  return {
    ts: 0,
    conversationId: 'c1',
    projectId: 'p1',
    side: 'executor',
    exhausted: false,
    detail: 'socket hung up',
    ...over
  }
}

section('shouldReportInstability — empty / single hiccup stays quiet')
assert(shouldReportInstability([]) === false, 'no events -> false')
assert(shouldReportInstability([ev({})]) === false, 'one recovered hiccup -> false')
assert(
  shouldReportInstability([ev({}), ev({})]) === false,
  'two recovered hiccups (below burst) -> false'
)

section('shouldReportInstability — exhaustion escalates immediately')
assert(shouldReportInstability([ev({ exhausted: true })]) === true, 'single exhausted -> true')
assert(
  shouldReportInstability([ev({}), ev({ exhausted: true })]) === true,
  'one recovered + one exhausted -> true'
)

section('shouldReportInstability — burst of recovered hiccups escalates')
assert(
  shouldReportInstability([ev({}), ev({}), ev({})]) === true,
  'three recovered hiccups (burst) -> true'
)

console.log('\n' + '='.repeat(60))
console.log(`通过: ${passed}    失败: ${failed}`)
if (failed > 0) {
  console.log('\n失败明细:')
  for (const f of failures) console.log('  • ' + f)
}
console.log('='.repeat(60))
process.exit(failed > 0 ? 1 : 0)
