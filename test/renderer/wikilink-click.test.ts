// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { compile } from '../../src/markdown/index.ts'
import { WikilinkWidget } from '../../src/renderer/src/view/widgets/wikilink.ts'
import { normalizeSource, rawSourceField, setRawSource, sourceOf } from '../../src/renderer/src/view/source.ts'

function viewWithRaw(raw: string) {
  const selections: unknown[] = []
  let focused = false
  let opened = ''
  const state = EditorState.create({
    doc: normalizeSource(raw),
    extensions: [rawSourceField]
  }).update({ effects: setRawSource.of(raw) }).state
  const view = {
    state,
    dispatch: (value: unknown) => selections.push(value),
    focus: () => { focused = true }
  } as unknown as EditorView
  return { view, selections, focused: () => focused, opened: () => opened, openNote: (path: string) => { opened = path } }
}

describe('wikilink activation', () => {
  it('plain click reveals source, modifier click opens the note', () => {
    const raw = '见 [[目标.md]]'
    const { view, selections, focused, opened, openNote } = viewWithRaw(raw)
    const link = new WikilinkWidget(
      { range: { start: raw.indexOf('[['), end: raw.indexOf(']]') + 2 }, target: '目标.md', display: '目标', embed: false },
      { noteRelPath: '当前.md', vaultHas: () => true, openNote }
    ).toDOM(view)
    link.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(selections).toEqual([{ selection: { anchor: sourceOf(view.state).toView(raw.indexOf('[[')) } }])
    expect(focused()).toBe(true)
    expect(opened()).toBe('')
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    expect(opened()).toBe('目标.md')
  })

  it('maps a CRLF wikilink click through toView', () => {
    const raw = '前文\r\n\r\n[[目标.md]]\r\n'
    const hit = compile(raw).index.wikilinks[0]!
    const { view, selections, focused, opened, openNote } = viewWithRaw(raw)
    const node = new WikilinkWidget(hit, { noteRelPath: '当前.md', vaultHas: () => true, openNote }).toDOM(view)
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const viewAnchor = sourceOf(view.state).toView(hit.range.start)
    expect(viewAnchor).not.toBe(hit.range.start)
    expect(selections).toEqual([{ selection: { anchor: viewAnchor } }])
    expect(focused()).toBe(true)
    expect(opened()).toBe('')
  })
})
