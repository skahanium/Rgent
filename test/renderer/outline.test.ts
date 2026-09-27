import { describe, expect, it } from 'vitest'
import { outlineLabel, outlineMarks } from '../../src/renderer/src/outline.ts'
import { isApple, shortcutFor, shortcutLabel } from '../../src/renderer/src/shortcuts.ts'

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init } as KeyboardEvent
}

describe('标题索引', () => {
  const headings = [
    { depth: 1, range: { start: 0, end: 4 }, text: '一' },
    { depth: 2, range: { start: 40, end: 44 }, text: '二' },
    { depth: 3, range: { start: 80, end: 84 }, text: '三' }
  ]

  const at = (from: number): { from: number; to: number } => ({ from, to: from + 400 })

  it('只取 h1–h3，一级最长三级最短', () => {
    const marks = outlineMarks([...headings, { depth: 4, range: { start: 120, end: 124 }, text: '四' }], at(0))
    expect(marks.map((mark) => mark.heading.text)).toEqual(['一', '二', '三'])
    expect(marks[0]!.scale).toBeGreaterThan(marks[1]!.scale)
    expect(marks[1]!.scale).toBeGreaterThan(marks[2]!.scale)
  })

  it('没有光标时按视口起点算当前项', () => {
    const now = (from: number) => outlineMarks(headings, at(from)).filter((mark) => mark.current).map((m) => m.heading.text)
    expect(now(0)).toEqual(['一'])
    expect(now(50)).toEqual(['二'])
    expect(now(999)).toEqual(['三'])
  })

  it('光标在可视范围内时以光标为准', () => {
    // 点完索引，视口顶部常停在上一节的末尾；这时该看光标，不该看视口。
    const marks = outlineMarks(headings, { from: 41, to: 441 }, 80)
    expect(marks.filter((mark) => mark.current).map((m) => m.heading.text)).toEqual(['三'])
  })

  it('光标在可视范围之外就退回视口判据', () => {
    const marks = outlineMarks(headings, { from: 41, to: 120 }, 999)
    expect(marks.filter((mark) => mark.current).map((m) => m.heading.text)).toEqual(['二'])
  })

  it('起点在第一个标题之前时没有当前项', () => {
    expect(outlineMarks(headings, at(-5)).some((mark) => mark.current)).toBe(false)
  })

  it('没有标题就没有索引', () => {
    expect(outlineMarks([], at(0))).toEqual([])
  })

  it('空标题有兜底文案', () => {
    expect(outlineLabel({ depth: 1, range: { start: 0, end: 0 }, text: '   ' })).toBe('（无标题）')
  })
})

describe('快捷键', () => {
  it('按平台给出 ⌘K / Ctrl+K', () => {
    expect(shortcutLabel('k', true)).toBe('⌘K')
    expect(shortcutLabel('k', false)).toBe('Ctrl+K')
  })

  it('只认不带 Alt 的主修饰键', () => {
    expect(shortcutFor(key({ key: 'k', metaKey: true }), true)).toBe('search')
    expect(shortcutFor(key({ key: 'k', ctrlKey: true }), false)).toBe('search')
    expect(shortcutFor(key({ key: 's', metaKey: true }), true)).toBe('save')
    expect(shortcutFor(key({ key: 'k' }), true)).toBeNull()
    expect(shortcutFor(key({ key: 'k', metaKey: true, altKey: true }), true)).toBeNull()
    expect(shortcutFor(key({ key: 'f', metaKey: true }), true)).toBeNull()
  })

  it('macOS 上 Ctrl+K 不算', () => {
    expect(shortcutFor(key({ key: 'k', ctrlKey: true }), true)).toBeNull()
  })

  it('平台判断读 UA，不抛异常', () => {
    expect(typeof isApple()).toBe('boolean')
  })
})
