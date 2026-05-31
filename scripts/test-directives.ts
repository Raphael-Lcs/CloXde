// Assertion harness for the brain's directive parser (src/main/assistant/directives.ts).
//
// Pure functions only — no DB, no Electron. This is the riskiest seam in the
// assistant layer: a regex that mis-extracts a body, or fails to strip a tag,
// either drops an action or leaks raw `<<TAG>>` markup into the user-visible
// reply. The UPDATE/SCHEDULE tags (the newest) get particular attention, plus the
// [M#] ref normalization the brain uses to resolve FORGET/UPDATE targets.
//
// Run with:  npx tsx scripts/test-directives.ts
// Exit code = number of failures.

import { extractAll, stripDirectives } from '../src/main/assistant/directives'

let passed = 0
let failed = 0
const failures: string[] = []

function eq<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
    return
  }
  failed++
  failures.push(label)
  console.log(`  ✕ ${label}\n      expected=${JSON.stringify(expected)}\n      actual  =${JSON.stringify(actual)}`)
}

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

/** Mirror of the [M#] ref normalization in brain.ts (FORGET/UPDATE resolution):
 *  `M${String(parsed.ref).replace(/\D/g, '')}`. Tested here so the parse +
 *  resolution contract is exercised end-to-end without the DB. */
function normRef(ref: string): string {
  return `M${String(ref).replace(/\D/g, '')}`
}

// =============================================================================
//                                  TESTS
// =============================================================================

section('extractAll — single well-formed block')
eq(
  extractAll('<<REMEMBER>>{"kind":"fact","content":"x"}<</REMEMBER>>', 'REMEMBER'),
  ['{"kind":"fact","content":"x"}'],
  'one REMEMBER body extracted'
)

section('extractAll — UPDATE (new tag) with JSON body')
eq(
  extractAll('改进一下。<<UPDATE>>{"ref":"M3","content":"更好的步骤"}<</UPDATE>>', 'UPDATE'),
  ['{"ref":"M3","content":"更好的步骤"}'],
  'UPDATE body extracted, prose ignored'
)

section('extractAll — SCHEDULE (new tag), both forms')
eq(
  extractAll('<<SCHEDULE>>{"inMinutes":15,"note":"看构建"}<</SCHEDULE>>', 'SCHEDULE'),
  ['{"inMinutes":15,"note":"看构建"}'],
  'one-shot inMinutes form'
)
eq(
  extractAll('<<SCHEDULE>>{"cron":"0 9 * * *","note":"每早汇报"}<</SCHEDULE>>', 'SCHEDULE'),
  ['{"cron":"0 9 * * *","note":"每早汇报"}'],
  'recurring cron form'
)

section('extractAll — multiple blocks of same tag')
eq(
  extractAll(
    '<<SCHEDULE>>{"inMinutes":5,"note":"a"}<</SCHEDULE>> 中间话 <<SCHEDULE>>{"inMinutes":10,"note":"b"}<</SCHEDULE>>',
    'SCHEDULE'
  ),
  ['{"inMinutes":5,"note":"a"}', '{"inMinutes":10,"note":"b"}'],
  'two SCHEDULE blocks both captured'
)

section('extractAll — missing closing tag, runs to next tag')
// Model dropped the closer; body must stop at the next `<<` tag, not swallow it.
eq(
  extractAll('<<UPDATE>>{"ref":"M2","content":"y"}<<REMEMBER>>{"content":"z"}', 'UPDATE'),
  ['{"ref":"M2","content":"y"}'],
  'UPDATE without closer stops at next tag'
)
eq(
  extractAll('<<UPDATE>>{"ref":"M2","content":"y"}<<REMEMBER>>{"content":"z"}', 'REMEMBER'),
  ['{"content":"z"}'],
  'following REMEMBER still extractable'
)

section('extractAll — missing closing tag at end of text')
eq(
  extractAll('收尾。<<REPORT>>构建已完成', 'REPORT'),
  ['构建已完成'],
  'REPORT without closer runs to end'
)

section('extractAll — absent tag yields empty')
eq(extractAll('就是一句普通回复，没有任何标签。', 'DISPATCH'), [], 'no tag -> []')
eq(extractAll('<<SCHEDULE>><</SCHEDULE>>', 'SCHEDULE'), [], 'empty body dropped')

section('extractAll — case-insensitive tag match')
eq(
  extractAll('<<schedule>>{"inMinutes":1,"note":"lc"}<</schedule>>', 'SCHEDULE'),
  ['{"inMinutes":1,"note":"lc"}'],
  'lowercase tag still matched'
)

section('stripDirectives — removes every tag kind, keeps prose')
{
  const raw =
    '好的，我来安排。' +
    '<<REMEMBER>>{"kind":"fact","content":"a"}<</REMEMBER>>' +
    '<<UPDATE>>{"ref":"M1","content":"b"}<</UPDATE>>' +
    '<<SCHEDULE>>{"inMinutes":15,"note":"c"}<</SCHEDULE>>' +
    '<<FORGET>>{"ref":"M2"}<</FORGET>>' +
    '<<DISPATCH>>{"name":"p","brief":"d"}<</DISPATCH>>' +
    '<<CONTINUE>>{"conversationId":"x","message":"e"}<</CONTINUE>>' +
    '<<REPORT>>f<</REPORT>>' +
    '已处理。'
  eq(stripDirectives(raw), '好的，我来安排。已处理。', 'all 7 tag kinds stripped, prose joined')
}

section('stripDirectives — UPDATE/SCHEDULE without closer also stripped')
eq(
  stripDirectives('剩下的我盯着。<<SCHEDULE>>{"inMinutes":30,"note":"g"}'),
  '剩下的我盯着。',
  'unclosed SCHEDULE fully removed (no leaked markup)'
)
assert(
  !stripDirectives('文字<<UPDATE>>{"ref":"M1","content":"h"}').includes('<<'),
  'no residual << after stripping unclosed UPDATE'
)

section('stripDirectives — pure prose untouched')
eq(
  stripDirectives('这只是普通回复，应当原样保留。'),
  '这只是普通回复，应当原样保留。',
  'no tags -> unchanged'
)

section('stripDirectives — collapses blank-line runs from removed blocks')
eq(
  stripDirectives('第一行\n\n<<REMEMBER>>{"content":"x"}<</REMEMBER>>\n\n第二行'),
  '第一行\n\n第二行',
  'triple+ newlines collapsed to double'
)

section('[M#] ref normalization (matches brain.ts resolution)')
eq(normRef('M3'), 'M3', '"M3" -> M3')
eq(normRef('3'), 'M3', 'bare "3" -> M3')
eq(normRef('[M3]'), 'M3', '"[M3]" -> M3')
eq(normRef('m12'), 'M12', 'lowercase + multidigit -> M12')

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
