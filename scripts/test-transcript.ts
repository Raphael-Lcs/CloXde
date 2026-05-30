// Lightweight assertion harness for the conversation transcript helpers.
//
// Pure functions only — no DB, no Electron, no ACP. These helpers drive
// load-bearing engine behavior:
//   • isContextOverflow  → triggers automatic context compaction
//   • isAdapterNoise     → keeps transient adapter errors out of the chat
//   • wrapTeamReport     → strips <<DONE>> markers before the PM wrap-up
//   • extract*/hasDone   → tag detection for the legacy hand-off path
// Plus a cross-check that a bare <<DONE>> yields an empty extractAction body
// (the reason driveStateMachine forwards `found.body || finalText`).
//
// Run with:  npx tsx scripts/test-transcript.ts
// Exit code = number of failures.

import {
  extractHandoff,
  extractDelegate,
  hasDone,
  wrapDelegate,
  wrapExecutorReport,
  wrapTeamReport,
  isAdapterNoise,
  isContextOverflow,
  condenseError,
  blocksToPlainText
} from '../src/main/conversation/transcript'
import { extractAction } from '../src/main/conversation/state-machine'
import type { MessageBlock } from '../src/shared/types'

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

// =============================================================================
//                          isContextOverflow
//   The compaction trigger. MUST match the deterministic "history too long"
//   rejections from Claude / Codex, and MUST NOT fire on ordinary turns.
// =============================================================================

section('isContextOverflow — matches real overflow rejections')
for (const msg of [
  'prompt is too long: 210000 tokens > 200000 maximum',
  'This model has a maximum context length of 128000 tokens',
  'input exceeds the context window',
  'too many tokens in request',
  'Error: context length exceeded'
]) {
  assert(isContextOverflow(msg), `overflow: ${msg.slice(0, 40)}`)
}

section('isContextOverflow — ignores unrelated adapter errors')
for (const msg of [
  'stream disconnected',
  'adapter exited mid-turn (code=1, signal=null)',
  'runtime disposed',
  'ECONNREFUSED 127.0.0.1:9000',
  'permission denied'
]) {
  assert(!isContextOverflow(msg), `not-overflow: ${msg.slice(0, 40)}`)
}

// =============================================================================
//                           isAdapterNoise
//   Suppresses transient stderr / teardown sentinels from the conversation.
// =============================================================================

section('isAdapterNoise — suppresses transient + teardown signals')
for (const msg of [
  'stream disconnected',
  'Reconnecting... 2/5',
  'runtime disposed',
  'adapter exited mid-turn (code=1, signal=null)',
  'windows sandbox: spawn failed',
  'ResponseStreamDisconnected'
]) {
  assert(isAdapterNoise(msg), `noise: ${msg.slice(0, 40)}`)
}

section('isAdapterNoise — lets real errors through')
for (const msg of [
  'TypeError: cannot read property foo of undefined',
  '架构师宣告任务完成',
  'prompt is too long'
]) {
  assert(!isAdapterNoise(msg), `not-noise: ${msg.slice(0, 40)}`)
}

// =============================================================================
//                            wrapTeamReport
//   Strips ALL <<DONE>> markers (agents sometimes repeat for emphasis) and
//   wraps the conclusion for the PM.
// =============================================================================

section('wrapTeamReport — strips every <<DONE>> and wraps')
{
  const out = wrapTeamReport('全部完成 <<DONE>> 收尾 <<DONE>>')
  assert(!/<<DONE>>/i.test(out), 'no DONE marker remains')
  assert(out.startsWith('[团队反馈]'), 'starts with 团队反馈 header')
  assert(out.includes('全部完成'), 'keeps conclusion body')
  assert(out.trim().endsWith('[结束反馈]'), 'ends with 结束反馈 footer')
}

section('wrapExecutorReport — wraps executor body')
{
  const out = wrapExecutorReport('  改完了  ')
  assert(out.startsWith('[执行者回报]'), 'starts with 执行者回报')
  assert(out.includes('改完了'), 'keeps trimmed body')
  assert(out.trim().endsWith('[结束回报]'), 'ends with 结束回报')
}

// =============================================================================
//                    extract* / hasDone (legacy tag path)
// =============================================================================

section('extractHandoff / extractDelegate')
eq(extractHandoff('前言 <<HANDOFF>>做个登录页<</HANDOFF>> 后语'), '做个登录页', 'handoff body trimmed')
eq(extractHandoff('没有标签'), null, 'no handoff → null')
eq(extractDelegate('<<DELEGATE>>\n实现 A\n<</DELEGATE>>'), '实现 A', 'delegate body trimmed')
eq(extractDelegate('nope'), null, 'no delegate → null')

section('hasDone — case-insensitive presence')
assert(hasDone('收工 <<DONE>>'), 'detects DONE')
assert(hasDone('<<done>>'), 'case-insensitive')
assert(!hasDone('未完成'), 'absent → false')

section('wrapDelegate — round-trips through extractDelegate')
eq(extractDelegate(wrapDelegate('第一步')), '第一步', 'wrapDelegate is extractable')

// =============================================================================
//   Cross-check: bare <<DONE>> yields empty body in extractAction.
//   This is exactly why driveStateMachine forwards `found.body || finalText`
//   — a regression here would silently send the PM an empty [团队反馈].
// =============================================================================

section('extractAction — bare <<DONE>> body is empty (|| finalText rationale)')
{
  const bare = extractAction('结论写在标签后面 <<DONE>>', ['DONE', 'FAIL'])
  eq(bare, { action: 'DONE', body: '' }, 'bare DONE → empty body')
  const closed = extractAction('<<DONE>>都搞定了<</DONE>>', ['DONE', 'FAIL'])
  eq(closed, { action: 'DONE', body: '都搞定了' }, 'closed DONE → body captured')
}

// =============================================================================
//                       condenseError / blocksToPlainText
// =============================================================================

section('condenseError — first non-empty line, capped')
eq(condenseError('\n  first line  \nsecond line'), 'first line', 'picks first non-empty line')
{
  const long = 'x'.repeat(500)
  const out = condenseError(long)
  assert(out.length === 201 && out.endsWith('…'), 'caps long line at 200 + ellipsis')
}

section('blocksToPlainText — concatenates text blocks only')
{
  const blocks: MessageBlock[] = [
    { type: 'text', text: 'Hello ' },
    { type: 'image', data: 'xxx', mimeType: 'image/png' },
    { type: 'text', text: 'world' }
  ]
  eq(blocksToPlainText(blocks), 'Hello world', 'drops non-text blocks')
  eq(blocksToPlainText([]), '', 'empty → empty string')
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
