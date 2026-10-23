import { describe, expect, it, vi } from 'vitest'
import { createSearchProvider, SEARCH_PROVIDERS } from '../../src/main/search.ts'
import type { ImageAddress } from '../../src/main/remote-image-transport.ts'

const PUBLIC: ImageAddress = { address: '93.184.216.34', family: 4 }
const KEY = 'KEY-do-not-leak-1234567890'
const signal = () => new AbortController().signal

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const fake = (response: () => Response | Promise<Response>) => ({
  request: vi.fn(async (_url: URL, _address: ImageAddress, _signal: AbortSignal, _headers?: Record<string, string>, _init?: unknown) => response()),
  resolve: vi.fn(async () => [PUBLIC])
})
const providerOf = (provider: 'brave' | 'tavily', deps: ReturnType<typeof fake>) =>
  createSearchProvider({ provider, key: KEY }, { resolve: deps.resolve, request: deps.request })
const braveRow = (index: number) => ({ title: `标题 ${index}`, url: `https://example.com/${index}`, description: `摘要 ${index}` })
const tavilyRow = (index: number) => ({ title: `标题 ${index}`, url: `https://example.com/${index}`, content: `摘要 ${index}` })

describe('search providers', () => {
  it('queries Brave with the preset endpoint, q/count params and the key header only', async () => {
    const deps = fake(() => json({ web: { results: [braveRow(1), braveRow(2), braveRow(3)] } }))
    const provider = providerOf('brave', deps)
    expect(provider.provider).toBe('brave')
    expect(provider.host).toBe(SEARCH_PROVIDERS.brave.host)
    const result = await provider.search('小猫 研究', { maxResults: 3, signal: signal() })
    expect(deps.request).toHaveBeenCalledTimes(1)
    const [url, address, , headers, init] = deps.request.mock.calls[0]!
    const expected = new URL('https://api.search.brave.com/res/v1/web/search')
    expected.searchParams.set('q', '小猫 研究')
    expected.searchParams.set('count', '3')
    expect(url.href).toBe(expected.href)
    expect(address).toEqual(PUBLIC)
    expect(headers).toEqual({ accept: 'application/json', 'accept-encoding': 'identity', 'x-subscription-token': KEY })
    // key 只在请求头里，不进 URL。
    expect(url.href).not.toContain(KEY)
    expect(init).toBeUndefined()
    expect(result).toEqual({
      results: [
        { title: '标题 1', url: 'https://example.com/1', snippet: '摘要 1' },
        { title: '标题 2', url: 'https://example.com/2', snippet: '摘要 2' },
        { title: '标题 3', url: 'https://example.com/3', snippet: '摘要 3' }
      ]
    })
  })

  it('queries Tavily with a POST body carrying api_key, query and max_results', async () => {
    const deps = fake(() => json({ results: [tavilyRow(1), tavilyRow(2)] }))
    const provider = providerOf('tavily', deps)
    expect(provider.host).toBe(SEARCH_PROVIDERS.tavily.host)
    const result = await provider.search('topic', { maxResults: 2, signal: signal() })
    expect(deps.request).toHaveBeenCalledTimes(1)
    const [url, address, , headers, init] = deps.request.mock.calls[0]!
    expect(url.href).toBe('https://api.tavily.com/search')
    expect(address).toEqual(PUBLIC)
    expect(headers).toEqual({ accept: 'application/json', 'accept-encoding': 'identity' })
    expect(init).toEqual({ method: 'POST', body: JSON.stringify({ api_key: KEY, query: 'topic', max_results: 2 }) })
    // key 只在请求体里，不进 URL。
    expect(url.href).not.toContain(KEY)
    expect(result.results.map(item => item.snippet)).toEqual(['摘要 1', '摘要 2'])
  })

  it.each([
    [400, 'SEARCH_REFUSED'],
    [401, 'SEARCH_UNAUTHORIZED'],
    [403, 'SEARCH_UNAUTHORIZED'],
    [429, 'SEARCH_REFUSED'],
    [500, 'SEARCH_REFUSED'],
    [302, 'SEARCH_REFUSED']
  ])('maps HTTP %i to %s without following any redirect', async (status, code) => {
    const deps = fake(() => status === 302
      ? new Response(null, { status, headers: { location: 'https://other.example/search' } })
      : json({ detail: 'upstream said something' }, status))
    await expect(providerOf('tavily', deps).search('q', { signal: signal() })).rejects.toThrow(code)
    expect(deps.request).toHaveBeenCalledTimes(1)
  })

  it('maps a non-JSON or structurally wrong body to SEARCH_MALFORMED', async () => {
    const cases: Array<[string, Response]> = [
      ['brave', new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })],
      ['brave', json({})],
      ['brave', json({ web: { results: 'nope' } })],
      ['brave', json({ web: { results: [{ title: 1, url: 'https://example.com/a', description: 's' }] } })],
      ['brave', json({ web: { results: [{ title: 't', url: 'javascript:alert(1)', description: 's' }] } })],
      ['brave', json({ web: { results: [{ title: 't', url: 'https://example.com/a' }] } })],
      ['tavily', json({ results: 'nope' })],
      ['tavily', json({ results: [{ title: 't', url: 'ftp://example.com/a', content: 's' }] })]
    ]
    for (const [provider, response] of cases) {
      const deps = fake(() => response)
      await expect(providerOf(provider as 'brave' | 'tavily', deps).search('q', { signal: signal() })).rejects.toThrow('SEARCH_MALFORMED')
    }
  })

  it('reports SEARCH_EMPTY for a well-formed empty result list', async () => {
    const brave = fake(() => json({ web: { results: [] } }))
    await expect(providerOf('brave', brave).search('q', { signal: signal() })).rejects.toThrow('SEARCH_EMPTY')
    const tavily = fake(() => json({ results: [] }))
    await expect(providerOf('tavily', tavily).search('q', { signal: signal() })).rejects.toThrow('SEARCH_EMPTY')
  })

  it('truncates to maxResults and says so instead of returning everything', async () => {
    const deps = fake(() => json({ results: Array.from({ length: 12 }, (_, index) => tavilyRow(index)) }))
    const provider = providerOf('tavily', deps)
    const capped = await provider.search('q', { maxResults: 3, signal: signal() })
    expect(capped.results).toHaveLength(3)
    expect(capped.truncated).toBe(true)
    const full = await provider.search('q', { signal: signal() })
    expect(full.results).toHaveLength(5)
    expect(full.truncated).toBe(true)
    const exact = fake(() => json({ results: [tavilyRow(1), tavilyRow(2)] }))
    const kept = await providerOf('tavily', exact).search('q', { maxResults: 2, signal: signal() })
    expect(kept).toEqual({ results: [{ title: '标题 1', url: 'https://example.com/1', snippet: '摘要 1' }, { title: '标题 2', url: 'https://example.com/2', snippet: '摘要 2' }] })
  })

  it('rejects an out-of-contract query or maxResults before any request', async () => {
    const deps = fake(() => json({ results: [tavilyRow(1)] }))
    const provider = providerOf('tavily', deps)
    for (const [query, maxResults] of [
      ['x'.repeat(257), undefined],
      ['   ', undefined],
      ['line\nbreak', undefined],
      [42, undefined],
      ['q', 0],
      ['q', 11],
      ['q', 1.5],
      ['q', '3']
    ] as Array<[unknown, unknown]>) {
      await expect(provider.search(query as string, { maxResults: maxResults as number, signal: signal() })).rejects.toThrow('SEARCH_MALFORMED')
    }
    expect(deps.request).not.toHaveBeenCalled()
  })

  it('fails as SEARCH_NOT_CONFIGURED without a provider or key and never calls out', async () => {
    const deps = fake(() => json({ results: [tavilyRow(1)] }))
    for (const credential of [null, { provider: 'nope' as never, key: KEY }]) {
      const provider = createSearchProvider(credential, { resolve: deps.resolve, request: deps.request })
      expect(provider.provider).toBeNull()
      expect(provider.host).toBeNull()
      await expect(provider.search('q', { signal: signal() })).rejects.toThrow('SEARCH_NOT_CONFIGURED')
    }
    // 服务商已知但密钥为空：同样按未配置拒，且不外发。
    const empty = createSearchProvider({ provider: 'tavily', key: '' }, { resolve: deps.resolve, request: deps.request })
    expect(empty.provider).toBe('tavily')
    await expect(empty.search('q', { signal: signal() })).rejects.toThrow('SEARCH_NOT_CONFIGURED')
    expect(deps.request).not.toHaveBeenCalled()
  })

  it('never puts the key into a thrown error message', async () => {
    const failures: Array<() => Response> = [
      () => new Response('upstream body with ' + KEY, { status: 500 }),
      () => new Response('upstream body with ' + KEY, { status: 401 }),
      () => new Response('raw ' + KEY, { status: 200 }),
      () => json({ web: { results: [{ title: 't', url: 'https://example.com/a', description: KEY }] } }), // 成功路径也不报错
      () => json({ results: [] })
    ]
    const messages: string[] = []
    for (const provider of ['brave', 'tavily'] as const) {
      for (const respond of failures) {
        const result = await providerOf(provider, fake(respond)).search('q', { signal: signal() }).catch((error: unknown) => String((error as Error).message))
        if (typeof result === 'string') messages.push(result)
      }
    }
    expect(messages.length).toBeGreaterThan(0)
    for (const message of messages) {
      expect(message).not.toContain(KEY)
      expect(message).not.toContain('upstream body')
      expect(['SEARCH_REFUSED', 'SEARCH_UNAUTHORIZED', 'SEARCH_MALFORMED', 'SEARCH_EMPTY']).toContain(message)
    }
  })

  it('does not send the key when the request is aborted before dispatch', async () => {
    const deps = fake(() => json({ results: [tavilyRow(1)] }))
    const controller = new AbortController()
    controller.abort()
    await expect(providerOf('tavily', deps).search('q', { signal: controller.signal })).rejects.toThrow('SEARCH_REFUSED')
    expect(deps.request).not.toHaveBeenCalled()
  })
})

describe('deepseek search provider', () => {
  const dsRow = (index: number, extra: Record<string, unknown> = {}) => ({
    title: `标题 ${index}`,
    url: `https://example.com/${index}`,
    snippet: `片段 ${index}`,
    summary: `摘要 ${index}`,
    content: 'x'.repeat(200),
    ...extra
  })
  const ds = (deps: ReturnType<typeof fake>) =>
    createSearchProvider({ provider: 'deepseek', key: KEY }, { resolve: deps.resolve, request: deps.request })
  const sentBody = (deps: ReturnType<typeof fake>): Record<string, unknown> => {
    const init = deps.request.mock.calls[0]![4] as { method?: string; body?: string }
    return JSON.parse(init.body ?? 'null') as Record<string, unknown>
  }

  it('posts the preset DeepSeek endpoint with a Bearer header and the documented body', async () => {
    const deps = fake(() => json({ results: [dsRow(1), dsRow(2)] }))
    const provider = ds(deps)
    expect(provider.provider).toBe('deepseek')
    expect(provider.host).toBe('api.deepseek.com')
    expect(SEARCH_PROVIDERS.deepseek).toEqual({ host: 'api.deepseek.com', endpoint: 'https://api.deepseek.com/v1/tools/search', method: 'POST' })
    const result = await provider.search('小猫 研究', { maxResults: 2, signal: signal() })
    expect(deps.request).toHaveBeenCalledTimes(1)
    const [url, address, , headers, init] = deps.request.mock.calls[0]!
    expect(url.href).toBe('https://api.deepseek.com/v1/tools/search')
    expect(address).toEqual(PUBLIC)
    expect(headers).toEqual({ accept: 'application/json', 'accept-encoding': 'identity', authorization: `Bearer ${KEY}` })
    expect(init).toEqual({ method: 'POST', body: JSON.stringify({ query: '小猫 研究', count: 2, need_content: false }) })
    // key 只在 Authorization 头里，不进 URL 也不进请求体。
    expect(url.href).not.toContain(KEY)
    expect(JSON.stringify(init)).not.toContain(KEY)
    expect(result.results.map(item => item.snippet)).toEqual(['摘要 1', '摘要 2'])
  })

  it('clamps the query to 128 characters before sending and counts whole characters, not UTF-16 units', async () => {
    const deps = fake(() => json({ results: [dsRow(1)] }))
    const provider = ds(deps)
    // 200 个汉字在 Rgent 的 256 字合同内，但对 DeepSeek 超限：截到 128。
    await provider.search('汉'.repeat(200), { signal: signal() })
    expect(sentBody(deps).query).toBe('汉'.repeat(128))
    deps.request.mockClear()
    // 恰好 128 不截。
    await provider.search('字'.repeat(128), { signal: signal() })
    expect(sentBody(deps).query).toBe('字'.repeat(128))
    deps.request.mockClear()
    // 100 个 emoji ＋ 40 汉字 = 140 个码点／240 个 UTF-16 单元：按码点截到 128，不切出半个代理对。
    const mixed = '😀'.repeat(100) + '汉'.repeat(40)
    await provider.search(mixed, { signal: signal() })
    const sent = sentBody(deps).query
    expect(sent).toBe('😀'.repeat(100) + '汉'.repeat(28))
    expect([...(sent as string)]).toHaveLength(128)
    expect((sent as string).length).toBe(228)
  })

  it('still rejects a query beyond the contract bound before any request', async () => {
    const deps = fake(() => json({ results: [dsRow(1)] }))
    await expect(ds(deps).search('x'.repeat(257), { signal: signal() })).rejects.toThrow('SEARCH_MALFORMED')
    await expect(ds(deps).search('   ', { signal: signal() })).rejects.toThrow('SEARCH_MALFORMED')
    expect(deps.request).not.toHaveBeenCalled()
  })

  it('prefers summary over snippet and falls back to snippet when summary is missing or empty', async () => {
    const deps = fake(() => json({
      results: [
        { title: 't1', url: 'https://example.com/1', summary: '整段摘要', snippet: '短摘要' },
        { title: 't2', url: 'https://example.com/2', snippet: '只有短摘要' },
        { title: 't3', url: 'https://example.com/3', summary: '', snippet: '空摘要退回' },
        { title: 't4', url: 'https://example.com/4', summary: '只有摘要' },
        { title: 't5', url: 'https://example.com/5', snippet: '带正文', content: '正文不该被用' }
      ]
    }))
    const result = await ds(deps).search('q', { signal: signal() })
    expect(result.results).toEqual([
      { title: 't1', url: 'https://example.com/1', snippet: '整段摘要' },
      { title: 't2', url: 'https://example.com/2', snippet: '只有短摘要' },
      { title: 't3', url: 'https://example.com/3', snippet: '空摘要退回' },
      { title: 't4', url: 'https://example.com/4', snippet: '只有摘要' },
      { title: 't5', url: 'https://example.com/5', snippet: '带正文' }
    ])
  })

  it('drops non-http(s) and empty urls instead of failing the whole search', async () => {
    const deps = fake(() => json({
      results: [
        { title: '保留 https', url: 'https://example.com/a', summary: 'a' },
        { title: '丢 javascript', url: 'javascript:alert(1)', summary: 'b' },
        { title: '丢空串', url: '', summary: 'c' },
        { title: '丢 ftp', url: 'ftp://example.com/d', summary: 'd' },
        { title: '丢带用户名的', url: 'https://user:pass@example.com/e', summary: 'e' },
        { title: '保留 http', url: 'http://example.com/f', summary: 'f' }
      ]
    }))
    const result = await ds(deps).search('q', { signal: signal() })
    expect(result.results.map(item => item.url)).toEqual(['https://example.com/a', 'http://example.com/f'])
    expect(result.results.map(item => item.title)).toEqual(['保留 https', '保留 http'])
    // 全被过滤掉等同于没有结果，不把空列表当成功。
    const empty = fake(() => json({ results: [{ title: 't', url: 'mailto:a@example.com', summary: 's' }] }))
    await expect(ds(empty).search('q', { signal: signal() })).rejects.toThrow('SEARCH_EMPTY')
  })

  it('truncates DeepSeek rows to maxResults and reports it, while filtered rows are not reported as truncation', async () => {
    const deps = fake(() => json({ results: Array.from({ length: 12 }, (_, index) => dsRow(index)) }))
    const provider = ds(deps)
    const capped = await provider.search('q', { maxResults: 3, signal: signal() })
    expect(capped.results).toHaveLength(3)
    expect(capped.truncated).toBe(true)
    const full = await provider.search('q', { signal: signal() })
    expect(full.results).toHaveLength(5)
    expect(full.truncated).toBe(true)
    const exact = fake(() => json({ results: [dsRow(1), dsRow(2)] }))
    expect(await ds(exact).search('q', { maxResults: 2, signal: signal() })).not.toHaveProperty('truncated')
    // 10 条里 2 条坏 url、maxResults 10：返回 8 条，这不是被 maxResults 截断。
    const filtered = fake(() => json({
      results: [
        ...Array.from({ length: 8 }, (_, index) => dsRow(index)),
        { title: '坏1', url: '', summary: 's' },
        { title: '坏2', url: 'not-a-url', summary: 's' }
      ]
    }))
    const kept = await ds(filtered).search('q', { maxResults: 10, signal: signal() })
    expect(kept.results).toHaveLength(8)
    expect(kept).not.toHaveProperty('truncated')
    // 超出上限的行只看 url、不做结构校验：坏行不会把整次搜索打成 SEARCH_MALFORMED，也不算被截断。
    const overCap = fake(() => json({ results: [dsRow(1), dsRow(2), dsRow(3), null] }))
    const exactKept = await ds(overCap).search('q', { maxResults: 3, signal: signal() })
    expect(exactKept.results).toHaveLength(3)
    expect(exactKept).not.toHaveProperty('truncated')
  })

  it.each([
    [401, 'SEARCH_UNAUTHORIZED'],
    [403, 'SEARCH_UNAUTHORIZED'],
    [402, 'SEARCH_REFUSED'],
    [429, 'SEARCH_REFUSED'],
    [500, 'SEARCH_REFUSED'],
    [503, 'SEARCH_REFUSED'],
    [302, 'SEARCH_REFUSED']
  ])('maps DeepSeek HTTP %i to %s without following any redirect', async (status, code) => {
    const deps = fake(() => status === 302
      ? new Response(null, { status, headers: { location: 'https://other.example/search' } })
      : json({ error: { message: 'upstream said something' } }, status))
    await expect(ds(deps).search('q', { signal: signal() })).rejects.toThrow(code)
    expect(deps.request).toHaveBeenCalledTimes(1)
  })

  it('maps a non-JSON or structurally wrong DeepSeek body to SEARCH_MALFORMED', async () => {
    const cases: Response[] = [
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      json({}),
      json({ results: 'nope' }),
      json({ results: [null] }),
      json({ results: [{ title: 1, url: 'https://example.com/a', summary: 's' }] })
    ]
    for (const response of cases) {
      await expect(ds(fake(() => response)).search('q', { signal: signal() })).rejects.toThrow('SEARCH_MALFORMED')
    }
    const empty = fake(() => json({ results: [] }))
    await expect(ds(empty).search('q', { signal: signal() })).rejects.toThrow('SEARCH_EMPTY')
  })

  it('never puts the key or the upstream body into a DeepSeek error message', async () => {
    for (const respond of [
      () => new Response('upstream body with ' + KEY, { status: 500 }),
      () => new Response('upstream body with ' + KEY, { status: 401 }),
      () => new Response('raw ' + KEY, { status: 200 })
    ]) {
      const message = await ds(fake(respond)).search('q', { signal: signal() })
        .then(() => 'resolved', (error: unknown) => String((error as Error).message))
      expect(message).not.toContain(KEY)
      expect(message).not.toContain('upstream body')
      expect(['SEARCH_REFUSED', 'SEARCH_UNAUTHORIZED', 'SEARCH_MALFORMED']).toContain(message)
    }
  })

  it('does not send the key when the request is aborted before dispatch', async () => {
    const deps = fake(() => json({ results: [dsRow(1)] }))
    const controller = new AbortController()
    controller.abort()
    await expect(ds(deps).search('q', { signal: controller.signal })).rejects.toThrow('SEARCH_REFUSED')
    expect(deps.request).not.toHaveBeenCalled()
  })

  it('fails as SEARCH_NOT_CONFIGURED when the DeepSeek key is empty and never calls out', async () => {
    const deps = fake(() => json({ results: [dsRow(1)] }))
    const provider = createSearchProvider({ provider: 'deepseek', key: '' }, { resolve: deps.resolve, request: deps.request })
    expect(provider.provider).toBe('deepseek')
    await expect(provider.search('q', { signal: signal() })).rejects.toThrow('SEARCH_NOT_CONFIGURED')
    expect(deps.request).not.toHaveBeenCalled()
  })
})
