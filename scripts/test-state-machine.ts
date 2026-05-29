// Lightweight assertion harness for the path-C state machine.
//
// Pure functions only — no DB, no Electron, no ACP. Verifies:
//   • transition table (every (status, action) edge)
//   • allowedTags / isToolAllowed (per role-status matrix)
//   • classifyTool heuristics
//   • extractAction picks the LAST allowed tag
//   • parsePlanSteps for bullet variants
//
// Run with:  npx tsx scripts/test-state-machine.ts
// Exit code = number of failures.

import {
  allowedTags,
  classifyTool,
  describeForbidden,
  extractAction,
  formatTaskPreamble,
  isToolAllowed,
  parsePlanSteps,
  transition,
  type TaskAction
} from '../src/main/conversation/state-machine'
import type { Role, Task, TaskStatus } from '../src/shared/types'

// --- micro-assertion utilities ---------------------------------------------

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

function section(name: string): void {
  console.log(`\n— ${name} —`)
}

// --- helpers ---------------------------------------------------------------

function mkTask(status: TaskStatus, owner: Role): Task {
  return {
    id: 'task-test',
    conversationId: 'conv-test',
    brief: 'test brief',
    status,
    owner,
    createdAt: 0,
    updatedAt: 0
  }
}

// =============================================================================
//                                  TESTS
// =============================================================================

section('classifyTool')
eq(classifyTool('read'), 'read', 'read')
eq(classifyTool('search'), 'read', 'search')
eq(classifyTool('grep'), 'read', 'grep')
eq(classifyTool('glob_files'), 'read', 'glob_files')
eq(classifyTool('fetch'), 'read', 'fetch')
eq(classifyTool('edit'), 'write', 'edit')
eq(classifyTool('write_file'), 'write', 'write_file')
eq(classifyTool('apply_patch'), 'write', 'apply_patch')
eq(classifyTool('execute'), 'execute', 'execute')
eq(classifyTool('bash'), 'execute', 'bash')
eq(classifyTool('shell_exec'), 'execute', 'shell_exec')
eq(classifyTool('terminal'), 'execute', 'terminal')
eq(classifyTool(''), 'other', 'empty')
eq(classifyTool(undefined), 'other', 'undefined')
eq(classifyTool('mcp_thinker'), 'other', 'unknown')

// -------------------------------------------------------------------------
section('isToolAllowed — PM never uses tools')
const allCats = ['read', 'write', 'execute', 'other'] as const
const allStatuses: TaskStatus[] = [
  'briefing', 'planning', 'executing', 'review', 'done', 'failed'
]
for (const s of allStatuses) {
  for (const c of allCats) {
    eq(isToolAllowed(s, 'pm', c), false, `pm/${s}/${c} -> false`)
  }
}

section('isToolAllowed — briefing: nobody acts')
for (const r of ['architect', 'executor'] as Role[]) {
  for (const c of allCats) {
    eq(isToolAllowed('briefing', r, c), false, `briefing/${r}/${c} -> false`)
  }
}

section('isToolAllowed — planning: architect read-only')
eq(isToolAllowed('planning', 'architect', 'read'), true, 'planning/arch/read -> true')
eq(isToolAllowed('planning', 'architect', 'other'), true, 'planning/arch/other -> true')
eq(isToolAllowed('planning', 'architect', 'write'), false, 'planning/arch/write -> false')
eq(isToolAllowed('planning', 'architect', 'execute'), false, 'planning/arch/exec -> false')
for (const c of allCats) {
  eq(isToolAllowed('planning', 'executor', c), false, `planning/exec/${c} -> false`)
}

section('isToolAllowed — executing: executor full power')
for (const c of allCats) {
  eq(isToolAllowed('executing', 'executor', c), true, `executing/exec/${c} -> true`)
  eq(isToolAllowed('executing', 'architect', c), false, `executing/arch/${c} -> false`)
}

section('isToolAllowed — review: architect read-only')
eq(isToolAllowed('review', 'architect', 'read'), true, 'review/arch/read -> true')
eq(isToolAllowed('review', 'architect', 'write'), false, 'review/arch/write -> false')
eq(isToolAllowed('review', 'architect', 'execute'), false, 'review/arch/exec -> false')
for (const c of allCats) {
  eq(isToolAllowed('review', 'executor', c), false, `review/exec/${c} -> false`)
}

section('isToolAllowed — done / failed: nobody acts')
for (const s of ['done', 'failed'] as TaskStatus[]) {
  for (const r of ['architect', 'executor'] as Role[]) {
    for (const c of allCats) {
      eq(isToolAllowed(s, r, c), false, `${s}/${r}/${c} -> false`)
    }
  }
}

// -------------------------------------------------------------------------
section('allowedTags')
eq(allowedTags('briefing', 'pm'), ['HANDOFF', 'FAIL'], 'briefing/pm')
eq(allowedTags('briefing', 'architect'), [], 'briefing/architect')
eq(allowedTags('briefing', 'executor'), [], 'briefing/executor')
eq(allowedTags('planning', 'architect'), ['PLAN', 'DELEGATE', 'FAIL'], 'planning/architect')
eq(allowedTags('planning', 'executor'), [], 'planning/executor')
eq(allowedTags('executing', 'executor'), ['REPORT', 'FAIL'], 'executing/executor')
eq(allowedTags('executing', 'architect'), [], 'executing/architect')
eq(allowedTags('review', 'architect'), ['DELEGATE', 'DONE', 'FAIL'], 'review/architect')
eq(allowedTags('review', 'executor'), [], 'review/executor')
eq(allowedTags('done', 'architect'), [], 'done/architect')
eq(allowedTags('failed', 'pm'), ['HANDOFF', 'FAIL'], 'failed/pm (pm always)')

// -------------------------------------------------------------------------
section('transition — happy path')
const briefing = mkTask('briefing', 'pm')
eq(transition(briefing, 'HANDOFF'), { nextStatus: 'planning', nextOwner: 'architect' }, 'briefing+HANDOFF -> planning/architect')

const planning = mkTask('planning', 'architect')
eq(transition(planning, 'PLAN'), { nextStatus: 'planning', nextOwner: 'architect' }, 'planning+PLAN -> stay')
eq(transition(planning, 'DELEGATE'), { nextStatus: 'executing', nextOwner: 'executor' }, 'planning+DELEGATE -> executing/executor')

const executing = mkTask('executing', 'executor')
eq(transition(executing, 'REPORT'), { nextStatus: 'review', nextOwner: 'architect' }, 'executing+REPORT -> review/architect')

const review = mkTask('review', 'architect')
eq(transition(review, 'DELEGATE'), { nextStatus: 'executing', nextOwner: 'executor' }, 'review+DELEGATE -> executing')
eq(transition(review, 'DONE'), { nextStatus: 'done', nextOwner: 'pm' }, 'review+DONE -> done/pm')

section('transition — FAIL is universal')
for (const s of allStatuses) {
  for (const r of ['pm', 'architect', 'executor'] as Role[]) {
    const t = mkTask(s, r)
    eq(transition(t, 'FAIL'), { nextStatus: 'failed', nextOwner: 'pm' }, `${s}/${r}+FAIL`)
  }
}

section('transition — invalid combinations return null')
eq(transition(briefing, 'PLAN'), null, 'briefing+PLAN -> null')
eq(transition(planning, 'DONE'), null, 'planning+DONE -> null')
eq(transition(planning, 'REPORT'), null, 'planning+REPORT -> null')
eq(transition(executing, 'DONE'), null, 'executing+DONE -> null')
eq(transition(executing, 'DELEGATE'), null, 'executing+DELEGATE -> null')
eq(transition(review, 'PLAN'), null, 'review+PLAN -> null')
eq(transition(review, 'REPORT'), null, 'review+REPORT -> null')
eq(transition(mkTask('done', 'pm'), 'HANDOFF'), { nextStatus: 'planning', nextOwner: 'architect' }, 'done/pm+HANDOFF -> planning (PM can restart)')
eq(transition(mkTask('done', 'architect'), 'DELEGATE'), null, 'done/architect+DELEGATE -> null (closed)')

section('transition — wrong owner rejected')
const planningExec = mkTask('planning', 'executor') // bogus state
eq(transition(planningExec, 'DELEGATE'), null, 'planning/executor+DELEGATE -> null (owner mismatch)')

// -------------------------------------------------------------------------
section('extractAction — basic')
eq(
  extractAction('<<DELEGATE>>do it<</DELEGATE>>', ['DELEGATE']),
  { action: 'DELEGATE', body: 'do it' },
  'single tag'
)
eq(
  extractAction('no tags here', ['DELEGATE', 'DONE']),
  null,
  'no tags -> null'
)

section('extractAction — picks LAST allowed tag')
const dualText = `首先我会 <<PLAN>>
- step 1
- step 2
<</PLAN>>

然后立即派单 <<DELEGATE>>具体指令<</DELEGATE>>`
eq(
  extractAction(dualText, ['PLAN', 'DELEGATE', 'FAIL']),
  { action: 'DELEGATE', body: '具体指令' },
  'PLAN then DELEGATE -> DELEGATE wins'
)

section('extractAction — ignores tags not in allowed list')
eq(
  extractAction('<<DELEGATE>>x<</DELEGATE>><<DONE>>y<</DONE>>', ['PLAN']),
  null,
  'only PLAN allowed, none present -> null'
)
eq(
  extractAction('<<DELEGATE>>x<</DELEGATE>><<DONE>>y<</DONE>>', ['DELEGATE']),
  { action: 'DELEGATE', body: 'x' },
  'only DELEGATE allowed -> picks it even though DONE comes after'
)

section('extractAction — case insensitive + multiline body')
eq(
  extractAction('<<plan>>\nline1\nline2\n<</plan>>', ['PLAN']),
  { action: 'PLAN', body: 'line1\nline2' },
  'lowercase tag, multiline body'
)

// -------------------------------------------------------------------------
section('parsePlanSteps — dash bullets')
eq(
  parsePlanSteps('- step one\n- step two\n- step three'),
  [
    { description: 'step one', status: 'pending' },
    { description: 'step two', status: 'pending' },
    { description: 'step three', status: 'pending' }
  ],
  '- bullets'
)

section('parsePlanSteps — numbered + mixed bullet styles')
eq(
  parsePlanSteps('1. first\n2) second\n* third\n• fourth'),
  [
    { description: 'first', status: 'pending' },
    { description: 'second', status: 'pending' },
    { description: 'third', status: 'pending' },
    { description: 'fourth', status: 'pending' }
  ],
  '1. 2) * • all parse'
)

section('parsePlanSteps — wrap continuation')
eq(
  parsePlanSteps('- first thing\n  that wraps to two lines\n- second'),
  [
    { description: 'first thing that wraps to two lines', status: 'pending' },
    { description: 'second', status: 'pending' }
  ],
  'continuation lines fold into the prior bullet'
)

section('parsePlanSteps — drops preamble before first bullet')
eq(
  parsePlanSteps('Here is my plan:\n\n- first\n- second'),
  [
    { description: 'first', status: 'pending' },
    { description: 'second', status: 'pending' }
  ],
  'preamble dropped'
)

section('parsePlanSteps — no bullets falls back to single step')
eq(
  parsePlanSteps('Just do the thing, no list.'),
  [{ description: 'Just do the thing, no list.', status: 'pending' }],
  'no bullets -> single step'
)

section('parsePlanSteps — empty input')
eq(parsePlanSteps(''), [], 'empty string')
eq(parsePlanSteps('   \n   \n'), [], 'whitespace only')

// -------------------------------------------------------------------------
section('formatTaskPreamble — contains key fields')
const preamble = formatTaskPreamble(mkTask('planning', 'architect'), 'architect')
assert(preamble.includes('[CLOXDE-TASK]'), 'preamble has marker')
assert(preamble.includes('status: planning'), 'preamble has status')
assert(preamble.includes('你的角色: architect'), 'preamble has role')
assert(preamble.includes('<<PLAN>>'), 'preamble lists PLAN as allowed')
assert(preamble.includes('<<DELEGATE>>'), 'preamble lists DELEGATE as allowed')
assert(preamble.includes('test brief'), 'preamble echoes brief')

section('describeForbidden — never empty')
for (const s of allStatuses) {
  for (const r of ['pm', 'architect', 'executor'] as Role[]) {
    const msg = describeForbidden(s, r)
    assert(typeof msg === 'string' && msg.length > 0, `describeForbidden(${s},${r}) non-empty`)
  }
}

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
