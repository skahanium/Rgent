import type { NetworkPreviewView } from '../../shared/ipc.ts'
import { openOverlay, type Overlay } from './overlay.ts'

/** 抓页结果的只读预览：外部文本一律按字面显示（textContent，绝不 innerHTML），
 *  标题与来源常驻「低信任·未核对」，不做链接、不给采纳入口。合同见
 *  docs/decisions.md「2026-10-20 联网只读合同」第 8 条。 */
export function openNetworkPreview(view: NetworkPreviewView): Overlay {
  const overlay = openOverlay({
    label: '外部内容（低信任·未核对）',
    initialFocus: () => overlay.root.querySelector<HTMLElement>('.network-preview-close')
  })
  overlay.root.classList.add('overlay-network-preview')

  const title = document.createElement('h2')
  title.textContent = '外部内容（低信任·未核对）'

  const meta = document.createElement('p')
  meta.className = 'network-preview-meta settings-hint'
  meta.textContent = `来源：${view.url} · 获取时间：${view.fetchedAt} · 字节数：${view.bytes} 字节 · ${view.truncated ? '已截断' : '未截断'}`
  meta.style.overflowWrap = 'anywhere'

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

  overlay.root.append(title, meta, body, footer)
  return overlay
}
