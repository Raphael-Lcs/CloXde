// Builds an FTS5 MATCH query from a free-form user message, for full-text search
// over the assistant's own past thread (see assistantMessageRepo.searchHistory).
//
// The FTS index uses the `trigram` tokenizer — the only built-in tokenizer that
// handles Chinese, since unicode61 doesn't segment CJK. Trigram indexes every
// 3-character run, so a query term must be ≥3 chars to match anything; shorter
// terms are dropped rather than sent (a <3-char trigram query returns nothing).
//
// Strategy (recall-oriented — we want any related past message, then let bm25
// rank): pull out latin/digit words (≥3 chars) and, for CJK runs, every 3-char
// sliding window. Each term is quoted as an FTS5 string literal (internal quotes
// doubled) so arbitrary user input can't break the MATCH syntax, then OR-joined.
//
// Pure function — no DB, no native deps — so it is unit-tested directly.

const LATIN = /[a-z0-9]{3,}/gi
const CJK_RUN = /[一-鿿]+/g

/** Turn free text into a safe FTS5 (trigram) MATCH expression, or null when the
 *  text yields no usable term (e.g. too short / punctuation only). Terms are
 *  deduped and capped so a long message can't produce a pathological query. */
export function buildHistoryFtsQuery(text: string, maxTerms = 24): string | null {
  const terms = new Set<string>()
  for (const m of text.matchAll(LATIN)) {
    terms.add(m[0].toLowerCase())
    if (terms.size >= maxTerms) break
  }
  if (terms.size < maxTerms) {
    for (const m of text.matchAll(CJK_RUN)) {
      const run = m[0]
      const chars = Array.from(run)
      if (chars.length < 3) continue
      for (let i = 0; i + 3 <= chars.length; i++) {
        terms.add(chars.slice(i, i + 3).join(''))
        if (terms.size >= maxTerms) break
      }
      if (terms.size >= maxTerms) break
    }
  }
  if (terms.size === 0) return null
  return [...terms].map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}
