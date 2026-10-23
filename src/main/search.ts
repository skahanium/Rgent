import type { NetworkProvider } from '../shared/ipc.ts'
import { EgressClient, type EgressPolicy } from './egress.ts'
import { requestPinnedImage, resolveImageAddresses } from './remote-image-transport.ts'

/**
 * 内置只读搜索：三家预设服务，端点与主机写死在代码里，不开放自定义端点。
 *
 * 出口仍是唯一的 `EgressClient`（`remote-image` 的硬化核心）：仅 HTTPS、仅 443、
 * 仅公网地址、每次钉地址、无 cookies／auth／referrer、`Accept-Encoding: identity`。
 * 本模块只做「服务商形状 + 结果结构校验 + 错误映射」，key 只在主进程内使用：
 * 错误消息一律是固定的 `SEARCH_*` 文案，绝不夹带 key、查询以外的响应原文。
 */
export const SEARCH_LIMITS = {
  maxQuery: 256,
  maxResults: 10,
  defaultResults: 5,
  maxBytes: 1_048_576,
  timeoutMs: 20_000,
  /** DeepSeek Search 自报的查询上限（1–128 字符）：超出按字符截断，不整次拒。 */
  deepseekMaxQuery: 128
} as const

export const SEARCH_PROVIDERS = {
  brave: { host: 'api.search.brave.com', endpoint: 'https://api.search.brave.com/res/v1/web/search', method: 'GET' },
  tavily: { host: 'api.tavily.com', endpoint: 'https://api.tavily.com/search', method: 'POST' },
  deepseek: { host: 'api.deepseek.com', endpoint: 'https://api.deepseek.com/v1/tools/search', method: 'POST' }
} as const satisfies Record<NetworkProvider, { host: string; endpoint: string; method: 'GET' | 'POST' }>

export type SearchResult = { title: string; url: string; snippet: string }
export type SearchResponse = { results: SearchResult[]; truncated?: boolean }
export type SearchCredential = { provider: NetworkProvider; key: string }
/** `EgressClient` 的注入点；生产不传，测试用假 request／resolve，不碰真网络。 */
export type SearchDependencies = { resolve?: EgressPolicy['resolve']; request?: EgressPolicy['request'] }
export type SearchProvider = {
  readonly provider: NetworkProvider | null
  readonly host: string | null
  search(query: string, options: { maxResults?: number; signal: AbortSignal }): Promise<SearchResponse>
}

const EGRESS_ERRORS: Record<string, string> = {
  INVALID_URL: 'SEARCH_REFUSED',
  HTTP_REFUSED: 'SEARCH_REFUSED',
  CROSS_ORIGIN_REFUSED: 'SEARCH_REFUSED',
  HTTP_CONFIRM: 'SEARCH_REFUSED',
  REDIRECT_CONFIRM: 'SEARCH_REFUSED',
  TOO_LARGE: 'SEARCH_REFUSED',
  ENCODING_REFUSED: 'SEARCH_REFUSED',
  TIMEOUT: 'SEARCH_REFUSED',
  UNAVAILABLE: 'SEARCH_REFUSED',
  BUSY: 'SEARCH_REFUSED'
}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isProvider = (value: unknown): value is NetworkProvider => value === 'brave' || value === 'tavily' || value === 'deepseek'

/** 入参不在合同范围内也按 `SEARCH_MALFORMED` 报：不新增合同外的错误码。 */
function requireQuery(query: unknown): string {
  if (typeof query !== 'string' || !query.trim() || query.length > SEARCH_LIMITS.maxQuery || /[\u0000-\u001f\u007f]/u.test(query)) throw Error('SEARCH_MALFORMED')
  return query
}
function requireMaxResults(value: unknown): number {
  if (value === undefined) return SEARCH_LIMITS.defaultResults
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > SEARCH_LIMITS.maxResults) throw Error('SEARCH_MALFORMED')
  return value
}
function httpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password
  } catch { return false }
}
/** DeepSeek 只收 1–128 字符的 query：按码点截断，不把代理对切成半个字符。 */
function clampDeepseekQuery(query: string): string {
  const characters = Array.from(query)
  return characters.length > SEARCH_LIMITS.deepseekMaxQuery ? characters.slice(0, SEARCH_LIMITS.deepseekMaxQuery).join('') : query
}
/** 凭据位置按服务商写死：Brave 用自己的头名，DeepSeek 用 Bearer，Tavily 在请求体里。 */
function credentialHeaders(provider: NetworkProvider, key: string): Record<string, string> {
  if (provider === 'brave') return { 'x-subscription-token': key }
  if (provider === 'deepseek') return { authorization: `Bearer ${key}` }
  return {}
}
/** POST 服务商的 JSON 请求体；Brave 走查询串，返回 `undefined`。 */
function postBody(provider: NetworkProvider, query: string, maxResults: number, key: string): string | undefined {
  if (provider === 'tavily') return JSON.stringify({ api_key: key, query, max_results: maxResults })
  // count 直接取 maxResults：产品上限 10 已落在 DeepSeek 允许的 1–50 内，不需要另夹。
  if (provider === 'deepseek') return JSON.stringify({ query: clampDeepseekQuery(query), count: maxResults, need_content: false })
  return undefined
}

/** Brave 把结果放在 `web.results`，摘要字段叫 `description`。 */
function braveRows(payload: unknown): unknown[] {
  if (!isRecord(payload) || !isRecord(payload.web) || !Array.isArray(payload.web.results)) throw Error('SEARCH_MALFORMED')
  return payload.web.results
}
/** Tavily 顶层就是 `results`，摘要字段叫 `content`。 */
function tavilyRows(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw Error('SEARCH_MALFORMED')
  return payload.results
}
/** DeepSeek Search 顶层也是 `results`；摘要优先取 `summary`，退回 `snippet`。 */
function deepseekRows(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw Error('SEARCH_MALFORMED')
  return payload.results
}

function rowsOf(provider: NetworkProvider, payload: unknown): unknown[] {
  if (provider === 'brave') return braveRows(payload)
  if (provider === 'tavily') return tavilyRows(payload)
  return deepseekRows(payload)
}

function normalize(provider: NetworkProvider, rows: readonly unknown[], maxResults: number): SearchResponse {
  if (provider === 'deepseek') return normalizeDeepseek(rows, maxResults)
  const results: SearchResult[] = []
  // 只校验真正要返回的那几条：条数先截到 maxResults，超出的部分不算结构问题。
  for (const row of rows.slice(0, maxResults)) {
    if (!isRecord(row)) throw Error('SEARCH_MALFORMED')
    const title = row.title
    const url = row.url
    const snippet = provider === 'brave' ? row.description : row.content
    if (typeof title !== 'string' || typeof url !== 'string' || typeof snippet !== 'string' || !httpUrl(url)) throw Error('SEARCH_MALFORMED')
    results.push({ title, url, snippet })
  }
  if (!results.length) throw Error('SEARCH_EMPTY')
  return { results, ...(rows.length > maxResults ? { truncated: true } : {}) }
}

/**
 * DeepSeek 的结果里可能混进非 http(s)／空 url 的条目：那一条按「没有这条」过滤，
 * 不让整次搜索失败；其余结构问题（行不是对象、标题不是字符串）仍按 `SEARCH_MALFORMED` 拒。
 * `truncated` 只表示「还有被 maxResults 截掉的可用条目」：被过滤掉的条目不算截断；
 * 超出上限的行只看 url，不做结构校验（与 Brave／Tavily 的「超出的部分不算结构问题」一致）。
 */
function normalizeDeepseek(rows: readonly unknown[], maxResults: number): SearchResponse {
  const results: SearchResult[] = []
  let truncated = false
  for (const row of rows) {
    if (results.length >= maxResults) {
      if (isRecord(row) && typeof row.url === 'string' && httpUrl(row.url)) truncated = true
      continue
    }
    if (!isRecord(row)) throw Error('SEARCH_MALFORMED')
    if (typeof row.url !== 'string' || !httpUrl(row.url)) continue
    if (typeof row.title !== 'string') throw Error('SEARCH_MALFORMED')
    const summary = typeof row.summary === 'string' ? row.summary : ''
    const snippet = typeof row.snippet === 'string' ? row.snippet : ''
    results.push({ title: row.title, url: row.url, snippet: summary || snippet })
  }
  if (!results.length) throw Error('SEARCH_EMPTY')
  return { results, ...(truncated ? { truncated: true } : {}) }
}

export function createSearchProvider(credential: SearchCredential | null, deps: SearchDependencies = {}): SearchProvider {
  const provider = credential && isProvider(credential.provider) ? credential.provider : null
  const key = credential?.key ?? ''
  const pinned = deps.request ?? requestPinnedImage
  return {
    provider,
    host: provider ? SEARCH_PROVIDERS[provider].host : null,
    async search(query, options): Promise<SearchResponse> {
      if (!provider || !key) throw Error('SEARCH_NOT_CONFIGURED')
      const cleanQuery = requireQuery(query)
      const maxResults = requireMaxResults(options.maxResults)
      const signal = options.signal
      if (signal.aborted) throw Error('SEARCH_REFUSED')
      // 只为了在 401/403 时给出凭据错误：出口核心把非 2xx 统一成 UNAVAILABLE，不带上状态码。
      let status = 0
      const request: NonNullable<EgressPolicy['request']> = async (url, address, requestSignal, headers = {}, init) => {
        const response = await pinned(url, address, requestSignal, {
          // 服务端返回 JSON；也让图片出口的默认 accept 不跟着进来。
          accept: 'application/json',
          ...headers,
          ...credentialHeaders(provider, key)
        }, init)
        status = response.status
        return response
      }
      const endpoint = SEARCH_PROVIDERS[provider]
      const target = new URL(endpoint.endpoint)
      if (provider === 'brave') {
        target.searchParams.set('q', cleanQuery)
        target.searchParams.set('count', String(maxResults))
      }
      const body = postBody(provider, cleanQuery, maxResults, key)
      const client = new EgressClient({
        http: 'refuse',
        crossOrigin: 'refuse',
        allowedPorts: [443],
        requireIdentityEncoding: true,
        maxBytes: SEARCH_LIMITS.maxBytes,
        timeoutMs: SEARCH_LIMITS.timeoutMs,
        maxRedirects: 0,
        ...(body === undefined ? {} : { method: 'POST' as const, body }),
        resolve: deps.resolve ?? resolveImageAddresses,
        request
      })
      const response = await client.fetch(target.href, { signal })
      if (!response.ok) {
        if (status === 401 || status === 403) throw Error('SEARCH_UNAUTHORIZED')
        throw Error(EGRESS_ERRORS[response.error] ?? 'SEARCH_REFUSED')
      }
      if (signal.aborted) throw Error('SEARCH_REFUSED')
      let payload: unknown
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)) }
      catch { throw Error('SEARCH_MALFORMED') }
      return normalize(provider, rowsOf(provider, payload), maxResults)
    }
  }
}
