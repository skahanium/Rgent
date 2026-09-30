import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { resolveImageAddresses, requestPinnedImage, type ImageAddress } from './remote-image-transport.ts'

export type RemoteImageError = 'INVALID_URL' | 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM' | 'NOT_IMAGE' | 'TOO_LARGE' | 'UNAVAILABLE' | 'BUSY'
export type RemoteImageResult = { ok: true; token: string } | { ok: false; error: Exclude<RemoteImageError, 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM'> } | { ok: false; error: 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM'; url: string; continuation: string }
export type RemoteImageLoadOptions = { mode: 'auto' | 'explicit'; allowHttp?: boolean; continuation?: string; signal?: AbortSignal; binding?: string; validate?: () => Promise<boolean> }
type Dependencies = { resolve?: (hostname: string) => Promise<ImageAddress[]>; request?: (url: URL, address: ImageAddress, signal: AbortSignal) => Promise<Response> }
type Stored = { bytes: Uint8Array; mime: string }
type Attempt = { raw: string; current: URL; mode: 'auto' | 'explicit'; deadline: number; redirects: number; bytes: number; binding?: string }
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const MAX_CACHE_BYTES = 80 * 1024 * 1024
const MAX_REDIRECTS = 3
const MAX_ACTIVE = 4
const MAX_WAITING = 32
export const REMOTE_IMAGE_SCHEME = 'rgent-image'
export function remoteImageUrl(token: string): string { return `${REMOTE_IMAGE_SCHEME}://media/?t=${encodeURIComponent(token)}` }
export function parseRemoteImageUrl(raw: string): string | null {
  try {
    const url = new URL(raw); const token = url.searchParams.get('t')
    return url.protocol === `${REMOTE_IMAGE_SCHEME}:` && url.hostname === 'media' && url.pathname === '/' && token && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(token) ? token : null
  } catch { return null }
}
/** Private, image-only transport. Its caller must first prove the note source and load mode. */
export class RemoteImageService {
  private readonly cache = new Map<string, Stored>()
  private readonly continuations = new Map<string, Attempt>()
  private cacheBytes = 0
  private active = 0
  private readonly waiting: Array<{ start: () => void; cancel: () => void }> = []
  private readonly resolve: NonNullable<Dependencies['resolve']>
  private readonly request: NonNullable<Dependencies['request']>
  private readonly maxBytes: number
  private readonly timeoutMs: number
  constructor(dependencies: Dependencies = {}, options: { maxBytes?: number; timeoutMs?: number } = {}) {
    this.resolve = dependencies.resolve ?? resolveImageAddresses
    this.request = dependencies.request ?? requestPinnedImage
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.timeoutMs = options.timeoutMs ?? 20_000
  }
  async load(raw: string, options: RemoteImageLoadOptions = { mode: 'auto' }): Promise<RemoteImageResult> {
    for (const [key, value] of this.continuations) if (value.deadline <= Date.now()) this.continuations.delete(key)
    let attempt: Attempt
    if (options.continuation) {
      const pending = this.continuations.get(options.continuation)
      this.continuations.delete(options.continuation)
      if (!pending || pending.raw !== raw || pending.binding !== options.binding || options.mode !== 'explicit') return { ok: false, error: 'UNAVAILABLE' }
      attempt = pending; attempt.mode = 'explicit'
    } else {
      const first = remoteUrl(raw)
      if (!first) return { ok: false, error: 'INVALID_URL' }
      attempt = { raw, current: first, mode: options.mode, deadline: Date.now() + this.timeoutMs, redirects: 0, bytes: 0, binding: options.binding }
      if (first.protocol === 'http:' && !(options.mode === 'explicit' && options.allowHttp)) return this.confirm(attempt, 'HTTP_CONFIRM')
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted || attempt.deadline <= Date.now()) controller.abort()
    const timeout = setTimeout(abort, Math.max(0, attempt.deadline - Date.now()))
    let acquired = false
    try {
      if (this.active >= MAX_ACTIVE && this.waiting.length >= MAX_WAITING) return { ok: false, error: 'BUSY' }
      await this.acquire(controller.signal); acquired = true
      return await this.fetchAndStore(attempt, controller.signal, options.validate)
    } catch { return { ok: false, error: 'UNAVAILABLE' } }
    finally {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort)
      if (acquired) { const next = this.waiting.shift(); if (next) next.start(); else this.active -= 1 }
    }
  }
  read(token: string): Stored | null {
    const found = this.cache.get(token)
    if (!found) return null
    this.cache.delete(token); this.cache.set(token, found); return found
  }
  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('aborted'))
    if (this.active < MAX_ACTIVE) { this.active += 1; return Promise.resolve() }
    return new Promise((resolve, reject) => {
      const item = { start: () => { signal.removeEventListener('abort', item.cancel); resolve() }, cancel: () => {
        const at = this.waiting.indexOf(item); if (at >= 0) this.waiting.splice(at, 1)
        reject(new Error('aborted'))
      } }
      this.waiting.push(item); signal.addEventListener('abort', item.cancel, { once: true })
    })
  }
  private confirm(attempt: Attempt, error: 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM'): RemoteImageResult {
    if (attempt.deadline <= Date.now()) return { ok: false, error: 'UNAVAILABLE' }
    if (this.continuations.size >= MAX_WAITING) return { ok: false, error: 'BUSY' }
    const continuation = randomUUID(); this.continuations.set(continuation, attempt)
    return { ok: false, error, url: attempt.current.href, continuation }
  }
  private async fetchAndStore(attempt: Attempt, signal: AbortSignal, validate?: () => Promise<boolean>): Promise<RemoteImageResult> {
    for (;;) {
      signal.throwIfAborted()
      if (validate && !(await untilAbort(validate(), signal))) return { ok: false, error: 'UNAVAILABLE' }
      signal.throwIfAborted()
      const host = attempt.current.hostname.replace(/^\[|\]$/g, '')
      const family = isIP(host)
      const answers = family ? [{ address: host, family: family as 4 | 6 }] : await untilAbort(this.resolve(host), signal)
      if (!answers.length || answers.some(answer => !publicAddress(answer.address) || isIP(answer.address) !== answer.family)) return { ok: false, error: 'INVALID_URL' }
      if (validate && !(await untilAbort(validate(), signal))) return { ok: false, error: 'UNAVAILABLE' }
      signal.throwIfAborted()
      const response = await untilAbort(this.request(attempt.current, answers[0], signal), signal)
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        if (attempt.redirects >= MAX_REDIRECTS) return { ok: false, error: 'UNAVAILABLE' }
        const location = response.headers.get('location')
        let next: URL | null = null
        try { next = location ? remoteUrl(new URL(location, attempt.current).href) : null } catch { /* invalid redirect */ }
        if (!next) return { ok: false, error: 'INVALID_URL' }
        const downgrade = attempt.current.protocol === 'https:' && next.protocol === 'http:'
        const changed = attempt.current.origin !== next.origin
        attempt.current = next; attempt.redirects += 1
        if (downgrade) return this.confirm(attempt, 'HTTP_CONFIRM')
        if (attempt.mode === 'explicit' && changed) return this.confirm(attempt, 'REDIRECT_CONFIRM')
        continue
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); return { ok: false, error: 'UNAVAILABLE' } }
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > this.maxBytes - attempt.bytes) { await response.body.cancel(); return { ok: false, error: 'TOO_LARGE' } }
      const bytes = await readBounded(response.body, this.maxBytes - attempt.bytes, signal)
      if (!bytes) return { ok: false, error: 'TOO_LARGE' }
      attempt.bytes += bytes.byteLength
      const mime = imageMime(bytes, response.headers.get('content-type'))
      if (!mime) return { ok: false, error: 'NOT_IMAGE' }
      signal.throwIfAborted()
      const token = randomUUID()
      while (this.cacheBytes + bytes.byteLength > MAX_CACHE_BYTES && this.cache.size) {
        const oldest = this.cache.keys().next().value as string
        this.cacheBytes -= this.cache.get(oldest)!.bytes.byteLength; this.cache.delete(oldest)
      }
      this.cache.set(token, { bytes, mime }); this.cacheBytes += bytes.byteLength
      return { ok: true, token }
    }
  }
}
// Ordinary globally routed IPv6 only. ipaddr's "unicast" also includes
// site-local, local-use translation, unallocated and newer special prefixes.
// IANA: https://www.iana.org/assignments/iana-ipv6-special-registry
const IPV6_GLOBAL = ipaddr.parseCIDR('2000::/3') as [ipaddr.IPv6, number]
const IPV6_SPECIAL = ['2001::/23', '3fff::/20'].map(prefix => ipaddr.parseCIDR(prefix) as [ipaddr.IPv6, number])
function publicAddress(address: string): boolean {
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
function remoteUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) && !publicAddress(host))) return null
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
function imageMime(bytes: Uint8Array, contentType: string | null): string | null {
  const ascii = (start: number, end: number): string => String.fromCharCode(...bytes.slice(start, end))
  if (bytes.length >= 8 && ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 4) === 'GIF8') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(0, 2) === 'BM') return 'image/bmp'
  if (ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'image/avif'
  if (contentType?.split(';')[0]?.trim().toLowerCase() === 'image/svg+xml') {
    const start = new TextDecoder().decode(bytes.slice(0, 1024)).replace(/^\uFEFF/, '').trimStart()
    if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(start)) return 'image/svg+xml'
  }
  return null
}
