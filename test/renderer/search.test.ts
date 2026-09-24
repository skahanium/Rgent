import { describe, expect, it } from 'vitest'
import { highlightParts } from '../../src/renderer/src/search.ts'

describe('highlightParts', () => {
  it('splits around a match in the middle', () => {
    expect(highlightParts('今天讨论了发布节奏，偏慢。', 5, 4)).toEqual({
      before: '今天讨论了',
      hit: '发布节奏',
      after: '，偏慢。'
    })
  })

  it('handles a match at the start', () => {
    expect(highlightParts('发布节奏偏慢', 0, 4)).toEqual({
      before: '',
      hit: '发布节奏',
      after: '偏慢'
    })
  })

  it('handles a match touching the end', () => {
    expect(highlightParts('会议纪要', 2, 2)).toEqual({ before: '会议', hit: '纪要', after: '' })
  })

  it('clamps offsets past the end instead of producing undefined', () => {
    expect(highlightParts('短', 9, 4)).toEqual({ before: '短', hit: '', after: '' })
    expect(highlightParts('短', -3, 1)).toEqual({ before: '', hit: '短', after: '' })
  })

  it('treats a zero length match as an insertion point', () => {
    expect(highlightParts('abc', 1, 0)).toEqual({ before: 'a', hit: '', after: 'bc' })
  })
})
