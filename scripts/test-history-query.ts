// Assertion harness for buildHistoryFtsQuery — the FTS5 (trigram) MATCH query
// builder for searching the assistant's own past thread.
//
// Pure function only — no DB, no native deps.
//
// Run with:  npx tsx scripts/test-history-query.ts
// Exit code = number of failures.

import { buildHistoryFtsQuery } from '../src/main/assistant/history-query'

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++
  } else {
    failed++
    failures.push(label)
  }
}

console.log('\n— buildHistoryFtsQuery — empty / unusable input returns null —\n')
assert(buildHistoryFtsQuery('') === null, 'empty string → null')
assert(buildHistoryFtsQuery('   ') === null, 'whitespace → null')
assert(buildHistoryFtsQuery('?! ,.') === null, 'punctuation only → null')
assert(buildHistoryFtsQuery('ab 你') === null, 'all terms shorter than trigram min → null')

console.log('\n— latin words ≥3 chars become quoted OR-terms —\n')
{
  const q = buildHistoryFtsQuery('deploy the script')
  // 'the' is 3 chars so it qualifies; 'deploy' and 'script' too.
  assert(q !== null, 'produces a query')
  assert(q!.includes('"deploy"'), 'includes deploy term')
  assert(q!.includes('"script"'), 'includes script term')
  assert(q!.includes(' OR '), 'OR-joins terms')
}

console.log('\n— latin shorter than 3 chars dropped —\n')
{
  const q = buildHistoryFtsQuery('go to ci')
  // 'go','to','ci' are all <3 → null
  assert(q === null, 'all <3-char latin → null')
}

console.log('\n— casing normalized to lower —\n')
{
  const q = buildHistoryFtsQuery('DEPLOY')
  assert(q === '"deploy"', `lowercased single term, got ${q}`)
}

console.log('\n— CJK runs become 3-char sliding windows —\n')
{
  const q = buildHistoryFtsQuery('部署脚本')
  // windows: 部署脚, 署脚本
  assert(q !== null, 'produces a query')
  assert(q!.includes('"部署脚"'), 'has first 3-char window')
  assert(q!.includes('"署脚本"'), 'has second 3-char window')
}
{
  const q = buildHistoryFtsQuery('记忆')
  assert(q === null, '2-char CJK run (below trigram min) → null')
}
{
  const q = buildHistoryFtsQuery('技能')
  assert(q === null, 'another 2-char CJK run → null')
}

console.log('\n— mixed latin + CJK —\n')
{
  const q = buildHistoryFtsQuery('用 Tailscale 远程访问')
  assert(q!.includes('"tailscale"'), 'latin term present, lowercased')
  assert(q!.includes('"远程访"'), 'CJK window present')
}

console.log('\n— quotes in input are escaped (no syntax break) —\n')
{
  const q = buildHistoryFtsQuery('say "hello" now')
  // term 'hello' extracted by \w; the surrounding quotes aren't part of the
  // word, so we just confirm output is well-formed quoted terms.
  assert(q !== null && /^("[^"]*"( OR "[^"]*")*)$/.test(q!), `well-formed OR list, got ${q}`)
}

console.log('\n— dedup + cap —\n')
{
  const q = buildHistoryFtsQuery('deploy deploy deploy')
  assert(q === '"deploy"', `duplicate terms folded, got ${q}`)
}
{
  // Long CJK run, maxTerms small → capped.
  const q = buildHistoryFtsQuery('一二三四五六七八九十', 3)
  const count = (q!.match(/ OR /g) || []).length + 1
  assert(count <= 3, `capped to maxTerms, got ${count}`)
}

console.log('\n============================================================')
console.log(`通过: ${passed}    失败: ${failed}`)
console.log('============================================================')
if (failures.length > 0) {
  console.log('失败项:')
  for (const f of failures) console.log('  ✗ ' + f)
}
process.exit(failed)
