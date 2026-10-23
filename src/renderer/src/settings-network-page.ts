import type { NetworkConfigResult, NetworkConfigView } from '../../shared/ipc.ts'
import { mountNetworkCard, mountNetworkGate, type NetworkCardHandlers } from './settings-network.ts'
import { mountMcpCard, type McpCardHandlers } from './settings-mcp.ts'

/**
 * 「联网」页：设备总闸、内置搜索／抓取、远端 MCP、模型自带联网与无头浏览器占位。
 *
 * 页头总闸只管搜索／抓取（含搜索类 MCP）与模型自带联网；非搜索类 MCP 只受启用与白名单约束，
 * 所以 MCP 卡自己写明边界。模型自带联网的探测由后续包接线，本页先保留启用选择与状态占位。
 * 围栏见 docs/decisions.md 的 2026-10-23 联网搜索与抓取整合。
 */
export type NetworkPageHost = {
  body: HTMLElement
  isCurrent: () => boolean
}
export type NetworkPageHandlers = {
  network: NetworkCardHandlers
  mcp: McpCardHandlers | null
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/** 模型自带联网：由模型服务商执行搜索；探测未接线前只显示占位状态。 */
function mountNativeSearch(host: NetworkPageHost, handlers: Pick<NetworkCardHandlers, 'get' | 'setNativeSearch'>): () => void {
  const body = host.body
  let config: NetworkConfigView | null = null
  let busy = false
  let disposed = false

  const heading = element('h3', 'settings-section-title')
  heading.textContent = '模型自带联网'
  const intro = element('p', 'settings-hint')
  intro.textContent = '由模型服务商执行搜索；启用前探测、仅部分模型支持。'
  const toggleLabel = element('label', 'settings-network-toggle')
  const minimax = element('input')
  minimax.type = 'checkbox'
  minimax.dataset.native = 'minimax'
  toggleLabel.append(minimax, document.createTextNode('MiniMax'))
  const state = element('p', 'settings-hint')
  state.dataset.native = 'status'
  state.setAttribute('role', 'status')
  state.textContent = '状态：未启用/不可用'
  const note = element('p', 'settings-hint')
  note.textContent = '搜索由模型服务商执行，查询不经过 Rgent；Rgent 只能中止整次请求。'
  const error = element('p', 'settings-network-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  error.dataset.native = 'error'
  body.append(heading, intro, toggleLabel, state, note, error)

  const showError = (message: string): void => { error.textContent = message; error.hidden = !message }
  const paint = (): void => {
    minimax.checked = config?.nativeSearch.minimax === true
    minimax.disabled = busy || config === null
  }
  minimax.addEventListener('change', () => {
    if (busy || !config) return
    const next = minimax.checked
    busy = true
    showError('')
    paint()
    void handlers.setNativeSearch(next).then((result: NetworkConfigResult) => {
      if (disposed || !host.isCurrent()) return
      if (!result.ok) { showError('保存失败，请重试。'); return }
      config = result.config
    }).catch(() => {
      if (!disposed && host.isCurrent()) showError('保存失败，请重试。')
    }).finally(() => {
      if (!disposed) { busy = false; paint() }
    })
  })

  paint()
  void handlers.get().then(result => {
    if (disposed || !host.isCurrent()) return
    if (!result.ok) { showError('暂时无法读取联网配置。'); return }
    config = result.config
  }).catch(() => {
    if (!disposed && host.isCurrent()) showError('暂时无法读取联网配置。')
  }).finally(() => {
    if (!disposed) paint()
  })

  return () => { disposed = true }
}

/** 无头浏览器只占位：没有第三方执行隔离前不出现可点入口。 */
function headlessSection(): HTMLElement {
  const section = element('section', 'settings-network-headless')
  const heading = element('h3', 'settings-section-title')
  heading.textContent = '无头浏览器'
  const row = element('div', 'settings-network-headless-row')
  const label = element('span')
  label.textContent = '自动打开网页并操作'
  const state = element('button', 'settings-network-headless-state')
  state.type = 'button'
  state.disabled = true
  state.textContent = '未开放'
  row.append(label, state)
  const note = element('p', 'settings-hint')
  note.textContent = '需要先有第三方执行隔离；当前不可用，也不会在任务里悄悄启动。'
  section.append(heading, row, note)
  return section
}

export function mountNetworkPage(host: NetworkPageHost, handlers: NetworkPageHandlers): () => void {
  const page = element('div', 'settings-network-page')
  host.body.append(page)

  const disposers: Array<() => void> = []
  disposers.push(mountNetworkGate({ body: page, isCurrent: host.isCurrent }, handlers.network))

  const card = element('section', 'settings-network-card')
  page.append(card)
  disposers.push(mountNetworkCard({ body: card, isCurrent: host.isCurrent }, handlers.network))

  if (handlers.mcp) {
    const mcp = element('section', 'settings-mcp')
    page.append(mcp)
    disposers.push(mountMcpCard({ body: mcp, isCurrent: host.isCurrent }, handlers.mcp))
  }

  const native = element('section', 'settings-network-native')
  page.append(native)
  disposers.push(mountNativeSearch({ body: native, isCurrent: host.isCurrent }, handlers.network))

  page.append(headlessSection())

  return () => { for (const dispose of disposers.splice(0)) dispose() }
}
