import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { isIP } from 'node:net'

export type ImageAddress = { address: string; family: 4 | 6 }
export async function resolveImageAddresses(hostname: string): Promise<ImageAddress[]> {
  return await lookup(hostname, { all: true, verbatim: true }) as ImageAddress[]
}

/** Fresh direct socket; only the prechecked address is supplied to Node's connection lookup.
 * The URL hostname remains the Host header and TLS certificate verification name. */
export function requestPinnedImage(url: URL, address: ImageAddress, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions & { autoSelectFamily: boolean } = {
      method: 'GET', agent: false, signal, autoSelectFamily: false, rejectUnauthorized: true,
      headers: { accept: 'image/*', 'accept-encoding': 'identity' },
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
    request.end()
  })
}
