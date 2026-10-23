import { describe, expect, it } from 'vitest'
import { compile } from '@markdown'
import {
  commandBlockHasDraftGap,
  isDraftPromptMarker,
  locatePromptBlock,
  pendingPromptDraftLines,
  planPromptInsertion,
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
