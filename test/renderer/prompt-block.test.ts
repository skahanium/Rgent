import { describe, expect, it } from 'vitest'
import { compile } from '@markdown'
import {
  commandBlockHasDraftGap,
  draftPromptBecameEmpty,
  draftPrompts,
  firstMarker,
  isDraftPromptMarker,
  locatePendingPrompt,
  locatePromptBlock,
  pendingPromptDraftLines,
  planPendingPromptInsertion,
  planPendingPromptRemoval,
  planPromptInsertion,
  removeDraftMarker,
  type PromptBlockOptions
} from '../../src/renderer/src/prompt-block.ts'

const MARKER = '<!-- rgent:prompt:v1 state="draft" -->'
const SENT = '<!-- rgent:prompt:v1 task-id="task-1" -->'

function indexOf(source: string) {
  return compile(source).index
}

function plan(source: string, caret: number, options?: PromptBlockOptions) {
  return planPromptInsertion(source, indexOf(source), caret, options)
}

function apply(source: string, insertion: ReturnType<typeof plan>): string {
  return source.slice(0, insertion.edit.from) + insertion.edit.insert + source.slice(insertion.edit.to)
}

function locate(source: string, caret: number) {
  return locatePromptBlock(source, indexOf(source), caret)
}

describe('prompt block insertion', () => {
  it('reuses a top-level empty paragraph instead of adding another blank line', () => {
    const source = '正文\n\n'
    const insertion = plan(source, source.length)
    expect(insertion.edit).toEqual({ from: source.length, to: source.length, insert: `${MARKER}\n` })
    expect(apply(source, insertion)).toBe(`正文\n\n${MARKER}\n`)
    expect(insertion.caret).toBe(source.length + MARKER.length + 1)
  })

  it('inserts after a non-empty top-level block with one blank line on each side', () => {
    const source = '甲\n\n乙\n'
    const insertion = plan(source, 1)
    expect(apply(source, insertion)).toBe(`甲\n\n${MARKER}\n\n\n乙\n`)
    // 插入后光标落在 marker 下面那行提问行上。
    expect(insertion.caret).toBe(2 + 1 + MARKER.length + 1)
  })

  it('inserts after the whole list, quote or code block instead of cutting it', () => {
    const cases = [
      '甲\n\n- 一\n- 二\n',
      '甲\n\n> 引用\n',
      '甲\n\n```ts\nconst a = 1\n```\n'
    ]
    for (const source of cases) {
      const caret = source.indexOf('一') >= 0 ? source.indexOf('一')
        : source.indexOf('引用') >= 0 ? source.indexOf('引用')
          : source.indexOf('const')
      const insertion = plan(source, caret)
      const result = apply(source, insertion)
      expect(result).toBe(`${source}\n${MARKER}\n`)
      expect(result.indexOf(MARKER)).toBeGreaterThan(source.lastIndexOf('```') >= 0 ? source.lastIndexOf('```') : 0)
    }
  })

  it('keeps CRLF and puts the prompt line at the caret', () => {
    const source = '甲\r\n\r\n乙\r\n'
    const insertion = plan(source, 1)
    expect(insertion.edit.insert).not.toMatch(/[^\r]\n/)
    expect(apply(source, insertion)).toBe(`甲\r\n\r\n${MARKER}\r\n\r\n\r\n乙\r\n`)
    expect(insertion.caret).toBe(3 + 2 + MARKER.length + 2)
  })

  it('keeps a BOM before the first paragraph when inserting after it', () => {
    const source = '\ufeff甲\r\n'
    const insertion = plan(source, 2)
    expect(apply(source, insertion)).toBe(`\ufeff甲\r\n\r\n${MARKER}\r\n`)
    expect(apply(source, insertion).startsWith('\ufeff甲')).toBe(true)
  })

  it('handles EOF with and without a trailing newline', () => {
    expect(apply('甲', plan('甲', 1))).toBe(`甲\n\n${MARKER}\n`)
    expect(apply('甲\n', plan('甲\n', 1))).toBe(`甲\n\n${MARKER}\n`)
    expect(apply('', plan('', 0))).toBe(`${MARKER}\n`)
  })

  it('creates an empty draft on a top-level blank line between paragraphs', () => {
    const source = '甲\n\n乙\n'
    const insertion = plan(source, 2)
    expect(apply(source, insertion)).toBe(`甲\n\n${MARKER}\n\n\n乙\n`)
    expect(insertion.caret).toBe(2 + 1 + MARKER.length + 1)
  })

  it('reuses the last empty line at EOF without inventing a third newline', () => {
    const source = '甲\n\n'
    const insertion = plan(source, source.length)
    expect(apply(source, insertion)).toBe(`甲\n\n${MARKER}\n`)
  })

  it('inserts pause-resend text byte for byte after the last block', () => {
    const source = '甲\r\n'
    const text = '问\r\n答'
    const insertion = plan(source, 0, { at: 'end', text })
    expect(apply(source, insertion)).toBe(`甲\r\n\r\n${MARKER}\r\n${text}\r\n`)
    expect(insertion.caret).toBe(3 + 2 + MARKER.length + 2 + text.length)
    // text 里的 CRLF 原样保留，没有按文件换行风格改写。
    expect(apply(source, insertion).slice(-text.length - 2)).toBe(`${text}\r\n`)
  })

  it('can still insert empty text at the end of an empty note', () => {
    const insertion = plan('', 0, { at: 'end' })
    expect(apply('', insertion)).toBe(`${MARKER}\n`)
  })
})

describe('prompt block lookup', () => {
  it('returns the draft paragraph and prompt without the marker', () => {
    const source = `前文\n\n${MARKER}\n问\n\n后文\n`
    const start = source.indexOf('问')
    const found = locate(source, start)
    expect(found).toEqual({
      range: { start, end: start + 1 },
      prompt: '问',
      empty: false,
      marker: { start: source.indexOf(MARKER), end: source.indexOf(MARKER) + MARKER.length },
      draft: true
    })
    expect(locate(source, start + 1)?.prompt).toBe('问')
    expect(locate(source, 0)).toBeNull()
  })

  it('returns an empty draft line and requires the caret to be on it', () => {
    const source = `甲\n\n${MARKER}\n\n\n乙\n`
    const line = source.indexOf(MARKER) + MARKER.length + 1
    expect(locate(source, line)).toEqual({
      range: { start: line, end: line },
      prompt: '',
      empty: true,
      marker: { start: source.indexOf(MARKER), end: source.indexOf(MARKER) + MARKER.length },
      draft: true
    })
    expect(locate(source, source.indexOf('乙'))).toBeNull()
    expect(locate(source, line + 1)).toBeNull()
  })

  it('recognizes an upgraded marker as sent and returns null from the draft lookup', () => {
    const source = `前文\n\n${SENT}\n问\n`
    const index = indexOf(source)
    const block = index.blocks.find((item) => item.identity === 'command')!
    expect(block).toBeTruthy()
    const marker = index.markers[0]!
    expect(isDraftPromptMarker(source, marker)).toBe(false)
    expect(locate(source, source.indexOf('问'))).toBeNull()
    expect(commandBlockHasDraftGap(source, index, block.range)).toBe(false)
  })

  it('does not treat the block after a non-adjacent draft marker as the prompt', () => {
    const source = `甲\n\n${MARKER}\n\n\n乙\n`
    const index = indexOf(source)
    const block = index.blocks.find((item) => item.identity === 'command')!
    expect(commandBlockHasDraftGap(source, index, block.range)).toBe(true)
    expect(locate(source, source.indexOf('乙'))).toBeNull()
    expect(pendingPromptDraftLines(source, index)).toEqual([source.indexOf(MARKER) + MARKER.length + 1])
  })

  it('does not treat a slash paragraph as a prompt block anymore', () => {
    const source = '/问\n\n正文\n'
    expect(locate(source, 1)).toBeNull()
    expect(pendingPromptDraftLines(source, indexOf(source))).toEqual([])
  })

  it('finds the draft after its marker is upgraded only until the attrs change', () => {
    const draft = `甲\n\n${MARKER}\n问\n`
    const sent = draft.replace(MARKER, SENT)
    expect(locate(draft, draft.indexOf('问'))?.prompt).toBe('问')
    expect(locate(sent, sent.indexOf('问'))).toBeNull()
    // 行类由身份渲染，升级后仍是 command。
    expect(indexOf(sent).blocks.find((item) => item.identity === 'command')?.type).toBe('paragraph')
  })
})

describe('pending prompt insertion (F1: no marker until first input)', () => {
  function pending(source: string, caret = source.length) {
    return planPendingPromptInsertion(source, indexOf(source), caret)
  }

  it('leaves an empty note empty and never writes a marker', () => {
    const insertion = pending('', 0)
    expect(insertion.edit).toEqual({ from: 0, to: 0, insert: '' })
    expect(insertion.caret).toBe(0)
    expect(apply('', insertion)).toBe('')
    expect(apply('', insertion)).not.toContain('rgent:prompt')
  })

  it('inserts only blank lines after a paragraph', () => {
    const source = '甲\n'
    const insertion = pending(source, 1)
    expect(apply(source, insertion)).toBe('甲\n\n')
    expect(apply(source, insertion)).not.toContain('rgent:prompt')
    expect(insertion.caret).toBe(3)
  })

  it('surrounds the pending line with blank lines between paragraphs', () => {
    const source = '甲\n\n乙\n'
    const insertion = pending(source, 1)
    expect(apply(source, insertion)).toBe('甲\n\n\n\n乙\n')
    expect(insertion.caret).toBe(3)
    // 目标行两侧都是空行：首次落字后自成一段，不并入甲／乙。
    expect(apply(source, insertion).slice(insertion.caret - 1, insertion.caret + 1)).toBe('\n\n')
  })

  it('reuses a blank line that already has blank neighbours without any edit', () => {
    const source = '甲\n\n\n\n乙\n'
    const insertion = pending(source, 3)
    expect(insertion.edit).toEqual({ from: 3, to: 3, insert: '' })
    expect(insertion.caret).toBe(3)
  })

  it('keeps CRLF when creating the pending line', () => {
    const insertion = pending('甲\r\n', 1)
    expect(insertion.edit).toEqual({ from: 3, to: 3, insert: '\r\n' })
    expect(insertion.edit.insert).not.toMatch(/[^\r]\n/)
    expect(insertion.caret).toBe(5)
    expect(apply('甲\r\n', insertion)).toBe('甲\r\n\r\n')
  })

  it('keeps BOM and EOF without a trailing newline', () => {
    const bom = pending('\ufeff甲\r\n', 2)
    expect(apply('\ufeff甲\r\n', bom).startsWith('\ufeff甲')).toBe(true)
    expect(apply('\ufeff甲\r\n', bom)).toBe('\ufeff甲\r\n\r\n')
    expect(apply('甲', pending('甲', 1))).toBe('甲\n\n')
  })
})

describe('pending prompt lookup and removal', () => {
  it('locates the empty pending line without a marker', () => {
    const source = '甲\n\n\n\n乙\n'
    expect(locatePendingPrompt(source, 3, 3)).toEqual({
      range: { start: 3, end: 3 },
      prompt: '',
      empty: true
    })
    expect(locatePendingPrompt(source, 3, 2)).toBeNull()
    expect(locatePendingPrompt(source, 2, 3)).toBeNull()
  })

  it('returns body text typed before the marker lands', () => {
    const source = '甲\n\n问\n\n乙\n'
    expect(locatePendingPrompt(source, 3, 4)).toEqual({
      range: { start: 3, end: 4 },
      prompt: '问',
      empty: false
    })
  })

  it('removes only the empty pending line', () => {
    expect(planPendingPromptRemoval('甲\n\n\n\n乙\n', 3)).toEqual({ from: 3, to: 4, insert: '' })
    expect(planPendingPromptRemoval('甲\n', 2)).toBeNull()
    expect(planPendingPromptRemoval('甲\n\n \n乙\n', 3)).toEqual({ from: 3, to: 5, insert: '' })
  })
})

describe('first marker, draft empty rollback', () => {
  it('inserts the draft marker above the first non-blank input', () => {
    expect(firstMarker('问\n', 0)).toEqual({ from: 0, to: 0, insert: `${MARKER}\n` })
    expect(firstMarker('甲\n\n问\n', 3)).toEqual({ from: 3, to: 3, insert: `${MARKER}\n` })
    expect(firstMarker('甲\n\n\n', 3)).toBeNull()
    expect(firstMarker('   \n', 0)).toBeNull()
  })

  it('keeps CRLF and a leading BOM', () => {
    expect(firstMarker('甲\r\n\r\n问\r\n', 5)).toEqual({ from: 5, to: 5, insert: `${MARKER}\r\n` })
    expect(firstMarker('\ufeff问\n', 1)).toEqual({ from: 1, to: 1, insert: `${MARKER}\n` })
  })

  it('removes only the marker line when the body is emptied', () => {
    const source = `${MARKER}\n\n乙\n`
    const marker = indexOf(source).markers[0]!
    expect(removeDraftMarker(source, marker.range)).toEqual({ from: 0, to: MARKER.length + 1, insert: '' })
    const crlf = `\ufeff${MARKER}\r\n\r\n乙`
    const crlfMarker = indexOf(crlf).markers[0]!
    expect(removeDraftMarker(crlf, crlfMarker.range)).toEqual({
      from: 1,
      to: 1 + MARKER.length + 2,
      insert: ''
    })
  })

  it('lists adjacent drafts and only rolls back non-empty to empty', () => {
    const source = `甲\n\n${MARKER}\n问\n\n${SENT}\n已发送\n`
    const drafts = draftPrompts(source, indexOf(source))
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ prompt: '问', empty: false })
    expect(draftPromptBecameEmpty(drafts[0], { empty: true })).toBe(true)
    expect(draftPromptBecameEmpty({ empty: true }, { empty: true })).toBe(false)
    expect(draftPromptBecameEmpty(drafts[0], null)).toBe(false)
  })

  it('lists an empty draft with no Markdown block as the line under its marker', () => {
    const source = `甲\n\n${MARKER}\n\n\n乙\n`
    const index = indexOf(source)
    const line = source.indexOf(MARKER) + MARKER.length + 1
    expect(draftPrompts(source, index)).toMatchObject([
      { prompt: '', empty: true, range: { start: line, end: line } }
    ])
  })
})
