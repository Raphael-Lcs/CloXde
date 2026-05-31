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
  constructor(private embedder: Embedder = getEmbedder()) {}

  /** Embed and store a single memory. */
  async remember(input: RememberInput): Promise<AssistantMemory> {
    const [embedding] = await this.embedder.embed([input.content])
    return memoryRepo.insert({ ...input, embedding })
  }

  /** Batch variant — one embedding call for many memories. */
  async rememberMany(inputs: RememberInput[]): Promise<AssistantMemory[]> {
    if (inputs.length === 0) return []
    const embeddings = await this.embedder.embed(inputs.map((i) => i.content))
    return inputs.map((input, i) =>
      memoryRepo.insert({ ...input, embedding: embeddings[i] })
    )
  }

  /** Semantic recall. Returns the k memories most relevant to `query`,
   *  nearest first, and bumps their last_used_at so the decay pass keeps
   *  them. */
  async recall(
    query: string,
    opts?: { k?: number; kind?: MemoryKind }
  ): Promise<MemoryHit[]> {
    const k = opts?.k ?? 8
    const [embedding] = await this.embedder.embed([query])
    const hits = memoryRepo.searchByVector(embedding, k, { kind: opts?.kind })
    memoryRepo.touch(hits.map((h) => h.id))
    return hits
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

export function getMemoryService(): MemoryService {
  if (!singleton) singleton = new MemoryService()
  return singleton
}
