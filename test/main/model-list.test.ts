import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchModelList, parseModelList, MODEL_LIST_LIMITS } from '../../src/main/model-list.ts'

const jsonResponse = (payload: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })

const streamResponse = (chunks: Uint8Array[], status = 200): Response =>
  new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  }), { status })

const baseURL = 'https://api.example.com/v1'

afterEach(() => { vi.useRealTimers() })

describe('model list parsing', () => {
  it('takes ids and the endpoint-reported context window, dropping duplicates and junk', () => {
    const result = parseModelList({
      object: 'list',
      data: [
        { id: 'a', context_window: 128000 },
        { id: 'a', context_window: 999 },
        { id: 'b' },
        { id: ' b ' },
        { id: 42 },
        { id: 'c', context_window: 0 },
        { id: 'd', context_window: 99999999 }
      ]
    })
    expect(result).toEqual({ models: [{ id: 'a', contextTokens: 128000 }, { id: 'b' }, { id: 'c' }, { id: 'd' }], truncated: false })
  })

  it('reports truncation instead of silently growing past the cap', () => {
    const data = Array.from({ length: MODEL_LIST_LIMITS.maxEntries + 5 }, (_value, index) => ({ id: `m${index}` }))
    const result = parseModelList({ data })
    expect(result.models).toHaveLength(MODEL_LIST_LIMITS.maxEntries)
    expect(result.truncated).toBe(true)
  })

  it('rejects payloads that are not an OpenAI-style model list', () => {
    for (const payload of [null, {}, { data: 'nope' }, 'text']) expect(() => parseModelList(payload)).toThrow('MODEL_LIST_FAILED')
  })
})

describe('reading models from a connection endpoint', () => {
  it('reads with the connection key, refuses redirects, and never needs the renderer', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const result = await fetchModelList({ baseURL, apiKey: 'key-one' }, {
      fetchImpl: async (url, init) => { seen.push({ url, init }); return jsonResponse({ data: [{ id: 'm', context_window: 4096 }] }) }
    })
    expect(result.models).toEqual([{ id: 'm', contextTokens: 4096 }])
    expect(seen[0]!.url).toBe(`${baseURL}/models`)
    expect(seen[0]!.init.method).toBe('GET')
    expect(seen[0]!.init.redirect).toBe('error')
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer key-one')
  })

  it('keeps a model without endpoint-reported capacity so a human can fill it in', async () => {
    const result = await fetchModelList({ baseURL, apiKey: 'k' }, { fetchImpl: async () => jsonResponse({ data: [{ id: 'MiniMax-M3' }] }) })
    expect(result.models).toEqual([{ id: 'MiniMax-M3' }])
  })

  it('maps endpoint answers to explicit failure codes', async () => {
    const call = (status: number, payload: unknown = {}): Promise<unknown> =>
      fetchModelList({ baseURL, apiKey: 'k' }, { fetchImpl: async () => jsonResponse(payload, status) })
    await expect(call(401)).rejects.toThrow('KEY_REJECTED')
    await expect(call(403)).rejects.toThrow('KEY_REJECTED')
    await expect(call(404)).rejects.toThrow('MODEL_LIST_UNSUPPORTED')
    await expect(call(405)).rejects.toThrow('MODEL_LIST_UNSUPPORTED')
    await expect(call(500)).rejects.toThrow('MODEL_LIST_FAILED')
    await expect(fetchModelList({ baseURL, apiKey: 'k' }, { fetchImpl: async () => new Response('not json', { status: 200 }) })).rejects.toThrow('MODEL_LIST_FAILED')
    await expect(fetchModelList({ baseURL, apiKey: 'k' }, { fetchImpl: async () => { throw new Error('offline') } })).rejects.toThrow('MODEL_LIST_FAILED')
  })

  it('bounds the response body and refuses non-HTTPS endpoints', async () => {
    await expect(fetchModelList({ baseURL, apiKey: 'k' }, {
      fetchImpl: async () => jsonResponse({ data: [] }, 200, { 'content-length': String(MODEL_LIST_LIMITS.maxBytes + 1) })
    })).rejects.toThrow('MODEL_LIST_TOO_LARGE')

    const chunk = new Uint8Array(64 * 1024)
    await expect(fetchModelList({ baseURL, apiKey: 'k' }, {
      fetchImpl: async () => streamResponse(Array.from({ length: 5 }, () => chunk))
    })).rejects.toThrow('MODEL_LIST_TOO_LARGE')

    await expect(fetchModelList({ baseURL: 'http://remote.example/v1', apiKey: 'k' }, { fetchImpl: async () => jsonResponse({ data: [] }) })).rejects.toThrow('BAD_BASE_URL')
    await expect(fetchModelList({ baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'k' }, { fetchImpl: async () => jsonResponse({ data: [{ id: 'local' }] }) })).resolves.toEqual({ models: [{ id: 'local' }], truncated: false })
  })

  it('gives up after the timeout instead of hanging on a silent endpoint', async () => {
    vi.useFakeTimers()
    const pending = fetchModelList({ baseURL, apiKey: 'k' }, {
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const settled = expect(pending).rejects.toThrow('MODEL_LIST_FAILED')
    await vi.advanceTimersByTimeAsync(MODEL_LIST_LIMITS.timeoutMs + 1)
    await settled
  })
})
