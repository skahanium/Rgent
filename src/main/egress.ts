import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { resolveImageAddresses, requestPinnedImage, type ImageAddress, type PinnedRequestInit } from './remote-image-transport.ts'

export type EgressError =
  | 'INVALID_URL' | 'HTTP_REFUSED' | 'CROSS_ORIGIN_REFUSED'
  | 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM'
  | 'TOO_LARGE' | 'UNAVAILABLE' | 'BUSY' | 'ENCODING_REFUSED' | 'TIMEOUT'
/** Outbound policy. The defaults are the hardened `remote-image` semantics. */
export type EgressPolicy = {
  http?: 'confirm' | 'refuse'
  /** `follow`: auto follows, explicit returns REDIRECT_CONFIRM. `refuse`: always CROSS_ORIGIN_REFUSED.
   *  Cross-origin confirmation only happens in remote-image's explicit mode via REDIRECT_CONFIRM,
   *  so it does not need a separate policy value. */
  crossOrigin?: 'follow' | 'refuse'
  allowedPorts?: readonly number[]
  requireIdentityEncoding?: boolean
  resolve?: (hostname: string) => Promise<ImageAddress[]>
  /** 第 5 个 `init` 只在 POST 时传入；既有 4 参调用方（图片／抓页）行为不变。 */
  request?: (url: URL, address: ImageAddress, signal: AbortSignal, headers?: Record<string, string>, init?: PinnedRequestInit) => Promise<Response>
  maxBytes?: number
  timeoutMs?: number
  maxActive?: number
  maxWaiting?: number
  maxRedirects?: number
  /** 只给预设端点的单次查询：默认 GET；POST 时 `body` 必须是完整的 JSON 字符串。 */
  method?: 'GET' | 'POST'
  body?: string
}
export type EgressOk = { ok: true; bytes: Uint8Array; status: number; finalUrl: string; headers: Record<string, string>; redirects: number }
export type EgressConfirm = { ok: false; error: 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM'; url: string; continuation: string }
export type EgressFail = { ok: false; error: Exclude<EgressError, 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM'> }
export type EgressResult = EgressOk | EgressConfirm | EgressFail
type FetchOptions = { signal?: AbortSignal; mode?: 'auto' | 'explicit'; allowHttp?: boolean; continuation?: string; binding?: string; validate?: () => Promise<boolean> }
type Attempt = { raw: string; current: URL; mode: 'auto' | 'explicit'; deadline: number; redirects: number; bytes: number; binding?: string }
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_ACTIVE = 4
const DEFAULT_MAX_WAITING = 32
const DEFAULT_MAX_REDIRECTS = 3
const IDENTITY_HEADERS: Record<string, string> = { 'accept-encoding': 'identity' }
const fail = (error: EgressFail['error']): EgressFail => ({ ok: false, error })
/** Hardened read-only HTTP(S) core. Callers still decide authorization and what to do with bytes. */
export class EgressClient {
  private readonly http: 'confirm' | 'refuse'
  private readonly crossOrigin: 'follow' | 'refuse'
  private readonly allowedPorts?: readonly number[]
  private readonly requireIdentityEncoding: boolean
  private readonly resolve: NonNullable<EgressPolicy['resolve']>
  private readonly request: NonNullable<EgressPolicy['request']>
  private readonly maxBytes: number
  private readonly timeoutMs: number
  private readonly maxActive: number
  private readonly maxWaiting: number
  private readonly maxRedirects: number
  private readonly method: 'GET' | 'POST'
  private readonly body?: string
  private readonly continuations = new Map<string, Attempt>()
  private active = 0
  private readonly waiting: Array<{ start: () => void; cancel: () => void }> = []
  constructor(policy: EgressPolicy = {}) {
    this.http = policy.http ?? 'confirm'
    this.crossOrigin = policy.crossOrigin ?? 'follow'
    this.allowedPorts = policy.allowedPorts
    this.requireIdentityEncoding = policy.requireIdentityEncoding ?? false
    this.resolve = policy.resolve ?? resolveImageAddresses
    this.request = policy.request ?? requestPinnedImage
    this.maxBytes = policy.maxBytes ?? DEFAULT_MAX_BYTES
    this.timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxActive = policy.maxActive ?? DEFAULT_MAX_ACTIVE
    this.maxWaiting = policy.maxWaiting ?? DEFAULT_MAX_WAITING
    this.method = policy.method === 'POST' ? 'POST' : 'GET'
    // 非 GET 的默认重定向预算就是 0；调用方显式给值也不改变下面「POST 不跟随」的硬规则。
    this.maxRedirects = policy.maxRedirects ?? (this.method === 'GET' ? DEFAULT_MAX_REDIRECTS : 0)
    this.body = this.method === 'POST' ? policy.body ?? '' : undefined
  }
  async fetch(raw: string, options: FetchOptions = {}): Promise<EgressResult> {
    for (const [key, value] of this.continuations) if (value.deadline <= Date.now()) this.continuations.delete(key)
    let attempt: Attempt
    if (options.continuation) {
      const pending = this.continuations.get(options.continuation)
      this.continuations.delete(options.continuation)
      if (!pending || pending.raw !== raw || pending.binding !== options.binding || options.mode !== 'explicit') return fail('UNAVAILABLE')
      attempt = pending; attempt.mode = 'explicit'
    } else {
      const first = egressUrl(raw, this.allowedPorts)
      if (!first) return fail('INVALID_URL')
      attempt = { raw, current: first, mode: options.mode ?? 'auto', deadline: Date.now() + this.timeoutMs, redirects: 0, bytes: 0, binding: options.binding }
      if (first.protocol === 'http:') {
        if (this.http === 'refuse') return fail('HTTP_REFUSED')
        if (!(attempt.mode === 'explicit' && options.allowHttp)) return this.confirm(attempt, 'HTTP_CONFIRM')
      }
    }
    const controller = new AbortController()
    let callerAborted = options.signal?.aborted ?? false
    const abortByCaller = (): void => { callerAborted = true; controller.abort() }
    options.signal?.addEventListener('abort', abortByCaller, { once: true })
    let timedOut = false
    const abortByTimeout = (): void => { timedOut = true; controller.abort() }
    if (!callerAborted && attempt.deadline <= Date.now()) abortByTimeout()
    if (callerAborted) controller.abort()
    const timeout = setTimeout(abortByTimeout, Math.max(0, attempt.deadline - Date.now()))
    let acquired = false
    try {
      if (this.active >= this.maxActive && this.waiting.length >= this.maxWaiting) return fail('BUSY')
      await this.acquire(controller.signal); acquired = true
      return await this.fetchAttempt(attempt, controller.signal, options.validate)
    } catch { return fail(timedOut && !callerAborted ? 'TIMEOUT' : 'UNAVAILABLE') }
    finally {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abortByCaller)
      if (acquired) { const next = this.waiting.shift(); if (next) next.start(); else this.active -= 1 }
    }
  }
  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('aborted'))
    if (this.active < this.maxActive) { this.active += 1; return Promise.resolve() }
    return new Promise((resolve, reject) => {
      const item = { start: () => { signal.removeEventListener('abort', item.cancel); resolve() }, cancel: () => {
        const at = this.waiting.indexOf(item); if (at >= 0) this.waiting.splice(at, 1)
        reject(new Error('aborted'))
      } }
      this.waiting.push(item); signal.addEventListener('abort', item.cancel, { once: true })
    })
  }
  private confirm(attempt: Attempt, error: 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM'): EgressResult {
    if (attempt.deadline <= Date.now()) return fail('TIMEOUT')
    if (this.continuations.size >= this.maxWaiting) return fail('BUSY')
    const continuation = randomUUID(); this.continuations.set(continuation, attempt)
    return { ok: false, error, url: attempt.current.href, continuation }
  }
  /** GET 仍然只传 4 个参数：既有 transport 注入方不需要认识第 5 个。 */
  private requestFor(url: URL, address: ImageAddress, signal: AbortSignal): Promise<Response> {
    if (this.method === 'POST') return this.request(url, address, signal, IDENTITY_HEADERS, { method: 'POST', body: this.body ?? '' })
    return this.request(url, address, signal, IDENTITY_HEADERS)
  }
  private async fetchAttempt(attempt: Attempt, signal: AbortSignal, validate?: () => Promise<boolean>): Promise<EgressResult> {
    for (;;) {
      signal.throwIfAborted()
      if (validate && !(await untilAbort(validate(), signal))) return fail('UNAVAILABLE')
      signal.throwIfAborted()
      const host = attempt.current.hostname.replace(/^\[|\]$/g, '')
      const family = isIP(host)
      const answers = family ? [{ address: host, family: family as 4 | 6 }] : await untilAbort(this.resolve(host), signal)
      if (!answers.length || answers.some(answer => !publicAddress(answer.address) || isIP(answer.address) !== answer.family)) return fail('INVALID_URL')
      if (validate && !(await untilAbort(validate(), signal))) return fail('UNAVAILABLE')
      signal.throwIfAborted()
      const response = await untilAbort(this.requestFor(attempt.current, answers[0], signal), signal)
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        // 非 GET 只允许预设端点的单次请求：任何 3xx 都拒绝，绝不改写成 GET 跟随。
        if (this.method !== 'GET') return fail('UNAVAILABLE')
        if (attempt.redirects >= this.maxRedirects) return fail('UNAVAILABLE')
        const location = response.headers.get('location')
        let next: URL | null = null
        try { next = location ? egressUrl(new URL(location, attempt.current).href, this.allowedPorts) : null } catch { /* invalid redirect */ }
        if (!next) return fail('INVALID_URL')
        const downgrade = attempt.current.protocol === 'https:' && next.protocol === 'http:'
        const changed = attempt.current.origin !== next.origin
        attempt.current = next; attempt.redirects += 1
        if (downgrade) {
          if (this.http === 'refuse') return fail('HTTP_REFUSED')
          // A refused origin must not become reachable through the HTTP confirmation.
          if (changed && this.crossOrigin === 'refuse') return fail('CROSS_ORIGIN_REFUSED')
          return this.confirm(attempt, 'HTTP_CONFIRM')
        }
        if (changed) {
          if (this.crossOrigin === 'refuse') return fail('CROSS_ORIGIN_REFUSED')
          // Existing remote-image split: auto follows, explicit asks before crossing.
          if (attempt.mode === 'explicit') return this.confirm(attempt, 'REDIRECT_CONFIRM')
        }
        continue
      }
      const encoding = response.headers.get('content-encoding')
      if (this.requireIdentityEncoding && encoding && encoding.trim().toLowerCase() !== 'identity') {
        await response.body?.cancel(); return fail('ENCODING_REFUSED')
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); return fail('UNAVAILABLE') }
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > this.maxBytes - attempt.bytes) { await response.body.cancel(); return fail('TOO_LARGE') }
      const bytes = await readBounded(response.body, this.maxBytes - attempt.bytes, signal)
      if (!bytes) return fail('TOO_LARGE')
      attempt.bytes += bytes.byteLength
      signal.throwIfAborted()
      return { ok: true, bytes, status: response.status, finalUrl: attempt.current.href, headers: responseHeaders(response.headers), redirects: attempt.redirects }
    }
  }
}
// Ordinary globally routed IPv6 only. ipaddr's "unicast" also includes
// site-local, local-use translation, unallocated and newer special prefixes.
// IANA: https://www.iana.org/assignments/iana-ipv6-special-registry
const IPV6_GLOBAL = ipaddr.parseCIDR('2000::/3') as [ipaddr.IPv6, number]
const IPV6_SPECIAL = ['2001::/23', '3fff::/20'].map(prefix => ipaddr.parseCIDR(prefix) as [ipaddr.IPv6, number])
/** 公网单播判定：普通全局 IPv4，或 2000::/3 内、排除 IANA 特殊段的 IPv6；映射地址按 IPv4 判。 */
export function publicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address)
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address()
    if (parsed.range() !== 'unicast') return false
    if (parsed.kind() === 'ipv6') {
      const v6 = parsed as ipaddr.IPv6
      return v6.match(IPV6_GLOBAL) && !IPV6_SPECIAL.some(prefix => v6.match(prefix))
    }
    return true
  } catch { return false }
}
/** 只做 URL 形状与端口把关（不解析 DNS）：协议、userinfo、本地名、字面私网地址在这里拒。 */
export function egressUrl(raw: string, allowedPorts?: readonly number[]): URL | null {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) && !publicAddress(host))) return null
    if (allowedPorts && allowedPorts.length) {
      const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
      if (!allowedPorts.includes(port)) return null
    }
    return url
  } catch { return null }
}
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
async function readBounded(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  const abort = (): void => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await untilAbort(reader.read(), signal)
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); return null }
      chunks.push(value)
    }
    const output = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
    return output
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
}
function responseHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {}
  headers.forEach((value, name) => { output[name.toLowerCase()] = value })
  return output
}
