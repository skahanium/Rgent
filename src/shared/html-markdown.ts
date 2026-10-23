/**
 * 手写 HTML→Markdown 与粘贴判定。纯字符串，不碰网络、不碰 DOM、不用 Buffer。
 * 抓页与编辑器粘贴共用这一份，避免两套规则。
 */

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

const CJK = /[\u2E80-\u2EFF\u2F00-\u2FDF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/
const CJK_GAP = new RegExp(`(${CJK.source})[ \\t\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]+(?=${CJK.source})`, 'g')
const SITE = /mp\.weixin|zhimg|zhihu|juejin|csdn|sspai|jianshu/i
const BLOCK = /<(?:p|div|h[1-6]|li|table|img|section|article|blockquote|a)\b/i
const FORBIDDEN = 'script|style|noscript|iframe|svg|object'
const PAIRED = new RegExp(`<(${FORBIDDEN})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi')
const FORBIDDEN_TAG = new RegExp(`</?(?:${FORBIDDEN})\\b[^>]*>`, 'gi')
const INNERMOST_TABLE = /<table\b[^>]*>(?:(?!<table\b)[\s\S])*?<\/table\s*>/gi

/** 粘贴 HTML 上限，与抓页 1 MiB 对齐。 */
export const PASTE_HTML_LIMIT = 1_048_576

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

export function parseClipboardHtml(html: string): { fragment: string; baseUrl?: string } {
  let text = String(html ?? '')
  let baseUrl: string | undefined
  const sourceUrl = /^SourceURL:(.+)$/im.exec(text)
  if (sourceUrl) {
    const url = sourceUrl[1]!.trim()
    if (/^https?:\/\//i.test(url)) baseUrl = url
  }
  if (/^Version:/im.test(text)) {
    const headerEnd = text.search(/<(?:html|!--|meta|body|div|p|section|article|span|a|h[1-6])\b/i)
    if (headerEnd > 0) text = text.slice(headerEnd)
  }
  const frag = /<!--\s*StartFragment\s*-->([\s\S]*?)<!--\s*EndFragment\s*-->/i.exec(text)
  if (frag) text = frag[1]!
  const base = /<base\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(text)
  const href = (base?.[1] ?? base?.[2] ?? base?.[3] ?? '').trim()
  if (!baseUrl && /^https?:\/\//i.test(href)) baseUrl = href
  return { fragment: text, ...(baseUrl ? { baseUrl } : {}) }
}

export function isWebPaste(html: string, baseUrl?: string): boolean {
  if (baseUrl && /^https?:/i.test(baseUrl)) return true
  if (/StartFragment|SourceURL:/i.test(html)) return true
  return SITE.test(html) && BLOCK.test(html)
}

export function looksLikeMarkdownPlain(text: string): boolean {
  if (/```/.test(text)) return true
  if (/\[\[[^\]]+\]\]/.test(text)) return true
  if (/>\s*\[!/.test(text)) return true
  return /(?<!\\)\[[^\]]+\]\([^)]+\)/.test(text)
}

export function tidyPastedPlain(text: string): string {
  const lines = decodeEntities(String(text ?? '')).replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const open = /^(```+|~~~+)/.exec(line)
    if (!fence && open) {
      fence = open[1]!
      output.push(line)
      continue
    }
    if (fence && line.startsWith(fence) && /^(```+|~+)[ \t]*$/.test(line)) {
      fence = null
      output.push(line)
      continue
    }
    if (fence) {
      output.push(line)
      continue
    }
    const cleaned = collapseCjkSpace(
      unescapeMarkdownLinks(line).replace(/[ \t\f\v\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, ' ').trim()
    )
    if (!cleaned && output.at(-1) === '') continue
    output.push(cleaned)
  }
  return output.join('\n').trim()
}

export function convertPaste(input: { html?: string; plain?: string; maxHtmlBytes?: number }): string | undefined {
  const html = typeof input.html === 'string' ? input.html : ''
  const plain = typeof input.plain === 'string' ? input.plain : ''
  const max = input.maxHtmlBytes ?? PASTE_HTML_LIMIT
  // 对方已经是 Markdown 时，即使剪贴板带 StartFragment 也不用富文本覆盖。
  if (html && utf8Bytes(html) <= max && !looksLikeMarkdownPlain(plain)) {
    const parsed = parseClipboardHtml(html)
    if (isWebPaste(html, parsed.baseUrl)) {
      const converted = htmlToMarkdown(parsed.fragment, parsed.baseUrl ?? '').text
      if (converted) return converted
    }
  }
  if (plain) return tidyPastedPlain(plain)
  return undefined
}

/** 手写 HTML→Markdown。相对地址用 baseUrl 解析；只保留 http(s)。 */
export function htmlToMarkdown(html: string, baseUrl = ''): { text: string; title?: string } {
  const parsed = parseClipboardHtml(String(html ?? ''))
  const resolved = parsed.baseUrl ?? baseUrl
  let source = parsed.fragment.replace(/<!--[\s\S]*?-->/g, ' ')
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)
  const title = titleMatch ? plain(titleMatch[1]!).slice(0, 200) || undefined : undefined
  source = source.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, ' ')
  source = stripForbidden(source)
  const blocks: string[] = []
  const hold = (markdown: string): string => {
    blocks.push(markdown)
    return `\u0001${blocks.length - 1}\u0001`
  }
  source = source.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_all, inner: string) => {
    const code = decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\r\n?/g, '\n')
    return hold(`\`\`\`\n${code.trim()}\n\`\`\``)
  })
  for (let pass = 0; pass < 8; pass += 1) {
    const next = source.replace(INNERMOST_TABLE, (all) => {
      const table = tableToMarkdown(all)
      return table ? `\n\n${hold(table)}\n\n` : ' '
    })
    if (next === source) break
    source = next
  }
  source = source.replace(/<img\b([^>]*)\/?>/gi, (_all, attrs: string) => imageMarkdown(attrs, resolved))
  source = source.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_all, attrs: string, inner: string) => {
    const label = plain(inner)
    const href = absoluteHref(attribute(attrs, 'href'), resolved)
    if (!label) return href ? ` ${href} ` : ' '
    if (!href) return ` ${label} `
    return ` [${label.replace(/\]/g, '\\]')}](${href}) `
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
  source = source.replace(/<\/?(?:p|div|section|article|header|footer|main|nav|aside|figure|figcaption|table|thead|tbody|tfoot|ul|ol|dl|dt|dd|hr)\b[^>]*>/gi, '\n\n')
  source = source.replace(/<[^>]*>/g, ' ')
  source = decodeEntities(source)
  const tidied = collapseCjkSpace(tidy(source))
  const text = tidied.replace(/\u0001(\d+)\u0001/g, (_all, index: string) => blocks[Number(index)] ?? '')
  return { text, ...(title ? { title } : {}) }
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
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
  const value = decodeEntities(href).trim()
  if (!value || value.startsWith('#')) return null
  try {
    const url = new URL(value, base || undefined)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch { return null }
}

function stripForbidden(html: string): string {
  let text = html
  for (let pass = 0; pass < 8; pass += 1) {
    const next = text.replace(PAIRED, ' ')
    if (next === text) break
    text = next
  }
  return text.replace(FORBIDDEN_TAG, ' ')
}

function imageMarkdown(attrs: string, baseUrl: string): string {
  const src = attribute(attrs, 'data-actualsrc')
    ?? attribute(attrs, 'data-src')
    ?? attribute(attrs, 'data-original')
    ?? attribute(attrs, 'src')
  const href = absoluteHref(src, baseUrl)
  if (!href) return ' '
  const alt = decodeEntities(attribute(attrs, 'alt') ?? attribute(attrs, 'title') ?? '').replace(/\]/g, '\\]')
  return ` ![${alt}](${href}) `
}

function tableToMarkdown(html: string): string {
  const rows: string[][] = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowRe.exec(html))) {
    const cells: string[] = []
    const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellRe.exec(rowMatch[1]!))) {
      cells.push(plain(cellMatch[2]!).replace(/\|/g, '\\|') || ' ')
    }
    if (cells.length) rows.push(cells)
  }
  if (!rows.length) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const pad = (row: string[]): string[] => {
    const next = row.slice()
    while (next.length < width) next.push(' ')
    return next
  }
  const header = pad(rows[0]!)
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`
  return [line(header), `| ${header.map(() => '---').join(' | ')} |`, ...rows.slice(1).map((row) => line(pad(row)))].join('\n')
}

function unescapeMarkdownLinks(text: string): string {
  return text.replace(/\\\[([^\]]*?)\\\]\(([^)]+)\)/g, '[$1]($2)')
}

function collapseCjkSpace(value: string): string {
  return value.replace(CJK_GAP, '$1')
}

function tidy(value: string): string {
  const lines = value.replace(/\r\n?/g, '\n').split('\n').map((line) =>
    line.includes('\u0001')
      ? line
      : line.replace(/[ \t\f\v\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, ' ').trim())
  const output: string[] = []
  for (const line of lines) {
    if (!line && output.at(-1) === '') continue
    output.push(line)
  }
  return output.join('\n').trim()
}
