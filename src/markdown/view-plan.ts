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

export function rangeInDoc(range: SourceRange, docLen: number): SourceRange | null {
  if (range.start < 0 || range.end > docLen || range.end <= range.start) return null
  return range
}

export function planWidgets(
  index: DocIndex,
  source: string,
  viewports: readonly { from: number; to: number }[]
): PlannedWidget[] {
  const out: PlannedWidget[] = []
  const docLen = source.length

  for (const callout of index.callouts) {
    const range = clipBlock(source, callout.range, viewports, docLen)
    if (!range) continue
    push(out, { kind: 'callout', range, callout })
  }
  for (const table of index.tables) {
    const range = clipBlock(source, table.range, viewports, docLen)
    if (!range) continue
    push(out, { kind: 'table', range, table })
  }
  for (const mermaid of index.mermaid) {
    const range = clipBlock(source, mermaid.range, viewports, docLen)
    if (!range) continue
    push(out, { kind: 'mermaid', range, mermaid })
  }
  for (const math of index.maths) {
    if (!math.block) continue
    const range = clipBlock(source, math.range, viewports, docLen)
    if (!range) continue
    push(out, { kind: 'math', range, math })
  }
  for (const image of index.images) {
    const range = clipInline(image.range, viewports, docLen)
    if (!range) continue
    push(out, { kind: 'image', range, image })
  }
  for (const link of index.wikilinks) {
    const range = clipInline(link.range, viewports, docLen)
    if (!range) continue
    if (link.embed && isVaultImagePath(link.target)) {
      const image: ImageRef = {
        range: link.range,
        url: link.target,
        alt: link.display,
        base: 'vault'
      }
      push(out, { kind: 'image', range, image })
      continue
    }
    push(out, { kind: 'wikilink', range, wikilink: link })
  }
  for (const math of index.maths) {
    if (math.block) continue
    const range = clipInline(math.range, viewports, docLen)
    if (!range) continue
    push(out, { kind: 'math', range, math })
  }
  return out
}

function visible(range: SourceRange, viewports: readonly { from: number; to: number }[]): boolean {
  return viewports.some((port) => inViewport(range, port.from, port.to))
}

function clipInline(
  range: SourceRange,
  viewports: readonly { from: number; to: number }[],
  docLen: number
): SourceRange | null {
  if (!rangeInDoc(range, docLen)) return null
  if (!visible(range, viewports)) return null
  return range
}

function clipBlock(
  source: string,
  range: SourceRange,
  viewports: readonly { from: number; to: number }[],
  docLen: number
): SourceRange | null {
  const clipped = clipInline(range, viewports, docLen)
  if (!clipped) return null
  return expandToLineBlock(source, clipped)
}

function push(out: PlannedWidget[], widget: PlannedWidget): void {
  if (widget.range.end <= widget.range.start) return
  if (out.some((item) => rangesOverlap(item.range, widget.range))) return
  out.push(widget)
}
