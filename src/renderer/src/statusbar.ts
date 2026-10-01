import type { MarkerRef } from '@markdown'

/**
 * 底栏。围栏 docs/frontend.md §编辑画布与辅助信息：
 * 与上方用一条细线分开：左侧行列与字数，中间是模型模块，右侧联网圆点与库名。
 *
 * 模型模块是「用哪个模型」的唯一入口（设置页只配置）：原生下拉按供应商分组列出已配置模型，
 * 切换即改变新任务所用模型；没有可用模型时给一句引导与一个打开设置的按钮，不放点不动的死控件。
 *
 * 底栏每次状态更新都会重绘，所以三个容器与那个下拉必须复用而不是重建，
 * 否则光标移动会把下拉和它的焦点一起销毁。
 */

export type StatusInput = {
  line: number
  column: number
  words: number
  vaultName: string | null
  noteOpen: boolean
}

export type StatusModelOption = { id: string; label: string }
export type StatusModelGroup = { label: string; items: StatusModelOption[] }
export type StatusModelModule = {
  groups: StatusModelGroup[]
  value: string | null
  /** 由构建方缓存：内容不变时不必重建下拉，底栏在光标移动时会被高频重绘。 */
  signature: string
  onChange: (modelId: string) => void
  onConfigure: () => void
}

export type StatusModel = {
  position: string | null
  words: string | null
  vault: string
  network: 'offline'
  model?: StatusModelModule
}

export function statusModel(input: StatusInput, model?: StatusModelModule): StatusModel {
  return {
    position: input.noteOpen ? `第 ${input.line} 行, 第 ${input.column} 列` : null,
    words: input.noteOpen ? `字数 ${input.words}` : null,
    vault: input.vaultName ?? '未选库',
    network: 'offline',
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
  const signature = module?.signature ?? ''
  if (center.dataset.signature === signature) return
  center.dataset.signature = signature
  center.replaceChildren()
  center.hidden = !module
  if (!module) return
  const label = document.createElement('span')
  label.className = 'status-model-label'
  label.textContent = '模型'
  const available = module.groups.some((group) => group.items.length > 0)
  if (!available) {
    const empty = document.createElement('span')
    empty.className = 'status-item status-model-empty'
    empty.textContent = '未配置模型'
    const configure = document.createElement('button')
    configure.type = 'button'
    configure.className = 'status-model-config'
    configure.textContent = '配置'
    configure.addEventListener('click', () => module.onConfigure())
    center.append(label, empty, configure)
    return
  }
  const select = document.createElement('select')
  select.className = 'status-model'
  select.setAttribute('aria-label', '新任务使用的模型')
  for (const group of module.groups) {
    if (!group.items.length) continue
    const optgroup = document.createElement('optgroup')
    optgroup.label = group.label
    for (const item of group.items) {
      const option = document.createElement('option')
      option.value = item.id
      option.textContent = item.label
      if (item.id === module.value) option.selected = true
      optgroup.append(option)
    }
    select.append(optgroup)
  }
  if (module.value === null || !module.groups.some((group) => group.items.some((item) => item.id === module.value))) {
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = '未选择模型'
    placeholder.selected = true
    placeholder.disabled = true
    select.prepend(placeholder)
  }
  select.addEventListener('change', () => { if (select.value) module.onChange(select.value) })
  center.append(label, select)
}

export function renderStatusbar(host: HTMLElement, model: StatusModel): void {
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
  right.replaceChildren()
  const dot = document.createElement('span')
  dot.className = 'status-dot'
  dot.dataset.state = model.network
  dot.setAttribute('role', 'img')
  dot.setAttribute('aria-label', '联网状态：离线')
  dot.title = '离线'
  const vault = document.createElement('span')
  vault.className = 'status-item status-vault'
  vault.textContent = model.vault
  vault.title = model.vault
  right.append(dot, vault)

  renderModelModule(center, model.model)
  // 只在顺序不对时重排；常规重绘不移动节点，保住下拉与焦点。
  if (host.children.length !== 3 || host.children[0] !== left || host.children[1] !== center || host.children[2] !== right) {
    host.replaceChildren(left, center, right)
  }
}
