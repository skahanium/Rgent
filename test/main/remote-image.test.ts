import { describe, expect, it, vi } from 'vitest'
import { RemoteImageService, parseRemoteImageUrl, remoteImageUrl } from '../../src/main/remote-image.ts'
import { attachRemoteImageProtocol } from '../../src/main/remote-image-protocol.ts'
import { protocol } from 'electron'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const image = (headers: Record<string, string> = {}) => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', ...headers } })

describe('remote image boundary', () => {
  it('serves only opaque image tokens through the display protocol', () => {
    const token = '7b5903b2-85fb-423f-9e3d-bdfad2ae98b9'
    expect(parseRemoteImageUrl(remoteImageUrl(token))).toBe(token)
    expect(parseRemoteImageUrl('rgent-image://media/?t=https://example.com')).toBeNull()
  })
  it('returns checked image bytes and rejects document navigation to the media protocol', async () => {
    const service = new RemoteImageService(async () => image())
    const loaded = await service.load('https://images.example/photo?id=1')
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    attachRemoteImageProtocol(service)
    const handler = vi.mocked(protocol.handle).mock.calls.at(-1)?.[1]
    expect(handler).toBeDefined()
    const src = remoteImageUrl(loaded.token)
    const rejected = await handler!({ url: src, destination: 'document' } as Request)
    expect(rejected.status).toBe(403)
    const chromiumImage = await handler!({ url: src, destination: '' } as Request)
    expect(chromiumImage.status).toBe(200)
    const displayed = await handler!({ url: src, destination: 'image' } as Request)
    expect(displayed.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await displayed.arrayBuffer())).toEqual(PNG)
  })
  it('loads a signed HTTPS image without relying on its extension', async () => {
    const fetcher = vi.fn(async () => image())
    const service = new RemoteImageService(fetcher)
    const result = await service.load('https://images.example/p?id=1%2F2')
    expect(result.ok).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('https://images.example/p?id=1%2F2', expect.objectContaining({ redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' }))
    if (result.ok) expect(service.read(result.token)?.bytes).toEqual(PNG)
  })

  it('does not request HTTP until that image is explicitly activated', async () => {
    const fetcher = vi.fn(async () => image())
    const service = new RemoteImageService(fetcher)
    expect(await service.load('http://images.example/a.png')).toEqual({ ok: false, error: 'HTTP_CONFIRM' })
    expect(fetcher).not.toHaveBeenCalled()
    expect((await service.load('http://images.example/a.png', true)).ok).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('asks before an HTTPS image redirects to HTTP', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://images.example/a.png' } }))
    const service = new RemoteImageService(fetcher)
    expect(await service.load('https://images.example/a.png')).toEqual({ ok: false, error: 'HTTP_CONFIRM' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects non-image responses, invalid schemes and local targets', async () => {
    const fetcher = vi.fn(async () => new Response('<html>hello</html>', { headers: { 'content-type': 'image/png' } }))
    const service = new RemoteImageService(fetcher)
    expect(await service.load('https://images.example/a.png')).toEqual({ ok: false, error: 'NOT_IMAGE' })
    expect(await service.load('file:///etc/passwd')).toEqual({ ok: false, error: 'INVALID_URL' })
    expect(await service.load('https://127.0.0.1/x')).toEqual({ ok: false, error: 'INVALID_URL' })
    expect(await service.load('https://[::ffff:127.0.0.1]/x')).toEqual({ ok: false, error: 'INVALID_URL' })
  })

  it('stops an oversized response before keeping it in memory', async () => {
    const service = new RemoteImageService(async () => image(), { maxBytes: 8 })
    expect(await service.load('https://images.example/a.png')).toEqual({ ok: false, error: 'TOO_LARGE' })
  })
  it('shows an unavailable result when offline', async () => {
    const service = new RemoteImageService(async () => { throw new Error('offline') })
    expect(await service.load('https://images.example/a.png')).toEqual({ ok: false, error: 'UNAVAILABLE' })
  })

  it('never exceeds four active requests when queued work is handed off', async () => {
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const service = new RemoteImageService(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return image()
    })
    const pending = Array.from({ length: 8 }, (_, index) => service.load(`https://images.example/${index}.png`))
    await vi.waitFor(() => expect(releases).toHaveLength(4))
    for (let index = 0; index < 8; index += 1) {
      releases[index]()
      if (index < 4) await vi.waitFor(() => expect(releases).toHaveLength(index + 5))
    }
    await Promise.all(pending)
    expect(peak).toBe(4)
  })
})
