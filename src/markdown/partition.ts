import { parseSource } from './parse-source.ts'
import type { Root } from 'mdast'
import { DEFAULT_STAGES, type Partition } from './types.ts'
import { extensionsFor } from './stages/registry.ts'

/**
 * 账本锚点。账本写在同一文件最末尾，正文永远在前。
 * 带 v1 是为了日后换格式时能被检测出来，而不是被误读。
 */
export const LEDGER_ANCHOR = '<!-- rgent:ledger:v1 -->'

/** 只认顶层、独立整行的 v1 注释；复用调用方已经解析的树。 */
export function findLedgerStart(source: string, parsed?: Root): number {
  if (!source.includes(LEDGER_ANCHOR)) return -1
  let tree = parsed
  if (!tree) {
    const { micromark, mdast } = extensionsFor(DEFAULT_STAGES)
    tree = parseSource(source, { extensions: micromark as never, mdastExtensions: mdast as never })
  }
  let found = -1
  for (const child of tree.children) {
    if (child.type !== 'html' || child.value.trimEnd() !== LEDGER_ANCHOR) continue
    const start = child.position?.start.offset
    const end = child.position?.end.offset
    if (start == null || end == null) continue
    const lineStart = Math.max(source.lastIndexOf('\n', start - 1), source.lastIndexOf('\r', start - 1)) + 1
    const contentStart = lineStart === 0 && source.startsWith('\ufeff') ? 1 : lineStart
    const nextBreak = source.slice(end).search(/[\r\n]/)
    const lineEnd = nextBreak < 0 ? source.length : end + nextBreak
    // 不把缩进、同一行的其他内容或容器里的例子认成机器边界。
    if (source.slice(contentStart, lineEnd).trimEnd() === LEDGER_ANCHOR) found = contentStart
  }
  return found
}

/**
 * 正文是账本锚点之前的部分，所以正文永远是文件前缀，位置不需要位移。
 * 没有锚点时保持恒等：全文即正文。
 */
export function partitionSource(source: string, parsed?: Root): Partition {
  const start = findLedgerStart(source, parsed)
  if (start < 0) return { body: source, ledger: null, bodyOffset: 0 }
  return { body: source.slice(0, start), ledger: source.slice(start), bodyOffset: 0 }
}

/**
 * 「听窗口」时该用哪份账本。
 *
 * 账本是机器写的追加记录，围栏要求原文不动；而写盘是整文件替换，所以窗口赢的
 * 只能是正文——用画布手里那份旧账本会把磁盘上新追加的章节整段抹掉。磁盘有账本
 * 就以磁盘为准。
 */
export function preferDiskLedger(diskLedger: string | null, tabLedger: string | null): string | null {
  return diskLedger ?? tabLedger
}

/**
 * 把画布里的正文和旁路账本拼回磁盘上的整文件。
 * 没有账本就不注入锚点。有账本时保证锚点落在行首。
 */
export function composeSource(body: string, ledger: string | null): string {
  if (ledger == null) return body
  if (body.length > 0 && body !== '\ufeff' && !/[\r\n]$/.test(body)) {
    const newline = body.match(/\r\n|\r|\n/g)?.at(-1) ?? ledger.match(/\r\n|\r|\n/)?.[0] ?? '\n'
    return body + newline + ledger
  }
  return `${body}${ledger}`
}
