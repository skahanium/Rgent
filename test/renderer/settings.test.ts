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
  it('has no top bar and closes only from backdrop or Escape', () => {
    const panel = createSettingsOverlay({ getMode: async () => 'day', setMode: async (mode) => ({ ok: true, mode }) })
    panel.open()
    let dialog = document.querySelector<HTMLDialogElement>('.overlay-settings')!
    expect(dialog.querySelector('.settings-header, .settings-close')).toBeNull()
    expect(dialog.querySelector('.settings-nav-heading')?.textContent).toBe('设置')
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 100, right: 700, bottom: 600 } as DOMRect)
    dialog.querySelector('.settings-main')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(dialog.open).toBe(true)
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 150, clientY: 150 }))
    expect(dialog.open).toBe(true)
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 20, clientY: 20 }))
    expect(dialog.open).toBe(false)

    panel.open()
    dialog = document.querySelector<HTMLDialogElement>('.overlay-settings')!
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(dialog.open).toBe(false)
  })

  it('keeps the theme selection available when its initial read finishes after changing pages', async () => {
    let finishMode!: (mode: 'night') => void
    const mode = new Promise<'night'>((resolve) => { finishMode = resolve })
    const config = {
      providers: [{ provider: 'custom' as const, configured: true, baseURL: 'http://127.0.0.1:5555/v1', hasKey: false, modelCount: 1 }],
      models: [{ id: 'm-1', provider: 'custom' as const, modelId: 'test', contextTokens: 16000 }],
      defaultModelId: 'm-1',
      limits: { none: { seconds: 180, steps: 4, tools: 0 }, local: { seconds: 300, steps: 12, tools: 24 }, network: { seconds: 600, steps: 20, tools: 40 } }
    }
    const stub = async () => ({ ok: true as const, config })
    const panel = createSettingsOverlay({
      getMode: () => mode, setMode: async (value) => ({ ok: true, mode: value }),
      getConfig: async () => ({ ok: true, config }),
      saveProvider: stub, removeProvider: stub, deleteKey: stub,
      addModel: stub, updateModel: stub, removeModel: stub, readModels: async () => ({ ok: true, models: [] }),
      setLimits: stub
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
  type FixtureConfig = {
    providers: { provider: 'deepseek' | 'minimax' | 'custom'; configured: boolean; baseURL: string; hasKey: boolean; modelCount: number }[]
    models: { id: string; provider: 'deepseek' | 'minimax' | 'custom'; modelId: string; contextTokens: number }[]
    defaultModelId: string | null
    limits: Record<'none' | 'local' | 'network', { seconds: number; steps: number; tools: number }>
  }
  const modelConfig = (overrides: Partial<FixtureConfig> = {}): FixtureConfig => ({
    providers: [
      { provider: 'deepseek', configured: true, baseURL: 'https://api.deepseek.com', hasKey: true, modelCount: 2 },
      { provider: 'minimax', configured: true, baseURL: 'https://api.minimaxi.com/v1', hasKey: true, modelCount: 1 },
      { provider: 'custom', configured: false, baseURL: '', hasKey: false, modelCount: 0 }
    ],
    models: [
      { id: 'm-ds-1', provider: 'deepseek', modelId: 'deepseek-flash', contextTokens: 1048576 },
      { id: 'm-ds-2', provider: 'deepseek', modelId: 'deepseek-reasoner', contextTokens: 65536 },
      { id: 'm-mm-1', provider: 'minimax', modelId: 'MiniMax-M3', contextTokens: 204800 }
    ],
    defaultModelId: 'm-mm-1',
    limits: { none: { seconds: 180, steps: 4, tools: 0 }, local: { seconds: 300, steps: 12, tools: 24 }, network: { seconds: 600, steps: 20, tools: 40 } },
    ...overrides
  })
  const modelHandlers = (config = modelConfig()) => ({
    getConfig: vi.fn().mockResolvedValue({ ok: true, config }),
    saveProvider: vi.fn().mockResolvedValue({ ok: true, config }),
    removeProvider: vi.fn().mockResolvedValue({ ok: true, config }),
    deleteKey: vi.fn().mockResolvedValue({ ok: true, config }),
    addModel: vi.fn().mockResolvedValue({ ok: true, config }),
    updateModel: vi.fn().mockResolvedValue({ ok: true, config }),
    removeModel: vi.fn().mockResolvedValue({ ok: true, config }),
    readModels: vi.fn().mockResolvedValue({ ok: true, models: [] }),
    setLimits: vi.fn().mockResolvedValue({ ok: true, config })
  })
  const openModelPage = async (handlers: ReturnType<typeof modelHandlers>) => {
    const panel = createSettingsOverlay({
      getMode: async () => 'day', setMode: async (mode) => ({ ok: true, mode }),
      ...handlers
    })
    panel.open()
    const nav = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')]
    nav.find((button) => button.textContent === '模型')?.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-providers')).not.toBeNull())
    return panel
  }
  const openProvider = async (handlers: ReturnType<typeof modelHandlers>, provider: string) => {
    const panel = await openModelPage(handlers)
    document.querySelector<HTMLButtonElement>(`.settings-provider-row[data-provider="${provider}"]`)!.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-back')).not.toBeNull())
    return panel
  }
  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>('.settings-action, .settings-row-action, .settings-back')].find((button) => button.textContent === text)

  it('lists every provider once and opens that provider as a sub-page', async () => {
    const handlers = modelHandlers()
    const panel = await openModelPage(handlers)
    const rows = [...document.querySelectorAll<HTMLElement>('.settings-provider-row')]
    expect(rows.map((row) => row.dataset.provider)).toEqual(['deepseek', 'minimax', 'custom'])
    expect(rows[0]!.textContent).toContain('密钥已保存 · 2 个模型')
    expect(rows[0]!.textContent).toContain('api.deepseek.com')
    expect(rows[2]!.textContent).toContain('未配置')
    // 一个供应商一份凭据：根页没有「添加连接」这类能造出第二条同厂商配置的入口
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('添加连接'))).toBe(false)

    rows[0]!.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-back')).not.toBeNull())
    expect(document.querySelector('.settings-subtitle')?.textContent).toBe('DeepSeek')
    expect([...document.querySelectorAll('.settings-model-row')].map((row) => row.querySelector('.settings-model-id')?.textContent)).toEqual(['deepseek-flash', 'deepseek-reasoner'])
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')
    expect(document.querySelector<HTMLInputElement>('.settings-field input')!.value).toBe('https://api.deepseek.com')

    buttonByText('← 供应商')!.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-providers')).not.toBeNull())
    panel.close()
  })

  it('saves one credential per provider and never provokes a second one', async () => {
    const handlers = modelHandlers()
    const panel = await openProvider(handlers, 'minimax')
    const secret = document.querySelector<HTMLInputElement>('input[type="password"]')!
    secret.value = 'new-key'
    buttonByText('保存配置')!.click()
    await vi.waitFor(() => expect(handlers.saveProvider).toHaveBeenCalledWith({
      provider: 'minimax', baseURL: 'https://api.minimaxi.com/v1', newKey: 'new-key', modelId: 'MiniMax-M3', contextTokens: 204800
    }))
    expect(handlers.saveProvider).toHaveBeenCalledTimes(1)

    const custom = modelHandlers(modelConfig({
      providers: modelConfig().providers.map((item) => item.provider === 'custom' ? { ...item, configured: true, baseURL: 'http://127.0.0.1:11434/v1', hasKey: true, modelCount: 1 } : item),
      models: [...modelConfig().models, { id: 'm-cu-1', provider: 'custom', modelId: 'local', contextTokens: 8192 }]
    }))
    const other = await openProvider(custom, 'custom')
    expect(document.querySelector<HTMLInputElement>('.settings-field input')!.value).toBe('http://127.0.0.1:11434/v1')
    other.close()
    panel.close()
  })

  it('asks for a real model id and capacity when a provider has no preset model', async () => {
    const handlers = modelHandlers(modelConfig({
      providers: modelConfig().providers.map((item) => item.provider === 'custom' ? { ...item, configured: false, baseURL: '', hasKey: false, modelCount: 0 } : item)
    }))
    const panel = await openProvider(handlers, 'custom')
    const fields = [...document.querySelectorAll<HTMLInputElement>('.settings-grid input')]
    expect(fields.map((input) => input.type)).toEqual(['text', 'password', 'text', 'number'])
    fields[2]!.value = 'local-model'
    fields[3]!.value = '128000'
    ;[...document.querySelectorAll<HTMLInputElement>('.settings-grid input')][0]!.value = 'http://127.0.0.1:11434/v1'
    buttonByText('保存配置')!.click()
    await vi.waitFor(() => expect(handlers.saveProvider).toHaveBeenCalledWith({
      provider: 'custom', baseURL: 'http://127.0.0.1:11434/v1', modelId: 'local-model', contextTokens: 128000
    }))
    expect(handlers.saveProvider.mock.calls[0]![0].modelId).not.toBe('model')
    panel.close()
  })

  it('requires a second click before clearing a provider or removing a model', async () => {
    const handlers = modelHandlers()
    const panel = await openProvider(handlers, 'deepseek')
    const clear = buttonByText('清除该供应商配置')!
    clear.click()
    expect(handlers.removeProvider).not.toHaveBeenCalled()
    expect(clear.textContent).toBe('确认删除？')
    clear.click()
    await vi.waitFor(() => expect(handlers.removeProvider).toHaveBeenCalledWith({ provider: 'deepseek' }))

    const removeModel = document.querySelectorAll<HTMLButtonElement>('.settings-model-row .settings-row-action')[1]!
    removeModel.click()
    expect(handlers.removeModel).not.toHaveBeenCalled()
    removeModel.click()
    await vi.waitFor(() => expect(handlers.removeModel).toHaveBeenCalledWith({ modelId: 'm-ds-2' }))
    panel.close()
  })

  it('edits a model capacity in place and adds a hand-written model', async () => {
    const handlers = modelHandlers()
    const panel = await openProvider(handlers, 'deepseek')
    const capacity = document.querySelectorAll<HTMLInputElement>('.settings-model-capacity')[0]!
    capacity.value = '200000'
    capacity.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(handlers.updateModel).toHaveBeenCalledWith({ modelId: 'm-ds-1', contextTokens: 200000 }))

    document.querySelector<HTMLInputElement>('.settings-add-model-id')!.value = 'deepseek-chat'
    document.querySelector<HTMLInputElement>('.settings-add-model-capacity')!.value = '65536'
    buttonByText('添加模型')!.click()
    await vi.waitFor(() => expect(handlers.addModel).toHaveBeenCalledWith({ provider: 'deepseek', modelId: 'deepseek-chat', contextTokens: 65536 }))
    panel.close()
  })

  it('keeps model reading behind a saved key and demands capacity the endpoint did not report', async () => {
    const withoutKey = modelHandlers(modelConfig({
      providers: modelConfig().providers.map((item) => item.provider === 'custom' ? { ...item, configured: true, baseURL: 'http://127.0.0.1:11434/v1', hasKey: false, modelCount: 1 } : item),
      models: [...modelConfig().models, { id: 'm-cu-1', provider: 'custom', modelId: 'local', contextTokens: 8192 }]
    }))
    const blocked = await openProvider(withoutKey, 'custom')
    expect(buttonByText('读取模型')!.disabled).toBe(true)
    blocked.close()

    const handlers = modelHandlers()
    handlers.readModels.mockResolvedValue({ ok: true, models: [{ id: 'MiniMax-M3', contextTokens: 204800 }, { id: 'MiniMax-M4' }] })
    const panel = await openProvider(handlers, 'minimax')
    buttonByText('读取模型')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('.settings-candidate')).toHaveLength(2))
    expect(handlers.readModels).toHaveBeenCalledWith({ provider: 'minimax' })
    expect([...document.querySelectorAll('.settings-candidate-note')].map((node) => node.textContent)).toEqual(['端点提供', '须填写'])
    const add = buttonByText('添加所选（2）')!
    expect(add.disabled).toBe(true)

    const capacities = document.querySelectorAll<HTMLInputElement>('.settings-candidate-capacity')
    capacities[1]!.value = '4096'
    capacities[1]!.dispatchEvent(new Event('input'))
    expect(add.disabled).toBe(false)
    add.click()
    await vi.waitFor(() => expect(handlers.addModel).toHaveBeenCalledTimes(2))
    expect(handlers.addModel.mock.calls[0]![0]).toEqual({ provider: 'minimax', modelId: 'MiniMax-M3', contextTokens: 204800 })
    expect(handlers.addModel.mock.calls[1]![0]).toEqual({ provider: 'minimax', modelId: 'MiniMax-M4', contextTokens: 4096 })
    panel.close()
  })

  it('has no set-as-current control and reports a corrupt model configuration', async () => {
    const handlers = modelHandlers()
    const panel = await openModelPage(handlers)
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('设为当前模型'))).toBe(false)
    panel.close()

    const broken = createSettingsOverlay({
      getMode: async () => 'day', setMode: async (mode) => ({ ok: true, mode }),
      ...modelHandlers(),
      getConfig: vi.fn().mockResolvedValue({ ok: false, error: 'BAD_MODEL_CONFIG' })
    })
    broken.open()
    const nav = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')]
    nav.find((button) => button.textContent === '模型')?.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-error')?.textContent).toContain('损坏'))
    broken.close()
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
