import type { Partition } from './types.ts'

/**
 * 账本锚点。账本写在同一文件最末尾，正文永远在前。
 * 带 v1 是为了日后换格式时能被检测出来，而不是被误读。
 */
export const LEDGER_ANCHOR = '<!-- rgent:ledger:v1 -->'

/**
 * 返回账本起始偏移（锚点那一行的行首）。没有锚点返回 -1。
 *
 * 只认整行（行尾空白可有）。取最后一次命中：正文里引用锚点、文末还有真账本时，
 * 不会把中间那段正文切进账本。正文里单独一整行锚点、后面没有第二次，就会切开——这是选定行为。
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

/**
 * 把画布里的正文和旁路账本拼回磁盘上的整文件。
 * 没有账本就不注入锚点。有账本时保证锚点落在行首。
 */
export function composeSource(body: string, ledger: string | null): string {
  if (ledger == null) return body
  if (body.length > 0 && !body.endsWith('\n')) return `${body}\n${ledger}`
  return `${body}${ledger}`
}
