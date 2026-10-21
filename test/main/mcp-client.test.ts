import { describe, expect, it, vi } from 'vitest'
import { createMcpClient, type McpClient } from '../../src/main/mcp-client.ts'
import type { McpPostOptions, McpTransport, McpTransportResult } from '../../src/main/mcp-transport.ts'

/**
 * B2 客户端：假 transport 记录每次 `post`，不碰网络。
 * 覆盖握手顺序与头、tools/list 校验、tools/call 文本与错误映射、会话失效重连与 close。
 */

const ENDPOINT = 'https://mcp.example/mcp'
const TOKEN = 'super-secret-token'
const SIGNAL = new AbortController().signal
const TOOLS = [
  { name: 'read', title: 'Read', description: 'read a page', inputSchema: { type: 'object' } },
  { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }
]

type Handler = (message: Record<string, unknown>, call: number, options?: McpPostOptions) => McpTransportResult | Promise<McpTransportResult>
type Recorded = { url: string; body: string; options?: McpPostOptions }

function fakeTransport(handler: Handler) {
  const calls: Recorded[] = []
  const post = vi.fn(async (url: string, body: string, options?: McpPostOptions): Promise<McpTransportResult> => {
    calls.push({ url, body, options })
    return await handler(JSON.parse(body) as Record<string, unknown>, calls.length, options)
  })
  return { transport: { post }, calls }
}

const ok = (message: unknown, sessionId?: string): McpTransportResult =>
  ({ ok: true, message, ...(sessionId ? { sessionId } : {}), status: 200 })
const accepted: McpTransportResult = { ok: true, message: null, status: 202 }
const failure = (error: Extract<McpTransportResult, { ok: false }>['error']): McpTransportResult => ({ ok: false, error })

const initReply = (message: Record<string, unknown>, version = '2025-06-18', sessionId = 'session-1'): McpTransportResult =>
  ok({ jsonrpc: '2.0', id: message.id, protocolVersion: version, capabilities: {}, serverInfo: { name: 'test', version: '1.0' } }, sessionId)

const toolList = (message: Record<string, unknown>, tools: unknown[] = TOOLS): McpTransportResult =>
  ok({ jsonrpc: '2.0', id: message.id, tools })

function handshake(overrides: { tools?: unknown[]; version?: string; onCall?: Handler } = {}) {
  return fakeTransport((message, call) => {
    if (message.method === 'initialize') return initReply(message, overrides.version)
    if (message.method === 'notifications/initialized') return accepted
    if (message.method === 'tools/list') return toolList(message, overrides.tools)
    if (message.method === 'tools/call' && overrides.onCall) return overrides.onCall(message, call)
    return failure('MCP_PROTOCOL')
  })
}

const parse = (call: Recorded): Record<string, unknown> => JSON.parse(call.body) as Record<string, unknown>

/** 运行期失败必须是标准 Error，且 message 恰为码（宿主按 error.message 取码）。 */
async function expectFailure(promise: Promise<unknown>, code: string): Promise<Error> {
  const error = await promise.then(() => 'resolved', (reason: unknown) => reason)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(code)
  return error as Error
}

function client(transport: McpTransport): McpClient {
  return createMcpClient({ url: ENDPOINT, token: TOKEN, transport })
}

describe('mcp client handshake', () => {
  it('performs initialize, initialized notification and tools/list in order with the contract headers', async () => {
    const { transport, calls } = handshake()
    const mcp = client(transport)
    expect(mcp.serverHost).toBe('mcp.example')
    const connected = await mcp.connect(SIGNAL)
    expect(connected.protocolVersion).toBe('2025-06-18')
    expect(connected.tools).toEqual([
      { name: 'read', title: 'Read', description: 'read a page', inputSchema: { type: 'object' } },
      { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }
    ])
    expect(calls.map((call) => parse(call).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(calls.every((call) => call.url === ENDPOINT)).toBe(true)

    expect(parse(calls[0]!)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'rgent', version: '0.1.0' }
      }
    })
    expect(calls[0]!.options?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      'mcp-protocol-version': '2025-06-18'
    })
    expect(calls[0]!.options?.headers).not.toHaveProperty('mcp-session-id')
    expect(calls[0]!.options?.expectId).toBe(1)

    expect(parse(calls[1]!)).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(calls[1]!.options?.expectId).toBeNull()
    expect(calls[1]!.options?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      'mcp-protocol-version': '2025-06-18',
      'mcp-session-id': 'session-1'
    })

    expect(parse(calls[2]!)).toMatchObject({ jsonrpc: '2.0', method: 'tools/list', params: {} })
    expect(calls[2]!.options?.headers).toMatchObject({ 'mcp-session-id': 'session-1' })
  })

  it('omits the authorization header when the token is empty (public read-only server)', async () => {
    const { transport, calls } = handshake({
      onCall: (message) => ok({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'public' }] } })
    })
    const mcp = createMcpClient({ url: ENDPOINT, token: '', transport })
    expect((await mcp.connect(SIGNAL)).tools.map((tool) => tool.name)).toEqual(['read', 'search'])
    expect(await mcp.call('read', {}, SIGNAL)).toMatchObject({ text: 'public' })
    expect(calls).toHaveLength(4)
    for (const call of calls) {
      // 空 token 不能发 `Bearer `（有些服务器会把它当成非法认证头）。
      expect(call.options?.headers).not.toHaveProperty('authorization')
      expect(call.options?.headers?.['mcp-protocol-version']).toBeTypeOf('string')
    }
    expect(calls[0]!.options?.headers).toEqual({ 'mcp-protocol-version': '2025-06-18' })
    expect(calls[3]!.options?.headers).toMatchObject({ 'mcp-session-id': 'session-1' })
  })

  it('uses the negotiated protocol version and session on every later request', async () => {
    const { transport, calls } = handshake({
      version: '2024-11-05',
      onCall: (message) => ok({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'hi' }] } })
    })
    const mcp = client(transport)
    expect((await mcp.connect(SIGNAL)).protocolVersion).toBe('2024-11-05')
    await mcp.call('read', { url: 'https://example.com' }, SIGNAL)
    expect(calls[1]!.options?.headers?.['mcp-protocol-version']).toBe('2024-11-05')
    expect(calls[2]!.options?.headers?.['mcp-protocol-version']).toBe('2024-11-05')
    expect(calls[3]!.options?.headers?.['mcp-protocol-version']).toBe('2024-11-05')
    expect(calls[3]!.options?.headers?.['mcp-session-id']).toBe('session-1')
    expect(parse(calls[3]!)).toMatchObject({ method: 'tools/call', params: { name: 'read', arguments: { url: 'https://example.com' } } })
  })

  it('validates and de-duplicates tools while keeping inputSchema by reference', async () => {
    const schema = { type: 'object', required: ['q'] }
    const { transport } = handshake({
      tools: [
        { name: 'same', description: 'first' },
        { name: 'same', description: 'second' },
        { name: '' },
        { name: 'x'.repeat(129) },
        { name: 'keep', inputSchema: schema, title: 'Keep', description: 'kept' },
        { name: 'ignored', title: 42, description: 42 },
        'not-an-object'
      ]
    })
    const connected = await client(transport).connect(SIGNAL)
    expect(connected.tools.map((tool) => tool.name)).toEqual(['same', 'keep', 'ignored'])
    expect(connected.tools[0]!.description).toBe('first')
    expect(connected.tools[1]!.inputSchema).toBe(schema)
    expect(connected.tools[1]!.title).toBe('Keep')
    expect(connected.tools[1]!.description).toBe('kept')
    expect(connected.tools[2]).toEqual({ name: 'ignored' })
  })

  it('rejects malformed handshake messages with MCP_PROTOCOL', async () => {
    const noVersion = fakeTransport((message) => {
      if (message.method === 'initialize') return ok({ jsonrpc: '2.0', id: message.id })
      if (message.method === 'notifications/initialized') return accepted
      return toolList(message)
    })
    await expectFailure(client(noVersion.transport).connect(SIGNAL), 'MCP_PROTOCOL')

    const noTools = fakeTransport((message) => {
      if (message.method === 'initialize') return initReply(message)
      if (message.method === 'notifications/initialized') return accepted
      return ok({ jsonrpc: '2.0', id: message.id, tools: 'nope' })
    })
    await expectFailure(client(noTools.transport).connect(SIGNAL), 'MCP_PROTOCOL')
  })
})

describe('mcp client tools/call', () => {
  it('joins text content with blank lines and carries isError', async () => {
    const { transport, calls } = handshake({
      onCall: (message) => ok({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            { type: 'text', text: 'line one' },
            { type: 'image', data: 'AAAA' },
            { type: 'text', text: 'line two' }
          ],
          isError: false
        }
      })
    })
    const mcp = client(transport)
    await mcp.connect(SIGNAL)
    const result = await mcp.call('read', { q: 'x' }, SIGNAL)
    expect(result).toEqual({ text: 'line one\n\nline two', bytes: Buffer.byteLength('line one\n\nline two', 'utf8'), isError: false })
    expect(parse(calls[3]!)).toMatchObject({ method: 'tools/call', params: { name: 'read', arguments: { q: 'x' } } })
  })

  it('reports isError only when result.isError is exactly true', async () => {
    const handler = (flag: unknown): Handler => (message) => ok({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'failed' }], isError: flag }
    })
    for (const [flag, expected] of [[true, true], [false, false], ['true', false], [undefined, false]] as const) {
      const { transport } = handshake({ onCall: handler(flag) })
      const result = await client(transport).call('read', {}, SIGNAL)
      expect(result.isError, String(flag)).toBe(expected)
    }
  })

  it('truncates text past 64 KiB without splitting a UTF-8 character', async () => {
    const ascii = 'a'.repeat(70_000)
    const asciiTransport = handshake({ onCall: (message) => ok({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: ascii }] } }) })
    const cut = await client(asciiTransport.transport).call('read', {}, SIGNAL)
    expect(cut).toEqual({ text: 'a'.repeat(64 * 1024), bytes: 70_000, isError: false, truncated: true })

    const wide = '汉'.repeat(30_000)
    const wideTransport = handshake({ onCall: (message) => ok({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: wide }] } }) })
    const wideCut = await client(wideTransport.transport).call('read', {}, SIGNAL)
    expect(wideCut.truncated).toBe(true)
    expect(wideCut.text.endsWith('汉')).toBe(true)
    expect(wideCut.text.includes('\uFFFD')).toBe(false)
    expect(wideCut.bytes).toBe(Buffer.byteLength(wide, 'utf8'))
    expect(wideCut.bytes).toBeGreaterThan(64 * 1024)
    expect(Buffer.byteLength(wideCut.text, 'utf8')).toBeLessThanOrEqual(64 * 1024)
  })

  it('maps transport errors verbatim and JSON-RPC errors to a fixed code', async () => {
    const transportFailure = fakeTransport(() => failure('MCP_TIMEOUT'))
    await expectFailure(client(transportFailure.transport).call('read', {}, SIGNAL), 'MCP_TIMEOUT')
    await expectFailure(client(transportFailure.transport).connect(SIGNAL), 'MCP_TIMEOUT')

    const jsonRpcError = handshake({
      onCall: (message) => ok({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: `server said ${TOKEN} and secret details`, data: { token: TOKEN } }
      })
    })
    const error = await expectFailure(client(jsonRpcError.transport).call('read', {}, SIGNAL), 'MCP_TOOL_FAILED')
    expect(String(error)).not.toContain(TOKEN)
    expect(String(error)).not.toContain('secret details')

    const missingResult = handshake({ onCall: (message) => ok({ jsonrpc: '2.0', id: message.id }) })
    await expectFailure(client(missingResult.transport).call('read', {}, SIGNAL), 'MCP_PROTOCOL')
  })
})

describe('mcp client session expiry and close', () => {
  it('reconnects once on MCP_PROTOCOL and retries the failed request exactly once', async () => {
    let initializeCount = 0
    let calls = 0
    const { transport, calls: recorded } = fakeTransport((message) => {
      if (message.method === 'initialize') { initializeCount += 1; return initReply(message, '2025-06-18', `session-${initializeCount}`) }
      if (message.method === 'notifications/initialized') return accepted
      if (message.method === 'tools/list') return toolList(message)
      calls += 1
      if (calls === 1) return failure('MCP_PROTOCOL')
      return ok({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'after reconnect' }] } })
    })
    const mcp = client(transport)
    await mcp.connect(SIGNAL)
    expect(await mcp.call('read', {}, SIGNAL)).toEqual({ text: 'after reconnect', bytes: 15, isError: false })
    expect(initializeCount).toBe(2)
    expect(recorded.map((call) => parse(call).method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/list',
      'tools/call', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call'
    ])
    expect(recorded[4]!.options?.headers).not.toHaveProperty('mcp-session-id')
    expect(recorded[5]!.options?.headers?.['mcp-session-id']).toBe('session-2')
    expect(recorded[6]!.options?.headers?.['mcp-session-id']).toBe('session-2')
    expect(recorded[7]!.options?.headers?.['mcp-session-id']).toBe('session-2')
  })

  it('only reconnects once per client and returns the original error when the retry fails', async () => {
    let initializeCount = 0
    let toolCalls = 0
    const { transport } = fakeTransport((message) => {
      if (message.method === 'initialize') { initializeCount += 1; return initReply(message, '2025-06-18', `session-${initializeCount}`) }
      if (message.method === 'notifications/initialized') return accepted
      if (message.method === 'tools/list') return toolList(message)
      toolCalls += 1
      return failure('MCP_PROTOCOL')
    })
    const mcp = client(transport)
    await mcp.connect(SIGNAL)
    await expectFailure(mcp.call('read', {}, SIGNAL), 'MCP_PROTOCOL')
    expect(initializeCount).toBe(2)
    expect(toolCalls).toBe(2)

    await expectFailure(mcp.call('read', {}, SIGNAL), 'MCP_PROTOCOL')
    expect(initializeCount).toBe(2)
    expect(toolCalls).toBe(3)
  })

  it('returns the original protocol error when the reconnect handshake itself fails', async () => {
    let initializeCount = 0
    const { transport } = fakeTransport((message) => {
      if (message.method === 'initialize') {
        initializeCount += 1
        return initializeCount === 1 ? initReply(message) : failure('MCP_UNAUTHORIZED')
      }
      if (message.method === 'notifications/initialized') return accepted
      if (message.method === 'tools/list') return toolList(message)
      return failure('MCP_PROTOCOL')
    })
    const mcp = client(transport)
    await mcp.connect(SIGNAL)
    await expectFailure(mcp.call('read', {}, SIGNAL), 'MCP_PROTOCOL')
    expect(initializeCount).toBe(2)
  })

  it('never puts the token into transport errors or local validation errors', async () => {
    const { transport } = fakeTransport((message) => {
      if (message.method === 'initialize') return initReply(message)
      if (message.method === 'notifications/initialized') return accepted
      if (message.method === 'tools/list') return ok({ jsonrpc: '2.0', id: message.id, tools: [{ name: 'read' }] })
      return ok({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: TOKEN }] } })
    })
    const mcp = client(transport)
    await mcp.connect(SIGNAL)
    // 结果正文里出现 token 不是错误消息；只证明抛出的错误不含它。
    for (const attempt of [() => mcp.call('read', {}, SIGNAL), () => mcp.connect(SIGNAL)]) {
      const outcome = await attempt()
      expect(JSON.stringify(outcome)).not.toContain('Bearer')
    }
    const connectError = await expectFailure(client(fakeTransport(() => failure('MCP_CONNECT_FAILED')).transport).connect(SIGNAL), 'MCP_CONNECT_FAILED')
    const callError = await expectFailure(client(fakeTransport(() => failure('MCP_UNAUTHORIZED')).transport).call('read', {}, SIGNAL), 'MCP_UNAUTHORIZED')
    for (const error of [connectError, callError]) {
      expect(String(error)).not.toContain(TOKEN)
      expect(error.message).not.toContain(TOKEN)
    }
  })

  it('turns a concurrent transport failure into MCP_CANCELLED when the caller already aborted', async () => {
    const controller = new AbortController()
    const transport = {
      post: vi.fn(async (_url: string, _body: string, options?: McpPostOptions) => {
        await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
        return failure('MCP_TIMEOUT')
      })
    }
    const pending = client(transport).connect(controller.signal)
    await vi.waitFor(() => expect(transport.post).toHaveBeenCalled())
    controller.abort()
    await expectFailure(pending, 'MCP_CANCELLED')
  })

  it('folds transport exceptions into Error("MCP_CONNECT_FAILED") without leaking their text', async () => {
    const transport = { post: vi.fn(async () => { throw new Error(`socket exploded with ${TOKEN}`) }) }
    const error = await expectFailure(client(transport).call('read', {}, SIGNAL), 'MCP_CONNECT_FAILED')
    expect(String(error)).not.toContain(TOKEN)
    expect(error.message).toBe('MCP_CONNECT_FAILED')
  })

  it('keeps MCP_CANCELLED first when the caller aborts during auto reconnect', async () => {
    const controller = new AbortController()
    let initializeCount = 0
    const { transport } = fakeTransport(async (message, _call, options) => {
      if (message.method === 'initialize') {
        initializeCount += 1
        if (initializeCount === 1) return initReply(message)
        await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
        return failure('MCP_CANCELLED')
      }
      if (message.method === 'notifications/initialized') return accepted
      if (message.method === 'tools/list') return toolList(message)
      return failure('MCP_PROTOCOL')
    })
    const mcp = client(transport)
    await mcp.connect(SIGNAL)
    const pending = mcp.call('read', {}, controller.signal)
    await vi.waitFor(() => expect(initializeCount).toBe(2))
    controller.abort()
    await expectFailure(pending, 'MCP_CANCELLED')
  })

  it('makes close local-only: later calls fail with MCP_CANCELLED and send no request', async () => {
    const { transport, calls } = handshake({
      onCall: (message) => ok({ jsonrpc: '2.0', id: message.id, result: { content: [] } })
    })
    const mcp = client(transport)
    await mcp.connect(SIGNAL)
    const before = calls.length
    mcp.close()
    await expectFailure(mcp.call('read', {}, SIGNAL), 'MCP_CANCELLED')
    await expectFailure(mcp.connect(SIGNAL), 'MCP_CANCELLED')
    expect(calls).toHaveLength(before)
  })
})
