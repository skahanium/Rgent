// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatStatsBytes,
  mountNetworkCard,
  mountNetworkGate,
  networkErrorText,
  networkStatsErrorText,
  type NetworkCardHandlers
} from '../../src/renderer/src/settings-network.ts'
import { mountNativeSearch } from '../../src/renderer/src/settings-network-page.ts'
import { hostErrorText } from '../../src/renderer/src/host-errors.ts'
import type {
  DeepSeekKeySource,
  EgressLogEntry,
  EgressLogResult,
  FetchService,
  NativeSearchProbeResult,
  NetworkConfigResult,
  NetworkProviderSaveRequest,
  NetworkConfigView,
  NetworkStatsClearResult,
  NetworkStatsResult,
  NetworkStatsView
} from '../../src/shared/ipc.ts'

afterEach(() => document.body.replaceChildren())

/** 新 v3 视图；deprecated 的 provider/hasKey 由 searchProvider/keyedProviders 推导，保持与主进程一致。 */
const view = (over: Partial<NetworkConfigView> = {}): NetworkConfigView => {
  const searchProvider = over.searchProvider !== undefined ? over.searchProvider : null
  const keyedProviders = over.keyedProviders ?? []
  return {
    enabled: false,
    searchProvider,
    keyedProviders,
    deepseekKeySource: 'own',
    fetch: 'direct',
    nativeSearch: { minimax: false },
    ...over,
    provider: searchProvider,
    hasKey: searchProvider !== null && keyedProviders.includes(searchProvider)
  }
}
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
    saveProvider: vi.fn(async (request: NetworkProviderSaveRequest) => ok(view({
      searchProvider: request.provider,
      keyedProviders: [request.provider]
    }))),
    clearProvider: vi.fn(async () => ok(view())),
    setDeepSeekKeySource: vi.fn(async (source: DeepSeekKeySource) => ok(view({
      searchProvider: 'deepseek',
      deepseekKeySource: source
    }))),
    setFetch: vi.fn(async (service: FetchService) => ok(view({ fetch: service }))),
    setNativeSearch: vi.fn(async (minimax: boolean) => ok(view({ nativeSearch: { minimax } }))),
    stats: vi.fn(async () => statsOk(statsView())),
    clearStats: vi.fn(async () => cleared),
    egressLog: vi.fn(async () => logOk()),
    ...overrides
  }
  const dispose = mountNetworkCard({ body, isCurrent: () => true }, handlers)
  return { body, handlers, dispose }
}

function mountGate(initial: NetworkConfigResult = ok(view()), overrides: Partial<Pick<NetworkCardHandlers, 'get' | 'setEnabled'>> = {}) {
  const body = document.createElement('section')
  document.body.append(body)
  const handlers = {
    get: vi.fn(async () => initial),
    setEnabled: vi.fn(async (enabled: boolean) => ok(view({ enabled }))),
    ...overrides
  }
  const dispose = mountNetworkGate({ body, isCurrent: () => true }, handlers)
  return { body, handlers, dispose }
}

describe('联网总闸（页头）', () => {
  it('默认关闭，写明只关搜索/抓取，保存失败回滚并显示人话', async () => {
    const { body, handlers } = mountGate()
    await tick()
    const toggle = node<HTMLInputElement>(body, 'enabled')
    expect(toggle.checked).toBe(false)
    expect(toggle.disabled).toBe(false)
    expect(body.textContent).toContain('关闭后内置抓页/搜索、搜索类 MCP、模型自带联网立即停止；非搜索类 MCP 不受影响')
    expect(body.textContent).toContain('与底栏最右的小球是同一个开关')
    expect(body.textContent).not.toContain('每场任务还要单独授权')
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    await tick()
    expect(handlers.setEnabled).toHaveBeenCalledWith(true)
    expect(toggle.checked).toBe(true)

    const rejected = mountGate(ok(view()), { setEnabled: vi.fn(async () => fail('IO_ERROR')) })
    await tick()
    const second = node<HTMLInputElement>(rejected.body, 'enabled')
    second.checked = true
    second.dispatchEvent(new Event('change'))
    await tick()
    expect(second.checked).toBe(false)
    expect(rejected.body.textContent).toContain(networkErrorText('IO_ERROR'))
  })
})

describe('联网搜索与抓取设置卡', () => {
  it('卡片不再放第二个总闸，只写设备搜索/抓取边界与密钥说明', async () => {
    const { body } = mount()
    await tick()
    expect(body.querySelector('[data-network="enabled"]')).toBeNull()
    expect(body.textContent).toContain('联网搜索与抓取')
    expect(body.textContent).toContain('只影响本设备的搜索/抓取；非搜索类 MCP 单独管理')
    expect(body.textContent).not.toContain('每场任务还要单独授权')
    expect(body.textContent).toContain('未配置')
    expect(body.textContent).toContain('只保存配置，不会发测试请求')
    expect(body.textContent).toContain('密钥只存本机加密，不显示')
    expect(body.querySelector<HTMLInputElement>('[data-network="key"]')!.type).toBe('password')
    expect(node<HTMLButtonElement>(body, 'clear').disabled).toBe(true)
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

  it('按 searchProvider/keyedProviders 显示每家状态，并可选择 DeepSeek', async () => {
    const { body, handlers } = mount(
      ok(view({ enabled: true, searchProvider: 'brave', keyedProviders: ['brave'] })),
      {
        saveProvider: vi.fn(async (request: NetworkProviderSaveRequest) => ok(view({
          searchProvider: request.provider,
          keyedProviders: ['brave', 'deepseek']
        })))
      }
    )
    await tick()
    const deepseek = body.querySelector<HTMLInputElement>('[data-network="provider"][data-provider="deepseek"]')!
    expect(deepseek).not.toBeNull()
    expect(body.textContent).toContain('DeepSeek')
    deepseek.checked = true
    deepseek.dispatchEvent(new Event('change'))
    // 选中的 DeepSeek 还没有密钥：状态如实显示未配置，清除也不可用。
    expect(body.textContent).toContain('未配置')
    expect(node<HTMLButtonElement>(body, 'clear').disabled).toBe(true)
    expect(body.textContent).toContain('api.deepseek.com')
    const key = node<HTMLInputElement>(body, 'key')
    key.value = 'ds-key'
    key.dispatchEvent(new Event('input'))
    node<HTMLButtonElement>(body, 'save').click()
    await tick()
    expect(handlers.saveProvider).toHaveBeenCalledWith({ provider: 'deepseek', key: 'ds-key' })
    expect(body.textContent).toContain('DeepSeek · 已配置')
    expect(node<HTMLButtonElement>(body, 'clear').disabled).toBe(false)
    // 切回 Brave：按 keyedProviders 独立判断，仍显示 Brave 已配置。
    const brave = body.querySelector<HTMLInputElement>('[data-network="provider"][data-provider="brave"]')!
    brave.checked = true
    brave.dispatchEvent(new Event('change'))
    expect(body.textContent).toContain('Brave · 已配置')
  })

  it('没有新密钥时不允许保存，避免把已保存的密钥重复提交', async () => {
    const { body, handlers } = mount(ok(view({ enabled: true, searchProvider: 'brave', keyedProviders: ['brave'] })))
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
    expect(node<HTMLInputElement>(body, 'key').disabled).toBe(true)
    expect(node<HTMLButtonElement>(body, 'save').disabled).toBe(true)
  })

  it('清除要二次确认；确认后清空输入并回到未配置', async () => {
    const { body, handlers } = mount(ok(view({ enabled: true, searchProvider: 'brave', keyedProviders: ['brave'] })))
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
    expect(handlers.clearProvider).toHaveBeenCalledWith('brave')
    expect(key.value).toBe('')
    expect(body.textContent).toContain('未配置')
  })

  it('清除失败时保留原状态并显示错误', async () => {
    const { body } = mount(ok(view({ enabled: true, searchProvider: 'brave', keyedProviders: ['brave'] })), { clearProvider: vi.fn(async () => fail('IO_ERROR')) })
    await tick()
    const clear = node<HTMLButtonElement>(body, 'clear')
    clear.click()
    clear.click()
    await tick()
    expect(body.textContent).toContain(networkErrorText('IO_ERROR'))
    expect(body.textContent).toContain('Brave · 已配置')
  })

  it('DeepSeek 密钥来源只在选中 DeepSeek 时可改，切换即保存并失败回滚', async () => {
    const { body, handlers } = mount(
      ok(view({ enabled: true, searchProvider: 'brave', keyedProviders: ['brave'] })),
      {
        setDeepSeekKeySource: vi.fn(async (source: DeepSeekKeySource) => ok(view({
          searchProvider: 'deepseek',
          keyedProviders: ['brave'],
          deepseekKeySource: source,
          fetch: 'deepseek'
        })))
      }
    )
    await tick()
    const source = node<HTMLInputElement>(body, 'deepseek-source')
    expect(source.disabled).toBe(true)
    expect(source.checked).toBe(false)
    const deepseek = body.querySelector<HTMLInputElement>('[data-network="provider"][data-provider="deepseek"]')!
    deepseek.checked = true
    deepseek.dispatchEvent(new Event('change'))
    expect(source.disabled).toBe(false)
    source.click()
    await tick()
    expect(handlers.setDeepSeekKeySource).toHaveBeenCalledWith('model')
    expect(source.checked).toBe(true)
    expect(body.textContent).toContain('DeepSeek · 使用模型页密钥')

    const rejected = mount(ok(view({ searchProvider: 'deepseek' })), {
      setDeepSeekKeySource: vi.fn(async () => fail('IO_ERROR'))
    })
    await tick()
    const failing = node<HTMLInputElement>(rejected.body, 'deepseek-source')
    expect(failing.disabled).toBe(false)
    failing.click()
    await tick()
    expect(failing.checked).toBe(false)
    expect(rejected.body.textContent).toContain(networkErrorText('IO_ERROR'))
  })

  it('抓取服务默认直连；DeepSeek 无密钥时禁用并说明先去配密钥', async () => {
    const { body } = mount(ok(view({ searchProvider: 'brave', keyedProviders: ['brave'] })))
    await tick()
    const direct = body.querySelector<HTMLInputElement>('[data-network="fetch"][data-fetch="direct"]')!
    const deepseek = body.querySelector<HTMLInputElement>('[data-network="fetch"][data-fetch="deepseek"]')!
    expect(direct.checked).toBe(true)
    expect(deepseek.checked).toBe(false)
    expect(deepseek.disabled).toBe(true)
    expect(body.textContent).toContain('先在搜索服务里保存 DeepSeek 密钥或勾选使用模型密钥')
    expect(body.textContent).toContain('会把目标网址发给 api.deepseek.com、按次计费')
    expect(body.textContent).toContain('人发起抓页仍直连')
  })

  it('有 DeepSeek 密钥或使用模型密钥时可切到 DeepSeek 代抓，保存即调 setFetch，失败回滚', async () => {
    const { body, handlers } = mount(
      ok(view({ searchProvider: 'brave', keyedProviders: ['brave', 'deepseek'] })),
      {
        setFetch: vi.fn(async (service: FetchService) => ok(view({
          searchProvider: 'brave',
          keyedProviders: ['brave', 'deepseek'],
          fetch: service
        })))
      }
    )
    await tick()
    const direct = body.querySelector<HTMLInputElement>('[data-network="fetch"][data-fetch="direct"]')!
    const deepseek = body.querySelector<HTMLInputElement>('[data-network="fetch"][data-fetch="deepseek"]')!
    expect(deepseek.disabled).toBe(false)
    deepseek.click()
    await tick()
    expect(handlers.setFetch).toHaveBeenCalledWith('deepseek')
    expect(deepseek.checked).toBe(true)
    expect(direct.checked).toBe(false)

    // 复用模型页密钥也算有凭据：抓页服务可切过去。
    const modelKey = mount(ok(view({ searchProvider: 'deepseek', deepseekKeySource: 'model' })))
    await tick()
    expect(modelKey.body.querySelector<HTMLInputElement>('[data-network="fetch"][data-fetch="deepseek"]')!.disabled).toBe(false)

    const rejected = mount(ok(view({ keyedProviders: ['deepseek'] })), {
      setFetch: vi.fn(async () => fail('IO_ERROR'))
    })
    await tick()
    const failing = rejected.body.querySelector<HTMLInputElement>('[data-network="fetch"][data-fetch="deepseek"]')!
    failing.click()
    await tick()
    expect(failing.checked).toBe(false)
    expect(rejected.body.querySelector<HTMLInputElement>('[data-network="fetch"][data-fetch="direct"]')!.checked).toBe(true)
    expect(rejected.body.textContent).toContain(networkErrorText('IO_ERROR'))
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
    expect(rows[2]!.textContent).toContain('MCP')
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

  it('shows a service column and keeps an unknown service value verbatim', async () => {
    const entries = [
      { at: '2026-10-21T05:00:00.000Z', action: 'fetch', host: 'direct.example.com', outcome: 'ok', service: 'direct' },
      { at: '2026-10-21T05:01:00.000Z', action: 'fetch', host: 'ds.example.com', outcome: 'ok', service: 'deepseek' },
      { at: '2026-10-21T05:02:00.000Z', action: 'search', host: 'other.example.com', outcome: 'refused', code: 'X', service: 'third-party' },
      { at: '2026-10-21T05:03:00.000Z', action: 'fetch', host: 'old.example.com', outcome: 'ok' }
    ] as unknown as EgressLogEntry[]
    const { body } = mount(ok(view()), { egressLog: vi.fn(async () => logOk(entries)) })
    await tick()
    const items = body.querySelectorAll<HTMLElement>('[data-network-stats="log-entry"]')
    expect(items[0]!.textContent).toContain('直连')
    expect(items[0]!.dataset.service).toBe('直连')
    expect(items[1]!.textContent).toContain('DeepSeek')
    expect(items[2]!.textContent).toContain('third-party')
    expect(items[2]!.dataset.service).toBe('third-party')
    // 旧记录没有 service：不补猜，也不显示空列。
    expect(items[3]!.textContent).not.toContain('third-party')
    expect(items[3]!.dataset.service).toBeUndefined()
    expect(statNode<HTMLElement>(body, 'log-note').textContent).toContain('服务')
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

describe('模型自带联网（设置页）', () => {
  const probeOk: NativeSearchProbeResult = { ok: true }
  const probeFail: NativeSearchProbeResult = { ok: false, error: 'NATIVE_SEARCH_UNAVAILABLE' }

  function mountNative(initial: NetworkConfigResult = ok(view()), overrides: Partial<Pick<NetworkCardHandlers, 'get' | 'setNativeSearch' | 'probe'>> = {}) {
    const body = document.createElement('section')
    document.body.append(body)
    const handlers = {
      get: vi.fn(async () => initial),
      setNativeSearch: vi.fn(async (minimax: boolean) => ok(view({ nativeSearch: { minimax } }))),
      probe: vi.fn(async () => probeOk),
      ...overrides
    }
    const dispose = mountNativeSearch({ body, isCurrent: () => true }, handlers)
    return { body, handlers, dispose }
  }
  const nativeNode = <T extends HTMLElement>(body: HTMLElement, name: string): T => body.querySelector<T>(`[data-native="${name}"]`)!

  it('勾选时先探测，成功才写配置并显示「探测通过」', async () => {
    const { body, handlers } = mountNative()
    await tick()
    const minimax = nativeNode<HTMLInputElement>(body, 'minimax')
    expect(minimax.checked).toBe(false)
    minimax.checked = true
    minimax.dispatchEvent(new Event('change'))
    await tick()
    await tick()
    expect(handlers.probe).toHaveBeenCalledTimes(1)
    expect(handlers.setNativeSearch).toHaveBeenCalledWith(true)
    expect(handlers.setNativeSearch).toHaveBeenCalledTimes(1)
    expect(minimax.checked).toBe(true)
    expect(nativeNode<HTMLElement>(body, 'status').textContent).toContain('探测通过')
    expect(nativeNode<HTMLElement>(body, 'error').hidden).toBe(true)
  })

  it('探测失败时保持未勾选、不写配置，并显示错误码人话与「不可用」', async () => {
    const { body, handlers } = mountNative(ok(view()), { probe: vi.fn(async () => probeFail) })
    await tick()
    const minimax = nativeNode<HTMLInputElement>(body, 'minimax')
    minimax.checked = true
    minimax.dispatchEvent(new Event('change'))
    await tick()
    await tick()
    expect(handlers.probe).toHaveBeenCalledTimes(1)
    expect(handlers.setNativeSearch).not.toHaveBeenCalled()
    expect(minimax.checked).toBe(false)
    expect(minimax.disabled).toBe(false)
    expect(nativeNode<HTMLElement>(body, 'status').textContent).toBe('状态：不可用')
    const error = nativeNode<HTMLElement>(body, 'error')
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe(hostErrorText('NATIVE_SEARCH_UNAVAILABLE'))
    expect(body.textContent).not.toContain('NATIVE_SEARCH_UNAVAILABLE')
  })

  it('已启用时显示探测通过；取消勾选直接写配置、不再探测', async () => {
    const { body, handlers } = mountNative(ok(view({ nativeSearch: { minimax: true } })))
    await tick()
    const minimax = nativeNode<HTMLInputElement>(body, 'minimax')
    expect(minimax.checked).toBe(true)
    expect(nativeNode<HTMLElement>(body, 'status').textContent).toContain('探测通过')
    minimax.checked = false
    minimax.dispatchEvent(new Event('change'))
    await tick()
    await tick()
    expect(handlers.probe).not.toHaveBeenCalled()
    expect(handlers.setNativeSearch).toHaveBeenCalledWith(false)
    expect(minimax.checked).toBe(false)
    expect(nativeNode<HTMLElement>(body, 'status').textContent).toBe('状态：未启用')
  })

  it('探测通过但保存失败时回滚勾选并显示保存错误', async () => {
    const { body, handlers } = mountNative(ok(view()), { setNativeSearch: vi.fn(async () => fail('IO_ERROR')) })
    await tick()
    const minimax = nativeNode<HTMLInputElement>(body, 'minimax')
    minimax.checked = true
    minimax.dispatchEvent(new Event('change'))
    await tick()
    await tick()
    expect(handlers.probe).toHaveBeenCalledTimes(1)
    expect(minimax.checked).toBe(false)
    expect(nativeNode<HTMLElement>(body, 'error').textContent).toBe(networkErrorText('IO_ERROR'))
  })
})
