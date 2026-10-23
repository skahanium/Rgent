import type { FetchService } from '../shared/ipc.ts'
import type { NetworkCredential } from './network-config.ts'
import { EgressClient, egressUrl, type EgressPolicy } from './egress.ts'
import { TEXT_LIMITS } from './html-text.ts'
import { assertFetchTarget, sanitizeText } from './text-fetch.ts'
import { requestPinnedImage, resolveImageAddresses } from './remote-image-transport.ts'

/**
 * 任务内抓页的 DeepSeek Fetch 服务：把目标 URL 交给 `api.deepseek.com` 取正文。
 *
 * 出口仍是唯一的 `EgressClient`（`remote-image` 的硬化核心）：仅 HTTPS、仅 443、
 * 仅公网地址、每次钉地址、无 cookies／referrer、`Accept-Encoding: identity`、
 * 单次 ≤1 MiB、≤20s。端点写死在代码里，**不跟随重定向**；服务请求本身也要过
 * 既有的地址校验（主机解析出私网就拒），不因为「只是服务端点」而绕过。
 *
 * 目标 URL 沿用 `text-fetch` 的既有校验（`assertFetchTarget` + `egressUrl`）：
 * https、无 userinfo、端口 443、长度 ≤2048、字面私网／localhost／`.local` 一律拒。
 * 主机名的公网性只能由服务方在真正抓取时确认（本模块不解析目标主机，也无法保证
 * 服务方与本地解析一致）；这是残留风险，不由这里另造一套判断。
 *
 * 返回与 `fetchText` 同形状的核心字段（`text/title/bytes/truncated/finalUrl`）；
 * 服务返回的是 Markdown 正文，不做 HTML 提取。`bytes` 是服务返回正文的 UTF-8
 * 字节数（不是 JSON 外壳的大小）；`truncated` 只在正文被本地卫生规则截断时为真。
 *
 * 错误一律是固定的机读码：外发失败是 `EGRESS_*`，缺凭据是 `SEARCH_NOT_CONFIGURED`；
 * 都不夹带 URL、正文、响应原文或 key。key 只进 `Authorization` 头，不进 URL、
 * 请求体、错误消息或任何日志。
 */
export const DEEPSEEK_FETCH = {
  host: 'api.deepseek.com',
  endpoint: 'https://api.deepseek.com/v1/tools/fetch'
} as const

export type DeepSeekFetchResult = {
  text: string
  title?: string
  finalUrl: string
  bytes: number
  truncated: boolean
}

export type DeepSeekFetchOptions = {
  signal: AbortSignal
  /** `EgressClient` 的注入点；生产不传，测试用假 request／resolve，不碰真网络。 */
  resolve?: EgressPolicy['resolve']
  request?: EgressPolicy['request']
}

export type FetchRoute = { service: 'direct' } | { service: 'deepseek'; key: string }

/** 出口核心的失败码 → 合同里的 `EGRESS_*`；与抓页／搜索同一套归一。 */
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
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * 任务内抓页走哪条路：选了 DeepSeek 就必须有 DeepSeek 凭据。
 *
 * 缺凭据时**不静默降级成直连**：那会把一次「走服务」的外发偷偷变成对目标站点的
 * 直连（人选的抓取路径与实际外发不符），也违反关闸／配置失效时不绕过的原则。
 * 这里抛 `SEARCH_NOT_CONFIGURED`，与搜索缺凭据同一个码；人话文案由渲染层统一映射
 * （N7 再补「抓取服务」的说法）。
 */
export function resolveFetchRoute(service: FetchService, credential: NetworkCredential | null): FetchRoute {
  if (service !== 'deepseek') return { service: 'direct' }
  if (!credential || credential.provider !== 'deepseek' || !credential.key) throw Error('SEARCH_NOT_CONFIGURED')
  return { service: 'deepseek', key: credential.key }
}

/** 目标 URL 的预检：复用既有 helper，不复制安全规则；返回归一化后的 URL。 */
function checkedTarget(rawUrl: string): URL {
  assertFetchTarget(rawUrl)
  const url = egressUrl(rawUrl, [443])
  // `egressUrl` 另挡字面私网／localhost／`.local`；过了 `assertFetchTarget` 后
  // 这里只会因这些主机名或端口而为 null。
  if (!url || url.protocol !== 'https:') throw Error('EGRESS_INVALID_URL')
  return url
}

/** 把非 2xx 状态映射成合同错误码；服务端响应原文一律丢弃。 */
function statusError(status: number): string {
  if (status === 401 || status === 403) return 'EGRESS_HTTP_REFUSED'
  if (status === 404) return 'EGRESS_UNAVAILABLE'
  if (status === 408 || status === 504) return 'EGRESS_TIMEOUT'
  if (status === 429) return 'EGRESS_BUSY'
  // 5xx 与其余非 2xx（含 3xx：POST 不跟随）都按服务不可用。
  return 'EGRESS_UNAVAILABLE'
}

export async function fetchViaDeepSeek(rawUrl: string, key: string, options: DeepSeekFetchOptions): Promise<DeepSeekFetchResult> {
  // 先按既有规则校验目标 URL：非法目标一次外发都不发生。
  const target = checkedTarget(rawUrl)
  if (typeof key !== 'string' || !key) throw Error('SEARCH_NOT_CONFIGURED')
  const signal = options.signal
  const pinned = options.request ?? requestPinnedImage
  // 出口核心把非 2xx 压成 UNAVAILABLE，不带状态码：这里旁听状态用于合同映射。
  let status = 0
  const request: NonNullable<EgressPolicy['request']> = async (url, address, requestSignal, headers = {}, init) => {
    const response = await pinned(url, address, requestSignal, {
      // 服务端返回 JSON；也让图片出口的默认 accept 不跟着进来。
      accept: 'application/json',
      ...headers,
      authorization: `Bearer ${key}`
    }, init)
    status = response.status
    return response
  }
  const client = new EgressClient({
    http: 'refuse',
    crossOrigin: 'refuse',
    allowedPorts: [443],
    requireIdentityEncoding: true,
    maxBytes: TEXT_LIMITS.maxBytes,
    timeoutMs: TEXT_LIMITS.timeoutMs,
    // POST 只允许对预设端点的单次请求：任何 3xx 都拒绝，绝不改写成 GET 跟随。
    maxRedirects: 0,
    method: 'POST',
    body: JSON.stringify({ url: target.href }),
    resolve: options.resolve ?? resolveImageAddresses,
    request
  })
  const response = await client.fetch(DEEPSEEK_FETCH.endpoint, { signal })
  // 与抓页一致：取消是确定事实，优先于出口报出的 UNAVAILABLE。
  if (signal.aborted) throw Error('EGRESS_ABORTED')
  if (!response.ok) {
    // 状态码是已知事实：先按合同映射；没有状态（传输／编码／过大）才用出口码。
    if (status >= 400) throw Error(statusError(status))
    throw Error(EGRESS_ERRORS[response.error] ?? 'EGRESS_UNAVAILABLE')
  }
  let payload: unknown
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)) }
  catch { throw Error('EGRESS_UNAVAILABLE') }
  // 结构至少有字符串 `content`；可选 `title` 也只能是字符串，其他偏差按不可用，不猜。
  if (!isRecord(payload) || typeof payload.content !== 'string') throw Error('EGRESS_UNAVAILABLE')
  if (payload.title !== undefined && typeof payload.title !== 'string') throw Error('EGRESS_UNAVAILABLE')
  if (!payload.content.trim()) throw Error('EGRESS_UNAVAILABLE')
  const clean = sanitizeText(payload.content)
  // 只有控制字符／空白的正文也当没有内容，不把空结果说成成功。
  if (!clean.text.trim()) throw Error('EGRESS_UNAVAILABLE')
  const title = typeof payload.title === 'string' ? payload.title.trim() : ''
  return {
    text: clean.text,
    ...(title ? { title } : {}),
    finalUrl: target.href,
    bytes: Buffer.byteLength(payload.content, 'utf8'),
    truncated: clean.truncated
  }
}
