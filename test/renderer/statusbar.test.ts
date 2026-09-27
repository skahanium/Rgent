import { describe, expect, it } from 'vitest'
import { compile } from '../../src/markdown/index.ts'
import { wordsOf } from '../../src/renderer/src/statusbar.ts'

describe('status bar word count', () => {
  it('counts CJK characters and Latin or numeric runs in the note body', () => {
    expect(wordsOf('你好 world v0', [])).toBe(4)
  })

  it('does not count identity marker syntax while keeping the marked prose', () => {
    const body = '甲。\n\n<!-- rgent:prompt:v1 -->\n你好 world\n'
    expect(wordsOf(body, compile(body).index.markers)).toBe(4)
  })

  it('does not count punctuation or whitespace', () => {
    expect(wordsOf(' \n\t。，！ ', [])).toBe(0)
  })
})
