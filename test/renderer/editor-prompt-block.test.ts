// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { redo, undo } from '@codemirror/commands'
import { mountEditor, type EditorHost } from '../../src/renderer/src/view/editor.ts'

const MARKER = '<!-- rgent:prompt:v1 state="draft" -->'
const SENT = '<!-- rgent:prompt:v1 task-id="task-1" -->'

const mounted: EditorHost[] = []
function editor(text: string, caret = text.length): EditorHost {
  const host = mountEditor(document.createElement('div'), () => {})
  mounted.push(host)
  host.setText(text, undefined, { anchor: caret, head: caret })
  return host
}
afterEach(() => { for (const host of mounted.splice(0)) host.destroy() })

function lines(host: EditorHost): HTMLElement[] {
  return [...host.view.dom.querySelectorAll<HTMLElement>('.cm-line')]
}

function commandLines(host: EditorHost): HTMLElement[] {
  return lines(host).filter((line) => line.classList.contains('rgent-block-command'))
}

describe('createPromptBlock', () => {
  it('creates a draft marker and an empty prompt line at the end of an empty note', () => {
    const host = editor('')
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).toBe(`${MARKER}\n`)
    expect(host.promptBlockAtCaret()).toEqual({
      range: { start: MARKER.length + 1, end: MARKER.length + 1 },
      prompt: '',
      empty: true
    })
    const pending = host.view.dom.querySelector<HTMLElement>('.cm-line.rgent-block-command.rgent-block-command-first')
    expect(pending).toBeTruthy()
    expect(pending!.textContent).toBe('')
    expect(host.view.dom.querySelector('.rgent-marker-label')?.textContent).toBe('口令')
  })

  it('inserts after the caret block and leaves a blank line on both sides', () => {
    const host = editor('甲\n', 1)
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).toBe(`甲\n\n${MARKER}\n`)
    expect(host.promptBlockAtCaret()?.empty).toBe(true)
    expect(host.selectionRange().anchor).toBe(host.getText().indexOf(MARKER) + MARKER.length + 1)
  })

  it('does not split a list and puts the draft after the whole block', () => {
    const source = '甲\n\n- 一\n- 二\n'
    const host = editor(source, source.indexOf('一'))
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).toBe(`${source}\n${MARKER}\n`)
    const pending = commandLines(host).filter((line) => line.textContent === '')
    expect(pending).toHaveLength(1)
  })

  it('keeps CRLF style on the inserted marker and prompt line', () => {
    const host = editor('甲\r\n', 1)
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).toBe(`甲\r\n\r\n${MARKER}\r\n`)
    expect(host.promptBlockAtCaret()?.range).toEqual({ start: host.getText().length, end: host.getText().length })
  })

  it('inserts pause-resend text without a slash and preserves its bytes', () => {
    const host = editor('甲\r\n', 1)
    expect(host.createPromptBlock({ at: 'end', text: '问\r\n答' })).toBe('created')
    expect(host.getText()).toBe(`甲\r\n\r\n${MARKER}\r\n问\r\n答\r\n`)
    expect(host.promptBlockAtCaret()).toEqual({
      range: { start: host.getText().indexOf('问'), end: host.getText().indexOf('问') + '问\r\n答'.length },
      prompt: '问\r\n答',
      empty: false
    })
  })

  it('is one undoable transaction', () => {
    const host = editor('甲\n', 1)
    expect(host.createPromptBlock()).toBe('created')
    const created = host.getText()
    expect(created).not.toBe('甲\n')
    expect(undo(host.view)).toBe(true)
    expect(host.getText()).toBe('甲\n')
    expect(redo(host.view)).toBe(true)
    expect(host.getText()).toBe(created)
  })

  it('focuses an existing draft instead of creating a second marker', () => {
    const host = editor('甲\n', 1)
    host.createPromptBlock()
    const once = host.getText()
    host.view.dispatch({ selection: { anchor: host.view.state.doc.length } })
    expect(host.createPromptBlock()).toBe('focused')
    expect(host.getText()).toBe(once)
  })

  it('refuses while the editor is read-only', () => {
    const host = editor('甲\n', 1)
    host.setReadOnly(true)
    expect(host.createPromptBlock()).toBe('refused')
    expect(host.promptBlockAtCaret()).toBeNull()
    expect(host.getText()).toBe('甲\n')
  })
})

describe('pending prompt decoration', () => {
  it('keeps the same line classes when the draft gets body text', () => {
    const host = editor('甲\n', 1)
    host.createPromptBlock()
    const empty = host.view.dom.querySelector<HTMLElement>('.cm-line.rgent-block-command.rgent-block-command-first')!
    expect(empty).toBeTruthy()
    expect(host.insertAtSelection('问')).toBe(true)
    expect(host.promptBlockAtCaret()).toMatchObject({ prompt: '问', empty: false })
    const typed = commandLines(host).find((line) => line.textContent === '问')
    expect(typed).toBeTruthy()
    expect(typed!.classList.contains('rgent-block-command-first')).toBe(true)
    // 行类集合与顺序都和空草稿时一致，只有由谁提供装饰不同。
    expect(typed!.className).toBe(empty.className)
    expect(host.view.dom.querySelector('.rgent-marker-label')?.textContent).toBe('口令')
  })

  it('does not paint the block below a non-adjacent empty draft as a prompt', () => {
    const host = editor('甲\n\n乙\n', 2)
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).toBe(`甲\n\n${MARKER}\n\n\n乙\n`)
    expect(host.promptBlockAtCaret()?.empty).toBe(true)
    const body = commandLines(host).find((line) => line.textContent === '乙')
    expect(body).toBeUndefined()
    const pending = lines(host).filter((line) => line.classList.contains('rgent-block-command-first'))
    expect(pending).toHaveLength(1)
    expect(pending[0]!.textContent).toBe('')
    expect(host.promptBlockAtCaret()).not.toBeNull()

    // 在空行里打出提问后，身份接管这一行；下面那段人写的字仍然不带口令样式。
    expect(host.insertAtSelection('问')).toBe(true)
    expect(host.promptBlockAtCaret()).toMatchObject({ prompt: '问', empty: false })
    expect(commandLines(host).find((line) => line.textContent === '乙')).toBeUndefined()
    expect(commandLines(host).find((line) => line.textContent === '问')?.classList
      .contains('rgent-block-command-first')).toBe(true)
  })

  it('upgrades only the marker without changing the line classes', () => {
    const host = editor(`前文\n\n${MARKER}\n问\n`)
    host.view.dispatch({ selection: { anchor: host.view.state.doc.toString().indexOf('问') + 1 } })
    expect(host.promptBlockAtCaret()?.prompt).toBe('问')
    const before = commandLines(host).map((line) => [...line.classList].sort())
    host.applyExternalText(host.getText().replace(MARKER, SENT))
    expect(host.promptBlockAtCaret()).toBeNull()
    const after = commandLines(host).map((line) => [...line.classList].sort())
    expect(after).toEqual(before)
    expect(host.view.dom.querySelector('.rgent-marker-label')?.textContent).toBe('口令')
  })

  it('does not treat an old slash paragraph as a prompt block', () => {
    const host = editor('/问\n', 1)
    expect(host.promptBlockAtCaret()).toBeNull()
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).toBe(`/问\n\n${MARKER}\n`)
  })
})
