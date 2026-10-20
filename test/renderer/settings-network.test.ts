// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountNetworkCard, networkErrorText, type NetworkCardHandlers } from '../../src/renderer/src/settings-network.ts'
import type { NetworkConfigResult, NetworkProviderSaveRequest, NetworkConfigView } from '../../src/shared/ipc.ts'

afterEach(() => document.body.replaceChildren())

const view = (over: Partial<NetworkConfigView> = {}): NetworkConfigView => ({ enabled: false, provider: null, hasKey: false, ...over })
const ok = (config: NetworkConfigView): NetworkConfigResult => ({ ok: true, config })
const fail = (error: string): NetworkConfigResult => ({ ok: false, error })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const node = <T extends HTMLElement>(body: HTMLElement, name: string): T => body.querySelector<T>(`[data-network="${name}"]`)!

function mount(initial: NetworkConfigResult = ok(view()), overrides: Partial<NetworkCardHandlers> = {}) {
  const body = document.createElement('section')
  document.body.append(body)
  const handlers: NetworkCardHandlers = {
    get: vi.fn(async () => initial),
    setEnabled: vi.fn(async (enabled: boolean) => ok(view({ enabled }))),
    saveProvider: vi.fn(async (request: NetworkProviderSaveRequest) => ok(view({ provider: request.provider, hasKey: true }))),
    clearProvider: vi.fn(async () => ok(view())),
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
})
