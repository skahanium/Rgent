// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { pendingSlash } from '../../src/renderer/src/slash.ts'
import { mountEditor, type EditorHost } from '../../src/renderer/src/view/editor.ts'

const mounted: EditorHost[] = []
function editor(): EditorHost {
  const host = mountEditor(document.createElement('div'), () => {})
  mounted.push(host)
  return host
}
afterEach(() => { for (const host of mounted.splice(0)) host.destroy() })

function typeSlash(host: EditorHost): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
  host.view.contentDOM.dispatchEvent(event)
  return event
}

describe('slash keydown starts a command only from an empty paragraph', () => {
  it('starts a command when / is pressed at an empty paragraph start', () => {
    const host = editor()
    host.setText('正文\n\n')
    host.view.dispatch({ selection: { anchor: host.view.state.doc.length } })
    expect(typeSlash(host).defaultPrevented).toBe(true)
    expect(host.getText()).toBe('正文\n\n/')
    expect(host.slashCommandStart()).toBe(host.getText().lastIndexOf('/'))
    const at = host.view.state.selection.main.head
    host.view.dispatch({
      changes: { from: at, insert: '问' },
      selection: { anchor: at + 1 },
      userEvent: 'input.type'
    })
    expect(pendingSlash(host.getText(), host.selectionRange().head, host.slashCommandStart())?.prompt).toBe('问')
  })

  it('starts a command when /prompt is inserted at an empty paragraph', () => {
    const host = editor()
    host.setText('')
    host.view.dispatch({
      changes: { from: 0, insert: '/请写两句话' },
      selection: { anchor: '/请写两句话'.length },
      userEvent: 'input.type'
    })
    expect(host.getText()).toBe('/请写两句话')
    expect(pendingSlash(host.getText(), host.selectionRange().head, host.slashCommandStart())?.prompt).toBe('请写两句话')
  })

  it('starts a command when a blank line and /prompt are inserted together', () => {
    const host = editor()
    host.setText('正文\n')
    host.view.dispatch({
      changes: { from: host.view.state.doc.length, insert: '\n/问' },
      selection: { anchor: host.view.state.doc.length + 3 },
      userEvent: 'input.type'
    })
    expect(host.getText()).toBe('正文\n\n/问')
    expect(pendingSlash(host.getText(), host.selectionRange().head, host.slashCommandStart())?.prompt).toBe('问')
  })

  it('inserts / at the start of an existing paragraph without submitting on Enter', () => {
    const host = editor()
    host.setText('已有段落')
    host.view.dispatch({ selection: { anchor: 0 } })
    expect(typeSlash(host).defaultPrevented).toBe(true)
    expect(host.getText()).toBe('/已有段落')
    expect(host.slashCommandStart()).toBeNull()
    host.view.dispatch({ selection: { anchor: host.view.state.doc.length } })
    expect(pendingSlash(host.getText(), host.selectionRange().head, host.slashCommandStart())).toBeNull()
  })
})
