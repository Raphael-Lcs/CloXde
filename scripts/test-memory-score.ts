// Assertion harness for the assistant memory recall score (scoreMemoryHit).
//
// Recall over-fetches by vector distance, then re-ranks by this composite score
// so a stale/low-confidence near-miss can't crowd out a pinned, high-confidence,
// fresh fact. This pins down the documented ordering properties.
//
// Pure function only — no DB, no embedder.
//
// Run with:  npx tsx scripts/test-memory-score.ts
// Exit code = number of failures.

import { scoreMemoryHit, RECENCY_HALF_LIFE_MS } from '../src/main/assistant/memory'
import type { MemoryHit } from '../src/shared/types'

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

const NOW = 1_000_000_000_000

/** Build a hit with sensible defaults; override any field. */
function hit(over: Partial<MemoryHit>): MemoryHit {
  return {
    id: 'm',
    kind: 'fact',
    content: 'x',
    confidence: 0.5,
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: NOW,
    distance: 0.2,
    ...over
  }
}

section('scoreMemoryHit — distance (semantic) ordering')
assert(
  scoreMemoryHit(hit({ distance: 0.1 }), NOW) > scoreMemoryHit(hit({ distance: 0.9 }), NOW),
  'closer distance -> higher score'
)

section('scoreMemoryHit — confidence ordering')
assert(
  scoreMemoryHit(hit({ confidence: 0.9 }), NOW) > scoreMemoryHit(hit({ confidence: 0.1 }), NOW),
  'higher confidence -> higher score (equal else)'
)

section('scoreMemoryHit — pinned boost')
assert(
  scoreMemoryHit(hit({ pinned: true }), NOW) > scoreMemoryHit(hit({ pinned: false }), NOW),
  'pinned -> higher score (equal else)'
)
assert(
  Math.abs(
    scoreMemoryHit(hit({ pinned: true }), NOW) - scoreMemoryHit(hit({ pinned: false }), NOW) - 0.15
  ) < 1e-9,
  'pinned boost is exactly 0.15'
)

section('scoreMemoryHit — recency decay')
assert(
  scoreMemoryHit(hit({ lastUsedAt: NOW }), NOW) >
    scoreMemoryHit(hit({ lastUsedAt: NOW - 60 * RECENCY_HALF_LIFE_MS }), NOW),
  'fresher -> higher score'
)
// At exactly one half-life, recency term halves: score drops by 0.15 * 0.5.
{
  const fresh = scoreMemoryHit(hit({ lastUsedAt: NOW }), NOW)
  const oneHalfLife = scoreMemoryHit(hit({ lastUsedAt: NOW - RECENCY_HALF_LIFE_MS }), NOW)
  assert(Math.abs(fresh - oneHalfLife - 0.15 * 0.5) < 1e-9, 'one half-life drops score by 0.075')
}
// Falls back to createdAt when lastUsedAt is absent.
assert(
  scoreMemoryHit(hit({ lastUsedAt: undefined, createdAt: NOW }), NOW) >
    scoreMemoryHit(hit({ lastUsedAt: undefined, createdAt: NOW - 60 * RECENCY_HALF_LIFE_MS }), NOW),
  'no lastUsedAt -> uses createdAt for recency'
)

section('scoreMemoryHit — similarity clamps at 0 for far hits')
{
  // distance 2 -> 1 - 4/2 = -1, clamped to 0; conf 0, ancient, unpinned -> ~0.
  const s = scoreMemoryHit(
    hit({ distance: 2, confidence: 0, pinned: false, lastUsedAt: NOW - 1000 * RECENCY_HALF_LIFE_MS }),
    NOW
  )
  assert(s >= 0 && s < 1e-6, 'far/weak/ancient hit -> ~0, never negative')
}

console.log('\n' + '='.repeat(60))
console.log(`通过: ${passed}    失败: ${failed}`)
if (failed > 0) {
  console.log('\n失败明细:')
  for (const f of failures) console.log('  • ' + f)
}
console.log('='.repeat(60))
process.exit(failed > 0 ? 1 : 0)
