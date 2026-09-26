import type { DocIndex, MarkerRef, SourceRange } from './types.ts'

/**
 * 身份标记的编辑动作，全部是「算出一处文本变更」的纯函数：
 * 触发点在画布（chip 上的按钮），这里只负责算，不碰 EditorView。
 *
 * 围栏：采纳 = 删掉那一枚标记（正文一字不改）；丢弃 = 连同它标的块一起删；
 * 拖动是搬家，只换位置、不换身份，标记必须跟着它标的块走。
 */

export type TextEdit = { from: number; to: number; insert: string }

export function lineStartOf(source: string, pos: number): number {
  const at = Math.max(0, Math.min(source.length, pos))
  const found = source.lastIndexOf('\n', at - 1)
  return found < 0 ? 0 : found + 1
}

function lineEndOf(source: string, pos: number): number {
  const found = source.indexOf('\n', pos)
  return found < 0 ? source.length : found + 1
}

/** 标记所在的整行（含换行），画布拿它换掉这一行。 */
export function markerLineBlock(source: string, marker: SourceRange): SourceRange {
  return { start: lineStartOf(source, marker.start), end: lineEndOf(source, marker.end) }
}



/**
 * 采纳：删掉标记那一行。正文一个字都不动，块从此跟手写的一样。
 */
export function acceptMarker(source: string, marker: MarkerRef): TextEdit | null {
  const line = markerLineBlock(source, marker.range)
  if (line.end <= line.start) return null
  return { from: line.start, to: line.end, insert: '' }
}

/**
 * 丢弃：标记行连同它标的块一起删，并把两侧的空行收成一个。
 * 块是文件最后一块时不留尾空行。
 *
 * 只算这一处，**不做整篇切片**：这个函数在每次按键时都会为每个标记跑一遍，
 * 整篇切一次就是 O(正文 × 标记数)——实测 57 KB、1000 个标记时要 119 ms 一次。
 */
export function discardMarkedBlock(source: string, marker: MarkerRef, block: SourceRange): TextEdit | null {
  const line = markerLineBlock(source, marker.range)
  if (block.end < line.end) return null
  let to = block.end
  while (to < source.length && source[to] === '\n') to += 1
  let from = line.start
  if (to >= source.length) {
    // 块在文件末尾：把前面的空行也收掉，只留一个换行收尾。
    while (from > 0 && source[from - 1] === '\n') from -= 1
    return { from, to, insert: from === 0 ? '' : '\n' }
  }
  if (from === 0) return { from, to, insert: '' }
  const beforeIsNewline = source[from - 1] === '\n'
  const beforeIsBlank = beforeIsNewline && from >= 2 && source[from - 2] === '\n'
  return { from, to, insert: beforeIsBlank ? '' : beforeIsNewline ? '\n' : '\n\n' }
}

/** 一个「搬家单位」= 一个顶层块，加上紧挨在它前面的那枚标记（如果有）。 */
export type IdentityUnit = {
  marker: MarkerRef | null
  block: SourceRange
}

/**
 * 把顶层块切成搬家单位。标记必须跟着它标的块走，所以把标记算进单位的开头，
 * 否则上移一个 AI 块会把标记留在原地、改标到别的块上。
 */
export function identityUnits(index: DocIndex): IdentityUnit[] {
  const markers = [...index.markers].sort((left, right) => left.range.start - right.range.start)
  const units: IdentityUnit[] = []
  let next = 0
  for (const block of [...index.blocks].sort((left, right) => left.range.start - right.range.start)) {
    let marker: MarkerRef | null = null
    while (next < markers.length && markers[next]!.range.end <= block.range.start) {
      marker = markers[next]!
      next += 1
    }
    units.push({ marker, block: block.range })
  }
  return units
}

function unitStart(source: string, unit: IdentityUnit): number {
  return unit.marker ? markerLineBlock(source, unit.marker.range).start : lineStartOf(source, unit.block.start)
}

function unitText(source: string, unit: IdentityUnit): string {
  return source.slice(unitStart(source, unit), unit.block.end)
}

/** 把相邻两个单位换个位置：两边的文本整段调换，中间固定收成一个空行。 */
export function swapUnits(source: string, units: readonly IdentityUnit[], first: number, second: number): TextEdit | null {
  const left = units[first]
  const right = units[second]
  if (!left || !right || first === second) return null
  const [a, b] = first < second ? [left, right] : [right, left]
  return {
    from: unitStart(source, a),
    to: b.block.end,
    insert: `${unitText(source, b)}\n\n${unitText(source, a)}`
  }
}

/**
 * 拖动是搬家：只和相邻的那一个单位换位置，身份不变。带标记的块连标记一起搬。
 * 计划层要按标记逐个算动作，所以它用 `swapUnits` 复用在外面算好的单位表——
 * 这里这份是给单点调用（与测试）用的。
 */
export function moveUnit(
  source: string,
  index: DocIndex,
  blockStart: number,
  direction: 'up' | 'down'
): TextEdit | null {
  const units = identityUnits(index)
  const at = units.findIndex((unit) => unit.block.start === blockStart)
  if (at < 0) return null
  const other = direction === 'up' ? at - 1 : at + 1
  if (other < 0 || other >= units.length) return null
  return swapUnits(source, units, at, other)
}
