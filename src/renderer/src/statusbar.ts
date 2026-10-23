import type { MarkerRef } from '@markdown'
import type { PublicModelConfig } from '@shared'
import { PROVIDER_LABELS } from '../../shared/model-endpoints.ts'

/**
 * 底栏。围栏 docs/frontend.md §编辑画布与辅助信息、
 * docs/decisions.md §2026-10-23 底栏减负与任务浮层：
 * 与上方用一条细线分开：左侧行列与字数，中间是模型模块，右侧只有联网总闸小球。
 *
 * 默认模型在助手设置保存；此处只为当前笔记的下一场任务临时选择，不写设备配置。
 * 无活动笔记时提供配置引导，失效选择不自动改用其他模型。
 *
 * 底栏每次状态更新都会重绘，所以三个容器与那个下拉必须复用而不是重建，
 * 否则光标移动会把下拉和它的焦点一起销毁。
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

export type StatusNetwork = {
  enabled: boolean
  onToggle: () => void
}

export type StatusModel = {
  position: string | null
  words: string | null
  network: StatusNetwork
  model?: StatusModelModule
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

export function statusModel(input: StatusInput, network: StatusNetwork, model?: StatusModelModule): StatusModel {
  return {
    position: input.noteOpen ? `第 ${input.line} 行, 第 ${input.column} 列` : null,
    words: input.noteOpen ? `字数 ${input.words}` : null,
    network,
    ...(model ? { model } : {})
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
function renderModelModule(center: HTMLElement, module: StatusModelModule | undefined): void {
  center.hidden = !module
  if (!module) return
  const available = module.groups.some(group => group.items.length > 0) && !module.disabled
  let select = center.querySelector<HTMLSelectElement>('.status-model')
  let configure = center.querySelector<HTMLButtonElement>('.status-model-config')
  if (!available) {
    const signature = `empty:${module.unavailableLabel ?? '未配置模型'}`
    if (center.dataset.signature !== signature) {
      center.dataset.signature = signature
      center.replaceChildren()
      const label = document.createElement('span')
      label.className = 'status-model-label'; label.textContent = '模型'
      const empty = document.createElement('span')
      empty.className = 'status-item status-model-empty'
      empty.textContent = module.unavailableLabel ?? '未配置模型'
      configure = document.createElement('button')
      configure.type = 'button'; configure.className = 'status-model-config'; configure.textContent = '配置'
      center.append(label, empty, configure)
    }
    configure!.onclick = module.onConfigure
    return
  }
  if (!select) {
    center.replaceChildren()
    const label = document.createElement('span')
    label.className = 'status-model-label'; label.textContent = '模型'
    select = document.createElement('select')
    select.className = 'status-model'
    select.setAttribute('aria-label', '新任务使用的模型')
    center.append(label, select)
  }
  // 回调也随当前笔记更新；复用节点不能把旧 tab 的选择处理器留在原处。
  select.onchange = () => { if (select!.value) module.onChange(select!.value) }
  if (center.dataset.signature !== module.signature) {
    center.dataset.signature = module.signature
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
  renderModelModule(center, model.model)
  // 只在顺序不对时重排；常规重绘不移动节点，保住下拉与焦点。
  if (host.children.length !== 4 || host.children[0] !== lead || host.children[1] !== left ||
      host.children[2] !== center || host.children[3] !== right) {
    host.replaceChildren(lead, left, center, right)
  }
}
