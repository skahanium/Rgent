import { compile, DEFAULT_STAGES, planWidgets, rangesOverlap, recoverCompile, type CompileResult, type ImageRef, type TableRef } from '@markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { EditorState, type Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type ViewUpdate
} from '@codemirror/view'


class TableWidget extends WidgetType {
  constructor(readonly table: TableRef) {
    super()
  }

  eq(other: TableWidget): boolean {
    return JSON.stringify(this.table.header) === JSON.stringify(other.table.header)
      && JSON.stringify(this.table.rows) === JSON.stringify(other.table.rows)
  }

  toDOM(): HTMLElement {
    const table = document.createElement('table')
    table.className = 'md-table'
    table.setAttribute('aria-label', '表格')
    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const cell of this.table.header) {
      const th = document.createElement('th')
      th.textContent = cell
      headRow.append(th)
    }
    thead.append(headRow)
    table.append(thead)
    const tbody = document.createElement('tbody')
    for (const row of this.table.rows) {
      const tr = document.createElement('tr')
      for (const cell of row) {
        const td = document.createElement('td')
        td.textContent = cell
        tr.append(td)
      }
      tbody.append(tr)
    }
    table.append(tbody)
    return table
  }

  ignoreEvent(): boolean {
    return true
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly image: ImageRef) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return this.image.url === other.image.url && this.image.alt === other.image.alt
  }

  toDOM(): HTMLElement {
    const figure = document.createElement('span')
    figure.className = 'md-image-ph'
    figure.setAttribute('role', 'img')
    figure.setAttribute('aria-label', this.image.alt || '图片')
    const label = document.createElement('span')
    label.textContent = this.image.alt || '图片'
    const src = document.createElement('span')
    src.className = 'md-image-src'
    src.textContent = this.image.url
    figure.append(label, src)
    return figure
  }

  ignoreEvent(): boolean {
    return true
  }
}

function decorationsFor(view: EditorView, result: CompileResult): DecorationSet {
  const decos: Range<Decoration>[] = []
  const source = view.state.doc.toString()
  const docLen = source.length
  const widgets = planWidgets(result.index, source, view.visibleRanges)

  for (const widget of widgets) {
    if (widget.kind === 'table') {
      decos.push(
        Decoration.replace({ widget: new TableWidget(widget.table), block: true }).range(
          widget.range.start,
          widget.range.end
        )
      )
    } else {
      decos.push(
        Decoration.replace({ widget: new ImageWidget(widget.image) }).range(widget.range.start, widget.range.end)
      )
    }
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
      try {
        if (update.docChanged) {
          this.result = compile(update.state.doc.toString(), { prev: this.result })
        }
        if (update.docChanged || update.viewportChanged) {
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
  focus: () => void
  destroy: () => void
}

export function mountEditor(
  parent: HTMLElement,
  onChange: (text: string) => void,
  onSave: () => void
): EditorHost {
  let applying = false
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
    focus: () => view.focus(),
    destroy: () => view.destroy()
  }
}
