import type { NetworkPreviewView } from '../../shared/ipc.ts'
import { openOverlay, type Overlay } from './overlay.ts'

/** 抓页／MCP 结果的只读预览：外部文本一律按字面显示（textContent，绝不 innerHTML），
 *  标题与来源常驻「低信任·未核对」，不做链接、不给采纳入口。合同见
 *  docs/decisions.md「2026-10-20 联网只读合同」第 8 条与「2026-10-22 质量与体验小轮」第 1 条。
 *  抓页（默认）浮层一字不改；只有 MCP 条目换标题、加一行来源说明。 */
export function openNetworkPreview(view: NetworkPreviewView): Overlay {
  const isMcp = view.kind === 'mcp'
  const mcpLabel = isMcp ? `MCP ${view.server ?? '未知服务器'}/${view.tool ?? '未知工具'}` : ''
  const overlay = openOverlay({
    label: isMcp ? `${mcpLabel}（低信任·未核对）` : '外部内容（低信任·未核对）',
    initialFocus: () => overlay.root.querySelector<HTMLElement>('.network-preview-close')
  })
  overlay.root.classList.add('overlay-network-preview')

  const title = document.createElement('h2')
  title.textContent = isMcp ? mcpLabel : '外部内容（低信任·未核对）'

  const meta = document.createElement('p')
  meta.className = 'network-preview-meta settings-hint'
  // MCP 的 url 只是占位来源，真正的来源是服务器/工具；抓页仍按原样显示 URL。
  const source = isMcp ? mcpLabel : view.url
  meta.textContent = `来源：${source} · 获取时间：${view.fetchedAt} · 字节数：${view.bytes} 字节 · ${view.truncated ? '已截断' : '未截断'}`
  meta.style.overflowWrap = 'anywhere'

  const notice = isMcp ? document.createElement('p') : null
  if (notice) {
    notice.className = 'network-preview-notice settings-hint'
    notice.textContent = '外部只读内容，低信任，未核对；账本只记调用不记正文'
  }

  const body = document.createElement('pre')
  body.className = 'network-preview-text'
  body.tabIndex = 0
  // 外部内容里的标签、事件处理器都只是文字；这里只设置 textContent。
  body.textContent = view.text
  body.style.whiteSpace = 'pre-wrap'
  body.style.overflowWrap = 'anywhere'
  body.style.maxHeight = '50vh'
  body.style.overflow = 'auto'

  const footer = document.createElement('footer')
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'network-preview-close'
  close.textContent = '关闭'
  close.addEventListener('click', () => overlay.close())
  footer.append(close)

  overlay.root.append(title, meta, ...(notice ? [notice] : []), body, footer)
  return overlay
}
