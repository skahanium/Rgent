import type { DocIndex, ImageRef, SourceRange, TableRef } from './types.ts'
import { inViewport } from './viewport.ts'

export type PlannedWidget =
  | { kind: 'table'; range: SourceRange; table: TableRef }
  | { kind: 'image'; range: SourceRange; image: ImageRef }

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
  for (const table of index.tables) {
    if (!viewports.some((port) => inViewport(table.range, port.from, port.to))) continue
    const range = expandToLineBlock(source, table.range)
    if (range.end <= range.start) continue
    if (out.some((widget) => rangesOverlap(widget.range, range))) continue
    out.push({ kind: 'table', range, table })
  }
  for (const image of index.images) {
    if (!viewports.some((port) => inViewport(image.range, port.from, port.to))) continue
    if (image.range.end <= image.range.start) continue
    if (out.some((widget) => rangesOverlap(widget.range, image.range))) continue
    out.push({ kind: 'image', range: image.range, image })
  }
  return out
}
