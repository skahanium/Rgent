import { TEXT_LIMITS, htmlToMarkdown, sliceToBytes } from './html-text.ts'

/**
 * 抓页正文提取：优先 Readability（jsdom），不够就回退手写 `htmlToMarkdown`。
 *
 * 两个依赖都在函数内懒加载：只有真要解析 HTML 时才引入 `jsdom`／`@mozilla/readability`，
 * 不拖慢主进程启动，也避免模块求值阶段碰 DOM 实现。
 *
 * `JSDOM` 故意只传 `url`：不传 `runScripts`（脚本不执行）、不传 `resources`
 * （外部资源不加载），这是合同要求，不是默认值的巧合。
 *
 * 输入在这里按 UTF-8 字节截到 1 MiB（与出口上限一致）；输出不截断，
 * 交给 `fetchText` 既有的卫生／截断。
 */
export const READABLE_MIN_CHARS = 200

export type ReadableMethod = 'readability' | 'fallback'

export type ReadableExtract = {
  text: string
  title?: string
  siteName?: string
  publishedAt?: string
  method: ReadableMethod
  /** `'empty'`｜`'short'`｜`'error:<ErrorName>'`（不带 message）。只在 `method: 'fallback'` 时出现。 */
  fallbackReason?: string
}

/** 折叠空白、去首尾、限长；空串当作缺失。 */
function clean(value: string | null | undefined, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > limit ? text.slice(0, limit) : text
}

/** 正文长度按去空白后的码点算（`<200 字` 判据；不把缩进与换行算进正文）。 */
function visibleLength(value: string | null | undefined): number {
  return value ? Array.from(value.replace(/\s+/g, '')).length : 0
}

/** 回退原因只留错误类型名，不带 message，避免内部细节将来随日志／界面外泄。 */
function errorName(error: unknown): string {
  const raw = error instanceof Error ? error.name : ''
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, 40)
  return name || 'unknown'
}

export async function extractReadable(html: string, url: string): Promise<ReadableExtract> {
  const raw = typeof html === 'string' ? html : String(html ?? '')
  const source = Buffer.byteLength(raw, 'utf8') > TEXT_LIMITS.maxBytes
    ? sliceToBytes(raw, TEXT_LIMITS.maxBytes)
    : raw

  /** 兜底永远用原始（截断后）HTML 走既有手写提取器，行为与接 Readability 之前一致。 */
  const fallback = (reason: string): ReadableExtract => {
    const converted = htmlToMarkdown(source, url)
    return {
      text: converted.text,
      ...(converted.title ? { title: converted.title } : {}),
      method: 'fallback',
      fallbackReason: reason
    }
  }

  let parsedTitle: string | null | undefined
  let parsedContent: string | null | undefined
  let parsedText: string | null | undefined
  let siteName: string | null | undefined
  let publishedAt: string | null | undefined
  let documentTitle: string | undefined

  try {
    const [{ JSDOM }, { Readability }] = await Promise.all([
      import('jsdom'),
      import('@mozilla/readability')
    ])
    const dom = new JSDOM(source, { url })
    try {
      const document = dom.window.document
      // 先取 `<title>`：`parse()` 可能改动文档，标题回退不能等它之后。
      documentTitle = clean(document.title, 200)
      const article = new Readability(document).parse()
      parsedTitle = article?.title
      parsedContent = article?.content
      parsedText = article?.textContent
      siteName = article?.siteName
      publishedAt = article?.publishedTime
    } finally {
      // Readability 只回字符串；关掉 window 让 DOM 与虚拟控制台尽早释放。
      dom.window.close()
    }
  } catch (error) {
    return fallback(`error:${errorName(error)}`)
  }

  if (!parsedContent || !parsedText) return fallback('empty')
  if (visibleLength(parsedText) < READABLE_MIN_CHARS) return fallback('short')

  const converted = htmlToMarkdown(parsedContent, url)
  if (!converted.text.trim()) return fallback('empty')

  const title = clean(parsedTitle, 200) ?? documentTitle
  const site = clean(siteName, 200)
  const published = clean(publishedAt, 100)
  return {
    text: converted.text,
    ...(title ? { title } : {}),
    ...(site ? { siteName: site } : {}),
    ...(published ? { publishedAt: published } : {}),
    method: 'readability'
  }
}
