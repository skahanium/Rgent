import { describe, expect, it } from 'vitest'
import { canStartSlash, slashAtCaret, submittedSlash } from '../../src/renderer/src/slash.ts'

describe('inline slash command', () => {
  it('finds a pending slash paragraph after text and Shift+Enter without treating headings as commands', () => {
    const source = '正文\n\n/第一行\n第二行\n\n后文'
    const end = source.indexOf('\n\n后文')
    expect(slashAtCaret(source, end)?.prompt).toBe('第一行\n第二行')
    expect(slashAtCaret('## /标题', '## /标题'.length)).toBeNull()
  })
  it('starts only at the beginning of an empty paragraph', () => {
    expect(canStartSlash('', 0)).toBe(true)
    expect(canStartSlash('text\n\n', 6)).toBe(true)
    expect(canStartSlash('text', 4)).toBe(false)
    expect(canStartSlash('  ', 1)).toBe(false)
    expect(canStartSlash('text\n', 5)).toBe(false)
  })

  it('submits multiline text without the trigger slash', () => {
    const source = 'before\n\n/拆成两段\n给出例子\n\nafter'
    const end = source.indexOf('\n\n', 8)
    expect(submittedSlash(source, 8, end)).toEqual({
      range: { start: 8, end },
      prompt: '拆成两段\n给出例子'
    })
    expect(submittedSlash('/   ', 0, 4)).toBeNull()
    expect(submittedSlash('/a\n\nb', 0, 5)).toBeNull()
  })
})
