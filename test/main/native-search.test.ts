import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'
import { AgentHost } from '../../src/main/agent-host.ts'
import { probeNativeSearch, streamNativeSearchStep, supportsNativeSearch, type NativeSearchStepInput } from '../../src/main/native-search.ts'
import type { ModelStepInput } from '../../src/main/model-stream.ts'
import type { ModelCredential } from '../../src/main/model-config.ts'
import { createScopedAgentTools } from '../../src/main/scoped-agent-tools.ts'
import type { TaskGrant } from '../../src/main/task-authorization.ts'
import { hostLedgerFixture } from './host-ledger-fixture.ts'
import { draftBody, draftRequest } from './draft-fixture.ts'

afterEach(() => { vi.restoreAllMocks() })

const tickInput = (over: Partial<ModelStepInput> = {}): ModelStepInput => ({
  baseURL: 'https://api.minimax.cn/v1',
  modelId: 'MiniMax-M3.1',
  apiKey: 'fixture-key',
  messages: [{ role: 'user', content: '你好' }],
  signal: new AbortController().signal,
  ...over
})

const sse = (events: unknown[]): string => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

type FetchCall = { url: string; init: RequestInit }
function mockFetch(response: () => Response, calls: FetchCall[] = []): FetchCall[] {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} })
    return response()
  })
  return calls
}

async function collect(input: NativeSearchStepInput, signal?: AbortSignal): Promise<import('../../src/main/model-stream.ts').ModelStepEvent[]> {
  const events: import('../../src/main/model-stream.ts').ModelStepEvent[] = []
  for await (const event of streamNativeSearchStep(input, signal ?? input.signal)) events.push(event)
  return events
}

describe('模型自带联网 allowlist', () => {
  it('只允许 MiniMax 的 M3／M3.1 系列', () => {
    for (const modelId of ['MiniMax-M3', 'MiniMax-M3.1', 'MiniMax-M3.5', 'minimax-m3.1', 'MiniMax-M3-2026']) {
      expect(supportsNativeSearch('minimax', modelId)).toBe(true)
    }
    for (const modelId of ['MiniMax-M2.7', 'MiniMax-M30', 'MiniMax-M4', 'MiniMax-M3x', 'deepseek-flash', '']) {
      expect(supportsNativeSearch('minimax', modelId)).toBe(false)
    }
    expect(supportsNativeSearch('deepseek', 'MiniMax-M3.1')).toBe(false)
    expect(supportsNativeSearch('custom', 'MiniMax-M3.1')).toBe(false)
  })
})

describe('Responses 适配器请求形状', () => {
  it('把 system／user／assistant／tool 映射成 instructions 与 input，并追加 web_search', async () => {
    const calls = mockFetch(() => new Response(sse([
      { type: 'response.output_text.delta', delta: '答' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const messages: ModelMessage[] = [
      { role: 'user', content: '旧问题' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '旧答' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'fetch_url', input: { url: 'https://example.com' } }
        ]
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'fetch_url', output: { type: 'text', value: '页面正文' } }]
      },
      { role: 'user', content: '新问题' }
    ]
    const events = await collect(tickInput({
      system: '只读规则',
      messages,
      tools: { fetch_url: { description: '抓页', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } } },
      maxOutputTokens: 512
    }))
    expect(events.map(event => event.type)).toEqual(['text', 'finish'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.minimax.cn/v1/responses')
    expect(calls[0]!.init.redirect).toBe('error')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer fixture-key')
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.model).toBe('MiniMax-M3.1')
    expect(body.stream).toBe(true)
    expect(body.max_output_tokens).toBe(512)
    expect(body.instructions).toBe('只读规则')
    expect(body.input).toEqual([
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧答' },
      { type: 'function_call', call_id: 'call-1', name: 'fetch_url', arguments: '{"url":"https://example.com"}' },
      { type: 'function_call_output', call_id: 'call-1', output: '页面正文' },
      { role: 'user', content: '新问题' }
    ])
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'fetch_url',
        description: '抓页',
        parameters: { type: 'object', properties: { url: { type: 'string' } } }
      },
      { type: 'web_search' }
    ])
  })

  it('兼容本地测试端点，但拒绝不合法地址与无法序列化的工具参数', async () => {
    mockFetch(() => new Response(sse([{ type: 'response.completed', response: {} }]), { status: 200 }))
    await collect(tickInput({ baseURL: 'http://127.0.0.1:1234/v1' }))
    await expect(collect(tickInput({ baseURL: 'http://example.com/v1' }))).rejects.toThrow('MODEL_REQUEST_FAILED')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(collect(tickInput({ messages: [{ role: 'user', content: [{ type: 'image', image: 'x' }] } as never] })))
      .rejects.toThrow('MODEL_PROTOCOL_ERROR')
    await expect(collect(tickInput({ tools: { bad: { description: '循环', inputSchema: circular as never } } })))
      .rejects.toThrow('MODEL_PROTOCOL_ERROR')
  })
})

describe('Responses SSE 事件映射', () => {
  it('分别产出正文与推理，completed 带 usage 与 stop', async () => {
    mockFetch(() => new Response(sse([
      { type: 'response.reasoning_text.delta', delta: '想一想' },
      { type: 'response.output_text.delta', delta: '你' },
      { type: 'response.output_text.delta', delta: '好' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 3 } } },
      // completed 之后迟到的事件不能追加到回答里。
      { type: 'response.output_text.delta', delta: '迟到了' }
    ]), { status: 200 }))
    expect(await collect(tickInput())).toEqual([
      { type: 'reasoning', text: '想一想' },
      { type: 'text', text: '你' },
      { type: 'text', text: '好' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 12, outputTokens: 3 } }
    ])
  })

  it('把增量 function_call 合成一次工具调用，completed 时是 tool-calls', async () => {
    const item = {
      type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'fetch_url',
      arguments: '{"url":"https://example.com"}'
    }
    mockFetch(() => new Response(sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'fetch_url', arguments: '' } },
      // 参数增量只带 item_id，靠别名认回同一条调用。
      { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"url":' },
      { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '"https://example.com"}' },
      { type: 'response.function_call_arguments.done', item_id: 'item-1', arguments: '{"url":"https://example.com"}' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { status: 'completed', output: [item] } }
    ]), { status: 200 }))
    const events = await collect(tickInput())
    expect(events.filter(event => event.type === 'tool-call')).toEqual([
      { type: 'tool-call', id: 'call-1', name: 'fetch_url', input: { url: 'https://example.com' } }
    ])
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls', usage: { inputTokens: null, outputTokens: null } })
  })

  it('参数不是 JSON 时仍交回调用，但标 invalid 且不猜参数', async () => {
    mockFetch(() => new Response(sse([
      {
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'fetch_url', arguments: '{bad' }
      },
      { type: 'response.completed', response: { status: 'completed' } }
    ]), { status: 200 }))
    expect(await collect(tickInput())).toEqual([
      { type: 'tool-call', id: 'call-1', name: 'fetch_url', input: {}, invalid: true },
      { type: 'finish', reason: 'tool-calls', usage: { inputTokens: null, outputTokens: null } }
    ])
  })

  it('web_search_call 不产出模型工具事件，只回调计数', async () => {
    const counts: number[] = []
    mockFetch(() => new Response(sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws-1', status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', id: 'ws-1', status: 'completed' } },
      { type: 'response.output_text.delta', delta: '查到了' },
      { type: 'response.completed', response: { status: 'completed' } }
    ]), { status: 200 }))
    const events = await collect({ ...tickInput(), onWebSearchCall: count => counts.push(count) })
    expect(events.some(event => event.type === 'tool-call')).toBe(false)
    expect(counts).toEqual([1])
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop', usage: { inputTokens: null, outputTokens: null } })
  })

  it('达到输出上限时把 incomplete 原因映射成 length，content_filter 同理', async () => {
    mockFetch(() => new Response(sse([
      { type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }
    ]), { status: 200 }))
    expect((await collect(tickInput())).at(-1)).toEqual({ type: 'finish', reason: 'length', usage: { inputTokens: null, outputTokens: null } })

    vi.restoreAllMocks()
    mockFetch(() => new Response(sse([
      { type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } }
    ]), { status: 200 }))
    expect((await collect(tickInput())).at(-1)).toEqual({ type: 'finish', reason: 'content-filter', usage: { inputTokens: null, outputTokens: null } })
  })

  it('忽略未知事件，只有未收到 completed 时才判协议错误', async () => {
    mockFetch(() => new Response(sse([
      { type: 'response.created', response: { id: 'x' } },
      { type: 'response.in_progress', response: { id: 'x' } }
    ]), { status: 200 }))
    await expect(collect(tickInput())).rejects.toThrow('MODEL_PROTOCOL_ERROR')

    vi.restoreAllMocks()
    mockFetch(() => new Response(sse([
      { type: 'response.created', response: { id: 'x' } },
      { type: 'response.output_text.delta', delta: '正文' },
      { type: 'response.completed', response: { status: 'completed' } }
    ]), { status: 200 }))
    expect(await collect(tickInput())).toEqual([
      { type: 'text', text: '正文' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: null, outputTokens: null } }
    ])
  })
})

describe('Responses 失败与边界', () => {
  it('response.failed 与 HTTP 非 2xx 只回固定失败码，不带上游正文或密钥', async () => {
    mockFetch(() => new Response(sse([
      { type: 'response.failed', response: { error: { message: 'upstream secret and fixture-key' } } }
    ]), { status: 200 }))
    let failed: unknown
    try { await collect(tickInput()) } catch (error) { failed = error }
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toBe('MODEL_REQUEST_FAILED')
    expect(JSON.stringify((failed as Error).cause ?? {})).not.toContain('secret')
    expect(JSON.stringify((failed as Error).cause ?? {})).not.toContain('fixture-key')

    vi.restoreAllMocks()
    mockFetch(() => new Response('upstream secret and fixture-key', { status: 503 }))
    let httpFailed: unknown
    try { await collect(tickInput()) } catch (error) { httpFailed = error }
    expect((httpFailed as Error).message).toBe('MODEL_REQUEST_FAILED')
    expect((httpFailed as Error).cause).toEqual({ httpStatus: 503 })
    expect(JSON.stringify(httpFailed)).not.toContain('secret')
    expect(JSON.stringify(httpFailed)).not.toContain('fixture-key')
  })

  it('坏 SSE JSON 判协议错误；响应体超过 1 MiB 判输出上限', async () => {
    mockFetch(() => new Response('data: {not json}\n\n', { status: 200 }))
    await expect(collect(tickInput())).rejects.toThrow('MODEL_PROTOCOL_ERROR')

    vi.restoreAllMocks()
    mockFetch(() => new Response(sse([
      { type: 'response.output_text.delta', delta: 'x'.repeat(1048577) },
      { type: 'response.completed', response: { status: 'completed' } }
    ]), { status: 200 }))
    await expect(collect(tickInput())).rejects.toThrow('MODEL_OUTPUT_LIMIT')
  })

  it('调用方取消时按取消语义中止，不把取消伪装成上游失败', async () => {
    const controller = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    const pending = collect(tickInput({ signal: controller.signal }))
    controller.abort()
    await expect(pending).rejects.toThrow('TASK_CANCELLED')
  })
})

describe('模型自带联网探测', () => {
  it('只发 ping 与 web_search，2xx 可解析即通过', async () => {
    const calls = mockFetch(() => new Response('{"id":"response-1"}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await probeNativeSearch({ baseURL: 'https://api.minimax.cn/v1', apiKey: 'fixture-key', modelId: 'MiniMax-M3.1' })
    expect(result).toEqual({ ok: true })
    expect(calls[0]!.url).toBe('https://api.minimax.cn/v1/responses')
    expect(calls[0]!.init.redirect).toBe('error')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer fixture-key')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: 'MiniMax-M3.1',
      input: 'ping',
      tools: [{ type: 'web_search' }],
      stream: false
    })
  })

  it('非 2xx、坏 JSON 与空响应都回固定码', async () => {
    const cases: (() => Response)[] = [
      () => new Response('upstream secret', { status: 401 }),
      () => new Response('data: not json', { status: 200 }),
      () => new Response(null, { status: 204 })
    ]
    for (const make of cases) {
      vi.restoreAllMocks()
      mockFetch(make)
      await expect(probeNativeSearch({ baseURL: 'https://api.minimax.cn/v1', apiKey: 'fixture-key', modelId: 'MiniMax-M3.1' }))
        .resolves.toEqual({ ok: false, error: 'NATIVE_SEARCH_UNAVAILABLE' })
    }
  })
})

describe('AgentHost 选择模型自带联网', () => {
  const originSource = () => ({
    sourceId: 'origin', relPath: 'a.md', title: 'a.md', sessionId: 's', objectVersion: 'o', revision: '1',
    fingerprint: 'f', tier: 'reference' as const, kind: 'body' as const, taskId: null, taskMaterialHash: null,
    classification: 'human' as const, start: 0, end: 2, hash: 'a'.repeat(64), basisHash: 'b'.repeat(64), sourceDeps: [], memoryDeps: []
  })

  type NativeCall = { id: string; name: string; input: unknown }
  function nativeHarness(options: {
    native?: boolean
    modelId?: string
    /** native 流每一步出什么；默认是一句文本回答。 */
    nativeSteps?: { calls?: NativeCall[]; text?: string }[]
    /** native 流挂起，等撤网 abort；用来测在途撤网。 */
    hangNative?: boolean
    /** 抓页依赖被调到时通知测试：可在这里撤网。 */
    onFetch?: () => void
  } = {}) {
    let content = '人写的段落。\n\n' + draftBody('问') + '\n'
    let revision = 1
    let networkLive = true
    const history = hostLedgerFixture()
    const nativeRequests: Parameters<NonNullable<import('../../src/main/agent-host.ts').HostDependencies['nativeStreamStep']>>[0][] = []
    const nativeSignals: AbortSignal[] = []
    const streamRequests: Parameters<NonNullable<import('../../src/main/agent-host.ts').HostDependencies['streamStep']>>[0][] = []
    const credential: ModelCredential = {
      provider: 'minimax', baseURL: 'https://api.minimax.cn/v1', modelId: options.modelId ?? 'MiniMax-M3.1',
      contextTokens: 32000, apiKey: 'fixture'
    }
    const limits = { seconds: 30, steps: 4, tools: 8 }
    const grant = {
      id: 'g', root: '/vault', sessionId: 's', origin: 'a.md', originProof: originSource(), sources: [originSource()],
      credential, limits, level: 'reference' as const, autoApproveWrites: false,
      // 动态撤网：native 是否还能用，看每一步开始时的 grant.network。
      get network() { return networkLive ? { allowed: true as const } : undefined },
      assertActive() {}, validateSources: async () => {}, acknowledgeOrigin() {}, revoke() {},
      assertNetwork() { if (!networkLive) throw Error('NETWORK_NOT_AUTHORIZED') },
      revokeNetwork() { networkLive = false },
      assertMcp() {}, revokeMcp() {},
      assertWriteTarget(path: string) { if (path !== 'a.md') throw Error('OUTSIDE_TASK_SCOPE') },
      assertLive: async () => {}
    } as unknown as TaskGrant
    const read = async () => ({ content, revision: String(revision), sessionId: 's', objectVersion: 'o' })
    const host = new AgentHost({
      ledger: history.ledger,
      root: () => '/vault',
      read,
      write: async (_path, next, expected) => {
        if (expected !== String(revision)) throw Error('CONFLICT')
        content = next
        revision += 1
        return String(revision)
      },
      tier: async () => 'reference',
      credential: () => credential,
      limits: () => limits,
      authorize: async () => grant,
      session: () => 's',
      stream: async function* () { throw Error('OLD_STREAM') },
      streamStep: async function* (input) {
        streamRequests.push(input)
        yield { type: 'text', text: '内置搜索回答' }
        yield { type: 'finish', reason: 'stop' }
      },
      nativeStreamStep: async function* (input, signal) {
        nativeRequests.push(input)
        nativeSignals.push(signal)
        if (options.hangNative) {
          // 真实适配器把调用方 signal 接到 fetch；撤网 abort 后按 AbortError 结束。
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
          })
          return
        }
        const step = options.nativeSteps?.[nativeRequests.length - 1]
        const calls = step?.calls ?? []
        for (const call of calls) yield { type: 'tool-call', ...call } as never
        if (calls.length) yield { type: 'finish', reason: 'tool-calls' }
        else {
          yield { type: 'text', text: step?.text ?? '模型自带联网回答' }
          yield { type: 'finish', reason: 'stop' }
        }
      },
      createReadOnlyTools: (granted, id, _memory, _materials, _write, network) => createScopedAgentTools(granted, id, {
        read, tier: async () => 'reference', acceptsObject: () => false, ...(network ? { network } : {})
      }),
      network: {
        fetch: async (_url: string, signal: AbortSignal) => {
          options.onFetch?.()
          await Promise.resolve()
          if (signal.aborted) throw Error('EGRESS_ABORTED')
          return { text: '页面', host: 'example.com', url: 'https://example.com', bytes: 3, truncated: false, lowTrust: true }
        },
        search: async () => ({ provider: 'brave', host: 'api.search.brave.com', results: [] }),
        availability: () => ({ available: true, search: true, providerHost: 'api.search.brave.com', native: options.native !== false })
      },
      emit: () => {}
    })
    const start = () => host.start({
      relPath: 'a.md', sessionId: 's', objectVersion: 'o', expectedRevision: '1',
      ...draftRequest(content, '问')
    })
    return { host, history, start, nativeRequests, nativeSignals, streamRequests, networkLive: () => networkLive }
  }

  it('native 生效时改用 nativeStreamStep，不宣告 search_web，保留 fetch_url', async () => {
    const app = nativeHarness()
    const task = await app.start()
    expect(await task.done).toEqual({ status: 'completed' })
    expect(app.nativeRequests).toHaveLength(1)
    expect(app.streamRequests).toHaveLength(0)
    const names = Object.keys(app.nativeRequests[0]!.tools ?? {})
    expect(names).toContain('fetch_url')
    expect(names).not.toContain('search_web')
    expect(app.nativeRequests[0]!.system.length).toBeGreaterThan(0)
    expect(app.history.records().at(-1)?.answer).toContain('模型自带联网回答')
  })

  it('总闸里的 native 关闭或模型不在允许列表时仍走内置适配器并保留 search_web', async () => {
    for (const options of [{ native: false }, { modelId: 'MiniMax-M2.7' }]) {
      const app = nativeHarness(options)
      const task = await app.start()
      expect(await task.done).toEqual({ status: 'completed' })
      expect(app.nativeRequests).toHaveLength(0)
      expect(app.streamRequests).toHaveLength(1)
      expect(Object.keys(app.streamRequests[0]!.tools ?? {})).toEqual(expect.arrayContaining(['fetch_url', 'search_web']))
    }
  })

  it('步前撤网后本步改走非 native 流，任务继续收尾', async () => {
    const app = nativeHarness({
      nativeSteps: [{ calls: [{ id: 'c1', name: 'fetch_url', input: { url: 'https://example.com/x' } }] }],
      // 第一次抓页时撤网：它发生在第 1 步工具环里，第 2 步必须已经不能再用 native。
      onFetch: () => { app.host.stopNetwork(app.host.active()[0]!.id) }
    })
    const task = await app.start()
    expect(await task.done).toEqual({ status: 'completed' })
    expect(app.networkLive()).toBe(false)
    expect(app.nativeRequests).toHaveLength(1)
    expect(app.streamRequests).toHaveLength(1)
    expect(Object.keys(app.streamRequests[0]!.tools ?? {})).not.toContain('search_web')
    expect(app.history.records().at(-1)?.status).toBe('completed')
    expect(app.host.active()).toEqual([])
  })

  it.each(['stop', 'all'] as const)('在途 native 步撤网（%s）：立即 abort，当前步 NETWORK_NOT_AUTHORIZED，不再走 native', async mode => {
    const app = nativeHarness({ hangNative: true })
    const task = await app.start()
    await vi.waitFor(() => expect(app.nativeSignals).toHaveLength(1))
    if (mode === 'stop') app.host.stopNetwork(task.id)
    else app.host.revokeNetworkForAll()
    expect(await task.done).toMatchObject({ status: 'failed', reason: 'NETWORK_NOT_AUTHORIZED' })
    expect(app.nativeSignals[0]!.aborted).toBe(true)
    expect(app.nativeRequests).toHaveLength(1)
    expect(app.streamRequests).toHaveLength(0)
    // 不自动重试、不改走另一条流：任务按现有状态收尾，没有后续模型步。
    expect(app.history.records().at(-1)).toMatchObject({ status: 'failed', reason: 'NETWORK_NOT_AUTHORIZED' })
    expect(app.host.active()).toEqual([])
  })
})
