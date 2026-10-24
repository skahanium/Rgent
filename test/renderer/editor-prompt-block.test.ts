// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { redo, undo } from '@codemirror/commands'
import { mountEditor, type EditorHost } from '../../src/renderer/src/view/editor.ts'

const MARKER = '<!-- rgent:prompt:v1 state="draft" -->'
const SENT = '<!-- rgent:prompt:v1 task-id="task-1" -->'

// jsdom 没有 Range.getClientRects；CM 的测量帧会在测试收尾后偶发调用它。
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
}

const mounted: EditorHost[] = []
function editor(text: string, caret = text.length): EditorHost {
  const host = mountEditor(document.createElement('div'), () => {})
  mounted.push(host)
  host.setText(text, undefined, { anchor: caret, head: caret })
  return host
}
afterEach(() => { for (const host of mounted.splice(0)) host.destroy() })

/** marker 插入/移除走微任务；等它落完再断言。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function lines(host: EditorHost): HTMLElement[] {
  return [...host.view.dom.querySelectorAll<HTMLElement>('.cm-line')]
}

function commandLines(host: EditorHost): HTMLElement[] {
  return lines(host).filter((line) => line.classList.contains('rgent-block-command'))
}

function markerCount(host: EditorHost): number {
  return host.getText().split(MARKER).length - 1
}

function insertLineBreak(host: EditorHost): void {
  const head = host.view.state.selection.main.head
  host.view.dispatch({
    changes: { from: head, insert: '\n' },
    selection: { anchor: head + 1 },
    userEvent: 'input.type'
  })
}

describe('createPromptBlock (F1: pending line, no marker)', () => {
  it('creates an empty pending line without writing a marker', () => {
    const host = editor('')
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).toBe('')
    expect(markerCount(host)).toBe(0)
    expect(host.promptBlockAtCaret()).toEqual({ range: { start: 0, end: 0 }, prompt: '', empty: true })
    const pending = host.view.dom.querySelector<HTMLElement>('.cm-line.rgent-block-command.rgent-block-command-first')
    expect(pending).toBeTruthy()
    expect(pending!.textContent).toBe('')
    // 还没有 marker：chip 不出现，首字之后才允许出现。
    expect(host.view.dom.querySelector('.rgent-marker-label')).toBeNull()
  })

  it('inserts only blank lines after a paragraph; no marker on disk text', () => {
    const host = editor('甲\n', 1)
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).toBe('甲\n\n')
    expect(markerCount(host)).toBe(0)
    expect(host.promptBlockAtCaret()?.empty).toBe(true)
    expect(host.selectionRange().anchor).toBe(3)
    expect(commandLines(host)).toHaveLength(1)
    expect(commandLines(host)[0]!.textContent).toBe('')
  })

  it('does not split a list and puts the pending line after the whole block', () => {
    const source = '甲\n\n- 一\n- 二\n'
    const host = editor(source, source.indexOf('一'))
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).not.toContain('rgent:prompt')
    expect(host.getText().startsWith(source)).toBe(true)
    const pending = commandLines(host).filter((line) => line.textContent === '')
    expect(pending).toHaveLength(1)
  })

  it('keeps CRLF style and the pending anchor', () => {
    const host = editor('甲\r\n', 1)
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).toBe('甲\r\n\r\n')
    expect(host.getText()).not.toMatch(/[^\r]\n/)
    expect(host.promptBlockAtCaret()?.range).toEqual({ start: 5, end: 5 })
    expect(host.selectionRange().anchor).toBe(5)
  })

  it('keeps pause-resend text and its immediate marker unchanged', () => {
    const host = editor('甲\r\n', 1)
    expect(host.createPromptBlock({ at: 'end', text: '问\r\n答' })).toBe('created')
    expect(host.getText()).toBe(`甲\r\n\r\n${MARKER}\r\n问\r\n答\r\n`)
    expect(host.promptBlockAtCaret()).toEqual({
      range: { start: host.getText().indexOf('问'), end: host.getText().indexOf('问') + '问\r\n答'.length },
      prompt: '问\r\n答',
      empty: false
    })
  })

  it('is one undoable transaction and undo removes the pending decoration', () => {
    const host = editor('甲\n', 1)
    expect(host.createPromptBlock()).toBe('created')
    const created = host.getText()
    expect(created).toBe('甲\n\n')
    expect(undo(host.view)).toBe(true)
    expect(host.getText()).toBe('甲\n')
    expect(host.promptBlockAtCaret()).toBeNull()
    expect(redo(host.view)).toBe(true)
    expect(host.getText()).toBe(created)
    // redo 恢复的是创建前光标；pending 装饰本身要跟着回来。
    expect(host.view.dom.querySelector('.cm-line.rgent-block-command.rgent-block-command-first')).toBeTruthy()
    host.view.dispatch({ selection: { anchor: 3 } })
    expect(host.promptBlockAtCaret()?.empty).toBe(true)
  })

  it('reusing a blank line without an edit does not wedge earlier undo history', async () => {
    const host = editor('甲\n\n\n\n乙\n')
    host.view.dispatch({ changes: { from: 0, insert: '丙' }, selection: { anchor: 1 }, userEvent: 'input.type' })
    // 三条连续空行取中间那条：唤起不产生正文变化（effect-only）。
    host.view.dispatch({ selection: { anchor: 4 } })
    const before = host.getText()
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).toBe(before)
    host.insertAtSelection('问')
    await tick()
    expect(markerCount(host)).toBe(1)
    expect(undo(host.view)).toBe(true)
    await tick()
    expect(markerCount(host)).toBe(0)
    expect(undo(host.view)).toBe(true)
    expect(host.getText().startsWith('甲')).toBe(true)
  })

  it('focuses an existing pending line instead of creating a second one', () => {
    const host = editor('甲\n', 1)
    host.createPromptBlock()
    const once = host.getText()
    host.view.dispatch({ selection: { anchor: host.view.state.doc.length } })
    expect(host.createPromptBlock()).toBe('focused')
    expect(host.getText()).toBe(once)
    expect(commandLines(host)).toHaveLength(1)
  })

  it('refuses while the editor is read-only', () => {
    const host = editor('甲\n', 1)
    host.setReadOnly(true)
    expect(host.createPromptBlock()).toBe('refused')
    expect(host.promptBlockAtCaret()).toBeNull()
    expect(host.getText()).toBe('甲\n')
  })
})

describe('first input inserts the marker; deleting to blank rolls back', () => {
  it('keeps the line classes and inserts the marker only on the first non-blank input', async () => {
    const host = editor('甲\n', 1)
    host.createPromptBlock()
    const empty = host.view.dom.querySelector<HTMLElement>('.cm-line.rgent-block-command.rgent-block-command-first')!
    const emptyClasses = [...empty.classList].filter((name) => name.startsWith('rgent-'))
    expect(host.insertAtSelection('问')).toBe(true)
    // 微任务之前：正文已经在待发送行里，但磁盘文本还没有 marker。
    expect(host.getText()).not.toContain('rgent:prompt')
    expect(host.promptBlockAtCaret()).toMatchObject({ prompt: '问', empty: false })
    await tick()
    expect(markerCount(host)).toBe(1)
    expect(host.getText()).toContain(`${MARKER}\n问`)
    expect(host.promptBlockAtCaret()).toMatchObject({ prompt: '问', empty: false })
    const typed = commandLines(host).find((line) => line.textContent === '问')!
    expect([...typed.classList].filter((name) => name.startsWith('rgent-'))).toEqual(emptyClasses)
    expect(typed.textContent).toBe('问')
    expect(host.view.dom.querySelector('.rgent-marker-label')?.textContent).toBe('口令')
    expect(host.insertAtSelection('题')).toBe(true)
    expect(host.promptBlockAtCaret()).toMatchObject({ prompt: '问题', empty: false })
    expect(host.getText()).toContain(`${MARKER}\n问题`)
  })

  it('keeps CRLF when the first input lands the marker', async () => {
    const host = editor('甲\r\n', 1)
    host.createPromptBlock()
    host.insertAtSelection('问')
    await tick()
    expect(host.getText()).toBe(`甲\r\n\r\n${MARKER}\r\n问`)
    expect(host.getText()).not.toMatch(/[^\r]\n/)
    expect(host.promptBlockAtCaret()).toMatchObject({ prompt: '问', empty: false })
  })

  it('keeps a leading BOM when the pending line becomes a marker', async () => {
    const host = editor('\ufeff甲\r\n', 2)
    expect(host.createPromptBlock()).toBe('created')
    expect(host.getText()).toBe('\ufeff甲\r\n\r\n')
    host.insertAtSelection('问')
    await tick()
    expect(host.getText()).toBe(`\ufeff甲\r\n\r\n${MARKER}\r\n问`)
  })

  it('undo removes the body and marker together; redo puts both back', async () => {
    const host = editor('甲\n', 1)
    host.createPromptBlock()
    host.insertAtSelection('问')
    await tick()
    expect(markerCount(host)).toBe(1)
    expect(undo(host.view)).toBe(true)
    await tick()
    expect(markerCount(host)).toBe(0)
    expect(host.promptBlockAtCaret()?.empty).toBe(true)
    expect(redo(host.view)).toBe(true)
    await tick()
    expect(host.getText()).toContain(`${MARKER}\n问`)
    expect(host.promptBlockAtCaret()).toMatchObject({ prompt: '问', empty: false })
  })

  it('does not write a marker for spaces or a line break', async () => {
    const host = editor('甲\n', 1)
    host.createPromptBlock()
    expect(host.insertAtSelection('   ')).toBe(true)
    await tick()
    expect(markerCount(host)).toBe(0)
    expect(host.promptBlockAtCaret()?.empty).toBe(true)
    insertLineBreak(host)
    await tick()
    expect(markerCount(host)).toBe(0)
    expect(host.promptBlockAtCaret()?.empty).toBe(true)
    expect(commandLines(host).length).toBeGreaterThanOrEqual(1)
  })

  it('removes the marker and returns to a pending line when the body is deleted to blank', async () => {
    const host = editor('甲\n', 1)
    host.createPromptBlock()
    host.insertAtSelection('问')
    await tick()
    expect(markerCount(host)).toBe(1)
    const body = host.promptBlockAtCaret()!.range
    host.view.dispatch({
      changes: { from: host.view.state.doc.toString().indexOf('问'), to: host.view.state.doc.toString().indexOf('问') + 1 },
      userEvent: 'delete.backward'
    })
    expect(body.end).toBe(body.start + 1)
    await tick()
    expect(markerCount(host)).toBe(0)
    expect(host.promptBlockAtCaret()).toMatchObject({ prompt: '', empty: true })
    const pending = host.view.dom.querySelector<HTMLElement>('.cm-line.rgent-block-command.rgent-block-command-first')
    expect(pending).toBeTruthy()
    // 回到待发送行后再落字，marker 会重新补上（不会留下空 marker）。
    expect(host.insertAtSelection('再')).toBe(true)
    await tick()
    expect(markerCount(host)).toBe(1)
    expect(host.getText()).toContain(`${MARKER}\n再`)
  })

  it('does not remove an already-empty draft marker that was not edited', async () => {
    const host = editor(`甲\n\n${MARKER}\n\n\n乙\n`)
    // 打开后改别处也是「没碰这段草稿」：不替人清理旧空 marker。
    host.view.dispatch({ changes: { from: 0, insert: '改' }, userEvent: 'input.type' })
    await tick()
    expect(markerCount(host)).toBe(1)
    expect(host.getText()).toContain(MARKER)
  })
})

describe('Esc and send-time guarantees', () => {
  it('Esc deletes the empty pending line without writing a marker', () => {
    const host = editor('甲\n\n乙\n', 1)
    host.createPromptBlock()
    expect(host.getText()).toBe('甲\n\n\n\n乙\n')
    expect(host.removeEmptyPromptBlockAtCaret()).toBe(true)
    expect(host.getText()).toBe('甲\n\n\n乙\n')
    expect(host.getText()).not.toContain('rgent:prompt')
    expect(host.promptBlockAtCaret()).toBeNull()
    // Esc 本身可撤销：空行与 pending 装饰一起回来，仍然没有 marker。
    expect(undo(host.view)).toBe(true)
    expect(host.getText()).toBe('甲\n\n\n\n乙\n')
    expect(host.getText()).not.toContain('rgent:prompt')
    expect(host.view.dom.querySelector('.cm-line.rgent-block-command.rgent-block-command-first')).toBeTruthy()
  })

  it('Esc still removes an old empty marker draft', () => {
    const source = `甲\n\n${MARKER}\n\n`
    const line = source.indexOf(MARKER) + MARKER.length + 1
    const host = editor(source, line)
    expect(host.promptBlockAtCaret()?.empty).toBe(true)
    expect(host.removeEmptyPromptBlockAtCaret()).toBe(true)
    expect(host.getText()).toBe('甲\n\n')
    expect(host.getText()).not.toContain('rgent:prompt')
  })

  it('ensurePromptMarker synchronously inserts the marker before send', async () => {
    const host = editor('甲\n', 1)
    host.createPromptBlock()
    host.insertAtSelection('问')
    expect(host.getText()).not.toContain('rgent:prompt')
    expect(host.ensurePromptMarker()).toBe(true)
    expect(host.getText()).toContain(`${MARKER}\n问`)
    expect(host.promptBlockAtCaret()).toMatchObject({ prompt: '问', empty: false })
    await tick()
    expect(markerCount(host)).toBe(1)
  })

  it('ensurePromptMarker refuses an empty pending line', () => {
    const host = editor('甲\n', 1)
    host.createPromptBlock()
    expect(host.ensurePromptMarker()).toBe(false)
    expect(host.getText()).not.toContain('rgent:prompt')
  })

  it('keeps an existing non-empty draft unupgraded and unchanged', () => {
    const source = `前文\n\n${MARKER}\n问\n`
    const host = editor(source, source.indexOf('问') + 1)
    expect(host.ensurePromptMarker()).toBe(true)
    expect(host.getText()).toBe(source)
    expect(host.promptBlockAtCaret()).toMatchObject({ prompt: '问', empty: false })
  })
})

describe('close / reopen and old marks', () => {
  it('closing an empty pending tab leaves only ordinary blank lines', () => {
    const host = editor('甲\n', 1)
    host.createPromptBlock()
    const saved = host.getText()
    expect(saved).not.toContain('rgent:prompt')
    // 切 tab 不要求清理普通空行，只要没有 marker／空提问块。
    host.setText('另一篇\n')
    expect(host.promptBlockAtCaret()).toBeNull()
    host.destroy()
    mounted.splice(mounted.indexOf(host), 1)
    const reopened = editor(saved)
    expect(reopened.getText()).toBe(saved)
    expect(reopened.getText()).not.toContain('rgent:prompt')
    expect(reopened.promptBlockAtCaret()).toBeNull()
  })

  it('an upgraded sent marker is no longer a draft and rolls nothing back', () => {
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
    expect(host.getText()).toBe('/问\n\n')
    expect(host.getText()).not.toContain('rgent:prompt')
  })
})
