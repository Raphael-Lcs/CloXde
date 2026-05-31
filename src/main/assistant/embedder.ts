// Embedders turn memory text into vectors for semantic recall. The dimension
// is fixed at 384 to match the vec0 table created in migration v11 — changing
// the embedder's output dimension requires a new migration.
//
// Two implementations:
//   • LocalEmbedder — a MiniLM-class model run in-process via transformers.js.
//     Fully local (no API key, no external service); the model downloads once
//     and is cached on disk. This is the default.
//   • HashEmbedder — a dependency-free feature-hashing fallback. It produces
//     stable vectors but carries NO semantic meaning, so recall degrades to
//     "exact-ish token overlap". Used when the model can't load, and in tests
//     that must not pull the native model runtime.

export const EMBED_DIM = 384

export interface Embedder {
  readonly dimension: number
  /** Embed a batch of texts, preserving order. */
  embed(texts: string[]): Promise<Float32Array[]>
}

function l2normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}

// FNV-1a — small, fast, good enough for feature hashing.
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export class HashEmbedder implements Embedder {
  readonly dimension = EMBED_DIM

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vec = new Float32Array(this.dimension)
      const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
      for (const tok of tokens) {
        const h = fnv1a(tok)
        const idx = h % this.dimension
        // Sign from a separate hash bit so collisions partly cancel.
        const sign = (h & 0x80000000) !== 0 ? -1 : 1
        vec[idx] += sign
      }
      return l2normalize(vec)
    })
  }
}

export class LocalEmbedder implements Embedder {
  readonly dimension = EMBED_DIM
  private static readonly MODEL = 'Xenova/all-MiniLM-L6-v2'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractorPromise: Promise<any> | null = null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getExtractor(): Promise<any> {
    if (!this.extractorPromise) {
      this.extractorPromise = import('@huggingface/transformers').then((tf) => {
        // huggingface.co is unreachable on some networks (e.g. mainland China),
        // so default to a mirror; HF_ENDPOINT overrides. The model is cached on
        // disk after the first download, so this only matters on first run.
        tf.env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com'
        return tf.pipeline('feature-extraction', LocalEmbedder.MODEL)
      })
    }
    return this.extractorPromise
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const extractor = await this.getExtractor()
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    const rows = output.tolist() as number[][]
    return rows.map((r) => Float32Array.from(r))
  }
}

let singleton: Embedder | null = null

/** The process-wide embedder. Tries the local model once; if it fails to
 *  load (missing dep, offline first-run, native error) it logs and falls back
 *  to the hash embedder so memory still functions, just without semantics. */
export function getEmbedder(): Embedder {
  if (singleton) return singleton
  const local = new LocalEmbedder()
  // Probe lazily on first embed; wrap so a load failure degrades gracefully.
  singleton = {
    dimension: EMBED_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      try {
        return await local.embed(texts)
      } catch (err) {
        console.error('[embedder] local model failed, falling back to hash:', err)
        const fallback = new HashEmbedder()
        singleton = fallback
        return fallback.embed(texts)
      }
    }
  }
  return singleton
}
