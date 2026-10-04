import { mountVaultManager, type VaultManagerHandlers, type VaultManagerPage } from './vault-manager.ts'
import { mountMemoryPage, memoryErrorText, type MemoryPageHandlers } from './memory-ui.ts'
import type {
  AssistantResult, LimitTier, ModelAddRequest, ModelConfigResult, ModelKeyDeleteRequest, ModelLimitsSetRequest,
  ModelListRequest, ModelListResult, ModelProviderRemoveRequest, ModelProviderSaveRequest, ModelRemoveRequest,
  ModelUpdateRequest, ModelDefaultSetRequest, ReadingPreference, ReadingSetResult, ThemeMode, ThemeSetResult
} from '../../shared/ipc.ts'
import { isReadingPreference, READING_FONTS } from '../../shared/reading-preference.ts'
import { CHROME_TEXT_SIZES, isChromeTextPreference, type ChromeTextPreference } from '../../shared/reading-preference.ts'
import type { ChromeTextSetResult } from '../../shared/ipc.ts'
import { mountModelPage, modelPageAvailable, type ModelPageHandlers } from './settings-model.ts'
import { ASSISTANT_LIMITS, ASSISTANT_TONE_LABELS, ASSISTANT_TONES, DEFAULT_ASSISTANT_HABITS, isAssistantHabits, type AssistantHabits, type AssistantTone } from '../../shared/assistant.ts'
import { openOverlay, type Overlay } from './overlay.ts'
import { applyChromeTextPreference, applyReadingPreference } from './reading.ts'
import { modelModuleGroups } from './statusbar.ts'
import { icon, type IconName } from './icons.ts'

export type SettingsHandlers = {
  vault?: VaultManagerHandlers
  memory?: () => MemoryPageHandlers | null

  getMode: () => Promise<ThemeMode>
  setMode: (mode: ThemeMode) => Promise<ThemeSetResult>
  getReading?: () => Promise<ReadingPreference>
  setReading?: (reading: ReadingPreference) => Promise<ReadingSetResult>
  getChromeText?: () => Promise<ChromeTextPreference>
  setChromeText?: (value: ChromeTextPreference) => Promise<ChromeTextSetResult>
  getConfig?: () => Promise<ModelConfigResult>
  saveProvider?: (request: ModelProviderSaveRequest) => Promise<ModelConfigResult>
  removeProvider?: (request: ModelProviderRemoveRequest) => Promise<ModelConfigResult>
  deleteKey?: (request: ModelKeyDeleteRequest) => Promise<ModelConfigResult>
  addModel?: (request: ModelAddRequest) => Promise<ModelConfigResult>
  updateModel?: (request: ModelUpdateRequest) => Promise<ModelConfigResult>
  removeModel?: (request: ModelRemoveRequest) => Promise<ModelConfigResult>
  readModels?: (request: ModelListRequest) => Promise<ModelListResult>
  setDefaultModel?: (request: ModelDefaultSetRequest) => Promise<ModelConfigResult>
  setLimits?: (request: ModelLimitsSetRequest) => Promise<ModelConfigResult>
  /** 配置写入后通知外壳刷新底栏模型模块。 */
  onModelConfigChanged?: () => void
  getAssistant?: () => Promise<AssistantResult>
  setAssistant?: (habits: AssistantHabits) => Promise<AssistantResult>
  /** 设置面板关闭后通知外壳（底栏模型模块据此取一次最新配置）。 */
  onClose?: () => void
}

type SettingsPage = '笔记库' | '界面' | '助手' | '记忆' | '模型' | '运行'

export type SettingsOverlay = {
  /** 打开设置；可指定落到哪一页（底栏模型模块的「配置」用它直达「模型」页）。 */
  open: (page?: SettingsPage) => void
  close: () => void
  isOpen: () => boolean
  isBusy: () => boolean
  prepareVaultChange: () => boolean
}

const CHOICES: Array<{ mode: ThemeMode; name: string; detail: string }> = [
  { mode: 'day', name: '日间', detail: '明亮、清晰的阅读画布' },
  { mode: 'night', name: '夜间', detail: '柔和的深蓝灰工作区' },
  { mode: 'system', name: '跟随系统', detail: '随设备外观自动切换' }
]

const FONT_NAMES: Record<(typeof READING_FONTS)[number], string> = {
  literary: '典雅衬线', song: '宋体阅读', system: '系统无衬线', humanist: '人文无衬线'
}
const sameReading = (left: ReadingPreference, right: ReadingPreference): boolean =>
  left.bodyFont === right.bodyFont && left.headingFont === right.headingFont &&
  left.fontSize === right.fontSize && left.lineHeight === right.lineHeight && left.maxWidth === right.maxWidth

const CONFIG_ERRORS: Record<string, string> = {
  CONNECTION_NOT_FOUND: '这个供应商连接已不存在，请重新配置。',
  MODEL_NOT_FOUND: '这个模型已不存在，请重新选择或添加。',
  BAD_PROVIDER: '无法使用这个供应商，请重新选择。',
  DUPLICATE_MODEL: '这个模型已经存在，无需重复添加。',
  TOO_MANY_MODELS: '已达到模型数量上限，请先移除不再使用的模型。',
  BAD_MODEL_CONFIG: '本机模型配置文件损坏，请先修复；笔记仍可正常使用。',
  BAD_BASE_URL: '接口地址须为 HTTPS，或本机回环地址的 HTTP。',
  BAD_MODEL_ID: '请填写有效的模型 ID。',
  BAD_CONTEXT_TOKENS: '请填写有限的正整数上下文容量。',
  BAD_API_KEY: '请填写非空密钥。',
  ENCRYPTION_UNAVAILABLE: '系统密钥保护当前不可用，密钥未保存。',
  KEY_ENCRYPT_FAILED: '密钥加密失败，原配置保持不变。',
  KEY_DECRYPT_FAILED: '已保存的密钥无法解密，请替换。',
  BAD_LIMITS: '运行上限须为允许范围内的有限整数。',
  IO_ERROR: '写入本机配置失败，原配置保持不变。',
  BAD_ASSISTANT: '助手习惯不合法：称呼或说明过长、含控制字符，或语气取值不对。'
}
const configErrorText = (error: string): string => Object.hasOwn(CONFIG_ERRORS, error)
  ? CONFIG_ERRORS[error]!
  : '操作未完成，请重试；仍然失败时请检查模型配置。'

export function createSettingsOverlay(handlers: SettingsHandlers): SettingsOverlay {
  let overlay: Overlay | null = null
  let inputsEdited = false
  let vaultPage: VaultManagerPage | null = null
  let vaultBusy = false
  let navigate: ((page: SettingsPage) => void) | null = null
  let request = 0
  let readingSaveSerial = 0
  let chromeTextSaveSerial = 0

  const close = (): void => overlay?.close()
  const open = (page?: SettingsPage): void => {
    if (overlay?.isOpen()) { if (page && !vaultBusy) navigate?.(page); return }
    page ??= '界面'
    // A native close event can arrive after the caller has reopened this dialog.
    vaultPage?.dispose(); vaultPage = null; vaultBusy = false
    const current = openOverlay({
      label: '设置',
      canDismiss: () => !vaultBusy,
      initialFocus: () => current.root.querySelector<HTMLElement>('.settings-page-title'),
      onClose: () => {
        if (overlay !== current) return
        request += 1
        overlay = null
        navigate = null
        vaultPage?.dispose(); vaultPage = null; vaultBusy = false
        disposeMemoryPage?.()
        disposeMemoryPage = null
        disposeModelPage?.()
        disposeModelPage = null
        disposeAssistantPage?.()
        disposeAssistantPage = null
        handlers.onClose?.()
      }
    })
    overlay = current
    inputsEdited = false
    const root = current.root
    const trackInput = (event: Event): void => {
      if (!(event.target instanceof Element) || !event.target.closest('.vault-settings')) inputsEdited = true
    }
    root.addEventListener('input', trackInput)
    root.addEventListener('change', trackInput)
    root.classList.add('overlay-settings')
    root.addEventListener('click', (event) => {
      if (vaultBusy || event.target !== root || event.detail === 0) return
      const bounds = root.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX >= bounds.right ||
          event.clientY < bounds.top || event.clientY >= bounds.bottom) close()
    })

    const layout = document.createElement('div')
    layout.className = 'settings-layout'
    const nav = document.createElement('nav')
    nav.className = 'settings-nav'
    nav.setAttribute('aria-label', '设置页面')
    const navHeading = document.createElement('strong')
    navHeading.className = 'settings-nav-heading'
    navHeading.textContent = '设置'
    nav.append(navHeading)
    const navGroup = (name: string): void => {
      const label = document.createElement('p')
      label.className = 'settings-nav-group'
      label.textContent = name
      nav.append(label)
    }
    const navButtons = new Map<string, HTMLButtonElement>()
    const addNav = (name: SettingsPage, graphic: IconName): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = name === '界面' ? 'settings-nav-current' : 'settings-nav-item'
      if (name === '界面') button.setAttribute('aria-current', 'page')
      button.append(icon(graphic), document.createTextNode(name))
      nav.append(button)
      navButtons.set(name, button)
      button.addEventListener('click', () => setPage(name))
      return button
    }
    navGroup('工作区')
    if (handlers.vault) addNav('笔记库', 'folder')
    addNav('界面', 'appearance')
    const assistantReady = Boolean(handlers.getAssistant && handlers.setAssistant)
    const modelsReady = modelPageAvailable(handlers) && Boolean(handlers.setLimits)
    if (assistantReady || modelsReady || handlers.memory) {
      navGroup('Agent')
      if (assistantReady) addNav('助手', 'assistant')
      if (handlers.memory) addNav('记忆', 'memory')
      if (modelsReady) {
        addNav('模型', 'model')
        addNav('运行', 'run')
      }
    }
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
    const readingSection = document.createElement('section')
    readingSection.className = 'settings-reading'
    main.append(title, intro, group, readingSection)
    layout.append(nav, main)
    root.append(layout)
    const themeNodes = [title, intro, group, readingSection]
    let openedPage: SettingsPage = '界面'
    let themeRequest = 0
    const setPage = (name: SettingsPage): void => {
      if (vaultBusy || !navButtons.has(name) || openedPage === name) return
      if (name !== '笔记库') { vaultPage?.dispose(); vaultPage = null }
      openedPage = name
      if (name !== '模型') { disposeModelPage?.(); disposeModelPage = null }
      if (name !== '助手') disposeAssistantPage?.()
      for (const [label, button] of navButtons) {
        button.className = label === name ? 'settings-nav-current' : 'settings-nav-item'
        if (label === name) button.setAttribute('aria-current', 'page')
        else button.removeAttribute('aria-current')
      }
      if (name === '笔记库') renderVaultPage()
      else if (name === '界面') main.replaceChildren(...themeNodes)
      else if (name === '助手') renderAssistantPage()
      else if (name === '记忆') renderMemoryPage()
      else if (name === '模型') renderModelPage()
      else void renderRunPage()
    }

    navigate = setPage

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

    function renderVaultPage(): void {
      if (!handlers.vault || vaultPage) return
      const { body } = pageFrame('笔记库', '管理这台设备上的笔记库。切换时会保存当前笔记，并恢复目标库上次的工作位置。')
      vaultPage = mountVaultManager({ body, isCurrent: () => current.isOpen() && openedPage === '笔记库', onBusyChange: busy => {
        vaultBusy = busy
        for (const button of navButtons.values()) button.disabled = busy
      } }, handlers.vault)
    }

    let disposeAssistantPage: (() => void) | null = null
    function renderAssistantPage(): void {
      if (!handlers.getAssistant || !handlers.setAssistant) return
      disposeAssistantPage?.()
      let disposed = false
      disposeAssistantPage = () => { disposed = true }
      const { body, error } = pageFrame('助手', '一个助手的设备级习惯，所有笔记库共用；它不改变笔记权限与工具范围。')
      let saved: AssistantHabits = { ...DEFAULT_ASSISTANT_HABITS }
      let draft: AssistantHabits = { ...DEFAULT_ASSISTANT_HABITS }
      let savingHabits = false
      let loadingHabits = true
      const editedHabits = new Set<keyof AssistantHabits>()
      const same = (left: AssistantHabits, right: AssistantHabits): boolean =>
        left.address === right.address && left.tone === right.tone && left.note === right.note

      const address = field('称呼（怎么称呼你，可留空）', '')
      address.maxLength = ASSISTANT_LIMITS.address
      const toneLabel = document.createElement('label')
      toneLabel.className = 'settings-field'
      const toneName = document.createElement('span')
      toneName.textContent = '语气'
      const tone = document.createElement('select')
      for (const value of ASSISTANT_TONES) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = ASSISTANT_TONE_LABELS[value]
        tone.append(option)
      }
      toneLabel.append(toneName, tone)
      const noteLabel = document.createElement('label')
      noteLabel.className = 'settings-field settings-field-block'
      const noteName = document.createElement('span')
      noteName.textContent = '补充说明（人写的附加要求）'
      const note = document.createElement('textarea')
      note.rows = 4
      note.maxLength = ASSISTANT_LIMITS.note
      noteLabel.append(noteName, note)
      const counter = document.createElement('p')
      counter.className = 'settings-hint'
      const scope = document.createElement('p')
      scope.className = 'settings-hint'
      scope.textContent = '本设备共用一个助手；多助手、记忆与技能不在此页。习惯只影响模型怎么回答，不改变权限、范围与工具。'
      const actions = document.createElement('div')
      actions.className = 'settings-actions'
      const save = action('保存', () => {
        if (loadingHabits || savingHabits) return
        savingHabits = true; save.disabled = true
        const submitted = { address: address.value, tone: tone.value, note: note.value }
        const next: AssistantHabits = { address: address.value.trim(), tone: tone.value as AssistantTone, note: note.value.trim() }
        showError(error, '')
        void handlers.setAssistant!({ ...next }).then((result) => {
          if (disposed || !current.isOpen() || openedPage !== '助手') return
          if (!result.ok) { showError(error, configErrorText(result.error)); return }
          saved = { ...result.habits }
          // 主进程回执只续接已保存值，不能抹掉等待期间继续输入的字符。
          if (address.value === submitted.address && tone.value === submitted.tone && note.value === submitted.note) {
            draft = { ...result.habits }; paint()
          } else paintState()
        }).catch(() => { if (!disposed) showError(error, '保存失败，请重试。') })
          .finally(() => { if (!disposed) { savingHabits = false; paintState() } })
      })
      const reset = action('恢复默认', () => {
        for (const key of ['address', 'tone', 'note'] as const) editedHabits.add(key)
        draft = { ...DEFAULT_ASSISTANT_HABITS }
        paint()
      })
      actions.append(save, reset)
      body.append(address.parentElement!, toneLabel, noteLabel, counter, scope, actions)
      if (handlers.getConfig && handlers.setDefaultModel) {
        const section = document.createElement('section')
        section.className = 'settings-section assistant-default-section'
        const heading = document.createElement('h3'); heading.textContent = '默认模型'
        const hint = document.createElement('p'); hint.className = 'settings-hint'
        hint.textContent = '此助手平时使用的模型，保存后所有笔记库共用。底栏切换只影响下一场任务。'
        const label = document.createElement('label'); label.className = 'settings-field'
        const name = document.createElement('span'); name.textContent = '模型'
        const select = document.createElement('select'); select.className = 'assistant-default-model'; select.disabled = true
        label.append(name, select)
        const status = document.createElement('p'); status.className = 'settings-hint assistant-default-status'; status.setAttribute('role', 'status')
        const modelError = document.createElement('p'); modelError.className = 'settings-error assistant-default-error'; modelError.setAttribute('role', 'alert'); modelError.hidden = true
        let original: string | null = null
        let loading = true, saving = false
        const paintModel = (): void => { modelSave.disabled = loading || saving || (select.value || null) === original }
        const modelSave = action('保存默认模型', () => {
          const chosen = select.value || null
          saving = true; select.disabled = true; paintModel(); showError(modelError, ''); status.textContent = ''
          void handlers.setDefaultModel!({ modelId: chosen }).then(result => {
            if (disposed || !current.isOpen() || openedPage !== '助手') return
            if (!result.ok) { showError(modelError, configErrorText(result.error)); return }
            original = result.config.defaultModelId; select.value = original ?? ''
            status.textContent = '默认模型已保存。'; handlers.onModelConfigChanged?.()
          }).catch(() => { if (!disposed) showError(modelError, '保存失败，请重试。') })
            .finally(() => { if (!disposed) { saving = false; select.disabled = loading; paintModel() } })
        })
        modelSave.classList.add('assistant-default-save'); modelSave.disabled = true
        select.addEventListener('change', () => { status.textContent = ''; paintModel() })
        section.append(heading, hint, label, modelError, status, modelSave)
        body.append(section)
        void handlers.getConfig().then(result => {
          if (disposed || !current.isOpen() || openedPage !== '助手') return
          if (!result.ok) { showError(modelError, configErrorText(result.error)); return }
          const groups = modelModuleGroups(result.config)
          const none = document.createElement('option'); none.value = ''; none.textContent = '未设置默认模型'; select.append(none)
          for (const group of groups) {
            const optgroup = document.createElement('optgroup'); optgroup.label = group.label
            for (const item of group.items) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; optgroup.append(option) }
            select.append(optgroup)
          }
          original = result.config.defaultModelId
          if (original && !groups.some(group => group.items.some(item => item.id === original))) {
            const invalid = document.createElement('option'); invalid.value = original; invalid.textContent = '默认模型不可用，请重新选择'; invalid.disabled = true; select.append(invalid)
          }
          select.value = original ?? ''; loading = false; select.disabled = false; paintModel()
        }).catch(() => { if (!disposed) showError(modelError, '暂时无法读取默认模型。') })
      }


      const paintState = (): void => {
        counter.textContent = `补充说明已用 ${draft.note.length} / ${ASSISTANT_LIMITS.note} 字。`
        save.disabled = loadingHabits || savingHabits || same(draft, saved)
      }
      const paint = (): void => {
        address.value = draft.address
        tone.value = draft.tone
        note.value = draft.note
        paintState()
      }
      const onDraftChange = (key: keyof AssistantHabits): void => {
        editedHabits.add(key)
        // 输入保留原样；首尾空白仅在保存时处理。
        draft = { address: address.value, tone: tone.value as AssistantTone, note: note.value }
        paintState()
      }
      address.addEventListener('input', () => onDraftChange('address'))
      tone.addEventListener('change', () => onDraftChange('tone'))
      note.addEventListener('input', () => onDraftChange('note'))

      paint()
      void handlers.getAssistant().then((result) => {
        if (disposed || !current.isOpen() || openedPage !== '助手') return
        if (!result.ok) { showError(error, configErrorText(result.error)); paint(); return }
        if (!isAssistantHabits(result.habits)) { showError(error, configErrorText('BAD_ASSISTANT')); paint(); return }
        saved = { ...result.habits }
        draft = {
          address: editedHabits.has('address') ? draft.address : saved.address,
          tone: editedHabits.has('tone') ? draft.tone : saved.tone,
          note: editedHabits.has('note') ? draft.note : saved.note
        }
        loadingHabits = false
        paint()
      }).catch(() => { if (!disposed) { showError(error, '暂时无法读取助手习惯。'); paint() } })
    }

    let disposeMemoryPage: (() => void) | null = null
    let memoryNodes: Node[] | null = null
    let memoryBody: HTMLElement | null = null
    function renderMemoryPage(): void {
      // Reuse a loaded page within this dialog; closing/changing vault still disposes it.
      if(memoryNodes&&memoryBody?.querySelector('[data-memory="vault-enabled"]')){main.replaceChildren(...memoryNodes);memoryBody.dispatchEvent(new Event('rgent:memory-resume'));return}
      disposeMemoryPage?.()
      const { body, error } = pageFrame('记忆', '开启后，AI 会从已保存的任务中整理值得长期保留的信息，并在后续任务中自动参考。记忆只用于当前笔记库，你可以随时修改或遗忘。')
      const memory = handlers.memory?.()
      if (!memory) { showError(error, '请先选择笔记库。'); return }
      memoryBody=body;memoryNodes=Array.from(main.childNodes)
      disposeMemoryPage = mountMemoryPage({ body, isCurrent: () => current.isOpen() && openedPage === '记忆', onChanged: () => handlers.onModelConfigChanged?.() }, memory)
    }

    let disposeModelPage: (() => void) | null = null
    const modelHandlers = (): ModelPageHandlers | null => modelPageAvailable(handlers) ? handlers : null
    function renderModelPage(): void {
      const page = modelHandlers()
      if (!page) return
      disposeModelPage?.()
      disposeModelPage = null
      const { body, error } = pageFrame('模型', '配置连接与模型。密钥只保存在此设备；设备默认在助手页保存，底栏可为下一场临时选择。')
      disposeModelPage = mountModelPage({
        body,
        showError: (message) => showError(error, message),
        configErrorText,
        isCurrent: () => current.isOpen() && openedPage === '模型',
        onChanged: () => handlers.onModelConfigChanged?.()
      }, page)
    }

    async function renderRunPage(): Promise<void> {
      if (!handlers.getConfig || !handlers.setLimits) return
      const mine = ++request
      const { body, error } = pageFrame('运行', '模型与工具上限按任务启动时的快照生效；联网与 MCP 尚未开放。')
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
      const memory = handlers.memory?.()
      if (memory) {
        const result = await memory.get()
        if (!current.isOpen() || openedPage !== '运行' || mine !== request) return
        if (!result.ok) { showError(error, memoryErrorText(result.error)); return }
        const group = document.createElement('fieldset'); group.className = 'settings-limit-group'
        const legend = document.createElement('legend'); legend.textContent = '记忆后台整理'; group.append(legend)
        const seconds = field('整理总期限（秒）', String(result.value.config.limits.seconds), 'number')
        seconds.min = '1'; seconds.max = '600'; seconds.dataset.memory = 'limit-seconds'
        const calls = field('模型调用数', String(result.value.config.limits.calls), 'number')
        calls.min = '1'; calls.max = '4'; calls.dataset.memory = 'limit-calls'
        appendField(group, seconds); appendField(group, calls)
        const hint = document.createElement('p'); hint.className = 'settings-hint'; hint.textContent = '工具调用固定 0 次；默认 120 秒、2 次模型调用。'; group.append(hint)
        const save = action('保存整理上限', () => {
          save.disabled = true
          void memory.save({ target: 'limits', limits: { seconds: Number(seconds.value), calls: Number(calls.value), tools: 0 } }).then(updated => {
            if (!current.isOpen() || openedPage !== '运行' || mine !== request) return
            showError(error, updated.ok ? '' : memoryErrorText(updated.error))
          }).catch(() => showError(error, '保存失败，请重试。')).finally(() => { save.disabled = false })
        })
        group.append(save); body.append(group)
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
      preview.innerHTML = '<span class="settings-preview-bar"></span><span class="settings-preview-side"><i></i><i></i><i></i></span><span class="settings-preview-paper"><b></b><i></i><i></i><i></i></span>'
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
        const mine = ++themeRequest
        busy = true
        paint()
        setError('')
        void handlers.setMode(item.mode).then((result) => {
          if (!current.isOpen() || mine !== themeRequest) return
          if (result.ok) selected = result.mode
          else setError(result.error === 'IO_ERROR' ? '主题设置保存失败，请重试。' : '无法使用这个主题选项。')
        }).catch(() => {
          if (current.isOpen() && mine === themeRequest) setError('主题设置保存失败，请重试。')
        }).finally(() => {
          if (current.isOpen() && mine === themeRequest) {
            busy = false
            paint()
          }
        })
      })
    }
    const mine = ++themeRequest
    void handlers.getMode().then((mode) => {
      if (!current.isOpen() || mine !== themeRequest) return
      selected = mode
      paint()
    }).catch(() => {
      if (current.isOpen() && mine === themeRequest) setError('暂时无法读取主题设置。')
    })

    if (handlers.getReading && handlers.setReading) {
      const heading = document.createElement('h3')
      heading.textContent = '阅读排版'
      const description = document.createElement('p')
      description.className = 'settings-reading-intro'
      description.textContent = '在样张里试好后再保存；适用于这台设备上的所有笔记。'
      const sample = document.createElement('article')
      sample.className = 'settings-reading-sample'
      sample.setAttribute('aria-label', '笔记排版预览')
      sample.innerHTML = '<span class="settings-sample-eyebrow">笔记样张 · 阅读预览</span><h4>自然生长</h4><p>好的想法不一定在写下时就已经完整。先留下一个清晰的落点，日后再回来，让新的线索与旧的经验相遇。</p><p>Writing is thinking in motion. 在中文与 English 之间，行距和字形应该保持安静、连贯。</p><p class="settings-sample-prompt">&gt; 能否把这个想法整理成两个可观察的行为？</p><p class="settings-sample-answer">可以。先记下离开笔记时的上下文，再观察重新打开后是否能够接着写。</p>'
      const controls = document.createElement('div')
      controls.className = 'settings-reading-controls'
      const fontSelect = (key: 'bodyFont' | 'headingFont', labelText: string): HTMLSelectElement => {
        const label = document.createElement('label')
        label.className = 'settings-reading-control'
        const name = document.createElement('span')
        name.textContent = labelText
        const select = document.createElement('select')
        select.dataset.setting = key
        for (const id of READING_FONTS) {
          const option = document.createElement('option')
          option.value = id
          option.textContent = FONT_NAMES[id]
          select.append(option)
        }
        label.append(name, select)
        controls.append(label)
        return select
      }
      const slider = (key: 'fontSize' | 'lineHeight' | 'maxWidth', labelText: string, min: string, max: string, step: string, suffix: string): HTMLInputElement => {
        const label = document.createElement('label')
        label.className = 'settings-reading-control'
        const name = document.createElement('span')
        const value = document.createElement('output')
        name.textContent = labelText
        const input = document.createElement('input')
        input.type = 'range'
        input.dataset.setting = key
        input.min = min
        input.max = max
        input.step = step
        input.addEventListener('input', () => { value.textContent = `${input.value}${suffix}` })
        label.append(name, value, input)
        controls.append(label)
        return input
      }
      const bodyFont = fontSelect('bodyFont', '正文字体')
      const headingFont = fontSelect('headingFont', '标题字体')
      const fontSize = slider('fontSize', '正文字号', '15', '21', '1', ' px')
      const lineHeight = slider('lineHeight', '行距', '1.4', '2', '0.05', '')
      const maxWidth = slider('maxWidth', '最大阅读宽度', '640', '960', '40', ' px')
      const allControls = [bodyFont, headingFont, fontSize, lineHeight, maxWidth]
      allControls.forEach((control) => { control.disabled = true })
      const save = document.createElement('button')
      save.type = 'button'
      save.className = 'settings-action settings-reading-save'
      save.textContent = '保存阅读排版'
      save.disabled = true
      const saveError = document.createElement('p')
      saveError.className = 'settings-error settings-reading-error'
      saveError.setAttribute('role', 'alert')
      saveError.hidden = true
      const footer = document.createElement('div')
      footer.className = 'settings-reading-footer'
      footer.append(save, saveError)
      readingSection.append(heading, description, sample, controls, footer)
      let original: ReadingPreference | null = null
      let draft: ReadingPreference | null = null
      const paintDraft = (): void => {
        if (!draft) return
        applyReadingPreference(draft, sample)
        sample.style.width = `${Math.round(draft.maxWidth / 960 * 100)}%`
        bodyFont.value = draft.bodyFont
        headingFont.value = draft.headingFont
        fontSize.value = String(draft.fontSize)
        lineHeight.value = String(draft.lineHeight)
        maxWidth.value = String(draft.maxWidth)
        for (const [input, suffix] of [[fontSize, ' px'], [lineHeight, ''], [maxWidth, ' px']] as const) {
          const output = input.parentElement?.querySelector('output')
          if (output) output.textContent = `${input.value}${suffix}`
        }
        save.disabled = !original || sameReading(draft, original)
      }
      const readControls = (): ReadingPreference => ({
        bodyFont: bodyFont.value as ReadingPreference['bodyFont'],
        headingFont: headingFont.value as ReadingPreference['headingFont'],
        fontSize: Number(fontSize.value),
        lineHeight: Number(lineHeight.value),
        maxWidth: Number(maxWidth.value)
      })
      for (const control of allControls) {
        const changed = (): void => {
          const next = readControls()
          if (!isReadingPreference(next)) return
          draft = next
          paintDraft()
          showError(saveError, '')
        }
        control.addEventListener('input', changed)
        control.addEventListener('change', changed)
      }
      save.addEventListener('click', () => {
        if (!draft || !isReadingPreference(draft)) return
        const submitted = { ...draft }
        const serial = ++readingSaveSerial
        save.disabled = true
        void handlers.setReading!(submitted).then((result) => {
          if (serial !== readingSaveSerial) return
          if (!result.ok) {
            if (current.isOpen()) showError(saveError, '阅读排版保存失败，工作区未更改。')
            return
          }
          applyReadingPreference(result.reading)
          if (!current.isOpen()) return
          original = { ...result.reading }
          draft = { ...result.reading }
          paintDraft()
          showError(saveError, '')
        }).catch(() => {
          if (current.isOpen()) showError(saveError, '阅读排版保存失败，工作区未更改。')
        }).finally(() => { if (current.isOpen()) save.disabled = !draft || !original || sameReading(draft, original) })
      })
      void handlers.getReading().then((reading) => {
        if (!current.isOpen() || !isReadingPreference(reading)) return
        original = { ...reading }
        draft = { ...reading }
        allControls.forEach((control) => { control.disabled = false })
        paintDraft()
      }).catch(() => { if (current.isOpen()) showError(saveError, '暂时无法读取阅读排版。') })
    }

    if (handlers.getChromeText && handlers.setChromeText) {
      const section = document.createElement('section')
      section.className = 'settings-chrome-section'
      section.innerHTML = '<h3>界面文字</h3><p class="settings-hint">在样张中预览，保存后应用到这台设备。正文排版单独设置。</p><div class="settings-chrome-sample" aria-label="tab 与侧栏字号预览"><div class="tab-wrap"><span class="tab"><span class="tab-label">研究记录 · 中英文 Research</span></span></div><div class="tree-row"><span class="tree-label">资料与研究</span></div><div class="tree-row"><span class="tree-label">一个特别特别长的笔记名称.md</span></div><div class="tree-row"><span class="tree-label">附件</span><span class="attachment-label">附件 · 研究记录</span></div></div>'
      const sample = section.querySelector<HTMLElement>('.settings-chrome-sample')!
      sample.querySelector('.tab')!.prepend(icon('note'))
      sample.querySelectorAll('.tree-row').forEach((row, index) => row.prepend(icon(index === 1 ? 'note' : 'folder')))
      const controls = document.createElement('div'); controls.className = 'settings-reading-controls'
      const selects = (['tabs', 'sidebar'] as const).map(key => {
        const label = document.createElement('label'); label.className = 'settings-reading-control'
        const name = document.createElement('span'); name.textContent = key === 'tabs' ? 'tab 名称字号' : '侧栏目录与资源字号'
        const select = document.createElement('select'); select.dataset.setting = `chrome-${key}`; select.disabled = true
        CHROME_TEXT_SIZES.forEach((id, index) => { const option = document.createElement('option'); option.value = id; option.textContent = ['小', '默认', '大'][index]!; select.append(option) })
        label.append(name, select); controls.append(label); return select
      })
      const save = document.createElement('button'); save.type = 'button'; save.className = 'settings-action settings-chrome-save'; save.textContent = '保存界面字号'; save.disabled = true
      const error = document.createElement('p'); error.className = 'settings-error'; error.setAttribute('role', 'alert'); error.hidden = true
      section.append(controls, save, error); readingSection.append(section)
      let original: ChromeTextPreference | null = null; let draft: ChromeTextPreference | null = null; let busy = false
      const paint = (): void => {
        if (draft) { applyChromeTextPreference(draft, sample); selects[0]!.value = draft.tabs; selects[1]!.value = draft.sidebar }
        selects.forEach(select => { select.disabled = !original || busy })
        save.disabled = busy || !draft || !original || draft.tabs === original.tabs && draft.sidebar === original.sidebar
      }
      selects.forEach(select => select.addEventListener('change', () => {
        if (!original || busy) return
        draft = { tabs: selects[0]!.value, sidebar: selects[1]!.value } as ChromeTextPreference; paint(); showError(error, '')
      }))
      save.addEventListener('click', () => {
        if (!draft || busy || !isChromeTextPreference(draft)) return
        const serial = ++chromeTextSaveSerial
        busy = true; paint()
        void handlers.setChromeText!({ ...draft }).then(result => {
          if (serial !== chromeTextSaveSerial) return
          if (!result.ok) { if (current.isOpen()) showError(error, '界面字号保存失败，工作区未更改。'); return }
          applyChromeTextPreference(result.preference)
          original = { ...result.preference }; draft = { ...result.preference }
          if (current.isOpen()) showError(error, '')
        }).catch(() => { if (current.isOpen()) showError(error, '界面字号保存失败，工作区未更改。') }).finally(() => { busy = false; if (current.isOpen()) paint() })
      })
      void handlers.getChromeText().then(value => {
        if (!current.isOpen() || !isChromeTextPreference(value)) return
        original = { ...value }; draft = { ...value }; paint()
      }).catch(() => { if (current.isOpen()) showError(error, '暂时无法读取界面字号。') })
    }
    if (page !== '界面') setPage(page)
  }

  return { open, close, isOpen: () => overlay?.isOpen() ?? false, isBusy: () => vaultBusy, prepareVaultChange: () => {
    if (overlay?.isOpen() && (inputsEdited || vaultPage?.isDirty()) && !window.confirm('还有未保存的设置或显示名称。请先保存；继续切换将在新库提交后放弃这些修改。是否继续？')) return false
    return true
  } }
}
