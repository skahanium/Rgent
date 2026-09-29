// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettingsOverlay } from '../../src/renderer/src/settings.ts'
import { DEFAULT_READING_PREFERENCE } from '../../src/shared/reading-preference.ts'

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
  for (const key of ['--reading-font-family', '--heading-font-family', '--reading-font-size', '--reading-line-height', '--reading-max-width']) {
    document.documentElement.style.removeProperty(key)
  }
})

describe('settings interface page', () => {
  it('keeps the theme selection available when its initial read finishes after changing pages', async () => {
    let finishMode!: (mode: 'night') => void
    const mode = new Promise<'night'>((resolve) => { finishMode = resolve })
    const config = {
      selected: 'custom' as const,
      profiles: {
        deepseek: { baseURL: 'https://api.deepseek.com', modelId: 'deepseek-chat', contextTokens: 64000, hasKey: false },
        minimax: { baseURL: 'https://api.minimax.io/v1', modelId: 'MiniMax-M2.7', contextTokens: 204800, hasKey: false },
        custom: { baseURL: 'http://127.0.0.1:5555/v1', modelId: 'test', contextTokens: 16000, hasKey: false }
      },
      limits: { none: { seconds: 180, steps: 4, tools: 0 }, local: { seconds: 300, steps: 12, tools: 24 }, network: { seconds: 600, steps: 20, tools: 40 } }
    }
    const panel = createSettingsOverlay({
      getMode: () => mode, setMode: async (value) => ({ ok: true, mode: value }),
      getConfig: async () => ({ ok: true, config }),
      setProfile: async () => ({ ok: true, config }),
      selectModel: async () => ({ ok: true, config }),
      deleteKey: async () => ({ ok: true, config }),
      setLimits: async () => ({ ok: true, config })
    })
    panel.open()
    const nav = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')]
    nav.find((button) => button.textContent === '模型')!.click()
    finishMode('night')
    await vi.waitFor(() => expect(document.querySelector('.settings-page-title')?.textContent).toBe('模型'))
    nav.find((button) => button.textContent === '界面')!.click()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[value="night"]')?.checked).toBe(true))
    expect(document.querySelector<HTMLInputElement>('input[value="day"]')?.disabled).toBe(false)
    panel.close()
  })

  it('previews reading typography locally, discards it on close, and applies only after save', async () => {
    const saved = { ...DEFAULT_READING_PREFERENCE }
    const setReading = vi.fn(async (reading) => ({ ok: true as const, reading }))
    const panel = createSettingsOverlay({
      getMode: async () => 'day', setMode: async (mode) => ({ ok: true, mode }),
      getReading: async () => saved, setReading
    })
    panel.open()
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[data-setting="bodyFont"]')?.value).toBe('literary'))
    const bodyFont = document.querySelector<HTMLSelectElement>('[data-setting="bodyFont"]')!
    bodyFont.value = 'humanist'
    bodyFont.dispatchEvent(new Event('change', { bubbles: true }))
    expect(document.querySelector<HTMLElement>('.settings-reading-sample')?.style.getPropertyValue('--reading-font-family')).toContain('sans-serif')
    expect(document.documentElement.style.getPropertyValue('--reading-font-family')).toBe('')
    panel.close()
    panel.open()
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[data-setting="bodyFont"]')?.value).toBe('literary'))
    const size = document.querySelector<HTMLInputElement>('[data-setting="fontSize"]')!
    size.value = '19'
    size.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('.settings-reading-save')?.click()
    await vi.waitFor(() => expect(setReading).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 19 })))
    await vi.waitFor(() => expect(document.documentElement.style.getPropertyValue('--reading-font-size')).toBe('19px'))
    panel.close()
  })

  it('keeps the workspace typography when saving reading preferences fails', async () => {
    const panel = createSettingsOverlay({
      getMode: async () => 'night', setMode: async (mode) => ({ ok: true, mode }),
      getReading: async () => DEFAULT_READING_PREFERENCE,
      setReading: async () => ({ ok: false, error: 'IO_ERROR' })
    })
    panel.open()
    await vi.waitFor(() => expect(document.querySelector('[data-setting="lineHeight"]')).not.toBeNull())
    const previous = document.documentElement.style.getPropertyValue('--reading-line-height')
    const lineHeight = document.querySelector<HTMLInputElement>('[data-setting="lineHeight"]')!
    lineHeight.value = '1.8'
    lineHeight.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('.settings-reading-save')?.click()
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.settings-reading-error')?.textContent).toMatch(/保存失败/))
    expect(document.documentElement.style.getPropertyValue('--reading-line-height')).toBe(previous)
    panel.close()
  })
  it('recognizes an unchanged reading choice regardless of stored object key order', async () => {
    const reversed = { maxWidth: 768, lineHeight: 1.65, fontSize: 17, headingFont: 'system' as const, bodyFont: 'literary' as const }
    const panel = createSettingsOverlay({
      getMode: async () => 'day', setMode: async (mode) => ({ ok: true, mode }),
      getReading: async () => reversed,
      setReading: async (reading) => ({ ok: true, reading })
    })
    panel.open()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-setting="fontSize"]')?.value).toBe('17'))
    const size = document.querySelector<HTMLInputElement>('[data-setting="fontSize"]')!
    size.value = '18'; size.dispatchEvent(new Event('input', { bubbles: true }))
    size.value = '17'; size.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelector<HTMLButtonElement>('.settings-reading-save')?.disabled).toBe(true)
    panel.close()
  })

  it('applies an explicitly submitted preference even when the panel closes before saving finishes', async () => {
    let finish!: (result: { ok: true; reading: typeof DEFAULT_READING_PREFERENCE }) => void
    const pending = new Promise<{ ok: true; reading: typeof DEFAULT_READING_PREFERENCE }>((resolve) => { finish = resolve })
    const panel = createSettingsOverlay({
      getMode: async () => 'day', setMode: async (mode) => ({ ok: true, mode }),
      getReading: async () => DEFAULT_READING_PREFERENCE,
      setReading: async () => pending
    })
    panel.open()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-setting="fontSize"]')?.value).toBe('17'))
    const size = document.querySelector<HTMLInputElement>('[data-setting="fontSize"]')!
    size.value = '19'
    size.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('.settings-reading-save')!.click()
    panel.close()
    expect(document.documentElement.style.getPropertyValue('--reading-font-size')).toBe('')
    finish({ ok: true, reading: { ...DEFAULT_READING_PREFERENCE, fontSize: 19 } })
    await vi.waitFor(() => expect(document.documentElement.style.getPropertyValue('--reading-font-size')).toBe('19px'))
  })
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
