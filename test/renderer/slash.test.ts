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


it.each(['\r\n', '\r', '\n'])('uses raw offsets with %j line endings', (newline) => {
  const empty = `正文${newline}${newline}`
  expect(canStartSlash(empty + newline, empty.length)).toBe(true)
  const source = `${empty}/问${newline}第二行${newline}`
  const end = source.length - newline.length
  expect(slashAtCaret(source, end)).toEqual({ range: { start: empty.length, end }, prompt: `问${newline}第二行` })
})
it('finds a command after a mixed-style blank line and rejects a CR-only blank command paragraph', () => {
  const source = '前文\n\r\n/问'
  expect(slashAtCaret(source, source.length)?.range.start).toBe(source.indexOf('/'))
  expect(submittedSlash('/一\r\r二', 0, 5)).toBeNull()
})


it('starts and submits the first paragraph after a document BOM', () => {
  expect(canStartSlash('\ufeff', 1)).toBe(true)
  expect(slashAtCaret('\ufeff/问\r\n', 3)).toEqual({ range: { start: 1, end: 3 }, prompt: '问' })
})
