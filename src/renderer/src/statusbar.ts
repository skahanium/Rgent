import type { MarkerRef } from '@markdown'
import type { AgentScopeLevel, PublicModelConfig } from '@shared'
import { PROVIDER_LABELS } from '../../shared/model-endpoints.ts'

/**
 * 底栏。围栏 docs/frontend.md §编辑画布与辅助信息、
 * docs/decisions.md §2026-10-23 三档工作范围与库内已删除：
 * 与上方用一条细线分开：左侧行列与字数，中间是模型与作业范围模块，右侧只有联网总闸小球。
 *
 * 默认模型在助手设置保存；此处只为当前笔记的下一场任务临时选择，不写设备配置。
 * 作业范围按 tab 记在渲染层内存里（shell 的 Map），这里只负责显示与回写。
 *
 * 底栏每次状态更新都会重绘，所以容器、下拉、范围按钮与锚定菜单都必须复用而不是重建，
 * 否则光标移动会把下拉、菜单和它们的焦点一起销毁。
 */

export type StatusInput = {
  line: number
  column: number
  words: number
  noteOpen: boolean
}

export type StatusModelOption = { id: string; label: string }
export type StatusModelGroup = { label: string; items: StatusModelOption[] }
export type StatusModelModule = {
  groups: StatusModelGroup[]
  value: string | null
  disabled?: boolean
  unavailableLabel?: string
  /** 由构建方缓存：内容不变时不必重建下拉，底栏在光标移动时会被高频重绘。 */
  signature: string
  onChange: (modelId: string) => void
  onConfigure: () => void
}

/** 三档作业范围：本篇／同册／整库。根目录笔记的「同册」由 shell 标灰并回落到本篇。 */
export type StatusScopeOption = {
  value: AgentScopeLevel
  label: string
  detail: string
  disabled?: boolean
  /** 禁用时用 title 说明原因：根目录没有同册。 */
  title?: string
}
export type StatusScopeModule = {
  value: AgentScopeLevel
  options: StatusScopeOption[]
  onChange: (scope: AgentScopeLevel) => void
}

export type StatusNetwork = {
  enabled: boolean
  onToggle: () => void
}

export type StatusModel = {
  position: string | null
  words: string | null
  network: StatusNetwork
  model?: StatusModelModule
  scope?: StatusScopeModule
}

/**
 * 底栏候选：只列**已存密钥**的供应商及其模型。
 * 未配置或缺密钥的不出现在候选里——选它也不能发起，只会让人以为能用。
 */
export function modelModuleGroups(config: PublicModelConfig): StatusModelGroup[] {
  return config.providers
    .filter((provider) => provider.hasKey && provider.modelCount > 0)
    .map((provider) => ({
      label: PROVIDER_LABELS[provider.provider],
      items: config.models.filter((model) => model.provider === provider.provider).map((model) => ({ id: model.id, label: model.modelId }))
    }))
}

export function statusModel(input: StatusInput, network: StatusNetwork, model?: StatusModelModule, scope?: StatusScopeModule): StatusModel {
  return {
    position: input.noteOpen ? `第 ${input.line} 行, 第 ${input.column} 列` : null,
    words: input.noteOpen ? `字数 ${input.words}` : null,
    network,
    ...(model ? { model } : {}),
    ...(scope ? { scope } : {})
  }
}

/** 正文（含标记行）→ 字数。标记行不算，机器语法不是文章。 */
export function wordsOf(body: string, markers: readonly MarkerRef[]): number {
  const ranges = [...markers].map(({ range }) => range).sort((a, b) => a.start - b.start)
  const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u
  const wordish = /[\p{L}\p{N}_]/u
  let count = 0
  let inRun = false
  let rangeIndex = 0
  for (let at = 0; at < body.length;) {
    const range = ranges[rangeIndex]
    if (range && at >= range.start) {
      at = Math.max(at, range.end)
      rangeIndex += 1
      inRun = false
      continue
    }
    const char = String.fromCodePoint(body.codePointAt(at)!)
    if (cjk.test(char)) {
      count += 1
      inRun = false
    } else if (wordish.test(char)) {
      if (!inRun) count += 1
      inRun = true
    } else {
      inRun = false
    }
    at += char.length
  }
  return count
}

function container(host: HTMLElement, className: string): HTMLElement {
  const existing = host.querySelector<HTMLElement>(`:scope > .${className}`)
  if (existing) return existing
  const created = document.createElement('div')
  created.className = className
  return created
}

/** 模型模块：同一次会话里保持同一个 select 节点，只在下拉内容真的变化时重建选项。 */
function renderModelModule(slot: HTMLElement, module: StatusModelModule | undefined): void {
  slot.hidden = !module
  if (!module) return
  const available = module.groups.some(group => group.items.length > 0) && !module.disabled
  let select = slot.querySelector<HTMLSelectElement>('.status-model')
  let configure = slot.querySelector<HTMLButtonElement>('.status-model-config')
  if (!available) {
    const signature = `empty:${module.unavailableLabel ?? '未配置模型'}`
    if (slot.dataset.signature !== signature) {
      slot.dataset.signature = signature
      slot.replaceChildren()
      const label = document.createElement('span')
      label.className = 'status-model-label'; label.textContent = '模型'
      const empty = document.createElement('span')
      empty.className = 'status-item status-model-empty'
      empty.textContent = module.unavailableLabel ?? '未配置模型'
      configure = document.createElement('button')
      configure.type = 'button'; configure.className = 'status-model-config'; configure.textContent = '配置'
      slot.append(label, empty, configure)
    }
    configure!.onclick = module.onConfigure
    return
  }
  if (!select) {
    slot.replaceChildren()
    const label = document.createElement('span')
    label.className = 'status-model-label'; label.textContent = '模型'
    select = document.createElement('select')
    select.className = 'status-model'
    select.setAttribute('aria-label', '新任务使用的模型')
    slot.append(label, select)
  }
  // 回调也随当前笔记更新；复用节点不能把旧 tab 的选择处理器留在原处。
  select.onchange = () => { if (select!.value) module.onChange(select!.value) }
  if (slot.dataset.signature !== module.signature) {
    slot.dataset.signature = module.signature
    select.replaceChildren()
    for (const group of module.groups) {
      if (!group.items.length) continue
      const optgroup = document.createElement('optgroup'); optgroup.label = group.label
      for (const item of group.items) {
        const option = document.createElement('option'); option.value = item.id; option.textContent = item.label
        optgroup.append(option)
      }
      select.append(optgroup)
    }
    if (module.value === null || !module.groups.some(group => group.items.some(item => item.id === module.value))) {
      const placeholder = document.createElement('option')
      placeholder.value = ''; placeholder.textContent = module.unavailableLabel ?? '未选'; placeholder.disabled = true
      select.prepend(placeholder)
      select.value = ''
    } else select.value = module.value
  }
}

type ScopeUi = {
  root: HTMLElement
  button: HTMLButtonElement
  menu: HTMLElement
  items: Map<AgentScopeLevel, HTMLButtonElement>
  module: StatusScopeModule | null
  renderedValue: AgentScopeLevel | null
  open: boolean
  onPointer: (event: Event) => void
  onKey: (event: KeyboardEvent) => void
  onBlur: () => void
}

const scopeUis = new WeakMap<HTMLElement, ScopeUi>()
const SCOPE_ORDER: AgentScopeLevel[] = ['note', 'folder', 'vault']

function closeScopeMenu(ui: ScopeUi, focusButton: boolean): void {
  if (ui.open) {
    ui.open = false
    ui.menu.hidden = true
    ui.button.setAttribute('aria-expanded', 'false')
    delete ui.root.dataset.open
    window.removeEventListener('pointerdown', ui.onPointer, true)
    window.removeEventListener('click', ui.onPointer, true)
    window.removeEventListener('keydown', ui.onKey, true)
    window.removeEventListener('blur', ui.onBlur)
  }
  if (focusButton) ui.button.focus()
}

function openScopeMenu(ui: ScopeUi): void {
  if (ui.open) return
  ui.open = true
  ui.menu.hidden = false
  ui.button.setAttribute('aria-expanded', 'true')
  ui.root.dataset.open = 'true'
  // 菜单非模态：焦点仍留在按钮上；点外面或 Esc 关闭，不能把 Esc 漏给「停止任务」。
  window.addEventListener('pointerdown', ui.onPointer, true)
  window.addEventListener('click', ui.onPointer, true)
  window.addEventListener('keydown', ui.onKey, true)
  window.addEventListener('blur', ui.onBlur)
}

function scopeUiFor(containerEl: HTMLElement): ScopeUi {
  const existing = scopeUis.get(containerEl)
  if (existing) return existing
  containerEl.classList.add('status-scope')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'status-scope-button'
  button.setAttribute('aria-haspopup', 'menu')
  button.setAttribute('aria-expanded', 'false')
  button.setAttribute('data-scope', 'note')
  const menu = document.createElement('div')
  menu.className = 'status-scope-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', '作业范围')
  menu.hidden = true
  const items = new Map<AgentScopeLevel, HTMLButtonElement>()
  for (const value of SCOPE_ORDER) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'status-scope-option'
    item.setAttribute('role', 'menuitemradio')
    item.setAttribute('aria-checked', 'false')
    item.dataset.scopeOption = value
    const name = document.createElement('span')
    name.className = 'status-scope-option-name'
    const detail = document.createElement('span')
    detail.className = 'status-scope-option-detail'
    const check = document.createElement('span')
    check.className = 'status-scope-check'
    check.setAttribute('aria-hidden', 'true')
    check.textContent = '✓'
    item.append(name, detail, check)
    item.addEventListener('click', () => {
      const module = ui.module
      const option = module?.options.find(candidate => candidate.value === value)
      if (!module || !option || option.disabled) return
      closeScopeMenu(ui, true)
      module.onChange(value)
    })
    menu.append(item)
    items.set(value, item)
  }
  containerEl.append(button, menu)
  const ui: ScopeUi = {
    root: containerEl, button, menu, items, module: null, renderedValue: null, open: false,
    onPointer: (event) => { if (!ui.root.contains(event.target as Node)) closeScopeMenu(ui, false) },
    onKey: (event) => {
      if (!ui.open) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeScopeMenu(ui, true)
        return
      }
      if (event.key === 'Tab') { closeScopeMenu(ui, false); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const enabled = [...ui.items.values()].filter(item => !item.hidden && !item.disabled)
      if (!enabled.length) return
      const at = enabled.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown'
        ? enabled[(at + 1 + enabled.length) % enabled.length]!
        : enabled[at <= 0 ? enabled.length - 1 : at - 1]!
      next.focus()
    },
    onBlur: () => closeScopeMenu(ui, false)
  }
  button.addEventListener('click', () => {
    if (ui.open) closeScopeMenu(ui, true)
    else openScopeMenu(ui)
  })
  scopeUis.set(containerEl, ui)
  return ui
}

/**
 * 范围模块：固定三个菜单项节点，重绘只改文字／勾选／禁用，不重建。
 * 这样光标移动、状态高频刷新时，打开着的菜单与焦点都不会被销毁。
 */
function renderScopeModule(containerEl: HTMLElement, module: StatusScopeModule | undefined): void {
  if (!module) {
    containerEl.hidden = true
    const existing = scopeUis.get(containerEl)
    if (existing) { closeScopeMenu(existing, false); existing.module = null }
    return
  }
  containerEl.hidden = false
  const ui = scopeUiFor(containerEl)
  const selected = module.options.find(option => option.value === module.value && !option.disabled)
    ?? module.options.find(option => !option.disabled)
    ?? module.options.find(option => option.value === module.value)
  // 外部换了当前篇的范围（不在选择中）：菜单开着也先收起，避免把旧选择当成新篇的。
  if (ui.open && ui.renderedValue !== null && ui.renderedValue !== module.value) closeScopeMenu(ui, false)
  ui.module = module
  ui.renderedValue = module.value
  const label = selected?.label ?? '本篇'
  const text = `${label} ▾`
  if (ui.button.textContent !== text) ui.button.textContent = text
  ui.button.dataset.scope = selected?.value ?? module.value
  const title = selected ? `作业范围：${selected.label}。${selected.detail}` : '作业范围'
  if (ui.button.title !== title) ui.button.title = title
  for (const [value, item] of ui.items) {
    const option = module.options.find(candidate => candidate.value === value)
    if (!option) { item.hidden = true; continue }
    item.hidden = false
    item.dataset.scopeOption = value
    const disabled = option.disabled === true
    if (item.disabled !== disabled) item.disabled = disabled
    item.setAttribute('aria-disabled', String(disabled))
    item.title = option.title ?? (disabled ? '这一档当前不可用。' : '')
    const name = item.querySelector<HTMLElement>('.status-scope-option-name')!
    if (name.textContent !== option.label) name.textContent = option.label
    const detail = item.querySelector<HTMLElement>('.status-scope-option-detail')!
    if (detail.textContent !== option.detail) detail.textContent = option.detail
    item.setAttribute('aria-checked', String(option.value === (selected?.value ?? module.value)))
  }
}

function renderNetworkDot(right: HTMLElement, network: StatusNetwork): void {
  let button = right.querySelector<HTMLButtonElement>('.status-dot')
  if (!button) {
    button = document.createElement('button')
    button.type = 'button'
    button.className = 'status-dot'
    const core = document.createElement('span')
    core.className = 'status-dot-core'
    core.setAttribute('aria-hidden', 'true')
    button.append(core)
    right.append(button)
  }
  const enabled = network.enabled
  button.dataset.state = enabled ? 'online' : 'offline'
  button.setAttribute('aria-pressed', enabled ? 'true' : 'false')
  // 小球是设备级「联网搜索与抓取」总闸：只管搜索／抓取，其他 MCP 不受此闸约束。
  const label = enabled ? '联网搜索与抓取：已开' : '联网搜索与抓取：已关'
  button.setAttribute('aria-label', label)
  button.title = label
  button.onclick = network.onToggle
}

export function renderStatusbar(host: HTMLElement, model: StatusModel): void {
  // 左侧的固定槽位（设置入口）绝对定位、不参与栅格，也不被重绘清空——否则每次
  // 状态更新都会把按钮移除再放回，而移除会夺走焦点。
  const lead = container(host, 'status-lead')
  const left = container(host, 'status-left')
  left.replaceChildren()
  if (model.position) {
    const position = document.createElement('span')
    position.className = 'status-item'
    position.textContent = model.position
    left.append(position)
  }
  if (model.words) {
    const words = document.createElement('span')
    words.className = 'status-item'
    words.textContent = model.words
    left.append(words)
  }

  const center = container(host, 'status-center')
  const right = container(host, 'status-right')
  right.querySelector('.status-vault')?.remove()
  renderNetworkDot(right, model.network)
  // 模型槽与范围槽是稳定兄弟节点：重绘只改内部，记忆按钮还在它们后面。
  let modelSlot = center.querySelector<HTMLElement>(':scope > .status-model-slot')
  if (!modelSlot) {
    modelSlot = document.createElement('div')
    modelSlot.className = 'status-model-slot'
    center.prepend(modelSlot)
  }
  let scopeSlot = center.querySelector<HTMLElement>(':scope > .status-scope')
  if (!scopeSlot) {
    scopeSlot = document.createElement('div')
    scopeSlot.className = 'status-scope'
    scopeSlot.hidden = true
    modelSlot.after(scopeSlot)
  }
  renderModelModule(modelSlot, model.model)
  renderScopeModule(scopeSlot, model.scope)
  center.hidden = !model.model && !model.scope
  // 只在顺序不对时重排；常规重绘不移动节点，保住下拉与焦点。
  if (host.children.length !== 4 || host.children[0] !== lead || host.children[1] !== left ||
      host.children[2] !== center || host.children[3] !== right) {
    host.replaceChildren(lead, left, center, right)
  }
}
