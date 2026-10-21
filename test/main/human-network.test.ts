import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { applyHumanNetworkGate, createHumanNetwork, type HumanFetchText, type HumanNetworkDependencies } from '../../src/main/human-network.ts'
import type { EgressLogEntry } from '../../src/shared/ipc.ts'

/** 人发起抓页／搜索：总闸、错误码、审计形状都用注入假件验证，不碰真网络。 */

type Harness = {
  deps: HumanNetworkDependencies
  entries: EgressLogEntry[]
  fetches: { url: string }[]
  searches: { query: string; maxResults?: number }[]
}

function harness(over: Partial<HumanNetworkDependencies> = {}): Harness {
  const entries: EgressLogEntry[] = []
  const fetches: { url: string }[] = []
  const searches: { query: string; maxResults?: number }[] = []
  const deps: HumanNetworkDependencies = {
    enabled: () => true,
    fetchText: async (url) => {
      fetches.push({ url })
      return { text: '外部正文', title: '示例标题', finalUrl: url, bytes: 12, truncated: false }
    },
    searchProvider: async () => ({
      provider: 'brave',
      host: 'api.search.brave.com',
      search: async (query, options) => {
        searches.push({ query, ...(options.maxResults === undefined ? {} : { maxResults: options.maxResults }) })
        return { results: [{ title: '结果一', url: 'https://result.example/a', snippet: '摘要一' }] }
      }
    }),
    log: { append: entry => entries.push(entry) },
    ...over
  }
  return { deps, entries, fetches, searches }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const broadcast = (value: unknown): string => JSON.stringify(value)

/** 永远挂起的假出口：只有 signal abort 时才拒绝，用来验证停止。 */
const pendingFetch = (_url: string, options: { signal: AbortSignal }): Promise<HumanFetchText> =>
  new Promise((_resolve, reject) => {
    const fail = (): void => reject(Error('EGRESS_ABORTED'))
    if (options.signal.aborted) { fail(); return }
    options.signal.addEventListener('abort', fail, { once: true })
  })

const pendingSearch = async () => ({
  provider: 'brave' as const,
  host: 'api.search.brave.com',
  search: (_query: string, options: { maxResults?: number; signal: AbortSignal }): Promise<never> =>
    new Promise((_resolve, reject) => {
      const fail = (): void => reject(Error('SEARCH_REFUSED'))
      if (options.signal.aborted) { fail(); return }
      options.signal.addEventListener('abort', fail, { once: true })
    })
})

describe('human network', () => {
  it('refuses a fetch before egress when the master switch is off, and logs the refusal code', async () => {
    const test = harness({ enabled: () => false })
    const network = createHumanNetwork(test.deps)
    const result = await network.fetchPage('https://example.com/page?q=SECRET_QUERY')
    expect(result).toEqual({ ok: false, error: 'NETWORK_NOT_AUTHORIZED' })
    expect(test.fetches).toEqual([])
    expect(test.entries).toHaveLength(1)
    expect(test.entries[0]).toMatchObject({ action: 'fetch', host: 'example.com', outcome: 'refused', code: 'NETWORK_NOT_AUTHORIZED' })
    expect(broadcast(test.entries)).not.toContain('SECRET_QUERY')
  })

  it('refuses a search before touching the credential when the master switch is off', async () => {
    const searchProvider = vi.fn(async () => {
      throw Error('must not be called')
    })
    const test = harness({ enabled: () => false, searchProvider })
    const network = createHumanNetwork(test.deps)
    const result = await network.search('小猫 研究')
    expect(result).toEqual({ ok: false, error: 'NETWORK_NOT_AUTHORIZED' })
    expect(searchProvider).not.toHaveBeenCalled()
    expect(test.entries[0]).toMatchObject({ action: 'search', host: '', outcome: 'refused', code: 'NETWORK_NOT_AUTHORIZED' })
  })

  it('fails closed when the gate itself throws', async () => {
    const test = harness({ enabled: () => { throw Error('config unreadable') } })
    const network = createHumanNetwork(test.deps)
    await expect(network.fetchPage('https://example.com/')).resolves.toEqual({ ok: false, error: 'NETWORK_NOT_AUTHORIZED' })
    expect(test.fetches).toEqual([])
  })

  it('returns a fetch result and logs host and bytes without URL or body', async () => {
    const test = harness()
    const network = createHumanNetwork(test.deps)
    const result = await network.fetchPage('https://example.com/page?q=SECRET_QUERY')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.url).toBe('https://example.com/page?q=SECRET_QUERY')
    expect(result.host).toBe('example.com')
    expect(result.title).toBe('示例标题')
    expect(result.text).toBe('外部正文')
    expect(result.bytes).toBe(12)
    expect(result.truncated).toBe(false)
    expect(Number.isNaN(Date.parse(result.fetchedAt))).toBe(false)
    expect(test.entries).toHaveLength(1)
    expect(test.entries[0]).toMatchObject({ action: 'fetch', host: 'example.com', bytes: 12, outcome: 'ok' })
    const log = broadcast(test.entries)
    expect(log).not.toContain('SECRET_QUERY')
    expect(log).not.toContain('外部正文')
    expect(log).not.toContain('example.com/page')
  })

  it('uses the final URL host when the fetch followed an allowed redirect', async () => {
    const test = harness({
      fetchText: async () => ({ text: '跳转后正文', finalUrl: 'https://cdn.example/final', bytes: 18, truncated: true })
    })
    const network = createHumanNetwork(test.deps)
    const result = await network.fetchPage('https://example.com/start')
    expect(result).toMatchObject({ ok: true, url: 'https://cdn.example/final', host: 'cdn.example', truncated: true })
    expect(test.entries[0]).toMatchObject({ action: 'fetch', host: 'cdn.example', bytes: 18, outcome: 'ok' })
    expect(broadcast(test.entries)).not.toContain('/final')
  })

  it('logs a refused fetch with only the error code and no URL path', async () => {
    const test = harness({
      fetchText: async () => { throw Error('EGRESS_TIMEOUT') }
    })
    const network = createHumanNetwork(test.deps)
    const result = await network.fetchPage('https://example.com/redirected')
    expect(result).toEqual({ ok: false, error: 'EGRESS_TIMEOUT' })
    expect(test.entries).toHaveLength(1)
    expect(test.entries[0]).toEqual({
      at: expect.any(String),
      action: 'fetch',
      host: 'example.com',
      outcome: 'refused',
      code: 'EGRESS_TIMEOUT'
    })
    expect(broadcast(test.entries)).not.toContain('redirected')
  })

  it('maps an unexpected exception to EGRESS_UNAVAILABLE instead of leaking its message', async () => {
    const test = harness({
      fetchText: async () => { throw Error('upstream said: secret token abc') }
    })
    const network = createHumanNetwork(test.deps)
    const result = await network.fetchPage('https://example.com/')
    expect(result).toEqual({ ok: false, error: 'EGRESS_UNAVAILABLE' })
    expect(test.entries[0]!.code).toBe('EGRESS_UNAVAILABLE')
    expect(broadcast(test.entries)).not.toContain('secret token')
  })

  it('reports SEARCH_NOT_CONFIGURED when no credential is available', async () => {
    const test = harness({
      searchProvider: async () => { throw Error('SEARCH_NOT_CONFIGURED') }
    })
    const network = createHumanNetwork(test.deps)
    const result = await network.search('小猫')
    expect(result).toEqual({ ok: false, error: 'SEARCH_NOT_CONFIGURED' })
    expect(test.entries[0]).toMatchObject({ action: 'search', host: '', outcome: 'refused', code: 'SEARCH_NOT_CONFIGURED' })
  })

  it('returns the search result shape and logs provider host with the result count', async () => {
    const test = harness()
    const network = createHumanNetwork(test.deps)
    const result = await network.search('小猫 研究', 3)
    expect(result).toEqual({
      ok: true,
      provider: 'brave',
      host: 'api.search.brave.com',
      results: [{ title: '结果一', url: 'https://result.example/a', snippet: '摘要一' }]
    })
    expect(test.searches).toEqual([{ query: '小猫 研究', maxResults: 3 }])
    expect(test.entries[0]).toMatchObject({ action: 'search', host: 'api.search.brave.com', count: 1, outcome: 'ok' })
    const log = broadcast(test.entries)
    expect(log).not.toContain('小猫')
    expect(log).not.toContain('摘要一')
    expect(log).not.toContain('result.example/a')
  })

  it('keeps truncated and empty search results honest', async () => {
    const test = harness({
      searchProvider: async () => ({
        provider: 'tavily',
        host: 'api.tavily.com',
        search: async () => ({
          results: [{ title: 't', url: 'https://x.example/', snippet: 's' }],
          truncated: true
        })
      })
    })
    const network = createHumanNetwork(test.deps)
    await expect(network.search('q')).resolves.toMatchObject({ ok: true, provider: 'tavily', truncated: true })

    const empty = harness({
      searchProvider: async () => ({
        provider: 'brave',
        host: 'api.search.brave.com',
        search: async () => ({ results: [] })
      })
    })
    const emptyNetwork = createHumanNetwork(empty.deps)
    await expect(emptyNetwork.search('q')).resolves.toEqual({ ok: false, error: 'SEARCH_EMPTY' })
    expect(empty.entries[0]).toMatchObject({ action: 'search', host: 'api.search.brave.com', outcome: 'refused', code: 'SEARCH_EMPTY' })
  })

  it('maps search errors to codes and never writes the message into the log', async () => {
    const test = harness({
      searchProvider: async () => ({
        provider: 'brave',
        host: 'api.search.brave.com',
        search: async () => { throw Error('SEARCH_UNAUTHORIZED') }
      })
    })
    const network = createHumanNetwork(test.deps)
    await expect(network.search('查询')).resolves.toEqual({ ok: false, error: 'SEARCH_UNAUTHORIZED' })
    expect(test.entries[0]).toMatchObject({ action: 'search', host: 'api.search.brave.com', outcome: 'refused', code: 'SEARCH_UNAUTHORIZED' })
  })

  it('abort() stops one in-flight fetch with EGRESS_ABORTED and logs a refusal', async () => {
    const test = harness({ fetchText: pendingFetch })
    const network = createHumanNetwork(test.deps)
    const pending = network.fetchPage('https://example.com/page?q=SECRET_QUERY', { requestId: 'rid-1' })
    expect(network.abort('rid-1')).toBe(true)
    expect(network.abort('rid-1')).toBe(false)
    await expect(pending).resolves.toEqual({ ok: false, error: 'EGRESS_ABORTED' })
    expect(test.entries).toHaveLength(1)
    expect(test.entries[0]).toMatchObject({ action: 'fetch', host: 'example.com', outcome: 'refused', code: 'EGRESS_ABORTED' })
    expect(broadcast(test.entries)).not.toContain('SECRET_QUERY')
  })

  it('abortAll() stops every in-flight request and returns how many it stopped', async () => {
    const test = harness({ fetchText: pendingFetch, searchProvider: pendingSearch })
    const network = createHumanNetwork(test.deps)
    const first = network.fetchPage('https://one.example/', { requestId: 'a' })
    const second = network.search('查询', undefined, { requestId: 'b' })
    expect(network.abortAll()).toBe(2)
    await expect(first).resolves.toEqual({ ok: false, error: 'EGRESS_ABORTED' })
    await expect(second).resolves.toEqual({ ok: false, error: 'EGRESS_ABORTED' })
    expect(test.entries).toHaveLength(2)
    for (const entry of test.entries) expect(entry).toMatchObject({ outcome: 'refused', code: 'EGRESS_ABORTED' })
    expect(network.abortAll()).toBe(0)
  })

  it('forgets a finished request so abort() no longer matches it', async () => {
    const test = harness()
    const network = createHumanNetwork(test.deps)
    await network.fetchPage('https://example.com/', { requestId: 'done' })
    expect(network.abort('done')).toBe(false)
  })

  it('reports degraded when a successful fetch could not be written to the audit log', async () => {
    const test = harness({ log: { append: () => { throw Error('disk full') } } })
    const result = await createHumanNetwork(test.deps).fetchPage('https://example.com/')
    expect(result).toMatchObject({ ok: true, host: 'example.com', text: '外部正文', degraded: 'log-failed' })
  })

  it('reports degraded when a successful search could not be written to the audit log', async () => {
    const test = harness({ log: { append: () => { throw Error('disk full') } } })
    const result = await createHumanNetwork(test.deps).search('小猫')
    expect(result).toMatchObject({ ok: true, provider: 'brave', degraded: 'log-failed' })
  })

  it('aborts human requests when the master switch is saved as off', () => {
    const abortAll = vi.fn()
    applyHumanNetworkGate({ abortAll }, true)
    expect(abortAll).not.toHaveBeenCalled()
    applyHumanNetworkGate({ abortAll }, false)
    expect(abortAll).toHaveBeenCalledTimes(1)
    expect(() => applyHumanNetworkGate(null, false)).not.toThrow()
  })

  it('wires the gate close into network:config so a saved-off switch stops in-flight calls', () => {
    const source = readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
    expect(source).toContain('applyHumanNetworkGate(humanNetwork, enabled)')
  })
})
