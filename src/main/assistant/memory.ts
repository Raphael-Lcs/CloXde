// MemoryService is the assistant's interface to its long-term memory. It owns
// the embedder and bridges to the pure storage in memoryRepo: it embeds on
// write and embeds the query on recall. It does NOT decide *what* to remember
// — the assistant brain distills raw conversation into memory statements and
// calls remember(); this service just stores and retrieves them.

import { memoryRepo } from '../storage/db'
import type { AssistantMemory, MemoryHit, MemoryKind } from '@shared/types'
import { getEmbedder, type Embedder } from './embedder'

export interface RememberInput {
  kind: MemoryKind
  content: string
  source?: string
  confidence?: number
  pinned?: boolean
}

export class MemoryService {
  /** vec0 L2 distance below which two same-kind memories are treated as the
   *  same fact. Embeddings are L2-normalized, so L2² = 2(1−cos); 0.35 ≈ cosine
   *  0.94 — "restating the same thing", not merely "related". */
  private static readonly DEDUP_DISTANCE = 0.35

  constructor(private embedder: Embedder = getEmbedder()) {}

  /** Embed and store a single memory. Near-duplicate guard: the brain restates
   *  the same fact across turns, so before inserting we look for a near-identical
   *  memory of the SAME kind and, if found, fold the new statement into it
   *  (refresh content, reinforce confidence, re-embed) instead of piling up
   *  copies that crowd recall. */
  async remember(input: RememberInput): Promise<AssistantMemory> {
    const [embedding] = await this.embedder.embed([input.content])
    return this.upsert(input, embedding)
  }

  /** Batch variant — one embedding call for many memories. Items are upserted
   *  sequentially so a near-duplicate WITHIN the batch folds into the row the
   *  earlier item just wrote, not just duplicates already in the DB. */
  async rememberMany(inputs: RememberInput[]): Promise<AssistantMemory[]> {
    if (inputs.length === 0) return []
    const embeddings = await this.embedder.embed(inputs.map((i) => i.content))
    return inputs.map((input, i) => this.upsert(input, embeddings[i]))
  }

  /** Fold `input` into a near-identical same-kind memory if one exists, else
   *  insert. Shared by remember / rememberMany. */
  private upsert(input: RememberInput, embedding: Float32Array): AssistantMemory {
    const [nearest] = memoryRepo.searchByVector(embedding, 1, { kind: input.kind })
    if (nearest && nearest.distance < MemoryService.DEDUP_DISTANCE) {
      const confidence = Math.min(
        1,
        Math.max(nearest.confidence, input.confidence ?? 0.5) + 0.05
      )
      memoryRepo.patch(nearest.id, {
        content: input.content,
        confidence,
        source: input.source
      })
      memoryRepo.updateEmbedding(nearest.id, embedding)
      memoryRepo.touch([nearest.id])
      return memoryRepo.get(nearest.id) ?? memoryRepo.insert({ ...input, embedding })
    }
    return memoryRepo.insert({ ...input, embedding })
  }

  /** Semantic recall with composite ranking. Pure nearest-neighbour by vector
   *  distance ignores how much the assistant trusts a memory and how fresh it
   *  is — so a stale, low-confidence near-miss can crowd out a slightly-further
   *  but pinned, high-confidence fact. We over-fetch by distance, then re-rank by
   *  a blend of semantic similarity + confidence + recency (+ a pinned boost) and
   *  keep the top k. Only the returned k are touched, so ranking doesn't keep
   *  candidates we discarded alive against the decay pass. */
  async recall(
    query: string,
    opts?: { k?: number; kind?: MemoryKind }
  ): Promise<MemoryHit[]> {
    const k = opts?.k ?? 8
    const [embedding] = await this.embedder.embed([query])
    // Over-fetch so re-ranking has room to promote a high-value near-miss over a
    // closer-but-weaker hit; cap so a huge k can't pull the whole table.
    const fetchK = Math.min(Math.max(k * 4, k), 60)
    const candidates = memoryRepo.searchByVector(embedding, fetchK, { kind: opts?.kind })
    const now = Date.now()
    const ranked = candidates
      .map((h) => ({ h, score: MemoryService.score(h, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((r) => r.h)
    memoryRepo.touch(ranked.map((h) => h.id))
    return ranked
  }

  /** Composite relevance score for a recall hit. Delegates to the pure,
   *  unit-tested `scoreMemoryHit`. */
  private static score(hit: MemoryHit, now: number): number {
    return scoreMemoryHit(hit, now)
  }

  /** Rewrite a memory's content (re-embedding it) or its metadata. */
  async update(
    id: string,
    patch: { content?: string; confidence?: number; pinned?: boolean; source?: string }
  ): Promise<void> {
    memoryRepo.patch(id, patch)
    if (patch.content !== undefined) {
      const [embedding] = await this.embedder.embed([patch.content])
      memoryRepo.updateEmbedding(id, embedding)
    }
  }

  forget(id: string): void {
    memoryRepo.delete(id)
  }

  get(id: string): AssistantMemory | null {
    return memoryRepo.get(id)
  }

  list(opts?: { kind?: MemoryKind; limit?: number }): AssistantMemory[] {
    return memoryRepo.list(opts)
  }

  /** Decay pass: drop unpinned, low-confidence memories untouched for a while.
   *  Defaults: confidence < 0.35 and not recalled in 30 days. */
  prune(opts?: { staleDays?: number; maxConfidence?: number }): number {
    const staleDays = opts?.staleDays ?? 30
    return memoryRepo.pruneStale({
      staleBefore: Date.now() - staleDays * 24 * 60 * 60 * 1000,
      maxConfidence: opts?.maxConfidence ?? 0.35
    })
  }
}

let singleton: MemoryService | null = null

/** Half-life for recency decay — matches the 30-day staleness window the decay
 *  pass uses, so "fresh enough to survive pruning" and "fresh enough to rank
 *  well" stay aligned. */
export const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000

/** Pure composite relevance score for a recall hit (extracted for unit tests).
 *  Semantic similarity dominates; confidence and recency break ties and lift
 *  trusted/fresh facts; pinned gets a flat boost so user-anchored memories
 *  surface reliably. Embeddings are L2-normalized, so cos = 1 − d²/2. */
export function scoreMemoryHit(hit: MemoryHit, now: number): number {
  const sim = Math.max(0, Math.min(1, 1 - (hit.distance * hit.distance) / 2))
  const ageMs = now - (hit.lastUsedAt ?? hit.createdAt)
  const recency = Math.pow(0.5, Math.max(0, ageMs) / RECENCY_HALF_LIFE_MS)
  return 0.65 * sim + 0.2 * hit.confidence + 0.15 * recency + (hit.pinned ? 0.15 : 0)
}

export function getMemoryService(): MemoryService {
  if (!singleton) singleton = new MemoryService()
  return singleton
}
