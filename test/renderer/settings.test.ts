// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettingsOverlay } from '../../src/renderer/src/settings.ts'

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute('open', '') }
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    }
  })
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('settings interface page', () => {
  it('saves a model profile without displaying a stored secret, and edits finite run limits', async () => {
    const config = {
      selected: 'custom' as const,
      profiles: {
        deepseek: { baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1000000, hasKey: false },
        minimax: { baseURL: 'https://api.minimax.io/v1', modelId: 'MiniMax-M2.7', contextTokens: 204800, hasKey: false },
        custom: { baseURL: 'http://127.0.0.1:5555/v1', modelId: 'test', contextTokens: 16000, hasKey: true }
      },
      limits: { none: { seconds: 180, steps: 4, tools: 0 }, local: { seconds: 300, steps: 12, tools: 24 }, network: { seconds: 600, steps: 20, tools: 40 } }
    }
    const setProfile = vi.fn().mockResolvedValue({ ok: true, config })
    const setLimits = vi.fn().mockResolvedValue({ ok: true, config })
    const panel = createSettingsOverlay({
      getMode: async () => 'day', setMode: async (mode) => ({ ok: true, mode }),
      getConfig: async () => ({ ok: true, config }), setProfile,
      selectModel: async () => ({ ok: true, config }), deleteKey: async () => ({ ok: true, config }), setLimits
    })
    panel.open()
    const nav = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')]
    nav.find((button) => button.textContent === '模型')?.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-key-state')?.textContent).toBe('密钥已保存'))
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('')
    const fields = [...document.querySelectorAll<HTMLInputElement>('.settings-form input')]
    fields.find((input) => input.type === 'password')!.value = 'new-key'
    const saveButton = [...document.querySelectorAll<HTMLButtonElement>('.settings-action')].find((button) => button.textContent === '保存配置')
    saveButton?.click()
    await vi.waitFor(() => expect(setProfile).toHaveBeenCalledWith(expect.objectContaining({ provider: 'custom', newKey: 'new-key' })))
    nav.find((button) => button.textContent === '运行')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('.settings-limit-group')).toHaveLength(3))
    expect(document.querySelector<HTMLInputElement>('.settings-limit-group input:disabled')?.value).toBe('0')
    const limitButton = document.querySelector<HTMLButtonElement>('.settings-limit-group .settings-action')
    limitButton?.click()
    await vi.waitFor(() => expect(setLimits).toHaveBeenCalledWith({ tier: 'none', limits: { seconds: 180, steps: 4, tools: 0 } }))
    panel.close()
  })
  it('shows only three live theme choices, saves one, and returns focus on close', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const setMode = vi.fn().mockResolvedValue({ ok: true, mode: 'night' })
    const panel = createSettingsOverlay({ getMode: async () => 'system', setMode })
    panel.open()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[value="system"]')?.checked).toBe(true))
    await vi.waitFor(() => expect(document.activeElement?.classList.contains('settings-page-title')).toBe(true))
    expect(document.querySelectorAll('.settings-choice')).toHaveLength(3)
    expect(document.querySelector('.settings-page-title')?.textContent).toBe('界面')
    document.querySelector<HTMLInputElement>('input[value="night"]')?.click()
    await vi.waitFor(() => expect(setMode).toHaveBeenCalledWith('night'))
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[value="night"]')?.checked).toBe(true))
    panel.close()
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps the prior choice and shows an error when saving fails', async () => {
    const panel = createSettingsOverlay({
      getMode: async () => 'day',
      setMode: async () => ({ ok: false, error: 'IO_ERROR' })
    })
    panel.open()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[value="day"]')?.checked).toBe(true))
    document.querySelector<HTMLInputElement>('input[value="night"]')?.click()
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.settings-error')?.textContent).toMatch(/保存失败/))
    expect(document.querySelector<HTMLInputElement>('input[value="day"]')?.checked).toBe(true)
    panel.close()
  })

  it('does not let a delayed close event erase a reopened settings panel', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute('open')
        setTimeout(() => this.dispatchEvent(new Event('close')), 0)
      }
    })
    const panel = createSettingsOverlay({ getMode: async () => 'day', setMode: async (mode) => ({ ok: true, mode }) })
    panel.open()
    panel.close()
    panel.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(panel.isOpen()).toBe(true)
    expect(document.querySelectorAll('.overlay-settings[open]')).toHaveLength(1)
    expect(document.activeElement?.classList.contains('settings-page-title'), document.activeElement?.outerHTML).toBe(true)
    panel.close()
  })
})
