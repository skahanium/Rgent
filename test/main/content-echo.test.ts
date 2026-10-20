import { describe, expect, it } from 'vitest'
import { SHINGLE_WORDS, buildShingles, containsEcho } from '../../src/main/content-echo.ts'

describe('content echo shingles', () => {
  it('hits an 8-word shingle from the authorized text and misses unrelated words', () => {
    const shingles = buildShingles(['the quick brown fox jumps over the lazy dog and then some more words'])
    expect(SHINGLE_WORDS).toBe(8)
    expect(containsEcho(shingles, 'https://example.com/the-quick-brown-fox-jumps-over-the-lazy-dog')).toBe(true)
    expect(containsEcho(shingles, 'https://example.com/unrelated-content-entirely')).toBe(false)
    expect(containsEcho(new Set(), 'the quick brown fox jumps over the lazy dog')).toBe(false)
    expect(containsEcho(shingles, '')).toBe(false)
  })

  it('splits Chinese into single-character tokens so eight characters make one shingle', () => {
    const shingles = buildShingles(['这是一段中文正文，用来检测偷渡。'])
    expect(containsEcho(shingles, 'https://example.com/这是一段中文正文')).toBe(true)
    expect(containsEcho(shingles, 'https://example.com/完全不同的一段内容')).toBe(false)
  })

  it('still hits after percent-encoding the outgoing value', () => {
    const shingles = buildShingles(['这是一段中文正文，用来检测偷渡。'])
    const encoded = encodeURIComponent('https://example.com/这是一段中文正文')
    expect(encoded).toContain('%')
    expect(containsEcho(shingles, encoded)).toBe(true)
  })

  it('dedupes shingles and stops at the cap', () => {
    const text = 'a b c d e f g h i j k l m n o p'
    const once = buildShingles([text])
    expect(once.size).toBe(9)
    expect([...once][0]).toMatch(/^[a-f0-9]{16}$/)
    expect(buildShingles([text, text]).size).toBe(once.size)
    expect(buildShingles([text], 4).size).toBe(4)
    expect(buildShingles([text], 0).size).toBe(0)
    expect(buildShingles([]).size).toBe(0)
  })
})
