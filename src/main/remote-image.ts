import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

export type RemoteImageError = 'INVALID_URL' | 'HTTP_CONFIRM' | 'NOT_IMAGE' | 'TOO_LARGE' | 'UNAVAILABLE' | 'BUSY'
export type RemoteImageResult = { ok: true; token: string } | { ok: false; error: RemoteImageError }
type Fetcher = (url: string, init: RequestInit) => Promise<Response>
type Stored = { bytes: Uint8Array; mime: string }

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const MAX_CACHE_BYTES = 80 * 1024 * 1024
const MAX_REDIRECTS = 3
const MAX_ACTIVE = 4
const MAX_WAITING = 32
export const REMOTE_IMAGE_SCHEME = 'rgent-image'

export function remoteImageUrl(token: string): string {
  return `${REMOTE_IMAGE_SCHEME}://media/?t=${encodeURIComponent(token)}`
}

export function parseRemoteImageUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    const token = url.searchParams.get('t')
    return url.protocol === `${REMOTE_IMAGE_SCHEME}:` && url.hostname === 'media' &&
      url.pathname === '/' && token && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(token)
      ? token : null
  } catch {
    return null
  }
}

/** In-memory, image-only boundary. It never returns response text or arbitrary URLs to the renderer. */
export class RemoteImageService {
  private readonly cache = new Map<string, Stored>()
  private cacheBytes = 0
  private active = 0
  private readonly waiting: Array<() => void> = []
  private readonly maxBytes: number

  constructor(private readonly fetcher: Fetcher, options: { maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  async load(raw: string, allowHttp = false): Promise<RemoteImageResult> {
    const first = remoteUrl(raw)
    if (!first) return { ok: false, error: 'INVALID_URL' }
    if (first.protocol === 'http:' && !allowHttp) return { ok: false, error: 'HTTP_CONFIRM' }
    if (this.active >= MAX_ACTIVE && this.waiting.length >= MAX_WAITING) return { ok: false, error: 'BUSY' }
    if (this.active >= MAX_ACTIVE) await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.active += 1
    try {
      return await this.fetchAndStore(first, allowHttp)
    } finally {
      const next = this.waiting.shift()
      if (next) next() // Transfer this slot directly to the next request.
      else this.active -= 1
    }
  }

  read(token: string): Stored | null {
    const found = this.cache.get(token)
    if (!found) return null
    this.cache.delete(token)
    this.cache.set(token, found)
    return found
  }

  private async fetchAndStore(first: URL, allowHttp: boolean): Promise<RemoteImageResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    let current = first
    try {
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const response = await this.fetcher(current.href, {
          method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
          cache: 'no-store', signal: controller.signal
        })
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel()
          const location = response.headers.get('location')
          const next = location ? remoteUrl(new URL(location, current).href) : null
          if (!next || redirect === MAX_REDIRECTS) return { ok: false, error: 'UNAVAILABLE' }
          if (next.protocol === 'http:' && !allowHttp) return { ok: false, error: 'HTTP_CONFIRM' }
          current = next
          continue
        }
        if (!response.ok || !response.body) return { ok: false, error: 'UNAVAILABLE' }
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > this.maxBytes) {
          await response.body.cancel()
          return { ok: false, error: 'TOO_LARGE' }
        }
        const bytes = await readBounded(response.body, this.maxBytes)
        if (!bytes) return { ok: false, error: 'TOO_LARGE' }
        const mime = imageMime(bytes, response.headers.get('content-type'))
        if (!mime) return { ok: false, error: 'NOT_IMAGE' }
        const token = randomUUID()
        while (this.cacheBytes + bytes.byteLength > MAX_CACHE_BYTES && this.cache.size) {
          const oldest = this.cache.keys().next().value as string
          this.cacheBytes -= this.cache.get(oldest)!.bytes.byteLength
          this.cache.delete(oldest)
        }
        this.cache.set(token, { bytes, mime })
        this.cacheBytes += bytes.byteLength
        return { ok: true, token }
      }
      return { ok: false, error: 'UNAVAILABLE' }
    } catch {
      return { ok: false, error: 'UNAVAILABLE' }
    } finally {
      clearTimeout(timeout)
    }
  }
}

function remoteUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null
    if (isIP(host) === 4) {
      const [a = 0, b = 0] = host.split('.').map(Number)
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
          (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
          (a === 100 && b >= 64 && b <= 127)) return null
    } else if (isIP(host) === 6 && (/^(::1|::|fc|fd|fe8|fe9|fea|feb)/i.test(host))) return null
    return url
  } catch {
    return null
  }
}

async function readBounded(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const output = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  } finally {
    reader.releaseLock()
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
