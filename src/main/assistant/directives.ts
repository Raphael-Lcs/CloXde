// Pure parsing of the brain's directive tags. Kept free of any electron/db/runtime
// imports so it can be unit-tested directly (scripts/test-directives.ts) and reused
// without dragging the whole brain module graph.
//
// The brain emits its natural-language reply interleaved with `<<TAG>> body <</TAG>>`
// blocks (DISPATCH/CONTINUE/REMEMBER/FORGET/UPDATE/SCHEDULE/REPORT). The closing tag
// is optional: a body runs until the next tag or end of text — lenient on purpose,
// since the model sometimes drops the closer.

/** All directive tags the brain may emit, in one place so extract + strip stay in
 *  sync (a tag stripped from the reply but not extractable, or vice-versa, is a bug). */
export const DIRECTIVE_TAGS = [
  'DISPATCH',
  'CONTINUE',
  'REMEMBER',
  'FORGET',
  'UPDATE',
  'SCHEDULE',
  'REPORT'
] as const

/** Collect all `<<TAG>> body <</TAG>>` blocks for a tag (closing optional, body
 *  runs to the next tag or end — same lenient convention as the team parser). */
export function extractAll(text: string, tag: string): string[] {
  const re = new RegExp(`<<${tag}>>([\\s\\S]*?)(?:<<\\/${tag}>>|(?=<<\\/?[A-Za-z])|$)`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const body = (m[1] ?? '').trim()
    if (body) out.push(body)
  }
  return out
}

/** Remove all directive tag blocks from the brain's output, leaving just the
 *  natural-language reply (what we surface to the user). */
export function stripDirectives(text: string): string {
  const re = new RegExp(
    `<<(${DIRECTIVE_TAGS.join('|')})>>[\\s\\S]*?(?:<<\\/\\1>>|(?=<<\\/?[A-Za-z])|$)`,
    'gi'
  )
  return text
    .replace(re, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
