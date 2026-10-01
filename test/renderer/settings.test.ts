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
      connections: [{ id: 'c-1', provider: 'custom' as const, baseURL: 'http://127.0.0.1:5555/v1', hasKey: false, modelCount: 1 }],
      models: [{ id: 'm-1', connectionId: 'c-1', modelId: 'test', contextTokens: 16000 }],
      defaultModelId: 'm-1',
      limits: { none: { seconds: 180, steps: 4, tools: 0 }, local: { seconds: 300, steps: 12, tools: 24 }, network: { seconds: 600, steps: 20, tools: 40 } }
    }
    const stub = async () => ({ ok: true as const, config })
    const panel = createSettingsOverlay({
      getMode: () => mode, setMode: async (value) => ({ ok: true, mode: value }),
      getConfig: async () => ({ ok: true, config }),
      addConnection: stub, updateConnection: stub, removeConnection: stub, deleteKey: stub,
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
    connections: { id: string; provider: 'deepseek' | 'minimax' | 'custom'; baseURL: string; hasKey: boolean; modelCount: number }[]
    models: { id: string; connectionId: string; modelId: string; contextTokens: number }[]
    defaultModelId: string | null
    limits: Record<'none' | 'local' | 'network', { seconds: number; steps: number; tools: number }>
  }
  const modelConfig = (overrides: Partial<FixtureConfig> = {}): FixtureConfig => ({
    connections: [
      { id: 'c-deepseek', provider: 'deepseek' as const, baseURL: 'https://api.deepseek.com', hasKey: true, modelCount: 2 },
      { id: 'c-minimax', provider: 'minimax' as const, baseURL: 'https://api.minimaxi.com/v1', hasKey: true, modelCount: 1 }
    ],
    models: [
      { id: 'm-ds-1', connectionId: 'c-deepseek', modelId: 'deepseek-flash', contextTokens: 1048576 },
      { id: 'm-ds-2', connectionId: 'c-deepseek', modelId: 'deepseek-reasoner', contextTokens: 65536 },
      { id: 'm-mm-1', connectionId: 'c-minimax', modelId: 'MiniMax-M3', contextTokens: 204800 }
    ],
    defaultModelId: 'm-mm-1',
    limits: { none: { seconds: 180, steps: 4, tools: 0 }, local: { seconds: 300, steps: 12, tools: 24 }, network: { seconds: 600, steps: 20, tools: 40 } }
  , ...overrides })
  const modelHandlers = (config = modelConfig()) => ({
    getConfig: vi.fn().mockResolvedValue({ ok: true, config }),
    addConnection: vi.fn().mockResolvedValue({ ok: true, config }),
    updateConnection: vi.fn().mockResolvedValue({ ok: true, config }),
    removeConnection: vi.fn().mockResolvedValue({ ok: true, config }),
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
    await vi.waitFor(() => expect(document.querySelector('.settings-connections')).not.toBeNull())
    return panel
  }
  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>('.settings-action, .settings-row-action')].find((button) => button.textContent === text)

  it('lists connections with key state and model count, and edits the selected one', async () => {
    const handlers = modelHandlers()
    const panel = await openModelPage(handlers)
    const cards = [...document.querySelectorAll<HTMLElement>('.settings-connection')]
    expect(cards).toHaveLength(2)
    expect(cards[0]!.classList.contains('is-active')).toBe(true)
    expect(cards[0]!.textContent).toContain('DeepSeek')
    expect(cards[0]!.textContent).toContain('密钥已保存 · 2 个模型')
    expect(cards[0]!.textContent).toContain('api.deepseek.com')
    expect(document.querySelector('.settings-key-state')?.textContent).toBe('密钥已保存')
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')

    cards[1]!.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-page-title + .settings-intro')?.textContent).toContain('底栏'))
    expect(document.querySelector<HTMLElement>('.settings-connection.is-active')!.textContent).toContain('MiniMax')
    expect([...document.querySelectorAll('.settings-model-row')].map((row) => row.querySelector('.settings-model-id')?.textContent)).toEqual(['MiniMax-M3'])
    panel.close()
  })

  it('adds a connection from the provider preset and saves a replaced key without echoing it', async () => {
    const handlers = modelHandlers()
    const panel = await openModelPage(handlers)
    buttonByText('添加连接')!.click()
    await vi.waitFor(() => expect(handlers.addConnection).toHaveBeenCalled())
    const added = handlers.addConnection.mock.calls[0]![0] as Record<string, unknown>
    expect(added).toEqual({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576 })

    const secret = document.querySelector<HTMLInputElement>('input[type="password"]')!
    secret.value = 'new-key'
    buttonByText('保存连接')!.click()
    await vi.waitFor(() => expect(handlers.updateConnection).toHaveBeenCalledWith({
      connectionId: 'c-deepseek', baseURL: 'https://api.deepseek.com', newKey: 'new-key'
    }))
    panel.close()
  })

  it('requires a second click before removing a connection or a model', async () => {
    const handlers = modelHandlers()
    const panel = await openModelPage(handlers)
    const removeConnection = buttonByText('删除连接')!
    removeConnection.click()
    expect(handlers.removeConnection).not.toHaveBeenCalled()
    expect(removeConnection.textContent).toBe('确认删除？')
    removeConnection.click()
    await vi.waitFor(() => expect(handlers.removeConnection).toHaveBeenCalledWith({ connectionId: 'c-deepseek' }))

    const removeModel = document.querySelectorAll<HTMLButtonElement>('.settings-model-row .settings-row-action')[1]!
    removeModel.click()
    expect(handlers.removeModel).not.toHaveBeenCalled()
    removeModel.click()
    await vi.waitFor(() => expect(handlers.removeModel).toHaveBeenCalledWith({ modelId: 'm-ds-2' }))
    panel.close()
  })

  it('edits a model capacity in place and adds a hand-written model', async () => {
    const handlers = modelHandlers()
    const panel = await openModelPage(handlers)
    const capacity = document.querySelectorAll<HTMLInputElement>('.settings-model-capacity')[0]!
    capacity.value = '200000'
    capacity.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(handlers.updateModel).toHaveBeenCalledWith({ modelId: 'm-ds-1', contextTokens: 200000 }))

    const id = document.querySelector<HTMLInputElement>('.settings-add-model-id')!
    const size = document.querySelector<HTMLInputElement>('.settings-add-model-capacity')!
    id.value = 'deepseek-chat'
    size.value = '65536'
    buttonByText('添加模型')!.click()
    await vi.waitFor(() => expect(handlers.addModel).toHaveBeenCalledWith({ connectionId: 'c-deepseek', modelId: 'deepseek-chat', contextTokens: 65536 }))
    panel.close()
  })

  it('reads models as candidates and demands capacity the endpoint did not report', async () => {
    const handlers = modelHandlers()
    handlers.readModels.mockResolvedValue({
      ok: true,
      models: [{ id: 'MiniMax-M3', contextTokens: 204800 }, { id: 'MiniMax-M4' }]
    })
    const panel = await openModelPage(handlers)
    buttonByText('读取模型')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('.settings-candidate')).toHaveLength(2))
    expect(handlers.readModels).toHaveBeenCalledWith({ connectionId: 'c-deepseek' })
    const notes = [...document.querySelectorAll('.settings-candidate-note')].map((node) => node.textContent)
    expect(notes).toEqual(['端点提供', '须填写'])
    const add = buttonByText('添加所选（2）')!
    expect(add.disabled).toBe(true)

    const capacities = document.querySelectorAll<HTMLInputElement>('.settings-candidate-capacity')
    capacities[1]!.value = '4096'
    capacities[1]!.dispatchEvent(new Event('input'))
    expect(add.disabled).toBe(false)
    add.click()
    await vi.waitFor(() => expect(handlers.addModel).toHaveBeenCalledTimes(2))
    expect(handlers.addModel.mock.calls[0]![0]).toEqual({ connectionId: 'c-deepseek', modelId: 'MiniMax-M3', contextTokens: 204800 })
    expect(handlers.addModel.mock.calls[1]![0]).toEqual({ connectionId: 'c-deepseek', modelId: 'MiniMax-M4', contextTokens: 4096 })
    panel.close()
  })

  it('guides instead of showing a dead page when nothing is configured, and has no set-as-current control', async () => {
    const handlers = modelHandlers({ ...modelConfig(), connections: [], models: [], defaultModelId: null })
    const panel = await openModelPage(handlers)
    expect(document.querySelector('.settings-empty')?.textContent).toContain('还没有连接')
    expect(buttonByText('添加连接')).toBeTruthy()
    expect(document.querySelector('.settings-models')).toBeNull()
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('设为当前模型'))).toBe(false)
    panel.close()
  })

  it('reports a corrupt model configuration in the shared alert area', async () => {
    const panel = createSettingsOverlay({
      getMode: async () => 'day', setMode: async (mode) => ({ ok: true, mode }),
      ...modelHandlers(),
      getConfig: vi.fn().mockResolvedValue({ ok: false, error: 'BAD_MODEL_CONFIG' })
    })
    panel.open()
    const nav = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')]
    nav.find((button) => button.textContent === '模型')?.click()
    await vi.waitFor(() => expect(document.querySelector('.settings-error')?.textContent).toContain('损坏'))
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
