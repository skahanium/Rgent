import type { LimitTier, ModelConfigResult, ModelLimitsSetRequest, ModelProfileSetRequest, ModelProvider, ThemeMode, ThemeSetResult } from '../../shared/ipc.ts'
import { openOverlay, type Overlay } from './overlay.ts'

export type SettingsHandlers = {
  getMode: () => Promise<ThemeMode>
  setMode: (mode: ThemeMode) => Promise<ThemeSetResult>
  getConfig?: () => Promise<ModelConfigResult>
  setProfile?: (request: ModelProfileSetRequest) => Promise<ModelConfigResult>
  selectModel?: (provider: ModelProvider) => Promise<ModelConfigResult>
  deleteKey?: (provider: ModelProvider) => Promise<ModelConfigResult>
  setLimits?: (request: ModelLimitsSetRequest) => Promise<ModelConfigResult>
}

export type SettingsOverlay = {
  open: () => void
  close: () => void
  isOpen: () => boolean
}

const CHOICES: Array<{ mode: ThemeMode; name: string; detail: string }> = [
  { mode: 'day', name: '日间', detail: '明亮、清晰的阅读画布' },
  { mode: 'night', name: '夜间', detail: '柔和的深蓝灰工作区' },
  { mode: 'system', name: '跟随系统', detail: '随设备外观自动切换' }
]

const CONFIG_ERRORS: Record<string, string> = {
  BAD_MODEL_CONFIG: '本机模型配置文件损坏，请先修复；笔记仍可正常使用。',
  BAD_BASE_URL: '接口地址须为 HTTPS，或本机回环地址的 HTTP。',
  BAD_MODEL_ID: '请填写有效的模型 ID。',
  BAD_CONTEXT_TOKENS: '请填写有限的正整数上下文容量。',
  BAD_API_KEY: '请填写非空密钥。',
  ENCRYPTION_UNAVAILABLE: '系统密钥保护当前不可用，密钥未保存。',
  KEY_ENCRYPT_FAILED: '密钥加密失败，原配置保持不变。',
  KEY_DECRYPT_FAILED: '已保存的密钥无法解密，请替换。',
  BAD_LIMITS: '运行上限须为允许范围内的有限整数。',
  IO_ERROR: '写入本机配置失败，原配置保持不变。'
}
const configErrorText = (error: string): string => CONFIG_ERRORS[error] ?? error

export function createSettingsOverlay(handlers: SettingsHandlers): SettingsOverlay {
  let overlay: Overlay | null = null
  let request = 0

  const close = (): void => overlay?.close()
  const open = (): void => {
    if (overlay?.isOpen()) return
    const current = openOverlay({
      label: '设置',
      initialFocus: () => current.root.querySelector<HTMLElement>('.settings-page-title'),
      onClose: () => {
        if (overlay !== current) return
        request += 1
        overlay = null
      }
    })
    overlay = current
    const root = current.root
    root.classList.add('overlay-settings')

    const header = document.createElement('div')
    header.className = 'settings-header'
    const heading = document.createElement('strong')
    heading.textContent = '设置'
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'settings-close'
    dismiss.setAttribute('aria-label', '关闭设置')
    dismiss.textContent = '×'
    dismiss.addEventListener('click', close)
    header.append(heading, dismiss)

    const layout = document.createElement('div')
    layout.className = 'settings-layout'
    const nav = document.createElement('nav')
    nav.className = 'settings-nav'
    nav.setAttribute('aria-label', '设置页面')
    const page = document.createElement('button')
    page.type = 'button'
    page.className = 'settings-nav-current'
    page.textContent = '界面'
    page.setAttribute('aria-current', 'page')
    nav.append(page)
    const main = document.createElement('section')
    main.className = 'settings-main'
    const title = document.createElement('h2')
    title.className = 'settings-page-title'
    title.tabIndex = -1
    title.textContent = '界面'
    const intro = document.createElement('p')
    intro.className = 'settings-intro'
    intro.textContent = '选择适合当下阅读与写作的外观。'
    const group = document.createElement('fieldset')
    group.className = 'settings-theme-group'
    const legend = document.createElement('legend')
    legend.textContent = '主题'
    const choices = document.createElement('div')
    choices.className = 'settings-choices'
    const error = document.createElement('p')
    error.className = 'settings-error'
    error.setAttribute('role', 'alert')
    error.hidden = true
    group.append(legend, choices, error)
    main.append(title, intro, group)
    layout.append(nav, main)
    root.append(header, layout)

    const themeNodes = [title, intro, group]
    let openedPage: '界面' | '模型' | '运行' = '界面'
    const navButtons = new Map<string, HTMLButtonElement>([['界面', page]])
    const setPage = (name: '界面' | '模型' | '运行'): void => {
      openedPage = name
      for (const [label, button] of navButtons) {
        button.className = label === name ? 'settings-nav-current' : 'settings-nav-item'
        if (label === name) button.setAttribute('aria-current', 'page')
        else button.removeAttribute('aria-current')
      }
      if (name === '界面') main.replaceChildren(...themeNodes)
      else if (name === '模型') void renderModelPage()
      else void renderRunPage()
    }
    page.addEventListener('click', () => setPage('界面'))
    if (handlers.getConfig && handlers.setProfile && handlers.selectModel && handlers.deleteKey && handlers.setLimits) {
      for (const name of ['模型', '运行'] as const) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = name
        button.className = 'settings-nav-item'
        button.addEventListener('click', () => setPage(name))
        nav.append(button)
        navButtons.set(name, button)
      }
    }

    const pageFrame = (name: string, description: string): { body: HTMLElement; error: HTMLElement } => {
      const heading = document.createElement('h2')
      heading.className = 'settings-page-title'
      heading.tabIndex = -1
      heading.textContent = name
      const sub = document.createElement('p')
      sub.className = 'settings-intro'
      sub.textContent = description
      const body = document.createElement('div')
      body.className = 'settings-form'
      const error = document.createElement('p')
      error.className = 'settings-error'
      error.setAttribute('role', 'alert')
      error.hidden = true
      main.replaceChildren(heading, sub, body, error)
      return { body, error }
    }
    const showError = (node: HTMLElement, message: string): void => {
      node.textContent = message
      node.hidden = !message
    }
    const field = (labelText: string, value: string, type = 'text'): HTMLInputElement => {
      const label = document.createElement('label')
      label.className = 'settings-field'
      const name = document.createElement('span')
      name.textContent = labelText
      const input = document.createElement('input')
      input.type = type
      input.value = value
      label.append(name, input)
      return input
    }
    const appendField = (body: HTMLElement, input: HTMLInputElement): void => { body.append(input.parentElement!) }
    const action = (label: string, click: () => void): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'settings-action'
      button.textContent = label
      button.addEventListener('click', click)
      return button
    }

    async function renderModelPage(): Promise<void> {
      if (!handlers.getConfig || !handlers.setProfile || !handlers.selectModel || !handlers.deleteKey) return
      const mine = ++request
      const { body, error } = pageFrame('模型', '配置文本模型。密钥保存在此设备，读取时只显示保存状态。')
      const result = await handlers.getConfig().catch(() => ({ ok: false, error: '读取失败' }) as ModelConfigResult)
      if (!current.isOpen() || openedPage !== '模型' || mine !== request) return
      if (!result.ok) { showError(error, `模型配置不可用：${configErrorText(result.error)}`); return }
      const config = result.config
      const provider = document.createElement('select')
      provider.className = 'settings-provider'
      const names: Record<ModelProvider, string> = { deepseek: 'DeepSeek', minimax: 'MiniMax', custom: '自定义兼容接口' }
      for (const id of ['deepseek', 'minimax', 'custom'] as ModelProvider[]) {
        const option = document.createElement('option')
        option.value = id
        option.textContent = names[id]
        provider.append(option)
      }
      provider.value = config.selected
      const providerLabel = document.createElement('label')
      providerLabel.className = 'settings-field'
      providerLabel.textContent = '供应商'
      providerLabel.append(provider)
      const base = field('接口地址', '')
      const model = field('模型 ID', '')
      const context = field('上下文容量（token）', '', 'number')
      context.min = '1'
      const secret = field('替换密钥（留空则不更改）', '', 'password')
      secret.autocomplete = 'new-password'
      const keyState = document.createElement('p')
      keyState.className = 'settings-key-state'
      const selectedState = document.createElement('p')
      selectedState.className = 'settings-key-state'
      const paintProfile = (): void => {
        const profile = config.profiles[provider.value as ModelProvider]
        base.value = profile.baseURL
        model.value = profile.modelId
        context.value = profile.contextTokens ? String(profile.contextTokens) : ''
        secret.value = ''
        keyState.textContent = profile.hasKey ? '密钥已保存' : '尚未保存密钥'
        selectedState.textContent = config.selected === provider.value ? '当前使用' : '尚未选用'
      }
      provider.addEventListener('change', paintProfile)
      paintProfile()
      const save = action('保存配置', () => {
        const id = provider.value as ModelProvider
        const newKey = secret.value.trim()
        save.disabled = true
        showError(error, '')
        void handlers.setProfile!({ provider: id, fields: { baseURL: base.value, modelId: model.value, contextTokens: Number(context.value) }, ...(newKey ? { newKey } : {}) })
          .then((updated) => {
            if (!current.isOpen() || openedPage !== '模型') return
            if (!updated.ok) { showError(error, `保存失败：${configErrorText(updated.error)}`); return }
            config.profiles = updated.config.profiles
            secret.value = ''
            paintProfile()
          }).catch(() => showError(error, '保存失败，请重试。'))
          .finally(() => { save.disabled = false })
      })
      const select = action('设为当前模型', () => {
        void handlers.selectModel!(provider.value as ModelProvider).then((updated) => {
          if (!current.isOpen() || openedPage !== '模型') return
          if (!updated.ok) { showError(error, `切换失败：${configErrorText(updated.error)}`); return }
          config.selected = updated.config.selected
          paintProfile()
          showError(error, '')
        }).catch(() => showError(error, '切换失败，请重试。'))
      })
      const remove = action('删除密钥', () => {
        void handlers.deleteKey!(provider.value as ModelProvider).then((updated) => {
          if (!current.isOpen() || openedPage !== '模型') return
          if (!updated.ok) { showError(error, `删除失败：${configErrorText(updated.error)}`); return }
          config.profiles = updated.config.profiles
          paintProfile()
          showError(error, '')
        }).catch(() => showError(error, '删除失败，请重试。'))
      })
      body.append(providerLabel)
      for (const input of [base, model, context, secret]) appendField(body, input)
      body.append(keyState, selectedState, save, select, remove)
    }

    async function renderRunPage(): Promise<void> {
      if (!handlers.getConfig || !handlers.setLimits) return
      const mine = ++request
      const { body, error } = pageFrame('运行', '上限按任务启动时的快照生效。当前最小环不调用工具。')
      const result = await handlers.getConfig().catch(() => ({ ok: false, error: '读取失败' }) as ModelConfigResult)
      if (!current.isOpen() || openedPage !== '运行' || mine !== request) return
      if (!result.ok) { showError(error, `运行设置不可用：${configErrorText(result.error)}`); return }
      const labels: Record<LimitTier, string> = { none: '无工具', local: '本地工具', network: '联网或 MCP' }
      for (const tier of ['none', 'local', 'network'] as LimitTier[]) {
        const group = document.createElement('fieldset')
        group.className = 'settings-limit-group'
        const legend = document.createElement('legend')
        legend.textContent = labels[tier]
        group.append(legend)
        const values = result.config.limits[tier]
        const seconds = field('总时长（秒）', String(values.seconds), 'number')
        const steps = field('模型步骤', String(values.steps), 'number')
        const tools = field('工具调用', String(values.tools), 'number')
        tools.disabled = tier === 'none'
        for (const input of [seconds, steps, tools]) { input.min = tier === 'none' && input === tools ? '0' : '1'; appendField(group, input) }
        const save = action('保存上限', () => {
          save.disabled = true
          void handlers.setLimits!({ tier, limits: { seconds: Number(seconds.value), steps: Number(steps.value), tools: tier === 'none' ? 0 : Number(tools.value) } })
            .then((updated) => showError(error, updated.ok ? '' : `保存失败：${configErrorText(updated.error)}`))
            .catch(() => showError(error, '保存失败，请重试。'))
            .finally(() => { save.disabled = false })
        })
        group.append(save)
        body.append(group)
      }
    }

    let selected: ThemeMode | null = null
    let busy = false
    const inputs: HTMLInputElement[] = []
    const paint = (): void => {
      for (const input of inputs) {
        input.checked = input.value === selected
        input.disabled = busy || selected === null
      }
    }
    const setError = (message: string): void => {
      error.textContent = message
      error.hidden = !message
    }
    for (const item of CHOICES) {
      const label = document.createElement('label')
      label.className = 'settings-choice'
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = 'theme-mode'
      input.value = item.mode
      input.disabled = true
      const copy = document.createElement('span')
      copy.className = 'settings-choice-copy'
      const preview = document.createElement('span')
      preview.className = `settings-choice-preview settings-preview-${item.mode}`
      preview.setAttribute('aria-hidden', 'true')
      const name = document.createElement('strong')
      name.textContent = item.name
      const detail = document.createElement('small')
      detail.textContent = item.detail
      copy.append(name, detail)
      label.append(input, preview, copy)
      choices.append(label)
      inputs.push(input)
      input.addEventListener('change', () => {
        if (!input.checked || busy || selected === item.mode) return
        const mine = ++request
        busy = true
        paint()
        setError('')
        void handlers.setMode(item.mode).then((result) => {
          if (!current.isOpen() || mine !== request) return
          if (result.ok) selected = result.mode
          else setError(result.error === 'IO_ERROR' ? '主题设置保存失败，请重试。' : '无法使用这个主题选项。')
        }).catch(() => {
          if (current.isOpen() && mine === request) setError('主题设置保存失败，请重试。')
        }).finally(() => {
          if (current.isOpen() && mine === request) {
            busy = false
            paint()
          }
        })
      })
    }
    const mine = ++request
    void handlers.getMode().then((mode) => {
      if (!current.isOpen() || mine !== request) return
      selected = mode
      paint()
    }).catch(() => {
      if (current.isOpen() && mine === request) setError('暂时无法读取主题设置。')
    })
  }

  return { open, close, isOpen: () => overlay?.isOpen() ?? false }
}
