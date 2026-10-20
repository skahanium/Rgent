import { afterEach, describe, expect, it, vi } from 'vitest'
import { EgressClient, type EgressPolicy } from '../../src/main/egress.ts'
import { RemoteImageService } from '../../src/main/remote-image.ts'
import type { ImageAddress } from '../../src/main/remote-image-transport.ts'

const PUBLIC_V4: ImageAddress = { address: '93.184.216.34', family: 4 }
const PUBLIC_V6: ImageAddress = { address: '2606:4700:4700::1111', family: 6 }
const PAYLOAD = Uint8Array.from([1, 2, 3, 4])
type Resolve = (hostname: string) => Promise<ImageAddress[]>
type Request = (url: URL, address: ImageAddress, signal: AbortSignal, headers?: Record<string, string>) => Promise<Response>
const reply = (body: BodyInit | null = PAYLOAD, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } })
const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location } })
const fake = (request: Request = async () => reply(), resolve: Resolve = async () => [PUBLIC_V4]) => ({ request: vi.fn(request), resolve: vi.fn(resolve) })
const make = (deps: ReturnType<typeof fake>, policy: EgressPolicy = {}): EgressClient => new EgressClient({ resolve: deps.resolve, request: deps.request, ...policy })
const literalUrl = (address: string): string => `https://${address.includes(':') ? `[${address}]` : address}/a`
afterEach(() => vi.useRealTimers())

describe('egress core', () => {
  it('allows public IPv4, IPv6 and mapped IPv6 answers and pins the first answer', async () => {
    for (const answer of [PUBLIC_V4, PUBLIC_V6, { address: '::ffff:93.184.216.34', family: 6 as const }]) {
      const deps = fake(async () => reply())
      deps.resolve.mockResolvedValue([answer])
      const result = await make(deps).fetch('https://images.example/a')
      expect(result).toMatchObject({ ok: true, status: 200, finalUrl: 'https://images.example/a', redirects: 0, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      if (result.ok) expect(result.bytes).toEqual(PAYLOAD)
      expect(deps.request).toHaveBeenCalledTimes(1)
      expect(deps.request).toHaveBeenCalledWith(new URL('https://images.example/a'), answer, expect.any(AbortSignal), { 'accept-encoding': 'identity' })
    }
  })
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.1.1', '192.0.2.1', '198.18.0.1',
    '224.0.0.1', '239.255.255.250', '255.255.255.255', '0.0.0.0',
    '::1', 'fe80::1', 'fc00::1', 'ff02::1', '::', '::ffff:127.0.0.1', '::ffff:a00:1',
    'fec0::1', '64:ff9b:1::a00:1', '100:0:0:1::1', '3fff::1', '5f00::1', '2001:2::1'
  ])('rejects the non-public literal %s before any request', async address => {
    const deps = fake()
    expect(await make(deps).fetch(literalUrl(address))).toEqual({ ok: false, error: 'INVALID_URL' })
    expect(deps.resolve).not.toHaveBeenCalled()
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('rejects non-http schemes, userinfo and local names', async () => {
    const deps = fake()
    const client = make(deps)
    for (const raw of ['file:///tmp/a', 'ftp://example.com/a', 'https://user:pass@example.com/a', 'https://localhost/a', 'https://a.localhost/a', 'https://printer.local/a']) {
      expect(await client.fetch(raw)).toEqual({ ok: false, error: 'INVALID_URL' })
    }
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('refuses plain HTTP before any request when the policy refuses HTTP', async () => {
    const deps = fake()
    expect(await make(deps, { http: 'refuse' }).fetch('http://images.example/a')).toEqual({ ok: false, error: 'HTTP_REFUSED' })
    expect(deps.request).not.toHaveBeenCalled()
    expect(deps.resolve).not.toHaveBeenCalled()
  })
  it('keeps the existing HTTP confirmation and resumes only explicitly', async () => {
    const deps = fake()
    const client = make(deps, { http: 'confirm' })
    const raw = 'http://images.example/a'
    const first = await client.fetch(raw)
    expect(first).toMatchObject({ ok: false, error: 'HTTP_CONFIRM', url: raw, continuation: expect.any(String) })
    if (first.ok || !('continuation' in first)) throw Error('missing confirmation')
    expect(deps.request).not.toHaveBeenCalled()
    const resumed = await client.fetch(raw, { mode: 'explicit', continuation: first.continuation })
    expect(resumed.ok).toBe(true)
    expect(deps.request).toHaveBeenCalledTimes(1)
  })
  it('refuses an HTTPS-to-HTTP redirect downgrade without confirming', async () => {
    const deps = fake(async () => redirect('http://images.example/b'))
    expect(await make(deps, { http: 'refuse' }).fetch('https://images.example/a')).toEqual({ ok: false, error: 'HTTP_REFUSED' })
    expect(deps.request).toHaveBeenCalledTimes(1)
    expect(deps.request.mock.calls[1]).toBeUndefined()
  })
  it('still pauses an HTTPS downgrade under the default confirmation policy', async () => {
    const deps = fake(async () => redirect('http://images.example/b'))
    expect(await make(deps).fetch('https://images.example/a')).toMatchObject({ ok: false, error: 'HTTP_CONFIRM', url: 'http://images.example/b', continuation: expect.any(String) })
    expect(deps.request).toHaveBeenCalledTimes(1)
  })
  it('refuses a cross-origin downgrade instead of offering HTTP confirmation', async () => {
    const deps = fake(async () => redirect('http://other.example/b'))
    expect(await make(deps, { http: 'confirm', crossOrigin: 'refuse' }).fetch('https://images.example/a')).toEqual({ ok: false, error: 'CROSS_ORIGIN_REFUSED' })
    expect(deps.request).toHaveBeenCalledTimes(1)
  })
  it('reports HTTP_REFUSED for a downgrade when both HTTP and cross-origin are refused', async () => {
    const deps = fake(async () => redirect('http://images.example/b'))
    expect(await make(deps, { http: 'refuse', crossOrigin: 'refuse' }).fetch('https://images.example/a')).toEqual({ ok: false, error: 'HTTP_REFUSED' })
    expect(deps.request).toHaveBeenCalledTimes(1)
  })
  it('refuses cross-origin redirects without resolving the target', async () => {
    const deps = fake(async () => redirect('https://other.example/b'))
    expect(await make(deps, { crossOrigin: 'refuse' }).fetch('https://images.example/a')).toEqual({ ok: false, error: 'CROSS_ORIGIN_REFUSED' })
    expect(deps.resolve).toHaveBeenCalledTimes(1)
    expect(deps.resolve).toHaveBeenCalledWith('images.example')
    expect(deps.resolve).not.toHaveBeenCalledWith('other.example')
    expect(deps.request).toHaveBeenCalledTimes(1)
  })
  it('allows same-origin redirects even when cross-origin redirects are refused', async () => {
    const deps = fake(vi.fn().mockResolvedValueOnce(redirect('/next')).mockResolvedValue(reply()))
    const result = await make(deps, { crossOrigin: 'refuse' }).fetch('https://images.example/a')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.finalUrl).toBe('https://images.example/next')
    expect(deps.resolve).toHaveBeenCalledTimes(2)
    expect(deps.request).toHaveBeenCalledTimes(2)
  })
  it('follows cross-origin redirects in auto mode and confirms only in explicit mode', async () => {
    const autoDeps = fake(vi.fn().mockResolvedValueOnce(redirect('https://other.example/a')).mockResolvedValue(reply()))
    const auto = await make(autoDeps, { crossOrigin: 'follow' }).fetch('https://images.example/a')
    expect(auto.ok).toBe(true)
    expect(autoDeps.request).toHaveBeenCalledTimes(2)

    const explicitDeps = fake(vi.fn().mockResolvedValueOnce(redirect('https://other.example/a')).mockResolvedValue(reply()))
    const client = make(explicitDeps, { crossOrigin: 'follow' })
    const first = await client.fetch('https://images.example/a', { mode: 'explicit' })
    expect(first).toMatchObject({ ok: false, error: 'REDIRECT_CONFIRM', url: 'https://other.example/a', continuation: expect.any(String) })
    if (first.ok || !('continuation' in first)) throw Error('missing confirmation')
    expect(explicitDeps.request).toHaveBeenCalledTimes(1)
    const resumed = await client.fetch('https://images.example/a', { mode: 'explicit', continuation: first.continuation })
    expect(resumed.ok).toBe(true)
    expect(explicitDeps.request).toHaveBeenCalledTimes(2)
  })
  it.each([0, 1, 3])('caps redirects at %i', async maxRedirects => {
    const deps = fake(async () => redirect('/next'))
    expect(await make(deps, { maxRedirects }).fetch('https://images.example/a')).toEqual({ ok: false, error: 'UNAVAILABLE' })
    expect(deps.request).toHaveBeenCalledTimes(maxRedirects + 1)
  })
  it('bounds declared and streamed bodies by maxBytes', async () => {
    const declaredDeps = fake(async () => new Response(new Uint8Array(1), { headers: { 'content-type': 'text/plain', 'content-length': '100' } }))
    expect(await make(declaredDeps, { maxBytes: 8 }).fetch('https://images.example/a')).toEqual({ ok: false, error: 'TOO_LARGE' })

    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close() } })
    const streamedDeps = fake(async () => new Response(stream, { headers: { 'content-type': 'text/plain' } }))
    expect(await make(streamedDeps, { maxBytes: 8 }).fetch('https://images.example/a')).toEqual({ ok: false, error: 'TOO_LARGE' })

    const exactDeps = fake(async () => new Response(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])))
    const exact = await make(exactDeps, { maxBytes: 8 }).fetch('https://images.example/a')
    expect(exact.ok).toBe(true)
    if (exact.ok) expect(exact.bytes).toHaveLength(8)
  })
  it('turns the overall deadline into TIMEOUT', async () => {
    vi.useFakeTimers()
    const deps = fake()
    deps.resolve.mockImplementation(() => new Promise<ImageAddress[]>(() => {}))
    const pending = make(deps, { timeoutMs: 5_000 }).fetch('https://images.example/a')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toEqual({ ok: false, error: 'TIMEOUT' })
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('maps an egress deadline back to UNAVAILABLE on the remote-image path', async () => {
    const request = vi.fn(() => new Promise<Response>(() => {}))
    const service = new RemoteImageService({ resolve: async () => [PUBLIC_V4], request }, { timeoutMs: 10 })
    expect(await service.load('https://images.example/a')).toEqual({ ok: false, error: 'UNAVAILABLE' })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('cancels a pending DNS wait on AbortSignal', async () => {
    const deps = fake()
    deps.resolve.mockImplementation(() => new Promise<ImageAddress[]>(() => {}))
    const controller = new AbortController()
    const pending = make(deps).fetch('https://images.example/a', { signal: controller.signal })
    await vi.waitFor(() => expect(deps.resolve).toHaveBeenCalled())
    controller.abort()
    expect(await pending).toEqual({ ok: false, error: 'UNAVAILABLE' })
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('cancels an active body read on AbortSignal', async () => {
    let reading = false
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ pull() { reading = true }, cancel() { cancelled = true } })
    const deps = fake(async () => new Response(body, { headers: { 'content-type': 'text/plain' } }))
    const controller = new AbortController()
    const pending = make(deps).fetch('https://images.example/a', { signal: controller.signal })
    await vi.waitFor(() => expect(reading).toBe(true))
    controller.abort()
    expect(await pending).toEqual({ ok: false, error: 'UNAVAILABLE' })
    expect(cancelled).toBe(true)
  })
  it('refuses non-identity content-encoding only when required', async () => {
    let cancelled = false
    const gzipBody = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array([1])) }, cancel() { cancelled = true } })
    const gzipDeps = fake(async () => new Response(gzipBody, { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } }))
    expect(await make(gzipDeps, { requireIdentityEncoding: true }).fetch('https://images.example/a')).toEqual({ ok: false, error: 'ENCODING_REFUSED' })
    expect(cancelled).toBe(true)

    for (const encoding of ['identity', 'Identity', undefined]) {
      const deps = fake(async () => reply(PAYLOAD, encoding ? { 'content-encoding': encoding } : {}))
      const result = await make(deps, { requireIdentityEncoding: true }).fetch('https://images.example/a')
      expect(result.ok).toBe(true)
    }

    const tolerated = fake(async () => reply(PAYLOAD, { 'content-encoding': 'gzip' }))
    expect((await make(tolerated).fetch('https://images.example/a')).ok).toBe(true)
  })
  it('enforces allowedPorts for the initial URL and every redirect', async () => {
    const deps = fake()
    const client = make(deps, { allowedPorts: [443] })
    expect(await client.fetch('https://images.example:8443/a')).toEqual({ ok: false, error: 'INVALID_URL' })
    expect(deps.request).not.toHaveBeenCalled()
    expect(await client.fetch('http://images.example/a')).toEqual({ ok: false, error: 'INVALID_URL' })
    expect((await client.fetch('https://images.example/a')).ok).toBe(true)
    expect((await client.fetch('https://images.example:443/a')).ok).toBe(true)

    const redirectDeps = fake(async () => redirect('https://images.example:8443/b'))
    expect(await make(redirectDeps, { allowedPorts: [443] }).fetch('https://images.example/a')).toEqual({ ok: false, error: 'INVALID_URL' })
    expect(redirectDeps.request).toHaveBeenCalledTimes(1)

    const unrestricted = fake()
    expect((await make(unrestricted, { allowedPorts: [] }).fetch('https://images.example:8443/a')).ok).toBe(true)
  })
  it('resolves DNS again for every redirect and pins the new answer', async () => {
    const deps = fake(vi.fn().mockResolvedValueOnce(redirect('https://other.example/a')).mockResolvedValue(reply()))
    deps.resolve.mockResolvedValueOnce([PUBLIC_V4]).mockResolvedValueOnce([PUBLIC_V6])
    const client = make(deps)
    const result = await client.fetch('https://images.example/a')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.finalUrl).toBe('https://other.example/a')
    expect(deps.resolve).toHaveBeenCalledTimes(2)
    expect(deps.resolve).toHaveBeenNthCalledWith(1, 'images.example')
    expect(deps.resolve).toHaveBeenNthCalledWith(2, 'other.example')
    expect(deps.request).toHaveBeenCalledTimes(2)
    expect(deps.request.mock.calls[0][1]).toEqual(PUBLIC_V4)
    expect(deps.request.mock.calls[1][1]).toEqual(PUBLIC_V6)
  })
  it('rejects a rebound private answer after a redirect without connecting', async () => {
    const deps = fake(async () => redirect('/next'))
    deps.resolve.mockResolvedValueOnce([PUBLIC_V4]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    expect(await make(deps).fetch('https://images.example/a')).toEqual({ ok: false, error: 'INVALID_URL' })
    expect(deps.request).toHaveBeenCalledTimes(1)
  })
  it('returns lowercase headers including content-type, content-encoding and content-length', async () => {
    const deps = fake(async () => reply(PAYLOAD, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'identity', 'content-length': '4', 'x-trace': 'abc' }))
    const result = await make(deps).fetch('https://images.example/a')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(result.headers['content-encoding']).toBe('identity')
      expect(result.headers['content-length']).toBe('4')
      expect(result.headers['x-trace']).toBe('abc')
      expect(Object.keys(result.headers).every(name => name === name.toLowerCase())).toBe(true)
    }
  })
  it('rechecks validate before DNS and again before connecting', async () => {
    const deps = fake()
    let valid = true
    let finishDns!: (answers: ImageAddress[]) => void
    deps.resolve.mockImplementation(() => new Promise<ImageAddress[]>(resolve => { finishDns = resolve }))
    const validate = vi.fn(async () => valid)
    const pending = make(deps).fetch('https://images.example/a', { validate })
    await vi.waitFor(() => expect(deps.resolve).toHaveBeenCalled())
    valid = false
    finishDns([PUBLIC_V4])
    expect(await pending).toEqual({ ok: false, error: 'UNAVAILABLE' })
    expect(validate).toHaveBeenCalledTimes(2)
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('consumes continuations once and binds them to raw URL, explicit mode and binding', async () => {
    const deps = fake()
    const client = make(deps)
    const raw = 'http://images.example/a'
    const first = await client.fetch(raw, { binding: 'note A' })
    if (first.ok || !('continuation' in first)) throw Error('missing confirmation')
    expect(await client.fetch(raw, { mode: 'explicit', binding: 'note B', continuation: first.continuation })).toEqual({ ok: false, error: 'UNAVAILABLE' })

    const second = await client.fetch(raw, { binding: 'note A' })
    if (second.ok || !('continuation' in second)) throw Error('missing confirmation')
    expect(await client.fetch(raw, { continuation: second.continuation, binding: 'note A' })).toEqual({ ok: false, error: 'UNAVAILABLE' })

    const third = await client.fetch(raw, { binding: 'note A' })
    if (third.ok || !('continuation' in third)) throw Error('missing confirmation')
    const resumed = await client.fetch(raw, { mode: 'explicit', binding: 'note A', continuation: third.continuation })
    expect(resumed.ok).toBe(true)
    expect(deps.request).toHaveBeenCalledTimes(1)
  })
  it('expires a continuation after its original deadline', async () => {
    vi.useFakeTimers()
    const deps = fake(async () => redirect('https://other.example/a'))
    const client = make(deps)
    const first = await client.fetch('https://images.example/a', { mode: 'explicit' })
    if (first.ok || !('continuation' in first)) throw Error('missing confirmation')
    vi.advanceTimersByTime(20_001)
    expect(await client.fetch('https://images.example/a', { mode: 'explicit', continuation: first.continuation })).toEqual({ ok: false, error: 'UNAVAILABLE' })
  })
  it('keeps maxActive and maxWaiting bounds and reports BUSY', async () => {
    const releases: Array<() => void> = []
    const deps = fake(vi.fn(async () => { await new Promise<void>(resolve => releases.push(resolve)); return reply() }))
    const client = make(deps, { maxActive: 1, maxWaiting: 1 })
    const first = client.fetch('https://images.example/a')
    await vi.waitFor(() => expect(deps.request).toHaveBeenCalledTimes(1))
    const second = client.fetch('https://images.example/b')
    expect(await client.fetch('https://images.example/c')).toEqual({ ok: false, error: 'BUSY' })
    releases[0]()
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]()
    expect((await Promise.all([first, second])).every(result => result.ok)).toBe(true)
    expect(deps.request).toHaveBeenCalledTimes(2)
  })
})
