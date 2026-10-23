import type { EditorView } from '@codemirror/view'
import type { PresentationPlan } from '../../../markdown/presentation.ts'
import { convertPaste } from '../../../shared/html-markdown.ts'
import { normalizeSource, sourceOf } from './source.ts'

export type PasteLike = {
  preventDefault: () => void
  clipboardData?: { getData: (type: string) => string } | null
}

/** 光标或选区完全落在围栏代码或行内代码里：粘贴不转换。 */
export function selectionInProtectedMarkup(view: EditorView, presentation: PresentationPlan): boolean {
  const projection = sourceOf(view.state)
  const from = projection.toRaw(view.state.selection.main.from)
  const to = projection.toRaw(view.state.selection.main.to)
  const inside = (start: number, end: number): boolean => from >= start && to <= end
  for (const block of presentation.blocks) {
    if (block.kind === 'code' && inside(block.range.start, block.range.end)) return true
  }
  for (const style of presentation.styles) {
    if (style.className === 'md-inlineCode' && inside(style.range.start, style.range.end)) return true
  }
  return false
}

export function handleEditorPaste(event: PasteLike, view: EditorView, presentation: PresentationPlan): boolean {
  if (view.state.readOnly) return false
  const html = event.clipboardData?.getData('text/html') ?? ''
  const plain = event.clipboardData?.getData('text/plain') ?? ''
  if (selectionInProtectedMarkup(view, presentation)) {
    const raw = plain || html
    if (!raw) return false
    event.preventDefault()
    return insertPaste(view, raw)
  }
  const converted = convertPaste({ html, plain })
  if (!converted) return false
  event.preventDefault()
  return insertPaste(view, converted)
}

function insertPaste(view: EditorView, text: string): boolean {
  const insert = normalizeSource(text)
  if (!insert) return false
  const selection = view.state.selection.main
  const before = view.state.doc.toString()
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: selection.from + insert.length },
    scrollIntoView: true,
    userEvent: 'input.paste'
  })
  return view.state.doc.toString() !== before
}
