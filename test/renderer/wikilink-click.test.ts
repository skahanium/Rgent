// @vitest-environment jsdom
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { WikilinkWidget } from '../../src/renderer/src/view/widgets/wikilink.ts'

describe('wikilink activation', () => {
  it('plain click reveals source, modifier click opens the note', () => {
    const selections: unknown[] = []
    let focused = false
    let opened = ''
    const view = { dispatch: (value: unknown) => selections.push(value), focus: () => { focused = true } } as unknown as EditorView
    const link = new WikilinkWidget(
      { range: { start: 4, end: 18 }, target: '目标.md', display: '目标', embed: false },
      { noteRelPath: '当前.md', vaultHas: () => true, openNote: (path) => { opened = path } }
    ).toDOM(view)
    link.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(selections).toEqual([{ selection: { anchor: 4 } }])
    expect(focused).toBe(true)
    expect(opened).toBe('')
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    expect(opened).toBe('目标.md')
  })
})
