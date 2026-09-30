// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { redo, undo } from '@codemirror/commands'
import { ALL_STAGES } from '../../src/markdown/index.ts'
import { mountEditor, type EditorHost } from '../../src/renderer/src/view/editor.ts'

const mounted: EditorHost[] = []
function editor(): EditorHost {
  const host = mountEditor(document.createElement('div'), () => {})
  mounted.push(host)
  return host
}
afterEach(() => { for (const host of mounted.splice(0)) host.destroy() })

describe('raw Markdown and editor coordinates', () => {
  it('normalizes the editing projection but preserves mixed source and BOM', () => {
    const host = editor()
    const raw = '\ufeff甲\r\n乙\n丙\r丁\r\n'
    host.setText(raw)
    expect(host.view.state.doc.toString()).toBe('\ufeff甲\n乙\n丙\n丁\n')
    expect(host.getText()).toBe(raw)
    host.view.dispatch({ changes: { from: 1, to: 2, insert: '改' } })
    expect(host.getText()).toBe(raw.replace('甲', '改'))
  })

  it('restores exact deleted separators through undo and redo', () => {
    const host = editor()
    const raw = '甲\r\n乙\n丙\r丁\r\n'
    host.setText(raw)
    host.view.dispatch({ changes: { from: 0, to: 6, insert: '替换\n' }, userEvent: 'input' })
    const edited = host.getText()
    expect(undo(host.view)).toBe(true)
    expect(host.getText()).toBe(raw)
    expect(redo(host.view)).toBe(true)
    expect(host.getText()).toBe(edited)
  })

  it('uses raw source offsets for selection and external changes', () => {
    const host = editor()
    const raw = '甲\r\n乙\r\n/问\r\n'
    const at = raw.indexOf('/问')
    host.setText(raw, undefined, { anchor: at, head: at + 2 })
    expect(host.view.state.selection.main.from).toBe('甲\n乙\n'.length)
    expect(host.selectionRange()).toEqual({ anchor: at, head: at + 2 })
    const next = raw.replace('甲', '新甲')
    host.applyExternalText(next)
    expect(host.getText()).toBe(next)
    expect(host.selectionRange()).toEqual({ anchor: at + 1, head: at + 3 })
  })

  it('keeps an undoable human edit after an external update and isolates tabs', () => {
    const host = editor()
    host.setText('甲\r\n乙\n')
    host.view.dispatch({ changes: { from: 0, to: 1, insert: '改' }, userEvent: 'input' })
    host.applyExternalText('改\r\n乙\n新增\r\n')
    expect(undo(host.view)).toBe(true)
    expect(host.getText()).toBe('甲\r\n乙\n新增\r\n')
    host.setText('另一篇\n')
    expect(undo(host.view)).toBe(false)
    expect(host.getText()).toBe('另一篇\n')
  })
})

it('exposes raw headings, markers and navigation offsets after CRLF lines', () => {
  const host = editor()
  const raw = '前文\r\n\r\n# 标题\r\n\r\n<!-- rgent:ai:v1 -->\r\n回答\r\n'
  host.setText(raw)
  expect(host.headings()[0]!.range.start).toBe(raw.indexOf('# 标题'))
  expect(host.markers()[0]!.range.start).toBe(raw.indexOf('<!--'))
  host.scrollTo(raw.indexOf('# 标题'))
  expect(host.selectionRange().anchor).toBe(raw.indexOf('# 标题'))
  expect(host.view.state.selection.main.anchor).toBe('前文\n\n'.length)
  expect(host.caret()).toBe(raw.indexOf('# 标题'))
  expect(host.viewport().to).toBe(raw.length)
})

it('moves marker actions using the latest raw bytes and restores them on undo', () => {
  const host = editor()
  const raw = '前文\r\n \t\n\r\n<!-- rgent:ai:v1 -->\r\n回答\n\n尾部\r\n'
  host.setText(raw)
  const next = raw.replace('前文', '改文')
  host.applyExternalText(next)
  const button = [...host.view.dom.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '上移一段')!
  expect(button).toBeTruthy()
  button.click()
  expect(host.getText()).toBe('<!-- rgent:ai:v1 -->\r\n回答\r\n \t\n\r\n改文\n\n尾部\r\n')
  expect(undo(host.view)).toBe(true)
  expect(host.getText()).toBe(next)
  expect(redo(host.view)).toBe(true)
  expect(host.getText()).toContain('改文')
})

it('preserves external newline-only changes without displacing selection', () => {
  const host = editor()
  host.setText('甲\n乙\n', undefined, { anchor: 2, head: 3 })
  host.applyExternalText('甲\r\n乙\r\n')
  expect(host.view.state.doc.toString()).toBe('甲\n乙\n')
  expect(host.getText()).toBe('甲\r\n乙\r\n')
  expect(host.selectionRange()).toEqual({ anchor: 3, head: 4 })
})

it('restores deleted mixed newlines after an unrelated external prefix update', () => {
  const host = editor()
  const raw = '甲\r\n乙\n丙\r丁\r\n'
  host.setText(raw)
  host.view.dispatch({ changes: { from: 2, to: 6, insert: '替换\n' }, userEvent: 'input.type' })
  const edited = host.getText()
  host.applyExternalText('新增\r\n' + edited)
  expect(undo(host.view)).toBe(true)
  expect(host.getText()).toBe('新增\r\n' + raw)
  expect(redo(host.view)).toBe(true)
  expect(host.getText()).toBe('新增\r\n' + edited)
})

it('normalizes pasted CRLF and CR into the LF projection using nearby source endings', () => {
  const host = editor()
  host.setText('甲\r\n尾部\n')
  host.view.dispatch({ changes: { from: 1, insert: '新\r\n行\r末' }, userEvent: 'input.paste' })
  expect(host.view.state.doc.toString()).toBe('甲新\n行\n末\n尾部\n')
  expect(host.getText()).toBe('甲新\r\n行\r\n末\r\n尾部\n')
  expect(undo(host.view)).toBe(true)
  expect(host.getText()).toBe('甲\r\n尾部\n')
})

it('keeps mixed source separators when external content splits an undo range', () => {
  const host = editor()
  host.setText('甲\r\n乙\n尾\r\n')
  host.view.dispatch({ changes: { from: 0, to: 4, insert: '新\n文\n' }, userEvent: 'input.paste' })
  host.applyExternalText('新\r\n外部\n文\r\n尾\r\n')
  expect(undo(host.view)).toBe(true)
  expect(host.getText()).toContain('甲\r\n乙\n')
  expect(host.getText()).toContain('外部\n')
  expect(host.getText().replace(/\r\n?|\n/g, '\n')).toBe(host.view.state.doc.toString())
  expect(redo(host.view)).toBe(true)
  expect(host.getText()).toBe('新\r\n外部\n文\r\n尾\r\n')
})

it('accepts a marker in a CR-only source without deleting preceding human text', () => {
  const host = editor()
  const raw = '人写的\r\r<!-- rgent:ai:v1 -->\r回答\r\r# 后文\r'
  host.setText(raw)
  const accept = host.view.dom.querySelector<HTMLButtonElement>('.rgent-marker-accept')!
  expect(accept).toBeTruthy()
  accept.click()
  expect(host.getText()).toBe('人写的\r\r回答\r\r# 后文\r')
  expect(host.headings()[0]!.range.start).toBe(host.getText().indexOf('# 后文'))
})

it('keeps typing below CR-only AI blocks human and leaves the caret after the text', () => {
  const host = editor()
  host.setText('<!-- rgent:ai:v1 -->\r回答\r\r后文\r')
  const at = host.view.state.doc.toString().indexOf('回答') + '回答\n'.length
  host.view.dispatch({ changes: { from: at, insert: '我' }, selection: { anchor: at + 1 }, userEvent: 'input.type' })
  expect(host.getText()).toBe('<!-- rgent:ai:v1 -->\r回答\r\r我\r后文\r')
  const next = host.view.state.selection.main.head
  host.view.dispatch({ changes: { from: next, insert: '写' }, selection: { anchor: next + 1 }, userEvent: 'input.type' })
  expect(host.getText()).toContain('\r我写\r')
})

it('projects each line of CR-only quotes into the matching editor line', () => {
  const host = editor()
  host.setText('> 一\r> 二\r')
  expect(host.view.dom.querySelectorAll('.md-quote')).toHaveLength(2)
})


it('shows a parse error for current raw source, clears old indexes and blocks writes until recovery', () => {
  const parent = document.createElement('div')
  const host = mountEditor(parent, () => {})
  mounted.push(host)
  host.setText('# 旧标题\r\n')
  const stage = ALL_STAGES.find((item) => item.id === 'identity')!
  const transform = stage.transform
  stage.transform = () => { throw new Error('故障注入') }
  const raw = '\ufeff# 当前原文\r\n\r\n<!-- rgent:ai:v1 -->\n回答\r\n'
  try {
    host.applyExternalText(raw)
    expect(host.getText()).toBe(raw)
    expect(host.view.state.doc.toString()).toBe(raw.replace(/\r\n|\r/g, '\n'))
    expect(host.headings()).toEqual([])
    expect(host.markers()).toEqual([])
    const alert = parent.querySelector<HTMLElement>('.md-parse-error[role="alert"]')!
    expect(alert).toBeTruthy()
    expect(alert.hidden).toBe(false)
    expect(alert.textContent).toContain('故障注入')
    host.view.dispatch({ changes: { from: 1, to: 2, insert: '改' }, userEvent: 'input.type' })
    expect(host.getText()).toBe(raw)
  } finally { stage.transform = transform }
  host.applyExternalText(raw + '\n恢复')
  expect(parent.querySelector<HTMLElement>('.md-parse-error')!.hidden).toBe(true)
  expect(host.headings()[0]!.range.start).toBe(1)
})


it('applies heading line decoration at physical line zero while keeping the BOM raw offset', () => {
  const host = editor()
  host.setText('\ufeff# BOM 标题\r\n\r\n正文\n')
  const heading = host.view.dom.querySelector('.cm-line.md-h1')
  expect(heading).toBeTruthy()
  expect(heading!.textContent).toContain('BOM 标题')
  expect(heading!.textContent).toContain('\ufeff')
  expect(host.headings()[0]!.range.start).toBe(1)
  expect(host.getText()).toBe('\ufeff# BOM 标题\r\n\r\n正文\n')
})
