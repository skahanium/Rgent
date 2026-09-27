/**
 * 冲突双预览的差异计算（纯函数，可单测）。
 *
 * 围栏（decisions.md §库、文件、窗口）要求给出并排两份**可读**预览、同样的前后文，
 * 并分别强调发生变化的文字。所以：
 *
 * - 先按行对齐（LCS），变化的行再按字符细化——中文没有词边界，按词切会切坏语义。
 * - 只渲染变化处附近的上下文，中间的长段同一内容折叠成「省略 N 行」。
 * - 变化簇太多时只渲染前几簇，其余计数报出来（「还有 N 处差异」），
 *   免得一次弹出一篇论文。
 */

export type LineMarks = Array<[number, number]>

export type DiffRow =
  | { kind: 'same'; text: string }
  | {
      kind: 'changed'
      windowLine: string
      diskLine: string
      windowMarks: LineMarks
      diskMarks: LineMarks
      /** 只有一边有这一行（增行／删行）。 */
      oneSided: 'window' | 'disk' | null
    }
  | { kind: 'gap'; lines: number }

export type DiffPreview = {
  rows: DiffRow[]
  /** 没渲染出来的变化簇里还藏着多少处差异。 */
  hidden: number
  truncated: boolean
}

export type DiffLimits = {
  /** 每个变化簇上下各留几行同样的前后文。 */
  context?: number
  /** 最多渲染几个变化簇。 */
  maxHunks?: number
  /** 单行超过这个长度就不再按字符细化，整行强调。 */
  maxLine?: number
}

const DEFAULTS = { context: 2, maxHunks: 6, maxLine: 240 }

type Pair = { windowLine: string | null; diskLine: string | null }

/** 行级对齐：去掉公共前后缀，中间用 LCS；中间太大就退化成「整段算变化」。 */
function align(windowLines: string[], diskLines: string[]): Pair[] {
  let head = 0
  while (
    head < windowLines.length &&
    head < diskLines.length &&
    windowLines[head] === diskLines[head]
  ) {
    head += 1
  }
  let tail = 0
  while (
    tail < windowLines.length - head &&
    tail < diskLines.length - head &&
    windowLines[windowLines.length - 1 - tail] === diskLines[diskLines.length - 1 - tail]
  ) {
    tail += 1
  }

  const midWindow = windowLines.slice(head, windowLines.length - tail)
  const midDisk = diskLines.slice(head, diskLines.length - tail)
  const pairs: Pair[] = []
  for (let index = 0; index < head; index += 1) {
    pairs.push({ windowLine: windowLines[index]!, diskLine: diskLines[index]! })
  }
  pairs.push(...alignMiddle(midWindow, midDisk))
  for (let index = tail; index > 0; index -= 1) {
    pairs.push({
      windowLine: windowLines[windowLines.length - index]!,
      diskLine: diskLines[diskLines.length - index]!
    })
  }
  return pairs
}

/**
 * 把相邻的「删一行 + 加一行」按顺序配对成「改了一行」。
 * 纯 LCS 只会给出删与加，两栏预览就看不出 v1 → v2 的对照——而那正是要看的东西。
 * 一边多出来的仍然算单边增删。
 */
function coalesce(pairs: Pair[]): Pair[] {
  const out: Pair[] = []
  let index = 0
  while (index < pairs.length) {
    const pair = pairs[index]!
    if (pair.windowLine != null && pair.diskLine != null) {
      out.push(pair)
      index += 1
      continue
    }
    const removed: string[] = []
    const added: string[] = []
    while (index < pairs.length) {
      const next = pairs[index]!
      if (next.windowLine != null && next.diskLine != null) break
      if (next.windowLine != null) removed.push(next.windowLine)
      else if (next.diskLine != null) added.push(next.diskLine)
      index += 1
    }
    const paired = Math.min(removed.length, added.length)
    for (let at = 0; at < paired; at += 1) {
      out.push({ windowLine: removed[at]!, diskLine: added[at]! })
    }
    for (let at = paired; at < removed.length; at += 1) out.push({ windowLine: removed[at]!, diskLine: null })
    for (let at = paired; at < added.length; at += 1) out.push({ windowLine: null, diskLine: added[at]! })
  }
  return out
}

const MAX_DP_LINES = 240

function alignMiddle(windowLines: string[], diskLines: string[]): Pair[] {
  if (windowLines.length === 0 && diskLines.length === 0) return []
  if (windowLines.length === 0) return diskLines.map((line) => ({ windowLine: null, diskLine: line }))
  if (diskLines.length === 0) return windowLines.map((line) => ({ windowLine: line, diskLine: null }))
  // 太大就不做 DP：整段当变化，靠字符级细化给出信息，也不至于卡住界面。
  if (windowLines.length > MAX_DP_LINES || diskLines.length > MAX_DP_LINES) {
    const length = Math.max(windowLines.length, diskLines.length)
    return Array.from({ length }, (_, index) => ({
      windowLine: windowLines[index] ?? null,
      diskLine: diskLines[index] ?? null
    }))
  }

  const rows = windowLines.length
  const cols = diskLines.length
  // LCS 长度表；行数被 MAX_DP_LINES 卡住，内存可控。
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0))
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j] =
        windowLines[i] === diskLines[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const pairs: Pair[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (windowLines[i] === diskLines[j]) {
      pairs.push({ windowLine: windowLines[i]!, diskLine: diskLines[j]! })
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      pairs.push({ windowLine: windowLines[i]!, diskLine: null })
      i += 1
    } else {
      pairs.push({ windowLine: null, diskLine: diskLines[j]! })
      j += 1
    }
  }
  while (i < rows) pairs.push({ windowLine: windowLines[i++]!, diskLine: null })
  while (j < cols) pairs.push({ windowLine: null, diskLine: diskLines[j++]! })
  return pairs
}

/** 一行内的字符级强调：公共前后缀之外就是变化处。长行直接整行强调。 */
export function markLine(before: string, after: string, maxLine = DEFAULTS.maxLine): [LineMarks, LineMarks] {
  if (before === after) return [[], []]
  if (before.length > maxLine || after.length > maxLine) {
    return [
      before.length > 0 ? [[0, before.length]] : [],
      after.length > 0 ? [[0, after.length]] : []
    ]
  }
  let head = 0
  const shortest = Math.min(before.length, after.length)
  while (head < shortest && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < shortest - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1
  }
  const beforeEnd = before.length - tail
  const afterEnd = after.length - tail
  return [
    beforeEnd > head ? [[head, beforeEnd]] : [],
    afterEnd > head ? [[head, afterEnd]] : []
  ]
}

export function diffPreview(windowText: string, diskText: string, limits: DiffLimits = {}): DiffPreview {
  const context = limits.context ?? DEFAULTS.context
  const maxHunks = limits.maxHunks ?? DEFAULTS.maxHunks
  const maxLine = limits.maxLine ?? DEFAULTS.maxLine
  const pairs = coalesce(align(windowText.split('\n'), diskText.split('\n')))

  const changed = pairs.map((pair) => pair.windowLine !== pair.diskLine)
  // 变化簇：连续的变化行（中间隔着不超过 2*context 行同一内容的也算一簇）。
  const hunks: Array<{ start: number; end: number }> = []
  for (let index = 0; index < pairs.length; index += 1) {
    if (!changed[index]) continue
    const last = hunks[hunks.length - 1]
    if (last && index - last.end <= context * 2) last.end = index
    else hunks.push({ start: index, end: index })
  }

  const shown = hunks.slice(0, maxHunks)
  const hidden = hunks.length - shown.length
  const rows: DiffRow[] = []
  let cursor = 0

  if (shown.length === 0) {
    // 没有差异：只给一小段相同的上下文，够看清「其实一样」。
    const lines = Math.min(pairs.length, context * 2 + 1)
    for (let index = 0; index < lines; index += 1) rows.push({ kind: 'same', text: pairs[index]!.windowLine! })
    if (pairs.length > lines) rows.push({ kind: 'gap', lines: pairs.length - lines })
    return { rows, hidden: 0, truncated: false }
  }

  for (const hunk of shown) {
    const from = Math.max(0, hunk.start - context)
    const to = Math.min(pairs.length - 1, hunk.end + context)
    if (from > cursor) rows.push({ kind: 'gap', lines: from - cursor })
    for (let index = from; index <= to; index += 1) {
      const pair = pairs[index]!
      if (!changed[index]) {
        rows.push({ kind: 'same', text: pair.windowLine! })
        continue
      }
      if (pair.windowLine == null || pair.diskLine == null) {
        rows.push({
          kind: 'changed',
          windowLine: pair.windowLine ?? '',
          diskLine: pair.diskLine ?? '',
          windowMarks: pair.windowLine ? [[0, pair.windowLine.length]] : [],
          diskMarks: pair.diskLine ? [[0, pair.diskLine.length]] : [],
          oneSided: pair.windowLine == null ? 'disk' : 'window'
        })
        continue
      }
      const [windowMarks, diskMarks] = markLine(pair.windowLine, pair.diskLine, maxLine)
      rows.push({
        kind: 'changed',
        windowLine: pair.windowLine,
        diskLine: pair.diskLine,
        windowMarks,
        diskMarks,
        oneSided: null
      })
    }
    cursor = to + 1
  }
  if (cursor < pairs.length) rows.push({ kind: 'gap', lines: pairs.length - cursor })

  return { rows, hidden, truncated: hidden > 0 }
}
