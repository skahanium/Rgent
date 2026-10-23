/**
 * 纯文本／HTML 助手：抓页共用的字节上限、按 UTF-8 字节截断。
 *
 * HTML→Markdown 的纯函数在 `src/shared/html-markdown.ts`，渲染进程粘贴与抓页共用。
 * 这里不碰网络、不碰 egress、也不加载 jsdom。
 */

export { decodeEntities, htmlToMarkdown } from '../shared/html-markdown.ts'

/** 抓页共享上限：单次下载/输入 1 MiB、单行 2000 字、单次 20s、URL 2048 字。 */
export const TEXT_LIMITS = { maxBytes: 1_048_576, maxLine: 2000, timeoutMs: 20_000, maxUrl: 2048 } as const

/** 只把 UTF-8 字节量当上限，且不切断代理对。 */
export function sliceToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let used = 0
  let output = ''
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    used += size
    output += char
  }
  return output
}
