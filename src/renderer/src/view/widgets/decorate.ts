import { Decoration } from '@codemirror/view'
import type { PlannedWidget } from '@markdown'
import type { NoteHost } from '../host.ts'
import { CalloutWidget } from './callout.ts'
import { ImageWidget } from './image.ts'
import { MathWidget } from './math.ts'
import { MermaidWidget } from './mermaid.ts'
import { TableWidget } from './table.ts'
import { WikilinkWidget } from './wikilink.ts'

export function decorationForWidget(widget: PlannedWidget, host: NoteHost): Decoration {
  switch (widget.kind) {
    case 'table':
      return Decoration.replace({ widget: new TableWidget(widget.table), block: true })
    case 'image':
      return Decoration.replace({ widget: new ImageWidget(widget.image, host) })
    case 'math':
      return Decoration.replace({
        widget: new MathWidget(widget.math),
        block: widget.math.block
      })
    case 'callout':
      return Decoration.replace({ widget: new CalloutWidget(widget.callout), block: true })
    case 'wikilink':
      return Decoration.replace({ widget: new WikilinkWidget(widget.wikilink, host) })
    case 'mermaid':
      return Decoration.replace({ widget: new MermaidWidget(widget.mermaid), block: true })
  }
}
