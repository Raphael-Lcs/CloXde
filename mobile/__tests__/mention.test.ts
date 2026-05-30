import { describe, expect, it } from '@jest/globals'
import {
  basenameOf,
  detectMention,
  dirnameOf,
  scoreFiles
} from '../src/utils/mention'

describe('detectMention', () => {
  it('detects an @token at the caret', () => {
    expect(detectMention('see @src', 8)).toEqual({ start: 4, query: 'src' })
  })

  it('detects an @ at the very start of the input', () => {
    expect(detectMention('@app', 4)).toEqual({ start: 0, query: 'app' })
  })

  it('returns an empty query right after a lone @', () => {
    expect(detectMention('hi @', 4)).toEqual({ start: 3, query: '' })
  })

  it('ignores an @ glued to a previous non-space char (e.g. emails)', () => {
    expect(detectMention('me@host', 7)).toBeNull()
  })

  it('does not match once whitespace follows the token', () => {
    expect(detectMention('@src now', 8)).toBeNull()
  })

  it('reads the query only up to the caret, not the whole word', () => {
    expect(detectMention('@components', 4)).toEqual({ start: 0, query: 'com' })
  })
})

describe('basenameOf / dirnameOf', () => {
  it('splits a nested path', () => {
    expect(basenameOf('src/utils/theme.ts')).toBe('theme.ts')
    expect(dirnameOf('src/utils/theme.ts')).toBe('src/utils')
  })

  it('treats a bare filename as having no directory', () => {
    expect(basenameOf('App.tsx')).toBe('App.tsx')
    expect(dirnameOf('App.tsx')).toBe('')
  })
})

describe('scoreFiles', () => {
  const files = [
    'src/utils/theme.ts',
    'src/screens/ChatScreen.tsx',
    'src/components/MessageBubble.tsx',
    'theme.config.js'
  ]

  it('returns the head of the list (capped) for an empty query', () => {
    expect(scoreFiles(files, '')).toEqual(files.slice(0, 30))
  })

  it('ranks a basename prefix match ahead of a path substring match', () => {
    // "theme" prefixes theme.config.js's basename and theme.ts's basename;
    // both beat any mere path-substring hit. Shorter path wins the tie.
    const ranked = scoreFiles(files, 'theme')
    expect(ranked[0]).toBe('theme.config.js')
    expect(ranked).toContain('src/utils/theme.ts')
  })

  it('matches case-insensitively', () => {
    expect(scoreFiles(files, 'CHAT')).toContain('src/screens/ChatScreen.tsx')
  })

  it('falls back to subsequence matching', () => {
    // "msgbub" is a subsequence of "messagebubble".
    expect(scoreFiles(files, 'msgbub')).toContain(
      'src/components/MessageBubble.tsx'
    )
  })

  it('excludes files that do not match at all', () => {
    expect(scoreFiles(files, 'zzz')).toEqual([])
  })
})
