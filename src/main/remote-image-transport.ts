import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { isIP } from 'node:net'

export type ImageAddress = { address: string; family: 4 | 6 }
/** 单次请求的形状：只有预设端点的查询允许 POST；GET 是既有图片／抓页路径的默认值。 */
export type PinnedRequestInit = { method?: 'GET' | 'POST'; body?: string }
export async function resolveImageAddresses(hostname: string): Promise<ImageAddress[]> {
  return await lookup(hostname, { all: true, verbatim: true }) as ImageAddress[]
}

/** Fresh direct socket; only the prechecked address is supplied to Node's connection lookup.
 * The URL hostname remains the Host header and TLS certificate verification name. */
export function requestPinnedImage(url: URL, address: ImageAddress, signal: AbortSignal, headers: Record<string, string> = { 'accept-encoding': 'identity' }, init: PinnedRequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const method = init.method === 'POST' ? 'POST' : 'GET'
    const body = method === 'POST' ? init.body ?? '' : undefined
    const mergedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
    // POST 只用于预设搜索端点：固定 JSON 内容类型，长度按 UTF-8 字节算（与实际发送字节一致）。
    const bodyHeaders = body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body, 'utf8')) }
    const options: https.RequestOptions & { autoSelectFamily: boolean } = {
      method, agent: false, signal, autoSelectFamily: false, rejectUnauthorized: true,
      headers: { accept: 'image/*', ...mergedHeaders, ...bodyHeaders },
      ...(url.protocol === 'https:' && !isIP(url.hostname.replace(/^\[|\]$/g, ''))
        ? { servername: url.hostname } : {}),
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
    }
    const request = (url.protocol === 'https:' ? https : http).request(url, options, (incoming) => {
      try {
        const status = incoming.statusCode ?? 502
        if (status < 200 || status > 599) throw new Error('Invalid image response')
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value != null) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        // Response forbids a body for these status codes. Stop their sockets immediately.
        if ([204, 205, 304].includes(status)) {
          incoming.destroy()
          resolve(new Response(null, { status, headers }))
        } else resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers }))
      } catch {
        incoming.destroy()
        reject(new Error('Invalid image response'))
      }
    })
    request.once('error', reject)
    request.end(body)
  })
}
