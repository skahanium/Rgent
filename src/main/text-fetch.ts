import { EgressClient, type EgressPolicy } from './egress.ts'
import { TEXT_LIMITS, sliceToBytes } from './html-text.ts'
import { extractReadable, type ReadableMethod } from './readable.ts'

/**
 * 抓页：唯一出口仍是 `EgressClient`（remote-image 的硬化核心）。本模块只做
 * 「策略收窄 + 类型／字符集判定 + 卫生 + 把 HTML 交给 readable」，不另写 HTTP 客户端；
 * 手写 HTML→Markdown 等纯函数在 `html-text.ts`。
 *
 * 明文 HTTP 一律拒绝（v1 合同）；端口只允许 443；主机是否公网由 `EgressClient` 的
 * 解析与钉地址负责，这里不复制地址判断。
 */

/**
 * 纯文本／HTML 助手都搬到了 `html-text.ts`；这里保留同名导出，既有调用方不用改。
 */
export { decodeEntities, htmlToMarkdown, sliceToBytes, TEXT_LIMITS } from './html-text.ts'

export type TextFetchResult = {
  text: string
  title?: string
  finalUrl: string
  bytes: number
  truncated: boolean
  contentType: string
  charsetFallback: boolean
  /** HTML 走的提取路径；`text/plain`／`application/json` 不带该字段。 */
  method?: ReadableMethod
  /** 回退原因（`'empty'`｜`'short'`｜`'error:<ErrorName>'`）；只在 `method: 'fallback'` 时出现。 */
  fallbackReason?: string
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
  const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml'
  // 标题优先级：readable 标题 → 无则留空；readable 内部已对 `<title>` 做过回退，
  // 兜底路径的标题则由 htmlToMarkdown 自己从 `<title>` 取。
  const extracted = isHtml ? await extractReadable(decoded.text, result.finalUrl) : undefined
  const clean = sanitizeText(extracted?.text ?? decoded.text)
  return {
    text: clean.text,
    ...(extracted?.title ? { title: extracted.title } : {}),
    ...(extracted?.method ? { method: extracted.method } : {}),
    ...(extracted?.fallbackReason ? { fallbackReason: extracted.fallbackReason } : {}),
    finalUrl: result.finalUrl,
    bytes: result.bytes.byteLength,
    truncated: clean.truncated,
    contentType,
    charsetFallback: decoded.fallback
  }
}
