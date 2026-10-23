import type { NetworkConfigView } from '../../shared/ipc.ts'
import { hostErrorText } from './host-errors.ts'
import { mountNetworkCard, mountNetworkGate, networkErrorText, type NetworkCardHandlers } from './settings-network.ts'
import { mountMcpCard, type McpCardHandlers } from './settings-mcp.ts'

/**
 * 「联网」页：设备总闸、内置搜索／抓取、远端 MCP、模型自带联网与无头浏览器占位。
 *
 * 页头总闸只管搜索／抓取（含搜索类 MCP）与模型自带联网；非搜索类 MCP 只受启用与白名单约束，
 * 所以 MCP 卡自己写明边界。模型自带联网在勾选时先探测，成功才写配置。
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

/** 模型自带联网：勾选时先探测（只发 ping），成功才写配置；失败保持未勾选并显示人话。 */
export function mountNativeSearch(host: NetworkPageHost, handlers: Pick<NetworkCardHandlers, 'get' | 'setNativeSearch' | 'probe'>): () => void {
  const body = host.body
  let config: NetworkConfigView | null = null
  let busy = false
  let disposed = false
  let probeFailed = false

  const heading = element('h3', 'settings-section-title')
  heading.textContent = '模型自带联网'
  const intro = element('p', 'settings-hint')
  intro.textContent = '由模型服务商执行搜索；启用前先探测，仅部分模型支持。'
  const toggleLabel = element('label', 'settings-network-toggle')
  const minimax = element('input')
  minimax.type = 'checkbox'
  minimax.dataset.native = 'minimax'
  toggleLabel.append(minimax, document.createTextNode('MiniMax'))
  const state = element('p', 'settings-hint')
  state.dataset.native = 'status'
  state.setAttribute('role', 'status')
  state.textContent = '状态：读取中…'
  const note = element('p', 'settings-hint')
  note.textContent = '搜索由模型服务商执行，查询不经过 Rgent；Rgent 只能中止整次请求。启用探测只发 ping，不带笔记内容。'
  const error = element('p', 'settings-network-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  error.dataset.native = 'error'
  body.append(heading, intro, toggleLabel, state, note, error)

  const showError = (message: string): void => { error.textContent = message; error.hidden = !message }
  const paint = (): void => {
    minimax.checked = config?.nativeSearch.minimax === true
    minimax.disabled = busy || config === null
    state.textContent = !config
      ? '状态：读取中…'
      : busy
        ? '状态：处理中…'
        : config.nativeSearch.minimax
          ? '状态：探测通过（已启用）'
          : probeFailed
            ? '状态：不可用'
            : '状态：未启用'
  }

  const change = async (): Promise<void> => {
    if (busy || !config) return
    const next = minimax.checked
    busy = true
    showError('')
    paint()
    try {
      if (next) {
        // 先探测再落配置：探测失败时磁盘保持原样，界面也不留下勾选。
        if (!handlers.probe) {
          probeFailed = true
          showError(hostErrorText('NATIVE_SEARCH_UNAVAILABLE'))
          return
        }
        const probe = await handlers.probe()
        if (disposed || !host.isCurrent()) return
        if (!probe.ok) {
          probeFailed = true
          showError(hostErrorText(probe.error))
          return
        }
        probeFailed = false
        const result = await handlers.setNativeSearch(true)
        if (disposed || !host.isCurrent()) return
        if (!result.ok) { showError(networkErrorText(result.error)); return }
        config = result.config
      } else {
        const result = await handlers.setNativeSearch(false)
        if (disposed || !host.isCurrent()) return
        if (!result.ok) { showError(networkErrorText(result.error)); return }
        config = result.config
        probeFailed = false
      }
    } catch {
      if (!disposed && host.isCurrent()) {
        probeFailed = next
        showError(next ? hostErrorText('NATIVE_SEARCH_UNAVAILABLE') : '操作未完成，请重试；仍然失败时请检查联网配置。')
      }
    } finally {
      if (!disposed) { busy = false; paint() }
    }
  }
  minimax.addEventListener('change', () => { void change() })

  paint()
  void handlers.get().then(result => {
    if (disposed || !host.isCurrent()) return
    if (!result.ok) { showError(networkErrorText(result.error)); return }
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
