import type {
  ModelAddRequest, ModelConfigResult, ModelConnectionAddRequest, ModelConnectionRemoveRequest,
  ModelConnectionUpdateRequest, ModelKeyDeleteRequest, ModelListEntry, ModelListRequest,
  ModelListResult, ModelRemoveRequest, ModelUpdateRequest, ModelProvider, PublicModelConfig
} from '../../shared/ipc.ts'
import { MODEL_ENDPOINTS, MODEL_PRESETS } from '../../shared/model-endpoints.ts'

/**
 * 「模型」页：只配置连接与模型。用哪个模型在底栏的模型模块里选，这里不设「当前模型」。
 * 围栏 docs/frontend.md §设置。
 */
export type ModelPageHandlers = {
  getConfig: () => Promise<ModelConfigResult>
  addConnection: (request: ModelConnectionAddRequest) => Promise<ModelConfigResult>
  updateConnection: (request: ModelConnectionUpdateRequest) => Promise<ModelConfigResult>
  removeConnection: (request: ModelConnectionRemoveRequest) => Promise<ModelConfigResult>
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

const PROVIDER_NAMES: Record<ModelProvider, string> = { deepseek: 'DeepSeek', minimax: 'MiniMax', custom: '自定义兼容接口' }
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
function confirmAction(button: HTMLButtonElement, label: string, run: () => void): void {
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

export function mountModelPage(host: ModelPageHost, handlers: ModelPageHandlers): (() => void) | null {
  let config: PublicModelConfig | null = null
  let selectedId: string | null = null
  let candidates: { id: string; contextTokens?: number; checked: boolean; input?: string }[] | null = null
  let candidateNote = ''
  let candidateTruncated = false
  let focusSelector: string | null = null
  let disposed = false
  let reading = false

  const modelsOf = (connectionId: string): PublicModelConfig['models'] =>
    (config?.models ?? []).filter((model) => model.connectionId === connectionId)

  const mutate = async (
    run: () => Promise<ModelConfigResult>,
    focus?: string,
    options: { keepCandidates?: boolean } = {}
  ): Promise<boolean> => {
    host.showError('')
    if (!options.keepCandidates) { candidates = null; candidateNote = '' }
    const result = await run().catch(() => ({ ok: false, error: 'IO_ERROR' }) as ModelConfigResult)
    if (disposed || !host.isCurrent()) return false
    if (!result.ok) { host.showError(host.configErrorText(result.error)); return false }
    config = result.config
    if (selectedId && !config.connections.some((connection) => connection.id === selectedId)) selectedId = null
    if (!selectedId) selectedId = config.connections[0]?.id ?? null
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

  function paintConnections(body: HTMLElement): void {
    body.append(sectionTitle('连接'))
    const list = element('div', 'settings-connections')
    list.setAttribute('role', 'list')
    if (!config?.connections.length) {
      const empty = element('p', 'settings-empty')
      empty.textContent = '还没有连接。添加一条连接后，才能在本机用 `/`。'
      list.append(empty)
    }
    for (const connection of config?.connections ?? []) {
      const card = element('button', 'settings-connection')
      card.type = 'button'
      card.setAttribute('role', 'listitem')
      if (connection.id === selectedId) card.classList.add('is-active')
      card.setAttribute('aria-pressed', connection.id === selectedId ? 'true' : 'false')
      card.dataset.connectionId = connection.id
      const head = element('span', 'settings-connection-head')
      const name = element('strong', 'settings-connection-name')
      name.textContent = PROVIDER_NAMES[connection.provider]
      const meta = element('span', 'settings-connection-meta')
      meta.textContent = `${connection.hasKey ? '密钥已保存' : '尚未保存密钥'} · ${connection.modelCount} 个模型`
      head.append(name, meta)
      const endpoint = element('span', 'settings-connection-host')
      endpoint.textContent = connection.baseURL || '尚未填写接口地址'
      card.append(head, endpoint)
      card.addEventListener('click', () => { selectedId = connection.id; candidates = null; paint() })
      list.append(card)
    }

    const add = element('div', 'settings-connection-add')
    const provider = element('select', 'settings-add-provider')
    provider.setAttribute('aria-label', '新连接的供应商')
    for (const id of ['deepseek', 'minimax', 'custom'] as ModelProvider[]) {
      const option = element('option')
      option.value = id
      option.textContent = PROVIDER_NAMES[id]
      provider.append(option)
    }
    const url = element('input', 'settings-add-url')
    url.type = 'text'
    url.placeholder = '接口地址'
    url.setAttribute('aria-label', '新连接的接口地址')
    const modelId = element('input', 'settings-add-model')
    modelId.type = 'text'
    modelId.placeholder = '模型 ID'
    modelId.setAttribute('aria-label', '新连接的模型 ID')
    const capacity = element('input', 'settings-add-capacity')
    capacity.type = 'number'
    capacity.min = '1'
    capacity.placeholder = '上下文容量'
    capacity.setAttribute('aria-label', '新连接的上下文容量')
    const customFields = [url, modelId, capacity]
    const syncAdd = (): void => {
      const preset = MODEL_PRESETS[provider.value as ModelProvider]
      const custom = provider.value === 'custom'
      for (const field of customFields) field.hidden = !custom
      if (!custom) {
        url.value = preset.endpoints[0]?.baseURL ?? ''
        modelId.value = preset.modelId
        capacity.value = String(preset.contextTokens)
      }
    }
    provider.addEventListener('change', syncAdd)
    syncAdd()
    const button = element('button', 'settings-action')
    button.type = 'button'
    button.textContent = '添加连接'
    button.addEventListener('click', () => {
      const id = provider.value as ModelProvider
      void mutate(() => handlers.addConnection({
        provider: id,
        baseURL: url.value.trim(),
        modelId: modelId.value.trim(),
        contextTokens: Number(capacity.value)
      }), '.settings-add-url')
    })
    const hint = element('p', 'settings-hint')
    hint.textContent = '同一供应商可以添加多条连接；密钥各自独立保存。'
    add.append(provider, url, modelId, capacity, button)
    body.append(list, add, hint)
  }

  function paintConnectionDetail(body: HTMLElement): void {
    const connection = config?.connections.find((item) => item.id === selectedId)
    if (!connection) return
    body.append(sectionTitle(`编辑连接 · ${PROVIDER_NAMES[connection.provider]}`))
    const grid = element('div', 'settings-grid')
    const baseLabel = element('label', 'settings-field wide')
    const baseName = element('span')
    baseName.textContent = '接口地址'
    const base = element('input')
    base.type = 'text'
    base.value = connection.baseURL
    base.setAttribute('list', 'model-endpoint-options')
    baseLabel.append(baseName, base)
    const options = element('datalist')
    options.id = 'model-endpoint-options'
    for (const endpoint of MODEL_ENDPOINTS[connection.provider]) {
      const option = element('option')
      option.value = endpoint.baseURL
      option.label = endpoint.note ? `${endpoint.label} · ${endpoint.note}` : endpoint.label
      options.append(option)
    }
    grid.append(baseLabel, options)
    const keyLabel = element('label', 'settings-field wide')
    const keyName = element('span')
    keyName.textContent = connection.hasKey ? '替换密钥（留空则不更改）' : '密钥'
    const key = element('input')
    key.type = 'password'
    key.autocomplete = 'new-password'
    keyLabel.append(keyName, key)
    grid.append(keyLabel)
    body.append(grid)
    const state = element('div', 'settings-model-state')
    const keyState = element('p', 'settings-key-state')
    keyState.textContent = connection.hasKey ? '密钥已保存' : '尚未保存密钥'
    const count = element('p', 'settings-key-state')
    count.textContent = `${modelsOf(connection.id).length} 个模型`
    state.append(keyState, count)
    const actions = element('div', 'settings-actions')
    const save = element('button', 'settings-action')
    save.type = 'button'
    save.textContent = '保存连接'
    save.addEventListener('click', () => {
      const newKey = key.value.trim()
      void mutate(() => handlers.updateConnection({
        connectionId: connection.id,
        baseURL: base.value.trim(),
        ...(newKey ? { newKey } : {})
      }), '.settings-connection.is-active')
    })
    actions.append(save)
    if (connection.hasKey) {
      const dropKey = element('button', 'settings-action')
      dropKey.type = 'button'
      dropKey.textContent = '删除密钥'
      dropKey.addEventListener('click', () => {
        void mutate(() => handlers.deleteKey({ connectionId: connection.id }), '.settings-connection.is-active')
      })
      actions.append(dropKey)
    }
    const remove = element('button', 'settings-action')
    remove.type = 'button'
    remove.textContent = '删除连接'
    remove.setAttribute('aria-label', `删除连接 ${PROVIDER_NAMES[connection.provider]}`)
    confirmAction(remove, '删除连接', () => {
      void mutate(() => handlers.removeConnection({ connectionId: connection.id }), '.settings-add-provider')
    })
    actions.append(remove)
    body.append(state, actions)
  }

  function paintReadModels(body: HTMLElement): void {
    const connection = config?.connections.find((item) => item.id === selectedId)
    if (!connection) return
    const row = element('div', 'settings-read-row')
    const button = element('button', 'settings-action')
    button.type = 'button'
    button.textContent = reading ? '读取中…' : '读取模型'
    button.disabled = reading
    button.addEventListener('click', () => {
      reading = true
      candidates = null
      candidateNote = ''
      paint()
      void handlers.readModels({ connectionId: connection.id }).then((result) => {
        reading = false
        if (disposed || !host.isCurrent()) return
        if (!result.ok) { host.showError(host.configErrorText(result.error)); candidates = null; paint(); return }
        candidates = result.models.length
          ? (result.models as ModelListEntry[]).map((entry) => ({
            id: entry.id,
            ...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
            checked: true
          }))
          : []
        candidateTruncated = result.truncated === true
        candidateNote = result.models.length
          ? `读取到 ${result.models.length} 个模型。`
          : '端点没有返回模型；可以手填模型 ID。'
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
    hint.textContent = '只读取该端点的模型清单；不会发送笔记内容。'
    row.append(button, hint)
    body.append(row)
    if (!candidates) return

    const panel = element('div', 'settings-read-panel')
    const head = element('div', 'settings-read-head')
    const title = element('strong')
    title.textContent = `读取模型 · ${PROVIDER_NAMES[connection.provider]} · ${safeHost(connection.baseURL)}`
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
    const footer = element('div', 'settings-actions')
    const selectAll = element('button', 'settings-action')
    selectAll.type = 'button'
    selectAll.textContent = '全选'
    selectAll.addEventListener('click', () => {
      const all = candidates?.every((candidate) => candidate.checked) !== true
      for (const candidate of candidates ?? []) candidate.checked = all
      paint()
    })
    const capacityOf = (candidate: { contextTokens?: number; input?: string }): number | null => {
      const raw = candidate.input ?? (candidate.contextTokens !== undefined ? String(candidate.contextTokens) : '')
      const value = Number(raw)
      return Number.isSafeInteger(value) && value > 0 ? value : null
    }
    const chosenNow = (): typeof candidates & object[] => (candidates ?? []).filter((candidate) => candidate.checked)
    const add = element('button', 'settings-action')
    add.type = 'button'
    refreshAddState = (): void => {
      const chosen = chosenNow()
      add.textContent = `添加所选${chosen.length ? `（${chosen.length}）` : ''}`
      add.disabled = chosen.length === 0 || chosen.some((candidate) => capacityOf(candidate) === null)
    }
    refreshAddState()
    add.addEventListener('click', () => {
      const chosen = chosenNow()
      const pending = chosen.map((candidate) => ({ modelId: candidate.id, contextTokens: capacityOf(candidate)! }))
      candidates = null
      candidateNote = ''
      void (async () => {
        let latest: ModelConfigResult | null = null
        for (const item of pending) {
          const result = await handlers.addModel({ connectionId: connection.id, ...item }).catch(() => ({ ok: false, error: 'IO_ERROR' }) as ModelConfigResult)
          if (disposed || !host.isCurrent()) return
          if (!result.ok && result.error !== 'DUPLICATE_MODEL') { host.showError(host.configErrorText(result.error)); latest = result; break }
          latest = result
        }
        if (latest?.ok) { config = latest.config; host.onChanged?.(); focusSelector = '.settings-read-row button' }
        paint()
      })()
    })
    const cancel = element('button', 'settings-action')
    cancel.type = 'button'
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => { candidates = null; candidateNote = ''; paint() })
    footer.append(selectAll, add, cancel)
    panel.append(status, footer)
    body.append(panel)
  }

  function paintModels(body: HTMLElement): void {
    const connection = config?.connections.find((item) => item.id === selectedId)
    if (!connection) return
    const models = modelsOf(connection.id)
    body.append(sectionTitle(`该连接的模型 · ${models.length}`))
    const list = element('div', 'settings-models')
    if (!models.length) {
      const empty = element('p', 'settings-empty')
      empty.textContent = '这条连接下还没有模型。可以读取模型，或手填模型 ID。'
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
      confirmAction(remove, '移除', () => {
        void mutate(() => handlers.removeModel({ modelId: model.id }), '.settings-model-id')
      })
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
      void mutate(() => handlers.addModel({ connectionId: connection.id, modelId: id.value.trim(), contextTokens: Number(capacity.value) }), '.settings-add-model-id')
    })
    add.append(id, capacity, button)
    body.append(list, add)
  }

  function paint(): void {
    if (disposed || !host.isCurrent() || !config) return
    const body = host.body
    body.replaceChildren()
    paintConnections(body)
    if (config.connections.length) {
      paintConnectionDetail(body)
      paintReadModels(body)
      paintModels(body)
    }
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
    selectedId = config.connections[0]?.id ?? null
    paint()
  }).catch(() => { if (!disposed && host.isCurrent()) host.showError(host.configErrorText('IO_ERROR')) })

  return () => { disposed = true }
}

export function modelPageAvailable(handlers: Partial<ModelPageHandlers>): handlers is ModelPageHandlers {
  return Boolean(handlers.getConfig && handlers.addConnection && handlers.updateConnection && handlers.removeConnection &&
    handlers.deleteKey && handlers.addModel && handlers.updateModel && handlers.removeModel && handlers.readModels)
}
