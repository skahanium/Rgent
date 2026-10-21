import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNetworkStats, flushNetworkStats, networkErrorCode, networkFailureCode, type NetworkStatEvent } from '../../src/main/network-stats.ts'
import { createHumanNetwork, type HumanFetchText, type HumanNetworkDependencies } from '../../src/main/human-network.ts'
import type { NetworkStatsCounts } from '../../src/shared/ipc.ts'

/**
 * 外发统计：只存计数／字节／拒绝码与时间；缺失、损坏、去抖、原子写与 0600 都用真临时目录验证。
 * 末尾另钉住人发起抓页／搜索只记一次、失败不改变返回形状这两条旁路语义。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const directories: string[] = []
function directory(): { dir: string; file: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rgent-network-stats-'))
  directories.push(dir)
  return {
    dir,
    file: path.join(dir, 'network-stats.json'),
    done: () => rmSync(dir, { recursive: true, force: true })
  }
}
afterEach(() => {
  vi.useRealTimers()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const zero = (): NetworkStatsCounts => ({ ok: 0, refused: 0, bytes: 0 })
const emptyKinds = () => ({ fetch: zero(), search: zero(), mcp: zero(), humanFetch: zero(), humanSearch: zero() })
const written = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

describe('network stats', () => {
  it('starts from an empty in-memory view when the file does not exist', () => {
    const app = directory()
    const stats = createNetworkStats(app.dir)
    expect(stats.view()).toEqual({ version: 1, kinds: emptyKinds(), lastCodes: [] })
    expect(existsSync(app.file)).toBe(false)
  })

  it('writes the v1 shape on flush and only counts bytes for fetch / humanFetch', () => {
    const app = directory()
    const stats = createNetworkStats(app.dir)
    stats.record('fetch', { outcome: 'ok', bytes: 1234 })
    stats.record('search', { outcome: 'ok', bytes: 999 })
    stats.record('mcp', { outcome: 'ok', bytes: 999 })
    stats.record('humanFetch', { outcome: 'ok', bytes: 66 })
    stats.record('humanSearch', { outcome: 'ok', bytes: 999 })
    stats.record('fetch', { outcome: 'refused', code: 'EGRESS_TIMEOUT' })
    stats.flush()
    const file = written(app.file)
    expect(file.version).toBe(1)
    expect(file.kinds).toEqual({
      fetch: { ok: 1, refused: 1, bytes: 1234 },
      search: { ok: 1, refused: 0, bytes: 0 },
      mcp: { ok: 1, refused: 0, bytes: 0 },
      humanFetch: { ok: 1, refused: 0, bytes: 66 },
      humanSearch: { ok: 1, refused: 0, bytes: 0 }
    })
    expect(typeof file.lastOkAt).toBe('string')
    expect(Number.isNaN(Date.parse(file.lastOkAt as string))).toBe(false)
    expect(file.lastCodes).toEqual([{ code: 'EGRESS_TIMEOUT', at: expect.any(String) }])
    expect(file.corrupt).toBeUndefined()
  })

  it('keeps a newest-first failure-code list capped at ten and skips adjacent duplicates without refreshing the time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
    const app = directory()
    const stats = createNetworkStats(app.dir)
    stats.record('fetch', { outcome: 'refused', code: 'EGRESS_TIMEOUT' })
    vi.advanceTimersByTime(1000)
    stats.record('fetch', { outcome: 'refused', code: 'EGRESS_TIMEOUT' })
    expect(stats.view().lastCodes).toEqual([{ code: 'EGRESS_TIMEOUT', at: '2026-10-21T00:00:00.000Z' }])
    stats.record('fetch', { outcome: 'refused', code: 'EGRESS_BUSY' })
    stats.record('fetch', { outcome: 'refused', code: 'EGRESS_TIMEOUT' })
    expect(stats.view().lastCodes.map(item => item.code)).toEqual(['EGRESS_TIMEOUT', 'EGRESS_BUSY', 'EGRESS_TIMEOUT'])
    for (let index = 0; index < 12; index += 1) {
      stats.record('search', { outcome: 'refused', code: `SEARCH_CODE_${index}` })
    }
    const codes = stats.view().lastCodes
    expect(codes).toHaveLength(10)
    expect(codes[0]!.code).toBe('SEARCH_CODE_11')
    expect(codes.at(-1)!.code).toBe('SEARCH_CODE_2')
    stats.flush()
    expect(written(app.file).lastCodes).toHaveLength(10)
  })

  it('debounces writes by 500ms and flushes immediately when asked', () => {
    vi.useFakeTimers()
    const app = directory()
    const stats = createNetworkStats(app.dir)
    stats.record('fetch', { outcome: 'ok', bytes: 10 })
    expect(existsSync(app.file)).toBe(false)
    vi.advanceTimersByTime(499)
    expect(existsSync(app.file)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(existsSync(app.file)).toBe(true)
    expect((written(app.file).kinds as Record<string, NetworkStatsCounts>).fetch).toEqual({ ok: 1, refused: 0, bytes: 10 })

    stats.record('fetch', { outcome: 'ok', bytes: 5 })
    expect((written(app.file).kinds as Record<string, NetworkStatsCounts>).fetch.ok).toBe(1)
    stats.flush()
    expect((written(app.file).kinds as Record<string, NetworkStatsCounts>).fetch).toEqual({ ok: 2, refused: 0, bytes: 15 })
  })

  it('clear() zeroes everything and writes immediately', () => {
    const app = directory()
    const stats = createNetworkStats(app.dir)
    stats.record('fetch', { outcome: 'ok', bytes: 5 })
    stats.record('fetch', { outcome: 'refused', code: 'EGRESS_TIMEOUT' })
    stats.flush()
    stats.clear()
    expect(existsSync(app.file)).toBe(true)
    const file = written(app.file)
    expect(file.kinds).toEqual(emptyKinds())
    expect(file.lastCodes).toEqual([])
    expect(file.lastOkAt).toBeUndefined()
    expect(stats.view()).toEqual({ version: 1, kinds: emptyKinds(), lastCodes: [] })
  })

  it('flags a corrupt file, preserves it on the next write, and starts a fresh one', () => {
    const app = directory()
    writeFileSync(app.file, '这不是 JSON\n')
    const stats = createNetworkStats(app.dir)
    expect(stats.view().corrupt).toBe(true)
    expect(stats.view().kinds).toEqual(emptyKinds())
    stats.record('fetch', { outcome: 'ok', bytes: 5 })
    stats.flush()
    const backup = readdirSync(app.dir).find(name => name.startsWith('network-stats.json.corrupt-'))
    expect(backup).toBeTruthy()
    expect(readFileSync(path.join(app.dir, backup!), 'utf8')).toBe('这不是 JSON\n')
    expect((written(app.file).kinds as Record<string, NetworkStatsCounts>).fetch).toEqual({ ok: 1, refused: 0, bytes: 5 })
    expect(stats.view().corrupt).toBeUndefined()
  })

  it('treats wrong versions and unknown root shapes as corrupt instead of guessing', () => {
    const app = directory()
    for (const raw of ['[]', '{"version":2,"kinds":{}}', '{"version":1}', '{"version":1,"kinds":[]}', 'null']) {
      writeFileSync(app.file, raw)
      const stats = createNetworkStats(app.dir)
      expect(stats.view().corrupt, raw).toBe(true)
      expect(stats.view().kinds, raw).toEqual(emptyKinds())
    }
  })

  it('normalizes bad numbers to zero, ignores unknown kinds, and drops bad code entries', () => {
    const app = directory()
    writeFileSync(app.file, JSON.stringify({
      version: 1,
      kinds: {
        fetch: { ok: -1, refused: 1.5, bytes: '12' },
        search: { ok: 2, refused: 3, bytes: 4 },
        mcp: null,
        alien: { ok: 99, refused: 99, bytes: 99 }
      },
      lastOkAt: 'not-a-date',
      lastCodes: [
        { code: 'EGRESS_TIMEOUT', at: '2026-10-21T00:00:00.000Z' },
        { code: 'lower-case', at: '2026-10-21T00:00:01.000Z' },
        { code: 'EGRESS_BUSY' },
        { code: 'SEARCH_EMPTY', at: '2026-10-21T00:00:02.000Z' }
      ]
    }))
    const view = createNetworkStats(app.dir).view()
    expect(view.corrupt).toBeUndefined()
    expect(view.kinds.fetch).toEqual(zero())
    expect(view.kinds.search).toEqual({ ok: 2, refused: 3, bytes: 4 })
    expect(view.kinds.mcp).toEqual(zero())
    expect(Object.keys(view.kinds)).toEqual(['fetch', 'search', 'mcp', 'humanFetch', 'humanSearch'])
    expect(view.lastOkAt).toBeUndefined()
    expect(view.lastCodes).toEqual([
      { code: 'EGRESS_TIMEOUT', at: '2026-10-21T00:00:00.000Z' },
      { code: 'SEARCH_EMPTY', at: '2026-10-21T00:00:02.000Z' }
    ])
  })

  it('ignores unknown kinds and invalid events without scheduling a write', () => {
    vi.useFakeTimers()
    const app = directory()
    const stats = createNetworkStats(app.dir)
    stats.record('alien' as never, { outcome: 'ok', bytes: 5 })
    stats.record('fetch', { outcome: 'maybe' } as never)
    vi.advanceTimersByTime(600)
    expect(existsSync(app.file)).toBe(false)
    stats.record('fetch', { outcome: 'refused', code: 'not a code' })
    stats.flush()
    const file = written(app.file)
    expect(file.lastOkAt).toBeUndefined()
    expect(file.lastCodes).toEqual([])
    expect((file.kinds as Record<string, NetworkStatsCounts>).fetch).toEqual({ ok: 0, refused: 1, bytes: 0 })
  })

  it('returns a detached snapshot with no file path or request content', () => {
    const app = directory()
    const stats = createNetworkStats(app.dir)
    stats.record('fetch', { outcome: 'ok', bytes: 1 })
    stats.record('fetch', { outcome: 'refused', code: 'EGRESS_TIMEOUT' })
    const view = stats.view()
    view.kinds.fetch.ok = 99
    view.lastCodes.push({ code: 'EGRESS_BUSY', at: '2026-10-21T00:00:00.000Z' })
    expect(stats.view().kinds.fetch.ok).toBe(1)
    expect(stats.view().lastCodes).toHaveLength(1)
    expect(JSON.stringify(stats.view())).not.toContain(app.dir)
  })

  it('creates the file with 0600 permissions', () => {
    const app = directory()
    const stats = createNetworkStats(app.dir)
    stats.record('fetch', { outcome: 'ok', bytes: 1 })
    stats.flush()
    if (process.platform !== 'win32') expect(statSync(app.file).mode & 0o777).toBe(0o600)
  })

  it('normalizes error codes to the contract whitelist and maps AbortError shapes to EGRESS_ABORTED', () => {
    expect(networkErrorCode(Error('EGRESS_TIMEOUT'))).toBe('EGRESS_TIMEOUT')
    expect(networkErrorCode('SEARCH_EMPTY')).toBe('SEARCH_EMPTY')
    expect(networkErrorCode(Error('upstream said: secret'))).toBe('EGRESS_UNAVAILABLE')
    expect(networkErrorCode(Error('egress_timeout'))).toBe('EGRESS_UNAVAILABLE')
    expect(networkErrorCode(undefined)).toBe('EGRESS_UNAVAILABLE')
    // 取消的三种真实形状：DOMException、改了 name 的 Error、Node 的 ABORT_ERR 码。
    expect(networkErrorCode(new DOMException('This operation was aborted', 'AbortError'))).toBe('EGRESS_ABORTED')
    const named = new Error('This operation was aborted')
    named.name = 'AbortError'
    expect(networkErrorCode(named)).toBe('EGRESS_ABORTED')
    const messageLess = new Error('')
    messageLess.name = 'AbortError'
    expect(networkErrorCode(messageLess)).toBe('EGRESS_ABORTED')
    expect(networkErrorCode({ code: 'ABORT_ERR', message: '' })).toBe('EGRESS_ABORTED')
    expect(networkErrorCode({ name: 'AbortError' })).toBe('EGRESS_ABORTED')
    // 信号已 abort 时优先记 EGRESS_ABORTED：搜索出口把取消折成 SEARCH_REFUSED 也不丢取消语义。
    expect(networkFailureCode(Error('SEARCH_REFUSED'), { aborted: true })).toBe('EGRESS_ABORTED')
    expect(networkFailureCode(Error('SEARCH_REFUSED'), { aborted: false })).toBe('SEARCH_REFUSED')
    expect(networkFailureCode(new DOMException('aborted', 'AbortError'), null)).toBe('EGRESS_ABORTED')
  })

  it('flushes pending debounced counts through the shutdown helper', () => {
    const app = directory()
    const stats = createNetworkStats(app.dir)
    stats.record('fetch', { outcome: 'ok', bytes: 7 })
    expect(existsSync(app.file)).toBe(false)
    flushNetworkStats(stats)
    expect((written(app.file).kinds as Record<string, NetworkStatsCounts>).fetch).toEqual({ ok: 1, refused: 0, bytes: 7 })
    // 退出收尾不能因为写失败而卡住：helper 自己吞掉，假 stats 也钉住调用次数。
    const flush = vi.fn()
    flushNetworkStats({ flush })
    expect(flush).toHaveBeenCalledTimes(1)
    expect(() => flushNetworkStats({ flush: () => { throw Error('disk full') } })).not.toThrow()
    expect(() => flushNetworkStats(null)).not.toThrow()
  })

  it('wires the shutdown flush into will-quit before the vault is disposed', () => {
    const source = readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
    const hook = source.slice(source.indexOf("app.on('will-quit'"))
    expect(hook).not.toBe('')
    expect(hook).toContain('flushNetworkStats(networkStats)')
    expect(hook.indexOf('flushNetworkStats(networkStats)')).toBeLessThan(hook.indexOf('vault?.dispose()'))
  })
})

/** 人发起抓页／搜索的统计旁路：每次请求恰好一条，成功／失败都不改变返回形状。 */
type Recorded = { kind: 'humanFetch' | 'humanSearch'; event: NetworkStatEvent }
function humanHarness(over: Partial<HumanNetworkDependencies> = {}) {
  const calls: Recorded[] = []
  const deps: HumanNetworkDependencies = {
    enabled: () => true,
    fetchText: async (url): Promise<HumanFetchText> => ({ text: '正文', finalUrl: url, bytes: 12, truncated: false }),
    searchProvider: async () => ({
      provider: 'brave',
      host: 'api.search.brave.com',
      search: async () => ({ results: [{ title: 't', url: 'https://r.example/', snippet: 's' }] })
    }),
    log: { append: () => {} },
    stats: { record: (kind, event) => { calls.push({ kind, event }) } },
    ...over
  }
  return { network: createHumanNetwork(deps), calls }
}

describe('human network stats wiring', () => {
  it('records one ok for a successful fetch and one for a successful search', async () => {
    const test = humanHarness()
    await test.network.fetchPage('https://example.com/page?q=SECRET')
    await test.network.search('小猫 研究')
    expect(test.calls).toEqual([
      { kind: 'humanFetch', event: { outcome: 'ok', bytes: 12 } },
      { kind: 'humanSearch', event: { outcome: 'ok' } }
    ])
    expect(JSON.stringify(test.calls)).not.toContain('SECRET')
  })

  it('records refused with the code for gate-off, search-not-configured and fetch errors', async () => {
    const off = humanHarness({ enabled: () => false })
    await off.network.fetchPage('https://example.com/')
    await off.network.search('q')
    expect(off.calls).toEqual([
      { kind: 'humanFetch', event: { outcome: 'refused', code: 'NETWORK_NOT_AUTHORIZED' } },
      { kind: 'humanSearch', event: { outcome: 'refused', code: 'NETWORK_NOT_AUTHORIZED' } }
    ])
    const broken = humanHarness({ fetchText: async () => { throw Error('EGRESS_TIMEOUT') } })
    await broken.network.fetchPage('https://example.com/')
    expect(broken.calls).toEqual([{ kind: 'humanFetch', event: { outcome: 'refused', code: 'EGRESS_TIMEOUT' } }])
    const noKey = humanHarness({ searchProvider: async () => { throw Error('SEARCH_NOT_CONFIGURED') } })
    await noKey.network.search('q')
    expect(noKey.calls).toEqual([{ kind: 'humanSearch', event: { outcome: 'refused', code: 'SEARCH_NOT_CONFIGURED' } }])
  })

  it('still records ok when the audit log degrades and records aborts once', async () => {
    const degraded = humanHarness({ log: { append: () => { throw Error('disk full') } } })
    await expect(degraded.network.fetchPage('https://example.com/')).resolves.toMatchObject({ ok: true, degraded: 'log-failed' })
    expect(degraded.calls).toEqual([{ kind: 'humanFetch', event: { outcome: 'ok', bytes: 12 } }])

    const pending = humanHarness({
      fetchText: (_url, options) => new Promise((_resolve, reject) => {
        const fail = (): void => reject(Error('EGRESS_ABORTED'))
        if (options.signal.aborted) { fail(); return }
        options.signal.addEventListener('abort', fail, { once: true })
      })
    })
    const request = pending.network.fetchPage('https://example.com/', { requestId: 'rid-1' })
    expect(pending.network.abort('rid-1')).toBe(true)
    await expect(request).resolves.toEqual({ ok: false, error: 'EGRESS_ABORTED' })
    expect(pending.calls).toEqual([{ kind: 'humanFetch', event: { outcome: 'refused', code: 'EGRESS_ABORTED' } }])
  })

  it('does not turn a stats failure into a network failure', async () => {
    const crashing = humanHarness({ stats: { record: () => { throw Error('stats disk full') } } })
    await expect(crashing.network.fetchPage('https://example.com/')).resolves.toMatchObject({ ok: true, bytes: 12 })
    await expect(crashing.network.search('q')).resolves.toMatchObject({ ok: true })
  })
})
