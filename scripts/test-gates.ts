// Assertion harness for the self-mod gate aggregation (src/main/assistant/gates.ts).
//
// Pure functions only — no spawning, no Electron. The verdict logic here is the
// safety hinge of self-modification: allGatesPassed decides whether a branch is
// allowed to merge back into the running app. A bug that returns true on an
// empty list, or ignores a failing gate, would let broken code self-promote.
//
// Run with:  npx tsx scripts/test-gates.ts
// Exit code = number of failures.

import { allGatesPassed, firstFailure, type GateResult } from '../src/main/assistant/gates'

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

function g(gate: string, ok: boolean): GateResult {
  return { gate, passed: ok, detail: '' }
}

console.log('\n— allGatesPassed —')
assert(allGatesPassed([]) === false, '空列表不算通过（绝不在零闸门上晋升）')
assert(allGatesPassed([g('typecheck', true)]) === true, '单个通过 -> true')
assert(
  allGatesPassed([g('typecheck', true), g('test', true), g('build', true), g('smoke', true)]) ===
    true,
  '全部通过 -> true'
)
assert(
  allGatesPassed([g('typecheck', true), g('test', false)]) === false,
  '任一失败 -> false'
)
assert(allGatesPassed([g('typecheck', false)]) === false, '首个失败 -> false')

console.log('\n— firstFailure —')
assert(firstFailure([g('typecheck', true)]) === null, '全过时无首失败')
assert(firstFailure([]) === null, '空列表无首失败')
assert(
  firstFailure([g('typecheck', true), g('test', false), g('build', false)])?.gate === 'test',
  '返回最早失败的闸门'
)

console.log('\n' + '='.repeat(60))
console.log(`通过: ${passed}    失败: ${failed}`)
if (failed > 0) {
  console.log('\n失败明细:')
  for (const f of failures) console.log('  • ' + f)
}
console.log('='.repeat(60))
process.exit(failed > 0 ? 1 : 0)
