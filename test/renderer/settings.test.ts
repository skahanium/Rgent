// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettingsOverlay } from '../../src/renderer/src/settings.ts'
import { DEFAULT_READING_PREFERENCE } from '../../src/shared/reading-preference.ts'
import type { AssistantHabits } from '../../src/shared/assistant.ts'
import type { AssistantResult } from '../../src/shared/ipc.ts'

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
  for (const key of ['--reading-font-family', '--heading-font-family', '--reading-font-size', '--reading-line-height', '--reading-max-width', '--tab-name-font-size', '--sidebar-name-font-size']) {
    document.documentElement.style.removeProperty(key)
  }
})

it('previews interface text only in samples and applies it after a successful save', async () => {
  const setChromeText = vi.fn(async (value: unknown) => ({ ok: true, preference: value }))
  const panel = createSettingsOverlay({ getMode: async () => 'day', setMode: async (mode: string) => ({ ok: true, mode }),
    getChromeText: async () => ({ tabs: 'default', sidebar: 'default' }), setChromeText } as never)
  panel.open()
  await new Promise(resolve => setTimeout(resolve, 0))
  const select = document.querySelector<HTMLSelectElement>('[data-setting="chrome-tabs"]')
  expect(select).not.toBeNull()
  select!.value = 'large'; select!.dispatchEvent(new Event('change', { bubbles: true }))
  expect(document.documentElement.style.getPropertyValue('--tab-name-font-size')).toBe('')
  document.querySelector<HTMLButtonElement>('.settings-chrome-save')!.click()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(setChromeText).toHaveBeenCalledWith({ tabs: 'large', sidebar: 'default' })
  expect(document.documentElement.style.getPropertyValue('--tab-name-font-size')).toContain('+ 1px')
  panel.close()
  document.documentElement.style.removeProperty('--tab-name-font-size')
  document.documentElement.style.removeProperty('--sidebar-name-font-size')
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

  it.each(['CONNECTION_NOT_FOUND', 'MODEL_NOT_FOUND', 'BAD_PROVIDER', 'DUPLICATE_MODEL', 'TOO_MANY_MODELS', 'secret internal stack', 'constructor', 'toString', '__proto__'])('shows readable configuration failures without internal detail: %s', async (error) => {
    const handlers = modelHandlers()
    handlers.addModel.mockResolvedValue({ ok: false, error })
    const panel = await openProvider(handlers, 'minimax')
    buttonByText('添加模型')!.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-error')?.textContent).toBeTruthy())
    const message = document.querySelector('.settings-error')!.textContent!
    expect(message).not.toContain(error)
    expect(message).toMatch(/[\u4e00-\u9fff]/)
    panel.close()
  })

  it('keeps failed and unattempted candidates and publishes partial batch success once', async () => {
    const config = modelConfig()
    const updated = modelConfig({ models: [...config.models, { id: 'new', provider: 'minimax', modelId: 'added', contextTokens: 4096 }] })
    const changed = vi.fn()
    const handlers = { ...modelHandlers(), onModelConfigChanged: changed }
    handlers.readModels.mockResolvedValue({ ok: true, models: [
      { id: 'added', contextTokens: 4096 }, { id: 'existing', contextTokens: 4096 }, { id: 'failed' }, { id: 'later', contextTokens: 4096 }
    ] })
    handlers.addModel.mockResolvedValueOnce({ ok: true, config: updated }).mockResolvedValueOnce({ ok: false, error: 'DUPLICATE_MODEL' }).mockResolvedValueOnce({ ok: false, error: 'TOO_MANY_MODELS' })
    const panel = await openProvider(handlers, 'minimax')
    buttonByText('读取模型')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('.settings-candidate')).toHaveLength(4))
    const capacity = document.querySelector<HTMLInputElement>('[aria-label="failed 的上下文容量"]')!
    capacity.value = '8192'; capacity.dispatchEvent(new Event('input'))
    buttonByText('添加所选（4）')!.click()
    await vi.waitFor(() => expect(handlers.addModel).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(document.querySelectorAll('.settings-candidate')).toHaveLength(2))
    expect([...document.querySelectorAll('.settings-candidate-id')].map(node => node.textContent)).toEqual(['failed', 'later'])
    expect(document.querySelector<HTMLInputElement>('[aria-label="failed 的上下文容量"]')!.value).toBe('8192')
    expect(document.querySelector<HTMLInputElement>('.settings-candidate input[type="checkbox"]')!.checked).toBe(true)
    expect([...document.querySelectorAll('.settings-model-id')].map(node => node.textContent)).toContain('added')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.settings-read-panel')!.textContent).toContain('已添加 1 个，已存在 1 个，失败 1 个，未尝试 1 个')
    panel.close()
  })

  it('explains an all-existing batch without treating duplicates as failure', async () => {
    const handlers = modelHandlers()
    handlers.readModels.mockResolvedValue({ ok: true, models: [{ id: 'existing', contextTokens: 4096 }] })
    handlers.addModel.mockResolvedValue({ ok: false, error: 'DUPLICATE_MODEL' })
    const panel = await openProvider(handlers, 'minimax')
    buttonByText('读取模型')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('.settings-candidate')).toHaveLength(1))
    buttonByText('添加所选（1）')!.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-read-panel')!.textContent).toContain('已存在的模型无需重复添加。'))
    expect(document.querySelector('.settings-error')?.textContent).toBe('')
    panel.close()
  })

  it('ignores a model-list reply from a previous supplier and request', async () => {
    const handlers = modelHandlers()
    let finishOld!: (result: unknown) => void
    handlers.readModels.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValueOnce({ ok: true, models: [{ id: 'new-list', contextTokens: 4096 }] })
    const panel = await openProvider(handlers, 'minimax')
    buttonByText('读取模型')!.click()
    document.querySelector<HTMLButtonElement>('.settings-back')!.click()
    document.querySelector<HTMLButtonElement>('[data-provider="deepseek"]')!.click()
    const read = document.querySelector<HTMLButtonElement>('.settings-read-row button')!
    expect(read.disabled).toBe(false)
    read.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-candidate-id')?.textContent).toBe('new-list'))
    finishOld({ ok: true, models: [{ id: 'old-list', contextTokens: 8192 }] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelector('.settings-candidate-id')?.textContent).toBe('new-list')
    panel.close()
  })

  it('publishes each saved batch result before a later pending item and ignores its reply after leaving', async () => {
    const changed = vi.fn()
    const config = modelConfig()
    const updated = modelConfig({ models: [...config.models, { id: 'new', provider: 'minimax', modelId: 'saved', contextTokens: 4096 }] })
    const handlers = { ...modelHandlers(), onModelConfigChanged: changed }
    handlers.readModels.mockResolvedValue({ ok: true, models: [{ id: 'saved', contextTokens: 4096 }, { id: 'pending', contextTokens: 4096 }] })
    let finish!: (result: unknown) => void
    handlers.addModel.mockResolvedValueOnce({ ok: true, config: updated })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const panel = await openProvider(handlers, 'minimax')
    buttonByText('读取模型')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('.settings-candidate')).toHaveLength(2))
    buttonByText('添加所选（2）')!.click()
    await vi.waitFor(() => expect(handlers.addModel).toHaveBeenCalledTimes(2))
    expect(changed).toHaveBeenCalledTimes(1)
    expect([...document.querySelectorAll('.settings-model-id')].map(node => node.textContent)).toContain('saved')
    expect([...document.querySelectorAll('.settings-candidate-id')].map(node => node.textContent)).toEqual(['pending'])
    ;[...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')].find(node => node.textContent === '界面')!.click()
    finish({ ok: true, config: updated })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.settings-page-title')?.textContent).toBe('界面')
    panel.close()
  })

  it('does not publish an adding callback after leaving the model page', async () => {
    const changed = vi.fn()
    const handlers = { ...modelHandlers(), onModelConfigChanged: changed }
    handlers.readModels.mockResolvedValue({ ok: true, models: [{ id: 'pending', contextTokens: 4096 }] })
    let finish!: (result: unknown) => void
    handlers.addModel.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const panel = await openProvider(handlers, 'minimax')
    buttonByText('读取模型')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('.settings-candidate')).toHaveLength(1))
    buttonByText('添加所选（1）')!.click()
    ;[...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')].find(node => node.textContent === '界面')!.click()
    finish({ ok: true, config: modelConfig() })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(changed).not.toHaveBeenCalled()
    expect(document.querySelector('.settings-page-title')?.textContent).toBe('界面')
    panel.close()
  })

  it('disables batch controls while adding and ignores late callbacks after closing', async () => {
    const changed = vi.fn()
    const handlers = { ...modelHandlers(), onModelConfigChanged: changed }
    handlers.readModels.mockResolvedValue({ ok: true, models: [{ id: 'pending', contextTokens: 4096 }] })
    let finish!: (result: unknown) => void
    handlers.addModel.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const panel = await openProvider(handlers, 'minimax')
    buttonByText('读取模型')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('.settings-candidate')).toHaveLength(1))
    const add = buttonByText('添加所选（1）')!
    add.click(); add.click()
    expect(handlers.addModel).toHaveBeenCalledTimes(1)
    expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.settings-read-panel input, .settings-read-panel button')].every(node => node.disabled)).toBe(true)
    expect(buttonByText('读取模型')!.disabled).toBe(true)
    panel.close()
    finish({ ok: true, config: modelConfig() })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(changed).not.toHaveBeenCalled()
    expect(document.querySelector('.overlay-settings')).toBeNull()
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

  it('edits the assistant habits with an explicit save and a reset that still needs saving', async () => {
    const saved = { address: '老陈', tone: 'concise' as const, note: '先给结论' }
    const getAssistant = vi.fn().mockResolvedValue({ ok: true, habits: saved })
    const setAssistant = vi.fn().mockResolvedValue({ ok: true, habits: { address: '小陈', tone: 'detailed' as const, note: '多说一步' } })
    const panel = createSettingsOverlay({
      getMode: async () => 'day', setMode: async (mode) => ({ ok: true, mode }),
      getAssistant, setAssistant
    })
    panel.open()
    const nav = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')]
    expect(nav.map((button) => button.textContent)).toEqual(['界面', '助手'])
    nav.find((button) => button.textContent === '助手')?.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-page-title')?.textContent).toBe('助手'))
    const address = document.querySelector<HTMLInputElement>('.settings-form input')!
    const tone = document.querySelector<HTMLSelectElement>('.settings-form select')!
    const note = document.querySelector<HTMLTextAreaElement>('.settings-form textarea')!
    expect([address.value, tone.value, note.value]).toEqual(['老陈', 'concise', '先给结论'])
    expect(address.maxLength).toBe(40)
    expect(note.maxLength).toBe(500)
    expect(document.querySelector('.settings-hint')?.textContent).toContain('补充说明已用 4 / 500 字')
    const save = (): HTMLButtonElement | undefined => [...document.querySelectorAll<HTMLButtonElement>('.settings-action')].find((button) => button.textContent === '保存')
    expect(save()!.disabled).toBe(true)

    address.value = '小陈'
    address.dispatchEvent(new Event('input'))
    expect(save()!.disabled).toBe(false)
    save()!.click()
    await vi.waitFor(() => expect(setAssistant).toHaveBeenCalledWith({ address: '小陈', tone: 'concise', note: '先给结论' }))

    await vi.waitFor(() => expect(note.value).toBe('多说一步'))
    await Promise.resolve()
    await Promise.resolve()
    expect(save()!.disabled).toBe(true)

    ;[...document.querySelectorAll<HTMLButtonElement>('.settings-action')].find((button) => button.textContent === '恢复默认')!.click()
    expect(address.value).toBe('')
    expect(tone.value).toBe('plain')
    expect(save()!.disabled).toBe(false)
    expect(setAssistant).toHaveBeenCalledTimes(1)
    // 输入草稿原样计数，trim 只发生在保存时
    note.value = '先说结论 '
    note.dispatchEvent(new Event('input'))
    expect(note.value).toBe('先说结论 ')
    expect(document.querySelector('.settings-hint')?.textContent).toContain('已用 5 / 500 字')
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

describe('assistant default model', () => {
  it('saves independently from habits and retains failed model selection', async () => {
    const config = {
      providers: [{ provider: 'custom' as const, configured: true, baseURL: 'http://127.0.0.1:5555/v1', hasKey: true, modelCount: 2 }],
      models: [{ id: 'one', provider: 'custom' as const, modelId: 'one', contextTokens: 16000 }, { id: 'two', provider: 'custom' as const, modelId: 'two', contextTokens: 16000 }],
      defaultModelId: 'one',
      limits: { none: { seconds: 180, steps: 4, tools: 0 }, local: { seconds: 300, steps: 12, tools: 24 }, network: { seconds: 600, steps: 20, tools: 40 } }
    }
    const setDefaultModel = vi.fn().mockResolvedValueOnce({ ok: false, error: 'IO_ERROR' }).mockResolvedValueOnce({ ok: true, config: { ...config, defaultModelId: 'two' } })
    const setAssistant = vi.fn()
    const onChanged = vi.fn()
    const panel = createSettingsOverlay({ getMode: async () => 'day', setMode: async mode => ({ ok: true, mode }),
      getAssistant: async () => ({ ok: true, habits: { address: '', tone: 'plain', note: '' } }), setAssistant,
      getConfig: async () => ({ ok: true, config }), setDefaultModel, onModelConfigChanged: onChanged })
    panel.open('助手')
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('.assistant-default-model')?.value).toBe('one'))
    const select = document.querySelector<HTMLSelectElement>('.assistant-default-model')!
    const save = document.querySelector<HTMLButtonElement>('.assistant-default-save')!
    select.value = 'two'; select.dispatchEvent(new Event('change')); save.click()
    await vi.waitFor(() => expect(document.querySelector('.assistant-default-error')?.textContent).toContain('原配置保持不变'))
    expect(select.value).toBe('two'); expect(save.disabled).toBe(false)
    expect(setAssistant).not.toHaveBeenCalled(); expect(onChanged).not.toHaveBeenCalled()
    save.click()
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(setDefaultModel).toHaveBeenLastCalledWith({ modelId: 'two' })
    expect(save.disabled).toBe(true)
    panel.close()
  })
})


it('keeps interface text unchanged on cancel and preserves a failed draft for retry', async () => {
  const setChromeText = vi.fn().mockResolvedValueOnce({ ok: false, error: 'IO_ERROR' }).mockResolvedValueOnce({ ok: true, preference: { tabs: 'small', sidebar: 'large' } })
  const panel = createSettingsOverlay({ getMode: async () => 'day', setMode: async (mode: 'day' | 'night' | 'system') => ({ ok: true, mode }),
    getChromeText: async () => ({ tabs: 'default', sidebar: 'default' }), setChromeText })
  panel.open()
  await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[data-setting="chrome-tabs"]')!.disabled).toBe(false))
  let tab = document.querySelector<HTMLSelectElement>('[data-setting="chrome-tabs"]')!
  tab.value = 'large'; tab.dispatchEvent(new Event('change'))
  panel.close()
  expect(setChromeText).not.toHaveBeenCalled()
  expect(document.documentElement.style.getPropertyValue('--tab-name-font-size')).toBe('')
  panel.open()
  await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[data-setting="chrome-tabs"]')!.disabled).toBe(false))
  tab = document.querySelector<HTMLSelectElement>('[data-setting="chrome-tabs"]')!
  const sidebar = document.querySelector<HTMLSelectElement>('[data-setting="chrome-sidebar"]')!
  tab.value = 'small'; sidebar.value = 'large'; tab.dispatchEvent(new Event('change'))
  const save = document.querySelector<HTMLButtonElement>('.settings-chrome-save')!
  save.click()
  await vi.waitFor(() => expect(save.disabled).toBe(false))
  expect(tab.value).toBe('small'); expect(sidebar.value).toBe('large')
  expect(document.querySelector('.settings-chrome-section')!.textContent).toContain('保存失败')
  expect(document.documentElement.style.getPropertyValue('--tab-name-font-size')).toBe('')
  save.click()
  await vi.waitFor(() => expect(document.documentElement.style.getPropertyValue('--tab-name-font-size')).toContain('max(12px'))
  panel.close()
})

it('does not let an old closed-panel save receipt overwrite a newer saved interface size', async () => {
  const receipts: Array<(value: { ok: true; preference: { tabs: 'small' | 'large'; sidebar: 'default' } }) => void> = []
  const panel = createSettingsOverlay({ getMode: async () => 'day', setMode: async (mode: 'day' | 'night' | 'system') => ({ ok: true, mode }),
    getChromeText: async () => ({ tabs: 'default', sidebar: 'default' }),
    setChromeText: () => new Promise(resolve => receipts.push(resolve)) })
  for (const size of ['small', 'large']) {
    panel.open()
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[data-setting="chrome-tabs"]')!.disabled).toBe(false))
    const select = document.querySelector<HTMLSelectElement>('[data-setting="chrome-tabs"]')!
    select.value = size; select.dispatchEvent(new Event('change'))
    document.querySelector<HTMLButtonElement>('.settings-chrome-save')!.click()
    expect(select.disabled).toBe(true)
    panel.close()
  }
  receipts[1]!({ ok: true, preference: { tabs: 'large', sidebar: 'default' } })
  await vi.waitFor(() => expect(document.documentElement.style.getPropertyValue('--tab-name-font-size')).toContain('+ 1px'))
  receipts[0]!({ ok: true, preference: { tabs: 'small', sidebar: 'default' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(document.documentElement.style.getPropertyValue('--tab-name-font-size')).toContain('+ 1px')
})

it('previews the real tab truncation structure and directory/resource type icons', async () => {
  const panel = createSettingsOverlay({ getMode: async () => 'day', setMode: async (mode: 'day' | 'night' | 'system') => ({ ok: true, mode }),
    getChromeText: async () => ({ tabs: 'default', sidebar: 'default' }), setChromeText: async preference => ({ ok: true, preference }) })
  panel.open()
  const sample = document.querySelector('.settings-chrome-sample')!
  expect(sample.querySelector('.tab .tab-label')).not.toBeNull()
  expect(sample.querySelectorAll('.tree-row .icon')).toHaveLength(3)
  panel.close()
})

it.each(['edit', 'reset'] as const)('preserves assistant %s while the initial read is in flight', async mode => {
  let finish!: (value: AssistantResult) => void
  const pending = new Promise<AssistantResult>(resolve => { finish = resolve })
  const setAssistant = vi.fn(async (habits: AssistantHabits) => ({ ok: true as const, habits }))
  const panel = createSettingsOverlay({ getMode: async () => 'day', setMode: async mode => ({ ok: true, mode }),
    getAssistant: () => pending, setAssistant })
  panel.open('助手')
  const note = document.querySelector<HTMLTextAreaElement>('.settings-form textarea')!
  const save = [...document.querySelectorAll<HTMLButtonElement>('.settings-action')].find(button => button.textContent === '保存')!
  expect(save.disabled).toBe(true)
  if (mode === 'edit') {
    note.value = '新草稿\n第二行'; note.dispatchEvent(new Event('input'))
  } else {
    [...document.querySelectorAll<HTMLButtonElement>('.settings-action')].find(button => button.textContent === '恢复默认')!.click()
  }
  expect(save.disabled).toBe(true)
  save.click(); expect(setAssistant).not.toHaveBeenCalled()
  finish({ ok: true, habits: { address: '原称呼', tone: 'concise', note: '磁盘旧说明' } })
  await vi.waitFor(() => expect(save.disabled).toBe(false))
  expect(note.value).toBe(mode === 'edit' ? '新草稿\n第二行' : '')
  save.click()
  await vi.waitFor(() => expect(setAssistant).toHaveBeenCalledWith(mode === 'edit'
    ? { address: '原称呼', tone: 'concise', note: '新草稿\n第二行' }
    : { address: '', tone: 'plain', note: '' }))
  panel.close()
})

it('retains assistant draft after a failed initial read without allowing an unchecked save', async () => {
  let finish!: (value: AssistantResult) => void
  const pending = new Promise<AssistantResult>(resolve => { finish = resolve })
  const setAssistant = vi.fn(async (habits: AssistantHabits) => ({ ok: true as const, habits }))
  const panel = createSettingsOverlay({ getMode: async () => 'day', setMode: async mode => ({ ok: true, mode }),
    getAssistant: () => pending, setAssistant })
  panel.open('助手')
  const note = document.querySelector<HTMLTextAreaElement>('.settings-form textarea')!
  note.value = '未保存的新输入\n第二行'; note.dispatchEvent(new Event('input'))
  finish({ ok: false, error: 'BAD_ASSISTANT' })
  await vi.waitFor(() => expect(document.querySelector('.settings-error')?.textContent).not.toBe(''))
  expect(note.value).toBe('未保存的新输入\n第二行')
  const save = [...document.querySelectorAll<HTMLButtonElement>('.settings-action')].find(button => button.textContent === '保存')!
  expect(save.disabled).toBe(true)
  save.click(); expect(setAssistant).not.toHaveBeenCalled()
  panel.close()
})

it('does not overwrite assistant edits made while a save receipt is in flight', async () => {
  let finish!: (result: { ok: true; habits: { address: string; tone: 'plain'; note: string } }) => void
  const pending = new Promise<{ ok: true; habits: { address: string; tone: 'plain'; note: string } }>(resolve => { finish = resolve })
  const panel = createSettingsOverlay({ getMode: async () => 'day', setMode: async mode => ({ ok: true, mode }),
    getAssistant: async () => ({ ok: true, habits: { address: '', tone: 'plain', note: '原说明' } }), setAssistant: () => pending })
  panel.open('助手')
  await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>('.settings-form textarea')?.value).toBe('原说明'))
  const note = document.querySelector<HTMLTextAreaElement>('.settings-form textarea')!
  const save = [...document.querySelectorAll<HTMLButtonElement>('.settings-action')].find(button => button.textContent === '保存')!
  note.value = '第一次保存'; note.dispatchEvent(new Event('input')); save.click()
  note.value = '保存途中新增'; note.dispatchEvent(new Event('input'))
  finish({ ok: true, habits: { address: '', tone: 'plain', note: '第一次保存' } })
  await vi.waitFor(() => expect(save.disabled).toBe(false))
  expect(note.value).toBe('保存途中新增')
  panel.close()
})

it('retains memory drafts when visiting another settings page in the same open dialog',async()=>{
 const value={sessionId:'session',revision:null,objectVersion:null,config:{defaultModelId:null,limits:{seconds:120,calls:2,tools:0},vault:{enabled:false,override:{mode:'inherit'}},effectiveModelId:null,modelStatus:'missing'},recipient:null,status:'ready',entries:[],jobs:[],running:{permits:0,pending:0,active:0}}
 const panel=createSettingsOverlay({getMode:async()=>'day',setMode:vi.fn(),memory:()=>({get:async()=>({ok:true,value}),models:async()=>({ok:false,error:'IO_ERROR'})})} as never)
 panel.open('记忆');await new Promise(r=>setTimeout(r,0))
 const enabled=document.querySelector<HTMLInputElement>('[data-memory="vault-enabled"]')!;enabled.checked=true;enabled.dispatchEvent(new Event('change'))
 const go=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')].find(b=>b.textContent===name)!.click()
 go('界面');go('记忆');await new Promise(r=>setTimeout(r,0))
 expect(document.querySelector('[data-memory="vault-enabled"]')).toBe(enabled)
 expect(enabled.checked).toBe(true);expect(document.querySelector('[data-memory="vault-draft"]')!.textContent).toContain('尚未保存')
 panel.close()
})
it('refreshes the model options on return without clearing an unsaved memory model choice',async()=>{
 const value={sessionId:'session',revision:null,objectVersion:null,config:{defaultModelId:null,limits:{seconds:120,calls:2,tools:0},vault:{enabled:false,override:{mode:'inherit'}},effectiveModelId:null,modelStatus:'missing'},recipient:null,status:'ready',entries:[],jobs:[],running:{permits:0,pending:0,active:0}}
 const config={defaultModelId:null,models:[{id:'m',modelId:'整理样张',provider:'custom',contextTokens:32000}],providers:[{provider:'custom',configured:true,hasKey:true,modelCount:1,baseURL:'http://localhost:1234'}],limits:{}}
 const panel=createSettingsOverlay({getMode:async()=>'day',setMode:vi.fn(),memory:()=>({get:async()=>({ok:true,value}),models:async()=>({ok:true,config})})} as never)
 panel.open('记忆');await new Promise(r=>setTimeout(r,0))
 const select=document.querySelector<HTMLSelectElement>('[data-memory="default-model"]')!;select.value='m';select.dispatchEvent(new Event('change'))
 const go=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')].find(b=>b.textContent===name)!.click()
 go('界面');go('记忆');await new Promise(r=>setTimeout(r,0))
 expect(document.querySelector('[data-memory="default-model"]')).toBe(select);expect(select.value).toBe('m')
 expect(document.querySelector('.memory-model-grid [role="status"]')!.textContent).toBe('尚未保存')
 panel.close()
})

it('keeps settings drafts when switching is cancelled and keeps the panel through accepted preparation', async () => {
  const save = vi.fn()
  const panel = createSettingsOverlay({ getMode: async () => 'day', setMode: async (mode: 'day' | 'night' | 'system') => ({ ok: true, mode }),
    getChromeText: async () => ({ tabs: 'default', sidebar: 'default' }), setChromeText: save } as never)
  panel.open()
  await new Promise(resolve => setTimeout(resolve, 0))
  const input = document.querySelector<HTMLSelectElement>('[data-setting="chrome-tabs"]')!
  input.value = 'large'; input.dispatchEvent(new Event('change', { bubbles: true }))
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  try {
    expect(panel.prepareVaultChange()).toBe(false)
    expect(panel.isOpen()).toBe(true)
    expect(input.value).toBe('large')
    expect(save).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    expect(panel.prepareVaultChange()).toBe(true)
    expect(panel.isOpen()).toBe(true)
  } finally { confirm.mockRestore(); panel.close() }
})

const vaultFlush = async () => { for (let i=0;i<8;i++) await Promise.resolve() }
function vaultSettings(overrides: Record<string,unknown> = {}) {
 const catalog = {revision:'r1',diagnostic:null,lastVaultId:'a',activeId:'a',entries:[{id:'a',label:'本库',path:'/a',rootIdentity:'a',pinned:false,lastUsed:1},{id:'b',label:'其它库',path:'/b',rootIdentity:'b',pinned:false,lastUsed:0}]}
 const vault = {get:async()=>catalog, open:vi.fn(async()=>{}), pick:vi.fn(async()=>{}), change:vi.fn(async(r:{label?:string})=>({...catalog,revision:'r2',entries:catalog.entries.map(e=>e.id==='a'?{...e,label:r.label??e.label}:e)})),...overrides}
 const panel=createSettingsOverlay({getMode:async()=>'day',setMode:async mode=>({ok:true,mode}),vault})
 return {panel,vault,go:(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')].find(b=>b.textContent===name)!.click()}
}
it('routes vault management into an already open settings dialog and defaults ordinary open to interface',async()=>{
 const {panel}=vaultSettings();panel.open();const dialog=document.querySelector('dialog')!
 expect(document.querySelector('.settings-page-title')!.textContent).toBe('界面')
 panel.open('笔记库');await vaultFlush()
 expect(document.querySelectorAll('dialog')).toHaveLength(1);expect(document.querySelector('dialog')).toBe(dialog)
 expect([...document.querySelectorAll('.settings-nav button')].map(b=>b.textContent)).toEqual(['笔记库','界面'])
 expect(document.querySelector('.settings-page-title')!.textContent).toBe('笔记库');panel.close()
})
it('guards busy vault operations against Escape, backdrop, direct routing and navigation',async()=>{
 let reject!:(error:Error)=>void;const pending=new Promise<void>((_,no)=>{reject=no})
 const {panel,go}=vaultSettings({open:()=>pending});panel.open('笔记库');await vaultFlush()
 document.querySelector<HTMLButtonElement>('[data-vault-open="b"]')!.click()
 const dialog=document.querySelector<HTMLDialogElement>('dialog')!
 dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 vi.spyOn(dialog,'getBoundingClientRect').mockReturnValue({left:100,top:100,right:700,bottom:600} as DOMRect)
 dialog.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:20,clientY:20}))
 go('界面');panel.open('界面');expect(panel.isOpen()).toBe(true);expect(document.querySelector('.settings-page-title')!.textContent).toBe('笔记库')
 reject(Error('VAULT_SWITCH_CANCELLED'));await vaultFlush();go('界面');expect(document.querySelector('.settings-page-title')!.textContent).toBe('界面');panel.close()
})
it('tracks unsaved name locally and stops treating successfully saved names as general settings edits',async()=>{
 const {panel}=vaultSettings();panel.open('笔记库');await vaultFlush()
 document.querySelector<HTMLButtonElement>('[data-vault-action="edit-name"]')!.click()
 const input=document.querySelector<HTMLInputElement>('.vault-settings-name input')!;input.value='已保存名';input.dispatchEvent(new Event('input',{bubbles:true}))
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 try {
 expect(panel.prepareVaultChange()).toBe(false);expect(confirm).toHaveBeenCalledTimes(1)
 document.querySelector<HTMLButtonElement>('[data-vault-action="label"]')!.click();await vaultFlush()
 expect(panel.prepareVaultChange()).toBe(true);expect(confirm).toHaveBeenCalledTimes(1);expect(panel.isOpen()).toBe(true)
 } finally {confirm.mockRestore();panel.close()}
})

it('repeated ordinary settings entry and same vault route preserve an active name draft',async()=>{
 const {panel}=vaultSettings();panel.open('笔记库');await vaultFlush()
 document.querySelector<HTMLButtonElement>('[data-vault-action="edit-name"]')!.click()
 const input=document.querySelector<HTMLInputElement>('.vault-settings-name input')!; input.value='新草稿'
 panel.open();panel.open('笔记库')
 expect(document.querySelector('.settings-page-title')!.textContent).toBe('笔记库')
 expect(document.querySelector('.vault-settings-name input')).toBe(input);expect(input.value).toBe('新草稿');panel.close()
})
it('reopens the vault page before a delayed prior close without reusing its disposed page',async()=>{
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open');setTimeout(()=>this.dispatchEvent(new Event('close')),0)}})
 const {panel}=vaultSettings();panel.open('笔记库');await vaultFlush();panel.close();panel.open('笔记库');await vaultFlush()
 expect(document.querySelector('dialog[open] .vault-settings [data-vault-id="a"]')).not.toBeNull()
 await new Promise(resolve=>setTimeout(resolve,0));expect(panel.isOpen()).toBe(true);panel.close()
})

it('offers all six available pages with vault management first in workspace',()=>{
 const {vault}=vaultSettings()
 const config={providers:[],models:[],defaultModelId:null,limits:{none:{seconds:180,steps:4,tools:0},local:{seconds:300,steps:12,tools:24},network:{seconds:600,steps:20,tools:40}}}
 const ok=async()=>({ok:true as const,config})
 const panel=createSettingsOverlay({getMode:async()=>'day',setMode:async mode=>({ok:true,mode}),vault,memory:()=>null,
 getAssistant:async()=>({ok:true,habits:{address:'',tone:'plain',note:''}}),setAssistant:async habits=>({ok:true,habits}),
 getConfig:ok,saveProvider:ok,removeProvider:ok,deleteKey:ok,addModel:ok,updateModel:ok,removeModel:ok,readModels:async()=>({ok:true,models:[]}),setLimits:ok})
 panel.open();expect([...document.querySelectorAll('.settings-nav button')].map(b=>b.textContent)).toEqual(['笔记库','界面','助手','记忆','模型','运行'])
 expect(document.querySelector('.settings-page-title')!.textContent).toBe('界面');panel.close()
})
it('ignores an initial vault receipt after navigating away from its page',async()=>{
 let resolve!:(value:unknown)=>void;const pending=new Promise(resolvePromise=>{resolve=resolvePromise})
 const {panel,go}=vaultSettings({get:()=>pending});panel.open('笔记库');await vaultFlush()
 const body=document.querySelector('.vault-settings')!;const before=body.textContent
 go('界面');resolve({revision:'later',diagnostic:null,lastVaultId:null,entries:[]});await vaultFlush()
 expect(document.querySelector('.settings-page-title')!.textContent).toBe('界面');expect(body.textContent).toBe(before);panel.close()
})
it('allows the restore owner to close a busy dialog programmatically',async()=>{
 let resolve!:()=>void;const pending=new Promise<void>(yes=>{resolve=yes})
 const {panel}=vaultSettings({open:()=>pending});panel.open('笔记库');await vaultFlush()
 document.querySelector<HTMLButtonElement>('[data-vault-open="b"]')!.click();expect(panel.isOpen()).toBe(true)
 panel.close();expect(panel.isOpen()).toBe(false);resolve();await vaultFlush();expect(document.querySelector('dialog')).toBeNull()
})
it('reports library busy state to native and global entry guards until cancellation settles',async()=>{
 let reject!:(error:Error)=>void;const pending=new Promise<void>((_,no)=>{reject=no})
 const {panel}=vaultSettings({open:()=>pending});panel.open('笔记库');await vaultFlush()
 expect(panel.isBusy).toBeTypeOf('function');expect(panel.isBusy()).toBe(false)
 document.querySelector<HTMLButtonElement>('[data-vault-open="b"]')!.click();expect(panel.isBusy()).toBe(true)
 reject(Error('VAULT_SWITCH_CANCELLED'));await vaultFlush();expect(panel.isBusy()).toBe(false);panel.close()
})
