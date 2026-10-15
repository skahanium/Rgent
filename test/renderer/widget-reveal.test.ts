// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { compile } from '../../src/markdown/index.ts'
import { CalloutWidget } from '../../src/renderer/src/view/widgets/callout.ts'
import { ImageWidget } from '../../src/renderer/src/view/widgets/image.ts'
import { MathWidget } from '../../src/renderer/src/view/widgets/math.ts'
import { MermaidWidget } from '../../src/renderer/src/view/widgets/mermaid.ts'
import { TableWidget } from '../../src/renderer/src/view/widgets/table.ts'
import { normalizeSource, rawSourceField, setRawSource, sourceOf } from '../../src/renderer/src/view/source.ts'

function viewWithRaw(raw: string) {
  const selections: unknown[] = []
  let focused = false
  const state = EditorState.create({
    doc: normalizeSource(raw),
    extensions: [rawSourceField]
  }).update({ effects: setRawSource.of(raw) }).state
  const view = {
    state,
    dispatch: (value: unknown) => selections.push(value),
    focus: () => { focused = true },
    requestMeasure: () => {}
  } as unknown as EditorView
  return { view, selections, focused: () => focused }
}

function expectedAnchor(view: EditorView, start: number, end: number): number {
  return sourceOf(view.state).toView(Math.min(start + 1, end))
}

describe('block widgets reveal source on a plain click', () => {
  it('table: plain click uses toView, modifier click stays presented', () => {
    const raw = '前文\r\n\r\n| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n'
    const table = compile(raw).index.tables[0]!
    const { view, selections, focused } = viewWithRaw(raw)
    const node = new TableWidget(table).toDOM(view)
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(selections).toEqual([{ selection: { anchor: expectedAnchor(view, table.range.start, table.range.end) } }])
    expect(focused()).toBe(true)
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, metaKey: true }))
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
    expect(selections).toHaveLength(1)
  })

  it('callout: plain click uses toView, modifier click stays presented', () => {
    const raw = '前文\r\n\r\n> [!note] 记要\r\n> 内容\r\n'
    const callout = compile(raw).index.callouts[0]!
    const { view, selections } = viewWithRaw(raw)
    const node = new CalloutWidget(callout).toDOM(view)
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(selections).toEqual([{ selection: { anchor: expectedAnchor(view, callout.range.start, callout.range.end) } }])
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, metaKey: true }))
    expect(selections).toHaveLength(1)
  })

  it('mermaid: plain click uses toView, modifier click stays presented', () => {
    const raw = '前文\r\n\r\n```mermaid\r\ngraph TD\r\nA-->B\r\n```\r\n'
    const mermaid = compile(raw).index.mermaid[0]!
    const { view, selections } = viewWithRaw(raw)
    const node = new MermaidWidget(mermaid).toDOM(view)
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(selections).toEqual([{ selection: { anchor: expectedAnchor(view, mermaid.range.start, mermaid.range.end) } }])
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
    expect(selections).toHaveLength(1)
  })

  it('math: plain click uses toView, modifier click stays presented', () => {
    const raw = '前文\r\n\r\n$$\r\nx+1\r\n$$\r\n'
    const math = compile(raw).index.maths[0]!
    const { view, selections } = viewWithRaw(raw)
    const node = new MathWidget(math).toDOM(view)
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(selections).toEqual([{ selection: { anchor: expectedAnchor(view, math.range.start, math.range.end) } }])
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, metaKey: true }))
    expect(selections).toHaveLength(1)
  })

  it('image: plain click reveals source; cmd/ctrl-click keeps the load control', async () => {
    const raw = '前文\r\n\r\n![图](https://images.example/a.png)\r\n'
    const image = { ...compile(raw).index.images[0]!, source: 'ai' as const }
    const load = vi.fn(async () => ({ ok: true as const, src: 'rgent-image://media/?t=abc' }))
    const { view, selections } = viewWithRaw(raw)
    const node = new ImageWidget(image, {
      noteRelPath: 'a.md',
      vaultHas: () => false,
      openNote: () => {},
      remoteImageGet: load
    }).toDOM(view)
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(selections).toEqual([{ selection: { anchor: expectedAnchor(view, image.range.start, image.range.end) } }])
    expect(load).not.toHaveBeenCalled()
    const button = node.querySelector('button') as HTMLButtonElement
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    await vi.waitFor(() => expect(load).toHaveBeenCalled())
  })
})
