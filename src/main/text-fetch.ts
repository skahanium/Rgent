import { EgressClient, type EgressPolicy } from './egress.ts'

/**
 * 抓页：唯一出口仍是 `EgressClient`（remote-image 的硬化核心）。本模块只做
 * 「策略收窄 + 类型／字符集判定 + 手写 HTML→Markdown + 卫生」，不另写 HTTP 客户端。
 *
 * 明文 HTTP 一律拒绝（v1 合同）；端口只允许 443；主机是否公网由 `EgressClient` 的
 * 解析与钉地址负责，这里不复制地址判断。
 */
export const TEXT_LIMITS = { maxBytes: 1_048_576, maxLine: 2000, timeoutMs: 20_000, maxUrl: 2048 } as const

export type TextFetchResult = {
  text: string
  title?: string
  finalUrl: string
  bytes: number
  truncated: boolean
  contentType: string
  charsetFallback: boolean
}

export type TextFetchDependencies = {
  /** `EgressClient` 的注入点；生产不传，测试用假 request／resolve，不碰真网络。 */
  resolve?: EgressPolicy['resolve']
  request?: EgressPolicy['request']
}

const ACCEPTED = new Set(['text/html', 'text/plain', 'application/xhtml+xml', 'application/json'])
const EGRESS_ERRORS: Record<string, string> = {
  INVALID_URL: 'EGRESS_INVALID_URL',
  HTTP_REFUSED: 'EGRESS_HTTP_REFUSED',
  CROSS_ORIGIN_REFUSED: 'EGRESS_CROSS_ORIGIN_REFUSED',
  HTTP_CONFIRM: 'EGRESS_HTTP_REFUSED',
  REDIRECT_CONFIRM: 'EGRESS_CROSS_ORIGIN_REFUSED',
  TOO_LARGE: 'EGRESS_TOO_LARGE',
  ENCODING_REFUSED: 'EGRESS_ENCODING_REFUSED',
  TIMEOUT: 'EGRESS_TIMEOUT',
  UNAVAILABLE: 'EGRESS_UNAVAILABLE',
  BUSY: 'EGRESS_BUSY'
}

function reject(error: string): never { throw Error(error) }

/** 预检：只放 https、无 userinfo、长度与端口受限；主机公网校验交给出口核心。 */
export function assertFetchTarget(rawUrl: string): void {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.length > TEXT_LIMITS.maxUrl) reject('EGRESS_INVALID_URL')
  let url: URL
  try { url = new URL(rawUrl) } catch { reject('EGRESS_INVALID_URL') }
  // v1 明文 HTTP 一律拒绝；其他协议同样不是本工具的目标。
  if (url.protocol !== 'https:') reject('EGRESS_HTTP_REFUSED')
  if (url.username || url.password) reject('EGRESS_INVALID_URL')
  if (!url.hostname) reject('EGRESS_INVALID_URL')
  if (url.port && url.port !== '443') reject('EGRESS_INVALID_URL')
}

export function parseContentType(header: string | undefined): { mime: string; charset?: string } {
  if (!header) return { mime: '' }
  const parts = header.split(';')
  const mime = (parts.shift() ?? '').trim().toLowerCase()
  let charset: string | undefined
  for (const part of parts) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim().toLowerCase() !== 'charset') continue
    charset = part.slice(index + 1).trim().replace(/^"|"$/g, '') || undefined
  }
  return { mime, ...(charset ? { charset } : {}) }
}

/** 字符集优先用 content-type 声明；`TextDecoder` 建不起来或解码失败就回退 UTF-8。 */
export function decodeBody(bytes: Uint8Array, charset?: string): { text: string; fallback: boolean } {
  const label = charset?.trim().replace(/^["']|["']$/g, '').toLowerCase()
  if (label) {
    try { return { text: new TextDecoder(label, { fatal: true }).decode(bytes), fallback: false } }
    catch { /* 未知标签或非法字节：如实回退 */ }
    return { text: new TextDecoder('utf-8').decode(bytes), fallback: true }
  }
  return { text: new TextDecoder('utf-8').decode(bytes), fallback: false }
}

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

/**
 * 卫生：去掉除 `\n`、`\t` 外的控制字符；单行截到 2000 字；整段硬上限 1 MiB。
 * 任一截断都置 `truncated`（如实说明，不静默）。
 */
export function sanitizeText(input: string): { text: string; truncated: boolean } {
  let truncated = false
  let text = input.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (text.split('\n').some(line => line.length > TEXT_LIMITS.maxLine)) truncated = true
  text = text.split('\n').map(line => {
    if (line.length <= TEXT_LIMITS.maxLine) return line
    let cut = line.slice(0, TEXT_LIMITS.maxLine)
    // 不把代理对切成半个字符。
    if (/[\uD800-\uDBFF]/.test(cut.slice(-1))) cut = cut.slice(0, -1)
    return cut
  }).join('\n')
  if (Buffer.byteLength(text, 'utf8') > TEXT_LIMITS.maxBytes) {
    truncated = true
    text = sliceToBytes(text, TEXT_LIMITS.maxBytes)
  }
  return { text, truncated }
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

/** 手写 HTML→Markdown（不新增依赖；jsdom 只在 dev，不进口）。 */
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

/** 抓一个公开网页的纯文本。错误一律是 `EGRESS_*` 字符串（不夹带远端原文）。 */
export async function fetchText(rawUrl: string, options: { signal: AbortSignal } & TextFetchDependencies): Promise<TextFetchResult> {
  assertFetchTarget(rawUrl)
  const client = new EgressClient({
    http: 'refuse',
    crossOrigin: 'refuse',
    allowedPorts: [443],
    requireIdentityEncoding: true,
    maxBytes: TEXT_LIMITS.maxBytes,
    timeoutMs: TEXT_LIMITS.timeoutMs,
    ...(options.resolve ? { resolve: options.resolve } : {}),
    ...(options.request ? { request: options.request } : {})
  })
  const result = await client.fetch(rawUrl, { signal: options.signal })
  if (options.signal.aborted) reject('EGRESS_ABORTED')
  if (!result.ok) reject(EGRESS_ERRORS[result.error] ?? 'EGRESS_UNAVAILABLE')
  const declared = parseContentType(result.headers['content-type'])
  let contentType = declared.mime
  if (!contentType) {
    // 合同：缺 content-type 时只有字节以 `<` 开头才按 HTML 处理。
    const bom = result.bytes[0] === 0xef && result.bytes[1] === 0xbb && result.bytes[2] === 0xbf
    const first = result.bytes[bom ? 3 : 0]
    if (first !== 0x3c) reject('EGRESS_UNSUPPORTED_TYPE')
    contentType = 'text/html'
  }
  if (!ACCEPTED.has(contentType)) reject('EGRESS_UNSUPPORTED_TYPE')
  const decoded = decodeBody(result.bytes, declared.charset)
  const converted = contentType === 'text/html' || contentType === 'application/xhtml+xml'
    ? htmlToMarkdown(decoded.text, result.finalUrl)
    : { text: decoded.text }
  const clean = sanitizeText(converted.text)
  return {
    text: clean.text,
    ...('title' in converted && converted.title ? { title: converted.title } : {}),
    finalUrl: result.finalUrl,
    bytes: result.bytes.byteLength,
    truncated: clean.truncated,
    contentType,
    charsetFallback: decoded.fallback
  }
}
