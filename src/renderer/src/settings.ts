import type {
  AssistantResult, LimitTier, ModelAddRequest, ModelConfigResult, ModelKeyDeleteRequest, ModelLimitsSetRequest,
  ModelListRequest, ModelListResult, ModelProviderRemoveRequest, ModelProviderSaveRequest, ModelRemoveRequest,
  ModelUpdateRequest, ReadingPreference, ReadingSetResult, ThemeMode, ThemeSetResult
} from '../../shared/ipc.ts'
import { isReadingPreference, READING_FONTS } from '../../shared/reading-preference.ts'
import { mountModelPage, modelPageAvailable, type ModelPageHandlers } from './settings-model.ts'
import { ASSISTANT_LIMITS, ASSISTANT_TONE_LABELS, ASSISTANT_TONES, DEFAULT_ASSISTANT_HABITS, isAssistantHabits, type AssistantHabits, type AssistantTone } from '../../shared/assistant.ts'
import { openOverlay, type Overlay } from './overlay.ts'
import { applyReadingPreference } from './reading.ts'
import { icon, type IconName } from './icons.ts'

export type SettingsHandlers = {
  getMode: () => Promise<ThemeMode>
  setMode: (mode: ThemeMode) => Promise<ThemeSetResult>
  getReading?: () => Promise<ReadingPreference>
  setReading?: (reading: ReadingPreference) => Promise<ReadingSetResult>
  getConfig?: () => Promise<ModelConfigResult>
  saveProvider?: (request: ModelProviderSaveRequest) => Promise<ModelConfigResult>
  removeProvider?: (request: ModelProviderRemoveRequest) => Promise<ModelConfigResult>
  deleteKey?: (request: ModelKeyDeleteRequest) => Promise<ModelConfigResult>
  addModel?: (request: ModelAddRequest) => Promise<ModelConfigResult>
  updateModel?: (request: ModelUpdateRequest) => Promise<ModelConfigResult>
  removeModel?: (request: ModelRemoveRequest) => Promise<ModelConfigResult>
  readModels?: (request: ModelListRequest) => Promise<ModelListResult>
  setLimits?: (request: ModelLimitsSetRequest) => Promise<ModelConfigResult>
  /** 配置写入后通知外壳刷新底栏模型模块。 */
  onModelConfigChanged?: () => void
  getAssistant?: () => Promise<AssistantResult>
  setAssistant?: (habits: AssistantHabits) => Promise<AssistantResult>
  /** 设置面板关闭后通知外壳（底栏模型模块据此取一次最新配置）。 */
  onClose?: () => void
}

export type SettingsOverlay = {
  /** 打开设置；可指定落到哪一页（底栏模型模块的「配置」用它直达「模型」页）。 */
  open: (page?: '界面' | '助手' | '模型' | '运行') => void
  close: () => void
  isOpen: () => boolean
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
const configErrorText = (error: string): string => CONFIG_ERRORS[error] ?? error

export function createSettingsOverlay(handlers: SettingsHandlers): SettingsOverlay {
  let overlay: Overlay | null = null
  let request = 0
  let readingSaveSerial = 0

  const close = (): void => overlay?.close()
  const open = (page: '界面' | '助手' | '模型' | '运行' = '界面'): void => {
    if (overlay?.isOpen()) return
    const current = openOverlay({
      label: '设置',
      initialFocus: () => current.root.querySelector<HTMLElement>('.settings-page-title'),
      onClose: () => {
        if (overlay !== current) return
        request += 1
        overlay = null
        disposeModelPage?.()
        disposeModelPage = null
        disposeAssistantPage?.()
        disposeAssistantPage = null
        handlers.onClose?.()
      }
    })
    overlay = current
    const root = current.root
    root.classList.add('overlay-settings')
    root.addEventListener('click', (event) => {
      if (event.target !== root || event.detail === 0) return
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
    const addNav = (name: '界面' | '助手' | '模型' | '运行', graphic: IconName): HTMLButtonElement => {
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
    addNav('界面', 'appearance')
    const assistantReady = Boolean(handlers.getAssistant && handlers.setAssistant)
    const modelsReady = modelPageAvailable(handlers) && Boolean(handlers.setLimits)
    if (assistantReady || modelsReady) {
      navGroup('Agent')
      if (assistantReady) addNav('助手', 'assistant')
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
    let openedPage: '界面' | '助手' | '模型' | '运行' = page
    let themeRequest = 0
    const setPage = (name: '界面' | '助手' | '模型' | '运行'): void => {
      openedPage = name
      if (name !== '模型') { disposeModelPage?.(); disposeModelPage = null }
      if (name !== '助手') disposeAssistantPage?.()
      for (const [label, button] of navButtons) {
        button.className = label === name ? 'settings-nav-current' : 'settings-nav-item'
        if (label === name) button.setAttribute('aria-current', 'page')
        else button.removeAttribute('aria-current')
      }
      if (name === '界面') main.replaceChildren(...themeNodes)
      else if (name === '助手') renderAssistantPage()
      else if (name === '模型') renderModelPage()
      else void renderRunPage()
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

    let disposeAssistantPage: (() => void) | null = null
    function renderAssistantPage(): void {
      if (!handlers.getAssistant || !handlers.setAssistant) return
      disposeAssistantPage?.()
      let disposed = false
      disposeAssistantPage = () => { disposed = true }
      const { body, error } = pageFrame('助手', '一个助手的设备级习惯，所有笔记库共用；它不改变笔记权限与工具范围。')
      let saved: AssistantHabits = { ...DEFAULT_ASSISTANT_HABITS }
      let draft: AssistantHabits = { ...DEFAULT_ASSISTANT_HABITS }
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
        save.disabled = true
        const next: AssistantHabits = { address: address.value.trim(), tone: tone.value as AssistantTone, note: note.value.trim() }
        showError(error, '')
        void handlers.setAssistant!({ ...next }).then((result) => {
          if (disposed || !current.isOpen() || openedPage !== '助手') return
          if (!result.ok) { showError(error, configErrorText(result.error)); return }
          saved = { ...result.habits }
          draft = { ...result.habits }
          paint()
        }).catch(() => { if (!disposed) showError(error, '保存失败，请重试。') })
          .finally(() => { if (!disposed) save.disabled = same(draft, saved) })
      })
      const reset = action('恢复默认', () => {
        draft = { ...DEFAULT_ASSISTANT_HABITS }
        paint()
      })
      actions.append(save, reset)
      body.append(address.parentElement!, toneLabel, noteLabel, counter, scope, actions)

      const paintState = (): void => {
        counter.textContent = `补充说明已用 ${draft.note.length} / ${ASSISTANT_LIMITS.note} 字。`
        save.disabled = same(draft, saved)
      }
      const paint = (): void => {
        address.value = draft.address
        tone.value = draft.tone
        note.value = draft.note
        paintState()
      }
      const onDraftChange = (): void => {
        // 只在草稿层 trim：输入框里保留人刚敲下的字符，保存时送出的仍是去空白版本
        draft = { address: address.value.trim(), tone: tone.value as AssistantTone, note: note.value.trim() }
        paintState()
      }
      address.addEventListener('input', onDraftChange)
      tone.addEventListener('change', onDraftChange)
      note.addEventListener('input', onDraftChange)

      void handlers.getAssistant().then((result) => {
        if (disposed || !current.isOpen() || openedPage !== '助手') return
        if (!result.ok) { showError(error, configErrorText(result.error)); paint(); return }
        if (!isAssistantHabits(result.habits)) { showError(error, configErrorText('BAD_ASSISTANT')); paint(); return }
        saved = { ...result.habits }
        draft = { ...result.habits }
        paint()
      }).catch(() => { if (!disposed) { showError(error, '暂时无法读取助手习惯。'); paint() } })
    }

    let disposeModelPage: (() => void) | null = null
    const modelHandlers = (): ModelPageHandlers | null => modelPageAvailable(handlers) ? handlers : null
    function renderModelPage(): void {
      const page = modelHandlers()
      if (!page) return
      disposeModelPage?.()
      disposeModelPage = null
      const { body, error } = pageFrame('模型', '配置连接与模型。密钥只保存在此设备；用哪个模型在底栏选择。')
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

    if (page !== '界面') setPage(page)
  }

  return { open, close, isOpen: () => overlay?.isOpen() ?? false }
}
