import type { Partition } from './types.ts'

/**
 * 账本锚点。账本写在同一文件最末尾，正文永远在前。
 * 带 v1 是为了日后换格式时能被检测出来，而不是被误读。
 */
export const LEDGER_ANCHOR = '<!-- rgent:ledger:v1 -->'

/**
 * 返回账本起始偏移（锚点那一行的行首）。没有锚点返回 -1。
 *
 * 取最后一次整行命中：正文里偶然写出锚点字符串不会把正文截进账本，
 * 而真账本永远被追加在最末尾。
 */
export function findLedgerStart(source: string): number {
  let lineStart = 0
  let found = -1
  for (const line of source.split('\n')) {
    if (line.trimEnd() === LEDGER_ANCHOR) found = lineStart
    lineStart += line.length + 1
  }
  return found
}

/**
 * 正文是账本锚点之前的部分，所以正文永远是文件前缀，位置不需要位移。
 * 没有锚点时保持恒等：全文即正文。
 */
export function partitionSource(source: string): Partition {
  const start = findLedgerStart(source)
  if (start < 0) return { body: source, ledger: null, bodyOffset: 0 }
  return { body: source.slice(0, start), ledger: source.slice(start), bodyOffset: 0 }
}
