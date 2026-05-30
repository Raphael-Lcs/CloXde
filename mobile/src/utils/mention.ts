// Pure helpers backing the composer's @file autocomplete. Extracted from
// ChatScreen so they can be unit-tested without rendering the native tree.
// Mirrors the desktop Composer's matching logic — keep the two in sync.

export interface Mention {
  start: number
  query: string
}

/** Find an in-progress `@token` ending at the caret. The `@` must sit at the
 *  start of the input or right after whitespace; the token is whitespace-free. */
export function detectMention(text: string, caret: number): Mention | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') {
      const prev = i > 0 ? text[i - 1] : ''
      if (i === 0 || /\s/.test(prev)) return { start: i, query: text.slice(i + 1, caret) }
      return null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

export function basenameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

export function dirnameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function isSubsequence(hay: string, needle: string): boolean {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++
  }
  return i === needle.length
}

/** Rank files against an @-query: basename prefix beats basename substring
 *  beats full-path substring beats subsequence; ties break on shorter path. */
export function scoreFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase()
  if (!q) return files.slice(0, 30)
  const scored: { path: string; score: number }[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    const base = basenameOf(lower)
    let score = -1
    if (base.startsWith(q)) score = 0
    else if (base.includes(q)) score = 1
    else if (lower.includes(q)) score = 2
    else if (isSubsequence(lower, q)) score = 3
    if (score >= 0) scored.push({ path, score })
  }
  scored.sort(
    (a, b) =>
      a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path)
  )
  return scored.map((s) => s.path)
}
