import { isVaultImagePath } from '../shared/vault-rel.ts'
import { acceptMarker, discardMarkedBlock, identityUnits, swapUnits, type TextEdit } from './identity-edit.ts'
import type {
  CalloutRef,
  DocIndex,
  ImageRef,
  MarkerRef,
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
  /**
   * 身份标记的 chip：替掉整行注释。这一处能做的动作在这里一次算完，
   * 画布那边只负责 dispatch——视图层不重算管线，也不自己拼文本。
   */
  | {
      kind: 'marker'
      range: SourceRange
      marker: MarkerRef
      accept: TextEdit | null
      discard: TextEdit | null
      moveUp: TextEdit | null
      moveDown: TextEdit | null
    }

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

  // 单位表与下标表都只算一次：这段每次按键都会跑，逐个标记重算就是 O(块 × 标记)。
  const units = index.markers.length > 0 ? identityUnits(index) : []
  const unitOfMarker = new Map<number, number>()
  units.forEach((unit, at) => {
    if (unit.marker) unitOfMarker.set(unit.marker.range.start, at)
  })

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

  // 标记排在最后，而且**不走 push 的重叠去重**：去重是 `out.some(...)`，整篇规划下
  // 标记一多就是 O(标记²)——实测 250 / 500 / 1000 / 2000 个标记的每标记耗时一路翻倍
  // （1.6 / 2.3 / 4.2 / 8.1 µs）。标记是整行注释叶子，本来就不可能和别的部件重叠。
  for (const marker of index.markers) {
    // 只替换注释本身，不连整行一起换：块级替换会在 CM6 里吞掉紧随其后的行装饰
    // （实测：装饰集里 [29,29,'rgent-block-ai'] 正确存在，却没落到 DOM 上）；
    // 而这一行本来就是空的，留着它也看不出区别。
    const range = clipInline(marker.range, viewports, docLen)
    if (!range) continue
    const at = unitOfMarker.get(marker.range.start)
    const unit = at == null ? null : units[at]!
    const block = unit ? unit.block : null
    out.push({
      kind: 'marker',
      range,
      marker,
      // 删标记对人写的口令也成立（身份没了而已），丢弃 / 搬家只对 AI 块有意义。
      accept: acceptMarker(source, marker),
      discard: block && marker.identity === 'ai' ? discardMarkedBlock(source, marker, block) : null,
      moveUp: at != null && at > 0 && marker.identity === 'ai' ? swapUnits(source, units, at - 1, at) : null,
      moveDown:
        at != null && at + 1 < units.length && marker.identity === 'ai'
          ? swapUnits(source, units, at, at + 1)
          : null
    })
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
