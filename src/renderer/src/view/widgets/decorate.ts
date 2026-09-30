import { Decoration } from '@codemirror/view'
import type { PlannedWidget } from '@markdown'
import type { NoteHost } from '../host.ts'
import { CalloutWidget } from './callout.ts'
import { ImageWidget } from './image.ts'
import { MarkerWidget } from './marker.ts'
import { MathWidget } from './math.ts'
import { MermaidWidget } from './mermaid.ts'
import { TableWidget } from './table.ts'
import { WikilinkWidget } from './wikilink.ts'

export function decorationForWidget(
  widget: PlannedWidget,
  host: NoteHost,
  dark = false
): Decoration {
  switch (widget.kind) {
    case 'table':
      return Decoration.replace({ widget: new TableWidget(widget.table, host), block: true })
    case 'image':
      return Decoration.replace({ widget: new ImageWidget(widget.image, host, widget.standalone), block: widget.block })
    case 'math':
      return Decoration.replace({
        widget: new MathWidget(widget.math),
        block: widget.math.block
      })
    case 'callout':
      return Decoration.replace({ widget: new CalloutWidget(widget.callout, host), block: true })
    case 'wikilink':
      return Decoration.replace({ widget: new WikilinkWidget(widget.wikilink, host) })
    case 'mermaid':
      // mermaid 的 SVG 自带配色，主题换了要重建才跟着变（见 MermaidWidget）。
      return Decoration.replace({ widget: new MermaidWidget(widget.mermaid, dark), block: true })
    case 'marker':
      // 行内部件：只换掉注释文本。块级替换会吞掉紧随其后的行装饰（见 view-plan.ts）。
      return Decoration.replace({ widget: new MarkerWidget(widget) })
  }
}
