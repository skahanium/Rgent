import { compile, DEFAULT_STAGES, planWidgets, rangesOverlap, recoverCompile, type CompileResult } from '@markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { Compartment, EditorState, Facet, type Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  keymap,
  type ViewUpdate
} from '@codemirror/view'
import { emptyNoteHost, type NoteHost } from './host.ts'
import { decorationForWidget } from './widgets/decorate.ts'

const noteHostFacet = Facet.define<NoteHost, NoteHost>({
  combine: (values) => values[0] ?? emptyNoteHost
})

function decorationsFor(view: EditorView, result: CompileResult): DecorationSet {
  const decos: Range<Decoration>[] = []
  const source = view.state.doc.toString()
  const docLen = source.length
  const host = view.state.facet(noteHostFacet)
  const widgets = planWidgets(result.index, source, view.visibleRanges)

  for (const widget of widgets) {
    decos.push(decorationForWidget(widget, host).range(widget.range.start, widget.range.end))
  }

  for (const heading of result.index.headings) {
    if (widgets.some((widget) => rangesOverlap(heading.range, widget.range))) continue
    const pos = clamp(heading.range.start, 0, Math.max(0, docLen - 1))
    decos.push(Decoration.line({ class: `md-heading md-h${heading.depth}` }).range(pos))
  }
  for (const mark of result.index.marks) {
    if (widgets.some((widget) => rangesOverlap(mark.range, widget.range))) continue
    const start = clamp(mark.range.start, 0, docLen)
    const end = clamp(mark.range.end, 0, docLen)
    if (end <= start) continue
    decos.push(Decoration.mark({ class: `md-${mark.type}` }).range(start, end))
  }

  return Decoration.set(decos, true)
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

const pipelinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    result: CompileResult

    constructor(view: EditorView) {
      try {
        this.result = compile(view.state.doc.toString())
        this.decorations = decorationsFor(view, this.result)
      } catch (err) {
        this.result = recoverCompile(
          view.state.doc.toString(),
          DEFAULT_STAGES,
          err instanceof Error ? err.message : String(err)
        )
        this.decorations = Decoration.none
      }
    }

    update(update: ViewUpdate): void {
      const hostChanged = update.startState.facet(noteHostFacet) !== update.state.facet(noteHostFacet)
      try {
        if (update.docChanged) {
          this.result = compile(update.state.doc.toString(), { prev: this.result })
        }
        if (update.docChanged || update.viewportChanged || hostChanged) {
          this.decorations = decorationsFor(update.view, this.result)
        }
      } catch (err) {
        this.result = recoverCompile(
          update.state.doc.toString(),
          this.result.stages,
          err instanceof Error ? err.message : String(err),
          this.result
        )
      }
    }
  },
  { decorations: (value) => value.decorations }
)

const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    fontSize: '17px'
  },
  '.cm-scroller': {
    fontFamily: '"Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif',
    lineHeight: '1.65'
  },
  '.cm-content': {
    caretColor: '#215c45',
    padding: '28px 8px 48px',
    maxWidth: '42rem',
    margin: '0 auto'
  },
  '.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: '#215c45' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: '#cde3d6'
  }
})

export type EditorHost = {
  view: EditorView
  getText: () => string
  setText: (text: string) => void
  setNoteHost: (host: NoteHost) => void
  focus: () => void
  destroy: () => void
}

export type { NoteHost }

export function mountEditor(
  parent: HTMLElement,
  onChange: (text: string) => void,
  onSave: () => void
): EditorHost {
  let applying = false
  const hostCompartment = new Compartment()
  const state = EditorState.create({
    doc: '',
    extensions: [
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        {
          key: 'Mod-s',
          run: () => {
            onSave()
            return true
          }
        }
      ]),
      EditorView.lineWrapping,
      theme,
      hostCompartment.of(noteHostFacet.of(emptyNoteHost)),
      pipelinePlugin,
      EditorView.updateListener.of((update) => {
        if (applying || !update.docChanged) return
        onChange(update.state.doc.toString())
      })
    ]
  })
  const view = new EditorView({ state, parent })
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText: (text) => {
      applying = true
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text }
      })
      applying = false
    },
    setNoteHost: (host) => {
      view.dispatch({ effects: hostCompartment.reconfigure(noteHostFacet.of(host)) })
    },
    focus: () => view.focus(),
    destroy: () => view.destroy()
  }
}
