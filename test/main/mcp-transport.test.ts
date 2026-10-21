import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpTransport } from '../../src/main/mcp-transport.ts'
import type { ImageAddress, PinnedRequestInit } from '../../src/main/remote-image-transport.ts'

/**
 * B1 传输层：全部用 DI 假 resolver／request 构造 `Response` 与 `ReadableStream`，不碰真网络。
 * 覆盖 URL 与 DNS 出口、状态映射、JSON／SSE 两种解析、早停、超时／取消与字节上限。
 */

const PUBLIC_V4: ImageAddress = { address: '93.184.216.34', family: 4 }
const PUBLIC_V6: ImageAddress = { address: '2606:4700:4700::1111', family: 6 }
const ENDPOINT = 'https://mcp.example/mcp'
const TOKEN_HEADERS = { authorization: 'Bearer device-token', 'mcp-protocol-version': '2025-06-18', 'mcp-session-id': 'session-1' }

type Resolve = (hostname: string) => Promise<ImageAddress[]>
type Request = (
  url: URL,
  address: ImageAddress,
  signal: AbortSignal,
  headers?: Record<string, string>,
  init?: PinnedRequestInit
) => Promise<Response>

const encoder = new TextEncoder()
const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

function make(request: Request, resolve: Resolve = async () => [PUBLIC_V4]) {
  const deps = { resolve: vi.fn(resolve), request: vi.fn(request) }
  return { deps, transport: createMcpTransport(deps) }
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function sse(chunks: string[], close = true, onCancel?: () => void): Response {
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!))
      else if (close) controller.close()
    },
    ...(onCancel ? { cancel: onCancel } : {})
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

afterEach(() => vi.useRealTimers())

describe('mcp transport URL and DNS gate', () => {
  it.each([
    'http://mcp.example/mcp',
    'https://mcp.example:8443/mcp',
    'https://mcp.example:80/mcp',
    'https://user:pass@mcp.example/mcp',
    'https://localhost/mcp',
    'https://printer.local/mcp',
    'https://127.0.0.1/mcp',
    'https://[::1]/mcp',
    'file:///tmp/mcp'
  ])('rejects %s before any DNS or socket work', async (raw) => {
    const { deps, transport } = make(async () => {
      throw Error('must not connect')
    })
    expect(await transport.post(raw, '{}')).toEqual({ ok: false, error: 'MCP_INVALID_URL' })
    expect(deps.resolve).not.toHaveBeenCalled()
    expect(deps.request).not.toHaveBeenCalled()
  })

  it('rejects name answers that include a private address, and pins the first public answer', async () => {
    const privateAnswer = make(async () => json({ ok: true }), async () => [{ address: '10.0.0.7', family: 4 }])
    expect(await privateAnswer.transport.post(ENDPOINT, '{}')).toEqual({ ok: false, error: 'MCP_INVALID_URL' })
    expect(privateAnswer.deps.request).not.toHaveBeenCalled()

    const mixed = make(async () => json({ ok: true }), async () => [PUBLIC_V4, { address: '127.0.0.1', family: 4 }])
    expect(await mixed.transport.post(ENDPOINT, '{}')).toEqual({ ok: false, error: 'MCP_INVALID_URL' })
    expect(mixed.deps.request).not.toHaveBeenCalled()

    const pinned = make(async () => json({ ok: true }), async () => [PUBLIC_V6, PUBLIC_V4])
    expect((await pinned.transport.post(ENDPOINT, '{}')).ok).toBe(true)
    expect(pinned.deps.request.mock.calls[0]![1]).toEqual(PUBLIC_V6)
    expect(pinned.deps.resolve).toHaveBeenCalledWith('mcp.example')
  })

  it('maps DNS and socket failures to MCP_CONNECT_FAILED', async () => {
    const dns = make(async () => json({ ok: true }), async () => { throw Error('EAI_AGAIN') })
    expect(await dns.transport.post(ENDPOINT, '{}')).toEqual({ ok: false, error: 'MCP_CONNECT_FAILED' })
    expect(dns.deps.request).not.toHaveBeenCalled()

    const socket = make(async () => { throw Error('ECONNRESET') })
    expect(await socket.transport.post(ENDPOINT, '{}')).toEqual({ ok: false, error: 'MCP_CONNECT_FAILED' })
  })

  it('sends one POST with the contract headers, caller headers and the exact body', async () => {
    const { deps, transport } = make(async () => json({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'Mcp-Session-Id': 'session-1' }))
    const body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
    const result = await transport.post(ENDPOINT, body, { headers: TOKEN_HEADERS, expectId: 1 })
    expect(result).toEqual({
      ok: true,
      message: { jsonrpc: '2.0', id: 1, result: {} },
      sessionId: 'session-1',
      status: 200
    })
    expect(deps.request).toHaveBeenCalledTimes(1)
    expect(deps.request).toHaveBeenCalledWith(
      new URL(ENDPOINT),
      PUBLIC_V4,
      expect.any(AbortSignal),
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'accept-encoding': 'identity',
        authorization: 'Bearer device-token',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'session-1'
      },
      { method: 'POST', body }
    )
  })

  it('does not follow redirects and maps status classes to fixed codes', async () => {
    const redirect = make(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/mcp' } }))
    expect(await redirect.transport.post(ENDPOINT, '{}')).toEqual({ ok: false, error: 'MCP_CONNECT_FAILED' })
    expect(redirect.deps.request).toHaveBeenCalledTimes(1)
    expect(redirect.deps.resolve).toHaveBeenCalledTimes(1)

    for (const [status, error] of [[401, 'MCP_UNAUTHORIZED'], [403, 'MCP_UNAUTHORIZED'], [429, 'MCP_CONNECT_FAILED'], [500, 'MCP_CONNECT_FAILED'], [503, 'MCP_CONNECT_FAILED'], [400, 'MCP_PROTOCOL'], [404, 'MCP_PROTOCOL'], [405, 'MCP_PROTOCOL']] as const) {
      const { transport } = make(async () => new Response(null, { status }))
      expect(await transport.post(ENDPOINT, '{}'), `status ${status}`).toEqual({ ok: false, error })
    }
  })

  it('parses application/json only when the expected id matches', async () => {
    const match = make(async () => json({ jsonrpc: '2.0', id: 7, result: { tools: [] } }))
    expect(await match.transport.post(ENDPOINT, '{}', { expectId: 7 })).toMatchObject({ ok: true, message: { result: { tools: [] } }, status: 200 })

    const mismatch = make(async () => json({ jsonrpc: '2.0', id: 8, result: {} }))
    expect(await mismatch.transport.post(ENDPOINT, '{}', { expectId: 7 })).toEqual({ ok: false, error: 'MCP_PROTOCOL' })

    const missingId = make(async () => json({ jsonrpc: '2.0', result: {} }))
    expect(await missingId.transport.post(ENDPOINT, '{}', { expectId: 7 })).toEqual({ ok: false, error: 'MCP_PROTOCOL' })
  })

  it('returns the message for a notification or a null message for 202 / empty bodies', async () => {
    const notification = { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } }
    const jsonNote = make(async () => json(notification))
    expect(await jsonNote.transport.post(ENDPOINT, '{}', { expectId: null })).toMatchObject({ ok: true, message: notification, status: 200 })

    const accepted = make(async () => new Response(null, { status: 202 }))
    expect(await accepted.transport.post(ENDPOINT, '{}', { expectId: null })).toEqual({ ok: true, message: null, status: 202 })

    const emptyJson = make(async () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }))
    expect(await emptyJson.transport.post(ENDPOINT, '{}', { expectId: null })).toEqual({ ok: true, message: null, status: 200 })

    const unexpectedEmpty = make(async () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }))
    expect(await unexpectedEmpty.transport.post(ENDPOINT, '{}', { expectId: 3 })).toEqual({ ok: false, error: 'MCP_PROTOCOL' })
  })

  it('maps malformed JSON and unknown content types to MCP_PROTOCOL', async () => {
    const broken = make(async () => new Response('{nope', { status: 200, headers: { 'content-type': 'application/json' } }))
    expect(await broken.transport.post(ENDPOINT, '{}')).toEqual({ ok: false, error: 'MCP_PROTOCOL' })

    const scalar = make(async () => json(42))
    expect(await scalar.transport.post(ENDPOINT, '{}')).toEqual({ ok: false, error: 'MCP_PROTOCOL' })

    const text = make(async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }))
    expect(await text.transport.post(ENDPOINT, '{}')).toEqual({ ok: false, error: 'MCP_PROTOCOL' })

    const gzip = make(async () => json({ ok: true }, 200, { 'content-encoding': 'gzip' }))
    expect(await gzip.transport.post(ENDPOINT, '{}')).toEqual({ ok: false, error: 'MCP_PROTOCOL' })
  })

  it('never lets a non-Error stream failure escape the public result', async () => {
    const body = new ReadableStream<Uint8Array>({ pull() { throw 'stream exploded' } })
    const { transport } = make(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
    expect(await transport.post(ENDPOINT, '{}', { expectId: 1 })).toEqual({ ok: false, error: 'MCP_CONNECT_FAILED' })
  })

  it('bounds declared and streamed bodies by maxBytes', async () => {
    const declared = make(async () => new Response('x', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '99' } }))
    expect(await declared.transport.post(ENDPOINT, '{}', { maxBytes: 8 })).toEqual({ ok: false, error: 'MCP_TOO_LARGE' })

    const streamed = make(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('{"a":')); controller.enqueue(encoder.encode('1234567890}')); controller.close() }
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    expect(await streamed.transport.post(ENDPOINT, '{}', { maxBytes: 8 })).toEqual({ ok: false, error: 'MCP_TOO_LARGE' })

    const exact = make(async () => new Response('12345678', { status: 200, headers: { 'content-type': 'application/json' } }))
    expect(await exact.transport.post(ENDPOINT, '{}', { maxBytes: 8, expectId: null })).toEqual({ ok: false, error: 'MCP_PROTOCOL' })
  })
})

describe('mcp transport SSE', () => {
  it('reads multiple frames, dispatches on blank lines and stops at the matching id', async () => {
    const body = sse([
      frame({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }),
      'event: message\r\nid: 1\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":7,"result":{"ok":true}}\r\n\r\n',
      'data: {this would fail if parsed}\n\n'
    ])
    const { transport } = make(async () => body)
    const result = await transport.post(ENDPOINT, '{}', { expectId: 7 })
    expect(result).toEqual({
      ok: true,
      message: { jsonrpc: '2.0', id: 7, result: { ok: true } },
      status: 200
    })
  })

  it('stops reading a never-ending stream as soon as the response frame arrives', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame({ jsonrpc: '2.0', method: 'notifications/message' })))
        controller.enqueue(encoder.encode(`${frame({ jsonrpc: '2.0', id: 9, result: { done: true } })}data: {broken\n\n`))
        // 故意不 close：等 done 的实现会挂起，早停的实现应立刻返回。
      },
      cancel() { cancelled = true }
    })
    const { transport } = make(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const result = await transport.post(ENDPOINT, '{}', { expectId: 9 })
    expect(result).toMatchObject({ ok: true, message: { id: 9, result: { done: true } } })
    expect(cancelled).toBe(true)
  })

  it('returns the first frame for a notification (expectId null) and skips comments', async () => {
    const notification = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }
    const body = sse([': keep-alive\n\n', 'event: message\n', `${frame(notification)}data: {broken\n\n`])
    const { transport } = make(async () => body)
    expect(await transport.post(ENDPOINT, '{}', { expectId: null })).toEqual({ ok: true, message: notification, status: 200 })
  })

  it('returns null for an empty SSE body only when a notification was expected', async () => {
    const note = make(async () => sse([]))
    expect(await note.transport.post(ENDPOINT, '{}', { expectId: null })).toEqual({ ok: true, message: null, status: 200 })

    const request = make(async () => sse([]))
    expect(await request.transport.post(ENDPOINT, '{}', { expectId: 4 })).toEqual({ ok: false, error: 'MCP_PROTOCOL' })
  })

  it('reports bad frame JSON, oversized frames and a missing response', async () => {
    const broken = make(async () => sse(['data: {broken\n\n']))
    expect(await broken.transport.post(ENDPOINT, '{}', { expectId: 1 })).toEqual({ ok: false, error: 'MCP_PROTOCOL' })

    const oversized = make(async () => sse([`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: 'x'.repeat(64) } })}\n\n`]))
    expect(await oversized.transport.post(ENDPOINT, '{}', { expectId: 1, maxBytes: 32 })).toEqual({ ok: false, error: 'MCP_TOO_LARGE' })

    const missing = make(async () => sse([frame({ jsonrpc: '2.0', method: 'notifications/progress' })]))
    expect(await missing.transport.post(ENDPOINT, '{}', { expectId: 1 })).toEqual({ ok: false, error: 'MCP_PROTOCOL' })
  })
})

describe('mcp transport cancellation and deadline', () => {
  it('maps the internal deadline to MCP_TIMEOUT and aborts the pinned request signal', async () => {
    vi.useFakeTimers()
    let seenSignal: AbortSignal | undefined
    const { deps, transport } = make((_url, _address, signal) => { seenSignal = signal; return new Promise<Response>(() => {}) })
    const pending = transport.post(ENDPOINT, '{}', { expectId: 1, timeoutMs: 5_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toEqual({ ok: false, error: 'MCP_TIMEOUT' })
    expect(deps.request).toHaveBeenCalledTimes(1)
    expect(seenSignal?.aborted).toBe(true)
  })

  it('maps a caller abort to MCP_CANCELLED, including while a body read is pending', async () => {
    const controller = new AbortController()
    const pending = make(() => new Promise<Response>(() => {}))
    const promise = pending.transport.post(ENDPOINT, '{}', { signal: controller.signal, expectId: 1 })
    await vi.waitFor(() => expect(pending.deps.request).toHaveBeenCalled())
    controller.abort()
    expect(await promise).toEqual({ ok: false, error: 'MCP_CANCELLED' })

    const reading = new AbortController()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; if (pulls === 1) controller.enqueue(encoder.encode('data: {"jsonrpc":"2.0"}\n\n')) } })
    const streaming = make(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const read = streaming.transport.post(ENDPOINT, '{}', { signal: reading.signal, expectId: 2 })
    await vi.waitFor(() => expect(pulls).toBeGreaterThan(0))
    reading.abort()
    expect(await read).toEqual({ ok: false, error: 'MCP_CANCELLED' })
  })

  it('does not call resolve or request when the caller signal is already aborted', async () => {
    const { deps, transport } = make(async () => json({ ok: true }))
    const controller = new AbortController()
    controller.abort()
    expect(await transport.post(ENDPOINT, '{}', { signal: controller.signal })).toEqual({ ok: false, error: 'MCP_CANCELLED' })
    expect(deps.resolve).not.toHaveBeenCalled()
    expect(deps.request).not.toHaveBeenCalled()
  })

  it('gives the caller signal priority over the internal deadline', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { transport } = make(() => new Promise<Response>(() => {}))
    const promise = transport.post(ENDPOINT, '{}', { signal: controller.signal, expectId: 1, timeoutMs: 1_000 })
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0))
    controller.abort()
    vi.advanceTimersByTime(1_001)
    expect(await promise).toEqual({ ok: false, error: 'MCP_CANCELLED' })
  })
})
