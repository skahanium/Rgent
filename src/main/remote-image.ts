import { randomUUID } from 'node:crypto'
import { EgressClient } from './egress.ts'
import { resolveImageAddresses, requestPinnedImage, type ImageAddress } from './remote-image-transport.ts'

export type RemoteImageError = 'INVALID_URL' | 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM' | 'NOT_IMAGE' | 'TOO_LARGE' | 'UNAVAILABLE' | 'BUSY'
export type RemoteImageResult = { ok: true; token: string } | { ok: false; error: Exclude<RemoteImageError, 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM'> } | { ok: false; error: 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM'; url: string; continuation: string }
export type RemoteImageLoadOptions = { mode: 'auto' | 'explicit'; allowHttp?: boolean; continuation?: string; signal?: AbortSignal; binding?: string; validate?: () => Promise<boolean> }
type Dependencies = { resolve?: (hostname: string) => Promise<ImageAddress[]>; request?: (url: URL, address: ImageAddress, signal: AbortSignal) => Promise<Response> }
type Stored = { bytes: Uint8Array; mime: string }
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const MAX_CACHE_BYTES = 80 * 1024 * 1024
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
  private readonly egress: EgressClient
  private cacheBytes = 0
  constructor(dependencies: Dependencies = {}, options: { maxBytes?: number; timeoutMs?: number } = {}) {
    // Keep the image dependency contract at three arguments: the hardened core supplies
    // Accept-Encoding: identity, while the transport fallback also owns that default.
    const request = dependencies.request ?? requestPinnedImage
    this.egress = new EgressClient({
      http: 'confirm', crossOrigin: 'follow',
      resolve: dependencies.resolve ?? resolveImageAddresses,
      request: (url, address, signal) => request(url, address, signal),
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      timeoutMs: options.timeoutMs ?? 20_000
    })
  }
  async load(raw: string, options: RemoteImageLoadOptions = { mode: 'auto' }): Promise<RemoteImageResult> {
    const result = await this.egress.fetch(raw, options)
    if (result.ok) {
      const mime = imageMime(result.bytes, result.headers['content-type'] ?? null)
      if (!mime) return { ok: false, error: 'NOT_IMAGE' }
      const token = randomUUID()
      while (this.cacheBytes + result.bytes.byteLength > MAX_CACHE_BYTES && this.cache.size) {
        const oldest = this.cache.keys().next().value as string
        this.cacheBytes -= this.cache.get(oldest)!.bytes.byteLength; this.cache.delete(oldest)
      }
      this.cache.set(token, { bytes: result.bytes, mime }); this.cacheBytes += result.bytes.byteLength
      return { ok: true, token }
    }
    if (result.error === 'HTTP_CONFIRM' || result.error === 'REDIRECT_CONFIRM') {
      return { ok: false, error: result.error, url: result.url, continuation: result.continuation }
    }
    switch (result.error) {
      case 'INVALID_URL': case 'BUSY': case 'TOO_LARGE': case 'UNAVAILABLE': return { ok: false, error: result.error }
      // TIMEOUT and the text-fetch refusals collapse to the old image result.
      case 'HTTP_REFUSED': case 'CROSS_ORIGIN_REFUSED': case 'ENCODING_REFUSED': case 'TIMEOUT': return { ok: false, error: 'UNAVAILABLE' }
    }
  }
  read(token: string): Stored | null {
    const found = this.cache.get(token)
    if (!found) return null
    this.cache.delete(token); this.cache.set(token, found); return found
  }
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
