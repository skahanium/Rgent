/**
 * 纯文本／HTML 助手：抓页共用的字节上限、按 UTF-8 字节截断、手写 HTML→Markdown。
 *
 * 这里不碰网络、不碰 egress、也不加载 jsdom；`readable` 与 `text-fetch` 都只从本模块
 * 取这些纯函数，避免两者互相 import 形成静态环。
 */

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

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', plusmn: '\u00b1',
  times: '\u00d7', divide: '\u00f7', minus: '\u2212', middot: '\u00b7', bull: '\u2022',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', laquo: '\u00ab', raquo: '\u00bb',
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  sect: '\u00a7', para: '\u00b6', dagger: '\u2020', Dagger: '\u2021', permil: '\u2030',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194',
  le: '\u2264', ge: '\u2265', ne: '\u2260', asymp: '\u2248', infin: '\u221e',
  sum: '\u2211', radic: '\u221a', prime: '\u2032', Prime: '\u2033', shy: ''
}

/** 常见命名实体 + 十进制／十六进制数字实体；未知实体原样保留。 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1] === 'x' || entity[1] === 'X'
      const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10)
      if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all
      return String.fromCodePoint(code)
    }
    return NAMED[entity] ?? all
  })
}

function plain(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

function absoluteHref(href: string | undefined, base: string): string | null {
  if (!href) return null
  const value = href.trim()
  if (!value || value.startsWith('#')) return null
  try {
    const url = new URL(value, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch { return null }
}

const FORBIDDEN = 'script|style|noscript|iframe|svg|object'
const PAIRED = new RegExp(`<(${FORBIDDEN})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi')
const FORBIDDEN_TAG = new RegExp(`</?(?:${FORBIDDEN})\\b[^>]*>`, 'gi')

/** 整段去掉不允许进入文本的元素（含其内容），嵌套同名标签循环处理。 */
function stripForbidden(html: string): string {
  let text = html
  for (let pass = 0; pass < 8; pass += 1) {
    const next = text.replace(PAIRED, ' ')
    if (next === text) break
    text = next
  }
  return text.replace(FORBIDDEN_TAG, ' ')
}

/** 手写 HTML→Markdown（不新增依赖；jsdom 只在 readable 模块里懒加载）。 */
export function htmlToMarkdown(html: string, baseUrl: string): { text: string; title?: string } {
  let source = String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ')
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)
  const title = titleMatch ? plain(titleMatch[1]!).slice(0, 200) || undefined : undefined
  source = source.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, ' ')
  source = stripForbidden(source)
  // 代码块先整段取出，避免里面的 `<` 被后面的标签清理误删。
  const blocks: string[] = []
  source = source.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_all, inner: string) => {
    const code = decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\r\n?/g, '\n')
    blocks.push(`\`\`\`\n${code.trim()}\n\`\`\``)
    return `\u0001${blocks.length - 1}\u0001`
  })
  // 链接输出「文字 (绝对URL)」；相对地址用 finalUrl 解析。
  source = source.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_all, attrs: string, inner: string) => {
    const label = plain(inner)
    const href = absoluteHref(attribute(attrs, 'href'), baseUrl)
    if (!label) return href ? ` ${href} ` : ' '
    return href ? ` ${label} (${href}) ` : ` ${label} `
  })
  for (let level = 1; level <= 6; level += 1) {
    source = source.replace(new RegExp(`<h${level}\\b[^>]*>`, 'gi'), `\n\n${'#'.repeat(level)} `)
    source = source.replace(new RegExp(`</h${level}\\s*>`, 'gi'), '\n\n')
  }
  source = source
    .replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/li\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<blockquote\b[^>]*>/gi, '\n\n> ').replace(/<\/blockquote\s*>/gi, '\n\n')
    .replace(/<code\b[^>]*>/gi, '`').replace(/<\/code\s*>/gi, '`')
    .replace(/<(strong|b)\b[^>]*>/gi, '**').replace(/<\/(strong|b)\s*>/gi, '**')
    .replace(/<(em|i)\b[^>]*>/gi, '*').replace(/<\/(em|i)\s*>/gi, '*')
    .replace(/<(td|th)\b[^>]*>/gi, ' ').replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<tr\b[^>]*>/gi, '\n').replace(/<\/tr\s*>/gi, '')
  // 其余块级边界统一成空行，交给收尾的空白整理折叠。
  source = source.replace(/<\/?(?:p|div|section|article|header|footer|main|nav|aside|figure|figcaption|table|thead|tbody|tfoot|ul|ol|dl|dt|dd|hr)\b[^>]*>/gi, '\n\n')
  source = source.replace(/<[^>]*>/g, ' ')
  source = source.replace(/\u0001(\d+)\u0001/g, (_all, index: string) => blocks[Number(index)] ?? '')
  source = decodeEntities(source)
  return { text: tidy(source), ...(title ? { title } : {}) }
}

/** 行内空白折叠成单空格、去掉首尾空白、连续空行只留一行。 */
function tidy(value: string): string {
  const lines = value.replace(/\r\n?/g, '\n').split('\n').map(line =>
    line.replace(/[ \t\f\v\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, ' ').trim())
  const output: string[] = []
  for (const line of lines) {
    if (!line && output.at(-1) === '') continue
    output.push(line)
  }
  return output.join('\n').trim()
}
