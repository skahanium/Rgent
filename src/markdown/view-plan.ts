import { isVaultImagePath } from '../shared/vault-rel.ts'
import type {
  CalloutRef,
  DocIndex,
  ImageRef,
  MathRef,
  MermaidRef,
  SourceRange,
  TableRef,
  WikiLinkRef
} from './types.ts'
import { inViewport } from './viewport.ts'

export type PlannedWidget =
  | { kind: 'table'; range: SourceRange; table: TableRef }
  | { kind: 'image'; range: SourceRange; image: ImageRef }
  | { kind: 'math'; range: SourceRange; math: MathRef }
  | { kind: 'callout'; range: SourceRange; callout: CalloutRef }
  | { kind: 'wikilink'; range: SourceRange; wikilink: WikiLinkRef }
  | { kind: 'mermaid'; range: SourceRange; mermaid: MermaidRef }

export function expandToLineBlock(source: string, range: SourceRange): SourceRange {
  let start = Math.max(0, range.start)
  let end = Math.min(source.length, range.end)
  while (start > 0 && source[start - 1] !== '\n') start -= 1
  if (end < source.length) {
    while (end < source.length && source[end] !== '\n') end += 1
    if (end < source.length && source[end] === '\n') end += 1
  }
  return { start, end }
}

export function rangesOverlap(a: SourceRange, b: SourceRange): boolean {
  return a.start < b.end && b.start < a.end
}

export function planWidgets(
  index: DocIndex,
  source: string,
  viewports: readonly { from: number; to: number }[]
): PlannedWidget[] {
  const out: PlannedWidget[] = []

  for (const callout of index.callouts) {
    if (!visible(callout.range, viewports)) continue
    push(out, { kind: 'callout', range: expandToLineBlock(source, callout.range), callout })
  }
  for (const table of index.tables) {
    if (!visible(table.range, viewports)) continue
    push(out, { kind: 'table', range: expandToLineBlock(source, table.range), table })
  }
  for (const mermaid of index.mermaid) {
    if (!visible(mermaid.range, viewports)) continue
    push(out, { kind: 'mermaid', range: expandToLineBlock(source, mermaid.range), mermaid })
  }
  for (const math of index.maths) {
    if (!math.block) continue
    if (!visible(math.range, viewports)) continue
    push(out, { kind: 'math', range: expandToLineBlock(source, math.range), math })
  }
  for (const image of index.images) {
    if (!visible(image.range, viewports)) continue
    push(out, { kind: 'image', range: image.range, image })
  }
  for (const link of index.wikilinks) {
    if (!visible(link.range, viewports)) continue
    if (link.embed && isVaultImagePath(link.target)) {
      const image: ImageRef = {
        range: link.range,
        url: link.target,
        alt: link.display,
        base: 'vault'
      }
      push(out, { kind: 'image', range: link.range, image })
      continue
    }
    push(out, { kind: 'wikilink', range: link.range, wikilink: link })
  }
  for (const math of index.maths) {
    if (math.block) continue
    if (!visible(math.range, viewports)) continue
    push(out, { kind: 'math', range: math.range, math })
  }
  return out
}

function visible(range: SourceRange, viewports: readonly { from: number; to: number }[]): boolean {
  return viewports.some((port) => inViewport(range, port.from, port.to))
}

function push(out: PlannedWidget[], widget: PlannedWidget): void {
  if (widget.range.end <= widget.range.start) return
  if (out.some((item) => rangesOverlap(item.range, widget.range))) return
  out.push(widget)
}
