import {
  lineStartOf,
  markerLine,
  markerLineBlock,
  parseMarker,
  type DocIndex,
  type MarkerRef,
  type SourceRange,
  type TextEdit
} from '@markdown'

/**
 * 提问块（草稿）的纯函数层：找当前位置的草稿、算一次插入、算待发送空行。
 *
 * 落盘身份见 docs/decisions.md §2026-10-23 提问块与 ⌘⇧↵：
 * 草稿 marker 紧贴提问段落，发送只把 marker 升级成带 `task-id` 的口令 marker。
 * 这里不碰 EditorView，也不编译；调用方把原文、索引与 raw 光标交进来。
 */

export const DRAFT_PROMPT_MARKER = markerLine('command', { state: 'draft' })

/** 壳只消费这三个字段；range／prompt 都是原文 raw 偏移，不含 marker。 */
export type PromptBlockAtCaret = {
  range: SourceRange
  prompt: string
  empty: boolean
}

/** 给测试与画布留一个能看出 marker／是否草稿的完整结果。 */
export type PromptBlockLocation = PromptBlockAtCaret & {
  marker: SourceRange
  draft: boolean
}

export type PromptBlockOptions = { at?: 'caret' | 'end'; text?: string }

export type PromptInsertion = {
  edit: TextEdit
  /** 插入后光标应在的原文 raw 偏移。 */
  caret: number
}

type Line = {
  /** 含 BOM 的物理行首；插入时不能把 BOM 劈开。 */
  start: number
  contentStart: number
  contentEnd: number
  /** 含行尾换行。 */
  end: number
}

function contentStartOf(source: string): number {
  return source.startsWith('\ufeff') ? 1 : 0
}

function lineAt(source: string, position: number): Line {
  const at = Math.max(0, Math.min(source.length, position))
  const start = lineStartOf(source, at)
  let contentEnd = start
  while (contentEnd < source.length && source[contentEnd] !== '\n' && source[contentEnd] !== '\r') {
    contentEnd += 1
  }
  let end = contentEnd
  if (end < source.length) end += source.startsWith('\r\n', end) ? 2 : 1
  return {
    start,
    contentStart: Math.max(start, contentStartOf(source)),
    contentEnd,
    end
  }
}

/** 插入点附近已有的换行风格；整段插入沿用它，正文 text 自身逐字节保留。 */
function newlineAt(source: string, position: number): string {
  const after = /(?:\r\n|\r|\n)/.exec(source.slice(position))
  if (after) return after[0]
  for (let at = Math.min(position, source.length) - 1; at >= 0; at -= 1) {
    if (source[at] === '\n') return at > 0 && source[at - 1] === '\r' ? '\r\n' : '\n'
    if (source[at] === '\r') return '\r'
  }
  return '\n'
}

/** 插入点所在行之前是否已经有一行空白；没有就先补一枚换行，避免 marker 贴住上一段。 */
function blankLineBefore(source: string, position: number): boolean {
  const first = contentStartOf(source)
  if (position <= first) return true
  let previousEnd = position
  if (position >= 2 && source[position - 1] === '\n' && source[position - 2] === '\r') previousEnd -= 2
  else if (source[position - 1] === '\n' || source[position - 1] === '\r') previousEnd -= 1
  else return false
  const previousStart = Math.max(first, lineStartOf(source, previousEnd))
  return source.slice(previousStart, previousEnd).trim() === ''
}

/** 从这里开始连续几行是空白行（含只有空格的行）；不算末尾没有换行的残行。 */
function leadingBlankLines(source: string, position: number): number {
  let count = 0
  let at = position
  while (at < source.length) {
    const line = lineAt(source, at)
    if (line.end === line.contentEnd) break
    if (source.slice(line.contentStart, line.contentEnd).trim() !== '') break
    count += 1
    at = line.end
  }
  return count
}

function hasContent(source: string, position: number): boolean {
  return /\S/.test(source.slice(position))
}

/** 块最后一行连同其换行；块尾已经落在换行之后时不再多吃一行。 */
function afterBlock(source: string, blockEnd: number): number {
  const end = Math.max(0, Math.min(source.length, blockEnd))
  if (end > 0 && (source[end - 1] === '\n' || source[end - 1] === '\r')) return end
  let at = end
  while (at < source.length && source[at] !== '\n' && source[at] !== '\r') at += 1
  if (at < source.length) at += source.startsWith('\r\n', at) ? 2 : 1
  return at
}

function containingBlock(blocks: readonly SourceRange[], position: number): SourceRange | null {
  let before: SourceRange | null = null
  for (const block of blocks) {
    if (block.start <= position && position < block.end) return block
    if (block.start <= position && (!before || block.start > before.start)) before = block
  }
  return before
}

/** 顶层空段：整行只有空白，且光标不在任何顶层块里（列表／引用／代码里的空行不算）。 */
function topLevelEmptyLine(source: string, blocks: readonly SourceRange[], caret: number): Line | null {
  if (blocks.some((block) => block.start <= caret && caret < block.end)) return null
  const line = lineAt(source, caret)
  if (source.slice(line.contentStart, line.contentEnd).trim() !== '') return null
  return line
}

function markerAttrs(source: string, marker: MarkerRef): Record<string, string> | null {
  const parsed = parseMarker(source.slice(marker.range.start, marker.range.end))
  if (!parsed || parsed.identity !== marker.identity) return null
  return parsed.attrs
}

/** 只有 `state="draft"` 的 command marker 是待发送草稿；带 task-id 的已发送块不算。 */
export function isDraftPromptMarker(source: string, marker: MarkerRef): boolean {
  if (marker.identity !== 'command') return false
  const attrs = markerAttrs(source, marker)
  return attrs !== null && attrs.state === 'draft' && !('task-id' in attrs)
}

/** 一枚标记按「最近的一枚」标在它下面那个顶层块上（与管线 identity 的归属一致）。 */
function markerBefore(index: DocIndex, blockStart: number): MarkerRef | null {
  let found: MarkerRef | null = null
  for (const marker of index.markers) {
    if (marker.range.end > blockStart) continue
    if (!found || marker.range.end > found.range.end) found = marker
  }
  return found
}

/** marker 与段落之间只允许恰好一个换行；空行/多行说明 marker 贴的不是这段。 */
function adjacent(source: string, marker: MarkerRef, blockStart: number): boolean {
  return /^(?:\r\n|\r|\n)$/.test(source.slice(marker.range.end, blockStart))
}

function adjacentDraftMarkers(source: string, index: DocIndex): Set<number> {
  return new Set(promptDraftChrome(source, index).askedMarkers)
}

/** 画布一次算完的草稿装饰：待发送空行 + 被误标的块起点。 */
export type PromptDraftChrome = {
  pendingLines: readonly number[]
  gapBlocks: ReadonlySet<number>
  /** 内部用：已经紧贴提问段落的草稿 marker 起点。 */
  askedMarkers: ReadonlySet<number>
}

export function promptDraftChrome(source: string, index: DocIndex): PromptDraftChrome {
  if (index.markers.length === 0) {
    return { pendingLines: [], gapBlocks: new Set(), askedMarkers: new Set() }
  }
  const markers = [...index.markers].sort((left, right) =>
    left.range.end - right.range.end || left.range.start - right.range.start)
  const blocks = [...index.blocks].sort((left, right) => left.range.start - right.range.start)
  const askedMarkers = new Set<number>()
  const gapBlocks = new Set<number>()
  let cursor = 0
  let pending: MarkerRef | null = null
  for (const block of blocks) {
    while (cursor < markers.length && markers[cursor]!.range.end <= block.range.start) {
      pending = markers[cursor]!
      cursor += 1
    }
    const marker = pending
    // 与 identity 管线一致：一枚 marker 只归它下面的那一个顶层块。
    pending = null
    if (!marker || !isDraftPromptMarker(source, marker)) continue
    if (adjacent(source, marker, block.range.start)) askedMarkers.add(marker.range.start)
    else gapBlocks.add(block.range.start)
  }
  const pendingLines = new Set<number>()
  for (const marker of markers) {
    if (!isDraftPromptMarker(source, marker) || askedMarkers.has(marker.range.start)) continue
    const line = markerLineBlock(source, marker.range)
    if (!/[\r\n]/.test(source.slice(marker.range.end, line.end))) continue
    const promptLine = lineAt(source, line.end)
    if (source.slice(promptLine.contentStart, promptLine.contentEnd).trim() !== '') continue
    pendingLines.add(line.end)
  }
  return {
    pendingLines: [...pendingLines].sort((left, right) => left - right),
    gapBlocks,
    askedMarkers
  }
}

/**
 * 草稿 marker 与一个非相邻块之间的空档：编译管线会把 marker 标到后面那个块上，
 * 但那不是提问正文。画布要跳过这种误标，等人在空行里打出真正的提问段。
 */
export function commandBlockHasDraftGap(source: string, index: DocIndex, block: SourceRange): boolean {
  return promptDraftChrome(source, index).gapBlocks.has(block.start)
}

/**
 * 光标所在的草稿提问块；只认 `state="draft"`。
 * - 有正文：返回紧贴 marker 的顶层段落（raw 范围，不含 marker）。
 * - 空草稿：返回 marker 下面那一行空行（start === end），光标必须落在这一行。
 * - 已发送（task-id）、人的块、草稿下方被误标的块：null。
 */
export function locatePromptBlock(source: string, index: DocIndex, caret: number): PromptBlockLocation | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > source.length) return null
  for (const block of index.blocks) {
    if (block.identity !== 'command') continue
    if (caret < block.range.start || caret > block.range.end) continue
    const marker = markerBefore(index, block.range.start)
    if (!marker || !isDraftPromptMarker(source, marker)) continue
    if (!adjacent(source, marker, block.range.start)) continue
    const prompt = source.slice(block.range.start, block.range.end)
    return {
      range: block.range,
      prompt,
      empty: prompt.trim().length === 0,
      marker: marker.range,
      draft: true
    }
  }
  const asked = adjacentDraftMarkers(source, index)
  for (const marker of index.markers) {
    if (!isDraftPromptMarker(source, marker) || asked.has(marker.range.start)) continue
    const line = markerLineBlock(source, marker.range)
    // marker 自己那一行没有换行（文件末尾的裸 marker）时不装作有提问行。
    if (!/[\r\n]/.test(source.slice(marker.range.end, line.end))) continue
    const promptLine = lineAt(source, line.end)
    if (caret < line.end || caret > promptLine.contentEnd) continue
    if (source.slice(promptLine.contentStart, promptLine.contentEnd).trim() !== '') continue
    return {
      range: { start: line.end, end: promptLine.contentEnd },
      prompt: source.slice(line.end, promptLine.contentEnd),
      empty: true,
      marker: marker.range,
      draft: true
    }
  }
  return null
}

/** 空草稿的一次性删除：marker 行 + 空提问行一起移除，不碰其它内容。 */
export function planEmptyPromptRemoval(source: string, index: DocIndex, caret: number): TextEdit | null {
  const found = locatePromptBlock(source, index, caret)
  if (!found || !found.empty) return null
  const from = lineStartOf(source, found.marker.start)
  let to = found.range.end
  if (source.startsWith('\r\n', to)) to += 2
  else if (to < source.length && (source[to] === '\n' || source[to] === '\r')) to += 1
  return { from, to, insert: '' }
}

/**
 * 空草稿的待发送行：marker 下面那行还没有 Markdown 块，画布要自己补
 * `.rgent-block-command` + `.rgent-block-command-first`，才有与已发送块相同的 `>` 和缩进。
 */
export function pendingPromptDraftLines(source: string, index: DocIndex): number[] {
  return [...promptDraftChrome(source, index).pendingLines]
}

function reuseEmptyLine(source: string, line: Line): PromptInsertion {
  const at = Math.max(line.start, contentStartOf(source))
  const eol = newlineAt(source, at)
  const prefix = blankLineBefore(source, at) ? '' : eol
  // 原来这行空行就是提问行；下面已有空行时它当分隔，否则再补一行分隔。
  const suffix = hasContent(source, line.end) && leadingBlankLines(source, line.end) === 0 ? eol : ''
  return {
    edit: { from: at, to: at, insert: prefix + DRAFT_PROMPT_MARKER + eol + suffix },
    caret: at + prefix.length + DRAFT_PROMPT_MARKER.length + eol.length
  }
}

function appendAfter(source: string, at: number, text: string | null): PromptInsertion {
  const eol = newlineAt(source, at)
  // 块尾落在没有换行的文件末尾时，先补「换行 + 空行」，marker 才不会贴住最后一行。
  const endsMidLine = at > 0 && source[at - 1] !== '\n' && source[at - 1] !== '\r'
  const prefix = endsMidLine ? eol + eol : blankLineBefore(source, at) ? '' : eol
  const rest = source.slice(at)
  const restHasContent = hasContent(source, at)
  const blanks = leadingBlankLines(source, at)
  const textStart = prefix.length + DRAFT_PROMPT_MARKER.length + eol.length
  let insert = prefix + DRAFT_PROMPT_MARKER + eol
  let caret = at + textStart
  if (text != null) {
    insert += text + eol
    caret = at + textStart + text.length
    if (restHasContent && blanks === 0) insert += eol
    return { edit: { from: at, to: at, insert }, caret }
  }
  if (restHasContent) {
    if (blanks === 0) insert += eol + eol
    else if (blanks === 1) insert += eol
  }
  return { edit: { from: at, to: at, insert }, caret }
}

/**
 * 算一次「创建提问块」：
 * - 光标在顶层空段：复用那一行（不再插空行）。
 * - 其他位置：在包含光标的顶层块之后插入（列表／引用／代码整块之后，不切原文）。
 * - `at: 'end'`：接在最后一个顶层块之后；没有块时用文末。
 * - `text`：暂停重发用，正文按给定字节插入，不做 slash 处理。
 *
 * marker 与正文之间恰好一个换行；空草稿的提问行由编辑器补行类。
 */
export function planPromptInsertion(
  source: string,
  index: DocIndex,
  caret: number,
  options: PromptBlockOptions = {}
): PromptInsertion {
  const text = options.text != null && options.text.length > 0 ? options.text : null
  const safeCaret = Number.isFinite(caret) ? Math.max(0, Math.min(source.length, Math.trunc(caret))) : 0
  const blocks = [...index.blocks].map((block) => block.range).sort((left, right) => left.start - right.start)
  if (options.at !== 'end' && text == null) {
    const empty = topLevelEmptyLine(source, blocks, safeCaret)
    if (empty) return reuseEmptyLine(source, empty)
  }
  if (options.at === 'end') {
    const last = blocks.at(-1)
    return appendAfter(source, last ? afterBlock(source, last.end) : source.length, text)
  }
  const reference = containingBlock(blocks, safeCaret)
  return appendAfter(source, reference ? afterBlock(source, reference.end) : lineAt(source, safeCaret).end, text)
}
