import type {
  ModelAddRequest, ModelConfigResult, ModelKeyDeleteRequest, ModelListEntry, ModelListRequest,
  ModelListResult, ModelProvider, ModelProviderRemoveRequest, ModelProviderSaveRequest,
  ModelRemoveRequest, ModelUpdateRequest, PublicModelConfig
} from '../../shared/ipc.ts'
import { MODEL_ENDPOINTS, MODEL_PRESETS, PROVIDER_LABELS } from '../../shared/model-endpoints.ts'

/**
 * 「模型」页：两级子页。根页列出全部供应商，点一行进入该供应商的子页配置端点、密钥与模型清单。
 * 一个供应商只有一份凭据，界面不提供「再添加一条同厂商连接」。
 * 用哪个模型在底栏的模型模块里选，这里不设「当前模型」。围栏 docs/frontend.md §设置。
 */
export type ModelPageHandlers = {
  getConfig: () => Promise<ModelConfigResult>
  saveProvider: (request: ModelProviderSaveRequest) => Promise<ModelConfigResult>
  removeProvider: (request: ModelProviderRemoveRequest) => Promise<ModelConfigResult>
  deleteKey: (request: ModelKeyDeleteRequest) => Promise<ModelConfigResult>
  addModel: (request: ModelAddRequest) => Promise<ModelConfigResult>
  updateModel: (request: ModelUpdateRequest) => Promise<ModelConfigResult>
  removeModel: (request: ModelRemoveRequest) => Promise<ModelConfigResult>
  readModels: (request: ModelListRequest) => Promise<ModelListResult>
}

export type ModelPageHost = {
  body: HTMLElement
  showError: (message: string) => void
  configErrorText: (error: string) => string
  isCurrent: () => boolean
  /** 配置写入成功后通知外壳（底栏模型模块据此刷新）。 */
  onChanged?: () => void
}

const PROVIDERS: ModelProvider[] = ['deepseek', 'minimax', 'custom']
const PROVIDER_NAMES = PROVIDER_LABELS
const CONFIRM_WINDOW_MS = 3000
const CANDIDATE_PREVIEW = 50

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

function safeHost(baseURL: string): string {
  try { return new URL(baseURL).host } catch { return baseURL }
}

/** 两段确认：第一次点击只改文案，窗口内再点才执行。 */
function confirmAction(button: HTMLElement, label: string, run: () => void): void {
  let armed = 0
  button.addEventListener('click', () => {
    const now = Date.now()
    if (now - armed > CONFIRM_WINDOW_MS) {
      armed = now
      button.textContent = '确认删除？'
      button.classList.add('is-confirming')
      window.setTimeout(() => {
        if (Date.now() - armed < CONFIRM_WINDOW_MS) return
        button.textContent = label
        button.classList.remove('is-confirming')
      }, CONFIRM_WINDOW_MS)
      return
    }
    run()
  })
}

export function mountModelPage(host: ModelPageHost, handlers: ModelPageHandlers): () => void {
  let config: PublicModelConfig | null = null
  let view: { kind: 'list' } | { kind: 'provider'; provider: ModelProvider } = { kind: 'list' }
  let candidates: { id: string; contextTokens?: number; checked: boolean; input?: string }[] | null = null
  let candidateNote = ''
  let candidateTruncated = false
  let reading = false
  let focusSelector: string | null = null
  let disposed = false

  const providerOf = (provider: ModelProvider): PublicModelConfig['providers'][number] | undefined =>
    config?.providers.find((item) => item.provider === provider)
  const modelsOf = (provider: ModelProvider): PublicModelConfig['models'] =>
    (config?.models ?? []).filter((model) => model.provider === provider)

  const mutate = async (run: () => Promise<ModelConfigResult>, focus?: string): Promise<boolean> => {
    host.showError('')
    const result = await run().catch(() => ({ ok: false, error: 'IO_ERROR' }) as ModelConfigResult)
    if (disposed || !host.isCurrent()) return false
    if (!result.ok) { host.showError(host.configErrorText(result.error)); return false }
    config = result.config
    focusSelector = focus ?? null
    host.onChanged?.()
    paint()
    return true
  }

  const sectionTitle = (text: string): HTMLElement => {
    const title = element('h3', 'settings-section-title')
    title.textContent = text
    return title
  }

  function paintList(body: HTMLElement): void {
    body.append(sectionTitle('供应商'))
    const list = element('div', 'settings-providers')
    for (const provider of PROVIDERS) {
      const state = providerOf(provider)
      const row = element('button', 'settings-provider-row')
      row.type = 'button'
      row.dataset.provider = provider
      const head = element('span', 'settings-provider-head')
      const name = element('strong', 'settings-provider-name')
      name.textContent = PROVIDER_NAMES[provider]
      const meta = element('span', 'settings-provider-meta')
      meta.textContent = state?.configured
        ? `${state.hasKey ? '密钥已保存' : '尚未保存密钥'} · ${state.modelCount} 个模型`
        : '未配置'
      head.append(name, meta)
      const endpoint = element('span', 'settings-provider-host')
      endpoint.textContent = state?.baseURL ? safeHost(state.baseURL) : '尚未填写接口地址'
      row.append(head, endpoint)
      row.addEventListener('click', () => {
        view = { kind: 'provider', provider }
        candidates = null
        candidateNote = ''
        focusSelector = '.settings-back'
        paint()
      })
      list.append(row)
    }
    body.append(list)
    const hint = element('p', 'settings-hint')
    hint.textContent = '每个供应商只保留一份配置。密钥只保存在此设备，界面只显示保存状态。'
    body.append(hint)
  }

  function paintProvider(body: HTMLElement, provider: ModelProvider): void {
    const state = providerOf(provider)
    const models = modelsOf(provider)
    const back = element('button', 'settings-back')
    back.type = 'button'
    back.textContent = '← 供应商'
    back.setAttribute('aria-label', '返回供应商列表')
    back.addEventListener('click', () => {
      view = { kind: 'list' }
      candidates = null
      candidateNote = ''
      focusSelector = `[data-provider="${provider}"]`
      paint()
    })
    body.append(back)
    const heading = element('h3', 'settings-subtitle')
    heading.textContent = PROVIDER_NAMES[provider]
    body.append(heading)
    const intro = element('p', 'settings-intro')
    intro.textContent = state?.configured
      ? `接口主机 ${safeHost(state.baseURL)}；密钥${state.hasKey ? '已保存' : '尚未保存'}。`
      : '还没有配置这个供应商。填写接口地址与密钥后即可在本机使用。'
    body.append(intro)

    const grid = element('div', 'settings-grid')
    const baseLabel = element('label', 'settings-field wide')
    const baseName = element('span')
    baseName.textContent = '接口地址'
    const base = element('input')
    base.type = 'text'
    base.value = state?.baseURL ?? MODEL_ENDPOINTS[provider][0]?.baseURL ?? ''
    if (provider === 'custom') base.placeholder = 'https://…'
    base.setAttribute('list', 'model-endpoint-options')
    baseLabel.append(baseName, base)
    const options = element('datalist')
    options.id = 'model-endpoint-options'
    for (const endpoint of MODEL_ENDPOINTS[provider]) {
      const option = element('option')
      option.value = endpoint.baseURL
      option.label = endpoint.note ? `${endpoint.label} · ${endpoint.note}` : endpoint.label
      options.append(option)
    }
    grid.append(baseLabel, options)
    const keyLabel = element('label', 'settings-field wide')
    const keyName = element('span')
    keyName.textContent = state?.hasKey ? '替换密钥（留空则不更改）' : '密钥'
    const key = element('input')
    key.type = 'password'
    key.autocomplete = 'new-password'
    keyLabel.append(keyName, key)
    grid.append(keyLabel)
    const preset = MODEL_PRESETS[provider]
    // 自定义供应商没有预置模型，首次保存要由人给出真实的模型 ID 与容量
    let firstModelId: HTMLInputElement | null = null
    let firstCapacity: HTMLInputElement | null = null
    if (!models.length && !preset.modelId) {
      const modelLabel = element('label', 'settings-field')
      const modelName = element('span')
      modelName.textContent = '模型 ID'
      firstModelId = element('input')
      firstModelId.type = 'text'
      firstModelId.placeholder = '例如 gpt-4o-mini'
      modelLabel.append(modelName, firstModelId)
      const capacityLabel = element('label', 'settings-field')
      const capacityName = element('span')
      capacityName.textContent = '上下文容量（token）'
      firstCapacity = element('input')
      firstCapacity.type = 'number'
      firstCapacity.min = '1'
      firstCapacity.placeholder = '例如 128000'
      capacityLabel.append(capacityName, firstCapacity)
      grid.append(modelLabel, capacityLabel)
    }
    body.append(grid)

    const actions = element('div', 'settings-actions')
    const save = element('button', 'settings-action')
    save.type = 'button'
    save.textContent = '保存配置'
    save.addEventListener('click', () => {
      const newKey = key.value.trim()
      void mutate(() => handlers.saveProvider({
        provider,
        baseURL: base.value.trim(),
        modelId: models[0]?.modelId ?? (firstModelId ? firstModelId.value.trim() : preset.modelId),
        contextTokens: models[0]?.contextTokens ?? (firstCapacity ? Number(firstCapacity.value) : preset.contextTokens),
        ...(newKey ? { newKey } : {})
      }), '.settings-provider-name')
    })
    actions.append(save)
    if (state?.hasKey) {
      const dropKey = element('button', 'settings-action')
      dropKey.type = 'button'
      dropKey.textContent = '删除密钥'
      dropKey.addEventListener('click', () => { void mutate(() => handlers.deleteKey({ provider }), '.settings-provider-name') })
      actions.append(dropKey)
    }
    if (state?.configured) {
      const remove = element('button', 'settings-action')
      remove.type = 'button'
      remove.textContent = '清除该供应商配置'
      remove.setAttribute('aria-label', `清除 ${PROVIDER_NAMES[provider]} 的配置`)
      confirmAction(remove, '清除该供应商配置', () => { void mutate(() => handlers.removeProvider({ provider }), '.settings-back') })
      actions.append(remove)
    }
    body.append(actions)

    paintReadModels(body, provider, state?.hasKey === true)
    paintModels(body, provider, models)
  }

  function paintReadModels(body: HTMLElement, provider: ModelProvider, hasKey: boolean): void {
    const row = element('div', 'settings-read-row')
    const button = element('button', 'settings-action')
    button.type = 'button'
    button.textContent = reading ? '读取中…' : '读取模型'
    button.disabled = reading || !hasKey
    button.title = hasKey ? '' : '先保存密钥再读取模型'
    button.addEventListener('click', () => {
      reading = true
      candidates = null
      candidateNote = ''
      paint()
      void handlers.readModels({ provider }).then((result) => {
        reading = false
        if (disposed || !host.isCurrent()) return
        if (!result.ok) { host.showError(host.configErrorText(result.error)); candidates = null; paint(); return }
        candidates = (result.models as ModelListEntry[]).map((entry) => ({
          id: entry.id,
          ...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
          checked: true
        }))
        candidateTruncated = result.truncated === true
        candidateNote = result.models.length ? `读取到 ${result.models.length} 个模型。` : '端点没有返回模型；可以手填模型 ID。'
        host.showError('')
        paint()
      }).catch(() => {
        reading = false
        if (disposed || !host.isCurrent()) return
        host.showError(host.configErrorText('MODEL_LIST_FAILED'))
        paint()
      })
    })
    const hint = element('p', 'settings-hint')
    hint.textContent = hasKey ? '只读取该端点的模型清单；不会发送笔记内容。' : '保存密钥后可以读取该端点的模型清单。'
    row.append(button, hint)
    body.append(row)
    if (!candidates) return

    const panel = element('div', 'settings-read-panel')
    const head = element('div', 'settings-read-head')
    const title = element('strong')
    title.textContent = `读取模型 · ${PROVIDER_NAMES[provider]}`
    head.append(title)
    panel.append(head)
    if (!candidates.length) {
      const empty = element('p', 'settings-empty')
      empty.textContent = candidateNote
      panel.append(empty)
      body.append(panel)
      return
    }
    const shown = candidates.slice(0, CANDIDATE_PREVIEW)
    let refreshAddState = (): void => {}
    const list = element('div', 'settings-candidates')
    for (const candidate of shown) {
      const line = element('label', 'settings-candidate')
      const box = element('input')
      box.type = 'checkbox'
      box.checked = candidate.checked
      const id = element('span', 'settings-candidate-id')
      id.textContent = candidate.id
      const capacity = element('input')
      capacity.type = 'number'
      capacity.min = '1'
      capacity.className = 'settings-candidate-capacity'
      capacity.value = candidate.input ?? (candidate.contextTokens !== undefined ? String(candidate.contextTokens) : '')
      capacity.placeholder = '上下文容量'
      capacity.setAttribute('aria-label', `${candidate.id} 的上下文容量`)
      const note = element('span', 'settings-candidate-note')
      note.textContent = candidate.contextTokens !== undefined ? '端点提供' : '须填写'
      box.addEventListener('change', () => { candidate.checked = box.checked; paint() })
      capacity.addEventListener('input', () => { candidate.input = capacity.value; refreshAddState() })
      line.append(box, id, capacity, note)
      list.append(line)
    }
    panel.append(list)
    if (candidates.length > shown.length) {
      const more = element('p', 'settings-hint')
      more.textContent = `另有 ${candidates.length - shown.length} 个未显示，请分次读取。`
      panel.append(more)
    }
    const status = element('p', 'settings-hint')
    status.textContent = `${candidateNote}${candidateTruncated ? ' 端点返回过多，只保留前 100 个。' : ''}端点未提供容量时必须填写。`
    const capacityOf = (candidate: { contextTokens?: number; input?: string }): number | null => {
      const raw = candidate.input ?? (candidate.contextTokens !== undefined ? String(candidate.contextTokens) : '')
      const value = Number(raw)
      return Number.isSafeInteger(value) && value > 0 ? value : null
    }
    const chosenNow = (): NonNullable<typeof candidates> => (candidates ?? []).filter((candidate) => candidate.checked)
    const footer = element('div', 'settings-actions')
    const add = element('button', 'settings-action')
    add.type = 'button'
    refreshAddState = (): void => {
      const chosen = chosenNow()
      add.textContent = `添加所选${chosen.length ? `（${chosen.length}）` : ''}`
      add.disabled = chosen.length === 0 || chosen.some((candidate) => capacityOf(candidate) === null)
    }
    refreshAddState()
    add.addEventListener('click', () => {
      const pending = chosenNow().map((candidate) => ({ modelId: candidate.id, contextTokens: capacityOf(candidate)! }))
      candidates = null
      candidateNote = ''
      void (async () => {
        let latest: ModelConfigResult | null = null
        for (const item of pending) {
          const result = await handlers.addModel({ provider, ...item }).catch(() => ({ ok: false, error: 'IO_ERROR' }) as ModelConfigResult)
          if (disposed || !host.isCurrent()) return
          if (!result.ok && result.error !== 'DUPLICATE_MODEL') { host.showError(host.configErrorText(result.error)); latest = result; break }
          latest = result
        }
        if (latest?.ok) { config = latest.config; host.onChanged?.(); focusSelector = '.settings-read-row button' }
        paint()
      })()
    })
    const selectAll = element('button', 'settings-action')
    selectAll.type = 'button'
    selectAll.textContent = '全选'
    selectAll.addEventListener('click', () => {
      const all = candidates?.every((candidate) => candidate.checked) !== true
      for (const candidate of candidates ?? []) candidate.checked = all
      paint()
    })
    const cancel = element('button', 'settings-action')
    cancel.type = 'button'
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => { candidates = null; candidateNote = ''; paint() })
    // 主操作在首位：`.settings-actions` 的首个子元素才是实心按钮
    footer.append(add, selectAll, cancel)
    panel.append(status, footer)
    body.append(panel)
  }

  function paintModels(body: HTMLElement, provider: ModelProvider, models: PublicModelConfig['models']): void {
    body.append(sectionTitle(`模型 · ${models.length}`))
    const list = element('div', 'settings-models')
    if (!models.length) {
      const empty = element('p', 'settings-empty')
      empty.textContent = '这个供应商下还没有模型。可以读取模型，或手填模型 ID。'
      list.append(empty)
    }
    for (const model of models) {
      const row = element('div', 'settings-model-row')
      const id = element('span', 'settings-model-id')
      id.textContent = model.modelId
      const capacity = element('input')
      capacity.type = 'number'
      capacity.min = '1'
      capacity.className = 'settings-model-capacity'
      capacity.value = String(model.contextTokens)
      capacity.setAttribute('aria-label', `${model.modelId} 的上下文容量`)
      capacity.addEventListener('change', () => {
        void mutate(() => handlers.updateModel({ modelId: model.id, contextTokens: Number(capacity.value) }), '.settings-model-id')
      })
      const remove = element('button', 'settings-row-action')
      remove.type = 'button'
      remove.textContent = '移除'
      remove.setAttribute('aria-label', `移除模型 ${model.modelId}`)
      confirmAction(remove, '移除', () => { void mutate(() => handlers.removeModel({ modelId: model.id }), '.settings-model-id') })
      row.append(id, capacity, remove)
      list.append(row)
    }
    const add = element('div', 'settings-model-add')
    const id = element('input')
    id.type = 'text'
    id.placeholder = '模型 ID'
    id.className = 'settings-add-model-id'
    id.setAttribute('aria-label', '新模型的 ID')
    const capacity = element('input')
    capacity.type = 'number'
    capacity.min = '1'
    capacity.placeholder = '上下文容量'
    capacity.className = 'settings-add-model-capacity'
    capacity.setAttribute('aria-label', '新模型的上下文容量')
    const button = element('button', 'settings-action')
    button.type = 'button'
    button.textContent = '添加模型'
    button.addEventListener('click', () => {
      void mutate(() => handlers.addModel({ provider, modelId: id.value.trim(), contextTokens: Number(capacity.value) }), '.settings-add-model-id')
    })
    add.append(id, capacity, button)
    body.append(list, add)
  }

  function paint(): void {
    if (disposed || !host.isCurrent() || !config) return
    const body = host.body
    body.replaceChildren()
    if (view.kind === 'list') paintList(body)
    else paintProvider(body, view.provider)
    const hint = element('p', 'settings-hint')
    hint.textContent = '用哪个模型在底栏的模型模块里选择；运行上限在「运行」页调整。'
    body.append(hint)
    if (focusSelector) {
      const target = body.querySelector<HTMLElement>(focusSelector)
      focusSelector = null
      target?.focus({ preventScroll: true })
    }
  }

  void handlers.getConfig().then((result) => {
    if (disposed || !host.isCurrent()) return
    if (!result.ok) { host.showError(host.configErrorText(result.error)); return }
    config = result.config
    paint()
  }).catch(() => { if (!disposed && host.isCurrent()) host.showError(host.configErrorText('IO_ERROR')) })

  return () => { disposed = true }
}

export function modelPageAvailable(handlers: Partial<ModelPageHandlers>): handlers is ModelPageHandlers {
  return Boolean(handlers.getConfig && handlers.saveProvider && handlers.removeProvider && handlers.deleteKey &&
    handlers.addModel && handlers.updateModel && handlers.removeModel && handlers.readModels)
}
