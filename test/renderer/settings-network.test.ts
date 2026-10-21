// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatStatsBytes, mountNetworkCard, networkErrorText, networkStatsErrorText, type NetworkCardHandlers } from '../../src/renderer/src/settings-network.ts'
import type {
  EgressLogEntry,
  EgressLogResult,
  NetworkConfigResult,
  NetworkProviderSaveRequest,
  NetworkConfigView,
  NetworkStatsClearResult,
  NetworkStatsResult,
  NetworkStatsView
} from '../../src/shared/ipc.ts'

afterEach(() => document.body.replaceChildren())

const view = (over: Partial<NetworkConfigView> = {}): NetworkConfigView => ({ enabled: false, provider: null, hasKey: false, ...over })
const ok = (config: NetworkConfigView): NetworkConfigResult => ({ ok: true, config })
const fail = (error: string): NetworkConfigResult => ({ ok: false, error })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const node = <T extends HTMLElement>(body: HTMLElement, name: string): T => body.querySelector<T>(`[data-network="${name}"]`)!
const statNode = <T extends HTMLElement>(body: HTMLElement, name: string): T => body.querySelector<T>(`[data-network-stats="${name}"]`)!

const count = (ok: number, refused: number, bytes: number) => ({ ok, refused, bytes })
const statsView = (over: Partial<NetworkStatsView> = {}): NetworkStatsView => ({
  version: 1,
  kinds: {
    fetch: count(0, 0, 0),
    search: count(0, 0, 0),
    mcp: count(0, 0, 0),
    humanFetch: count(0, 0, 0),
    humanSearch: count(0, 0, 0)
  },
  lastCodes: [],
  ...over
})
const statsOk = (stats: NetworkStatsView): NetworkStatsResult => ({ ok: true, stats })
const statsFail = (error: string): NetworkStatsResult => ({ ok: false, error })
const logOk = (entries: EgressLogEntry[] = [], skipped = 0): EgressLogResult => ({ ok: true, view: { entries, skipped } })
const logFail = (error: string): EgressLogResult => ({ ok: false, error })
const cleared: NetworkStatsClearResult = { ok: true }

function mount(initial: NetworkConfigResult = ok(view()), overrides: Partial<NetworkCardHandlers> = {}) {
  const body = document.createElement('section')
  document.body.append(body)
  const handlers: NetworkCardHandlers = {
    get: vi.fn(async () => initial),
    setEnabled: vi.fn(async (enabled: boolean) => ok(view({ enabled }))),
    saveProvider: vi.fn(async (request: NetworkProviderSaveRequest) => ok(view({ provider: request.provider, hasKey: true }))),
    clearProvider: vi.fn(async () => ok(view())),
    stats: vi.fn(async () => statsOk(statsView())),
    clearStats: vi.fn(async () => cleared),
    egressLog: vi.fn(async () => logOk()),
    ...overrides
  }
  const dispose = mountNetworkCard({ body, isCurrent: () => true }, handlers)
  return { body, handlers, dispose }
}

describe('联网只读设置卡', () => {
  it('默认关闭，说明只保存配置、不发测试请求、密钥不显示', async () => {
    const { body } = mount()
    await tick()
    const toggle = node<HTMLInputElement>(body, 'enabled')
    expect(toggle.checked).toBe(false)
    expect(toggle.disabled).toBe(false)
    expect(body.textContent).toContain('联网只读')
    expect(body.textContent).toContain('未配置')
    expect(body.textContent).toContain('只保存配置，不会发测试请求')
    expect(body.textContent).toContain('密钥只存本机加密，不显示')
    expect(body.querySelector<HTMLInputElement>('[data-network="key"]')!.type).toBe('password')
    expect(node<HTMLButtonElement>(body, 'clear').disabled).toBe(true)
  })

  it('保存总开关时调用 IPC，失败则回滚勾选并显示人话', async () => {
    const saved = mount()
    await tick()
    const toggle = node<HTMLInputElement>(saved.body, 'enabled')
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    await tick()
    expect(saved.handlers.setEnabled).toHaveBeenCalledWith(true)
    expect(toggle.checked).toBe(true)

    const rejected = mount(ok(view()), { setEnabled: vi.fn(async () => fail('IO_ERROR')) })
    await tick()
    const second = node<HTMLInputElement>(rejected.body, 'enabled')
    second.checked = true
    second.dispatchEvent(new Event('change'))
    await tick()
    expect(second.checked).toBe(false)
    expect(rejected.body.textContent).toContain(networkErrorText('IO_ERROR'))
  })

  it('保存服务与密钥后清空输入框，界面只显示“已配置”而不回显密钥', async () => {
    const { body, handlers } = mount()
    await tick()
    const tavily = body.querySelector<HTMLInputElement>('[data-network="provider"][data-provider="tavily"]')!
    tavily.checked = true
    tavily.dispatchEvent(new Event('change'))
    const key = node<HTMLInputElement>(body, 'key')
    key.value = 'tvly-SECRET-123'
    key.dispatchEvent(new Event('input'))
    const save = node<HTMLButtonElement>(body, 'save')
    expect(save.disabled).toBe(false)
    save.click()
    await tick()
    expect(handlers.saveProvider).toHaveBeenCalledWith({ provider: 'tavily', key: 'tvly-SECRET-123' })
    expect(key.value).toBe('')
    expect(body.textContent).not.toContain('tvly-SECRET-123')
    expect(body.textContent).toContain('Tavily · 已配置')
    expect(save.disabled).toBe(true)
  })

  it('没有新密钥时不允许保存，避免把已保存的密钥重复提交', async () => {
    const { body, handlers } = mount(ok(view({ enabled: true, provider: 'brave', hasKey: true })))
    await tick()
    const save = node<HTMLButtonElement>(body, 'save')
    expect(save.disabled).toBe(true)
    save.click()
    await tick()
    expect(handlers.saveProvider).not.toHaveBeenCalled()
    expect(body.textContent).toContain('Brave · 已配置')
  })

  it('读取失败时显示人话错误，不出现内部错误码', async () => {
    const { body } = mount(fail('BAD_NETWORK_CONFIG'))
    await tick()
    const error = node<HTMLElement>(body, 'error')
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe(networkErrorText('BAD_NETWORK_CONFIG'))
    expect(body.textContent).not.toContain('BAD_NETWORK_CONFIG')
    expect(node<HTMLInputElement>(body, 'enabled').disabled).toBe(true)
  })

  it('清除要二次确认；确认后清空输入并回到未配置', async () => {
    const { body, handlers } = mount(ok(view({ enabled: true, provider: 'brave', hasKey: true })))
    await tick()
    const key = node<HTMLInputElement>(body, 'key')
    key.value = 'typed-but-not-saved'
    key.dispatchEvent(new Event('input'))
    const clear = node<HTMLButtonElement>(body, 'clear')
    clear.click()
    await tick()
    expect(handlers.clearProvider).not.toHaveBeenCalled()
    expect(clear.textContent).toBe('确认清除？')
    clear.click()
    await tick()
    expect(handlers.clearProvider).toHaveBeenCalledTimes(1)
    expect(key.value).toBe('')
    expect(body.textContent).toContain('未配置')
  })

  it('清除失败时保留原状态并显示错误', async () => {
    const { body } = mount(ok(view({ enabled: true, provider: 'brave', hasKey: true })), { clearProvider: vi.fn(async () => fail('IO_ERROR')) })
    await tick()
    const clear = node<HTMLButtonElement>(body, 'clear')
    clear.click()
    clear.click()
    await tick()
    expect(body.textContent).toContain(networkErrorText('IO_ERROR'))
    expect(body.textContent).toContain('Brave · 已配置')
  })

  it('renders five stat rows with counts and human-readable bytes', async () => {
    const stats = statsView({
      kinds: {
        fetch: count(3, 1, 1234),
        search: count(2, 0, 0),
        mcp: count(0, 0, 0),
        humanFetch: count(1, 2, 1234567),
        humanSearch: count(4, 5, 0)
      },
      lastOkAt: '2026-10-21T05:06:07.000Z',
      lastCodes: [
        { code: 'EGRESS_TIMEOUT', at: '2026-10-21T05:00:00.000Z' },
        { code: 'SEARCH_REFUSED', at: '2026-10-21T05:01:00.000Z' },
        { code: 'EGRESS_BUSY', at: '2026-10-21T05:02:00.000Z' },
        { code: 'EGRESS_ABORTED', at: '2026-10-21T05:03:00.000Z' },
        { code: 'SEARCH_EMPTY', at: '2026-10-21T05:04:00.000Z' },
        { code: 'EGRESS_UNAVAILABLE', at: '2026-10-21T05:05:00.000Z' }
      ]
    })
    const { body } = mount(ok(view()), { stats: vi.fn(async () => statsOk(stats)) })
    await tick()
    const rows = body.querySelectorAll<HTMLElement>('[data-network-stats="row"]')
    expect(rows).toHaveLength(5)
    expect(rows[0]!.dataset.kind).toBe('fetch')
    expect(rows[0]!.textContent).toContain('抓页(AI)')
    expect(rows[0]!.textContent).toContain('成功 3')
    expect(rows[0]!.textContent).toContain('拒绝 1')
    expect(rows[0]!.textContent).toContain('1.2 KB')
    expect(rows[1]!.textContent).toContain('搜索(AI)')
    expect(rows[1]!.textContent).toContain('0 B')
    expect(rows[2]!.textContent).toContain('MCP（未启用）')
    expect(rows[3]!.textContent).toContain('抓页(人)')
    expect(rows[3]!.textContent).toContain('1.2 MB')
    expect(rows[4]!.textContent).toContain('搜索(人)')
    expect(statNode<HTMLElement>(body, 'last-ok').textContent).toContain('最近成功：')
    expect(body.querySelectorAll('[data-network-stats="code"]')).toHaveLength(5)
    expect(body.textContent).not.toContain('EGRESS_UNAVAILABLE')
    expect(statNode<HTMLElement>(body, 'corrupt').hidden).toBe(true)
  })

  it('shows a corrupt warning instead of pretending the stats are normal', async () => {
    const { body } = mount(ok(view()), { stats: vi.fn(async () => statsOk(statsView({ corrupt: true }))) })
    await tick()
    const warning = statNode<HTMLElement>(body, 'corrupt')
    expect(warning.hidden).toBe(false)
    expect(warning.textContent).toBe('统计文件损坏，已保留原文件')
    for (const row of body.querySelectorAll<HTMLElement>('[data-network-stats="row"]')) {
      expect(row.textContent).toContain('—')
    }
    expect(body.textContent).not.toContain('成功 0')
    expect(statNode<HTMLElement>(body, 'last-ok').hidden).toBe(true)
    expect(body.querySelectorAll('[data-network-stats="code"]')).toHaveLength(0)
  })

  it('clearing stats needs two clicks, then refreshes both stats and the egress log', async () => {
    const { body, handlers } = mount()
    await tick()
    const clear = statNode<HTMLButtonElement>(body, 'clear')
    clear.click()
    await tick()
    expect(handlers.clearStats).not.toHaveBeenCalled()
    expect(clear.textContent).toBe('确认清空？')
    clear.click()
    await tick()
    await tick()
    expect(handlers.clearStats).toHaveBeenCalledTimes(1)
    expect(handlers.stats).toHaveBeenCalledTimes(2)
    expect(handlers.egressLog).toHaveBeenCalledTimes(2)
    expect(clear.textContent).toBe('清空统计与外发日志')
    expect(statNode<HTMLElement>(body, 'notice').textContent).toBe('已清空统计与外发日志。')
    expect(statNode<HTMLElement>(body, 'notice').hidden).toBe(false)
  })

  it('lists recent human egress with host, time and result but never a URL or query', async () => {
    const leaky = {
      at: '2026-10-21T05:00:00.000Z',
      action: 'fetch',
      host: 'example.com',
      bytes: 12,
      outcome: 'ok',
      query: 'SECRET_QUERY',
      url: 'https://example.com/page?q=SECRET_QUERY'
    } as unknown as EgressLogEntry
    const refused: EgressLogEntry = {
      at: '2026-10-21T05:01:00.000Z',
      action: 'search',
      host: 'api.search.brave.com',
      outcome: 'refused',
      code: 'SEARCH_REFUSED'
    }
    const egressLog = vi.fn(async () => logOk([leaky, refused]))
    const { body } = mount(ok(view()), { egressLog })
    await tick()
    const items = body.querySelectorAll<HTMLElement>('[data-network-stats="log-entry"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('抓页')
    expect(items[0]!.textContent).toContain('example.com')
    expect(items[0]!.textContent).toContain('成功')
    expect(items[1]!.textContent).toContain('搜索')
    expect(items[1]!.textContent).toContain('拒绝 SEARCH_REFUSED')
    expect(body.textContent).not.toContain('SECRET_QUERY')
    expect(body.textContent).not.toContain('https://example.com/page')
    expect(egressLog).toHaveBeenCalledWith(10)
  })

  it('turns a failed stats or egress request into human text, not an internal code', async () => {
    const { body } = mount(ok(view()), {
      stats: vi.fn(async () => statsFail('IO_ERROR')),
      egressLog: vi.fn(async () => logFail('IO_ERROR'))
    })
    await tick()
    const error = statNode<HTMLElement>(body, 'error')
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe(networkStatsErrorText('IO_ERROR'))
    expect(body.textContent).not.toContain('IO_ERROR')
    expect(statNode<HTMLElement>(body, 'log-note').textContent).toContain('读取最近外发记录失败')
    expect(formatStatsBytes(1234)).toBe('1.2 KB')
    expect(formatStatsBytes(0)).toBe('0 B')
  })
})
