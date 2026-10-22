// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openNetworkPreview } from '../../src/renderer/src/preview-overlay.ts'
import type { NetworkPreviewView } from '../../src/shared/ipc.ts'
import type { Overlay } from '../../src/renderer/src/overlay.ts'

/** 抓页预览：外部文本按字面显示，低信任与截断可见，Esc 关闭并归还焦点。 */

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute('open', '') }
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) }
  })
})

const opened: Overlay[] = []
afterEach(() => {
  for (const overlay of opened.splice(0)) overlay.close()
  document.body.replaceChildren()
})

const view = (over: Partial<NetworkPreviewView> = {}): NetworkPreviewView => ({
  id: 'preview-1',
  url: 'https://example.com/page?q=1',
  host: 'example.com',
  text: '外部正文第一行。',
  bytes: 1234,
  truncated: false,
  fetchedAt: '2026-10-20T12:34:56.000Z',
  lowTrust: true,
  ...over
})

function show(over: Partial<NetworkPreviewView> = {}): Overlay {
  const trigger = document.createElement('button')
  trigger.className = 'trigger'
  trigger.textContent = '查看'
  document.body.append(trigger)
  trigger.focus()
  const overlay = openNetworkPreview(view(over))
  opened.push(overlay)
  return overlay
}

describe('network preview overlay', () => {
  it('renders external text literally instead of interpreting HTML', () => {
    const overlay = show({ text: '<img src=x onerror="window.__pwned=1">正文' })
    const pre = overlay.root.querySelector('pre')!
    expect(pre.textContent).toBe('<img src=x onerror="window.__pwned=1">正文')
    expect(overlay.root.querySelector('img')).toBeNull()
    expect(pre.innerHTML).toContain('&lt;img')
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('keeps the low-trust title and the truncation marker', () => {
    const overlay = show({ truncated: true })
    expect(overlay.root.querySelector('h2')!.textContent).toBe('外部内容（低信任·未核对）')
    expect(overlay.root.querySelector('.network-preview-meta')!.textContent).toContain('已截断')
    expect(overlay.root.textContent).toContain('低信任')
  })

  it('shows the source URL, fetch time, byte count and truncation state in the meta line', () => {
    const meta = show({ truncated: false }).root.querySelector('.network-preview-meta')!
    expect(meta.textContent).toContain('来源：https://example.com/page?q=1')
    expect(meta.textContent).toContain('获取时间：2026-10-20T12:34:56.000Z')
    expect(meta.textContent).toContain('字节数：1234 字节')
    expect(meta.textContent).toContain('未截断')
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const overlay = show()
    // openOverlay 在 microtask 里把焦点交给浮层；等它落位后再按 Esc。
    await Promise.resolve()
    expect(document.activeElement?.classList.contains('network-preview-close')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(overlay.isOpen()).toBe(false)
    expect(document.activeElement?.classList.contains('trigger')).toBe(true)
  })

  it('closes from the explicit close button', async () => {
    const overlay = show()
    await Promise.resolve()
    overlay.root.querySelector<HTMLButtonElement>('.network-preview-close')!.click()
    expect(overlay.isOpen()).toBe(false)
    expect(document.querySelector('.overlay-network-preview')).toBeNull()
  })
})

describe('MCP preview overlay', () => {
  const mcp = (over: Partial<NetworkPreviewView> = {}): NetworkPreviewView => view({
    kind: 'mcp',
    url: 'mcp:deepwiki/read_page',
    host: 'mcp.example',
    title: 'deepwiki/read_page',
    server: 'deepwiki',
    tool: 'read_page',
    text: '外部结果正文。',
    ...over
  })

  it('titles the overlay with MCP server/tool, adds the read-only notice and renders text literally', () => {
    const overlay = show(mcp({ text: '<img src=x onerror="window.__mcpPwned=1">结果' }))
    expect(overlay.root.querySelector('h2')!.textContent).toBe('MCP deepwiki/read_page')
    expect(overlay.root.querySelector('.network-preview-meta')!.textContent).toContain('来源：MCP deepwiki/read_page')
    expect(overlay.root.querySelector('.network-preview-notice')!.textContent).toBe('外部只读内容，低信任，未核对；账本只记调用不记正文')
    const pre = overlay.root.querySelector('pre')!
    expect(pre.textContent).toBe('<img src=x onerror="window.__mcpPwned=1">结果')
    expect(overlay.root.querySelector('img')).toBeNull()
    expect((window as unknown as { __mcpPwned?: number }).__mcpPwned).toBeUndefined()
  })

  it('keeps the truncation marker for MCP while fetch previews stay unchanged', () => {
    const mcpOverlay = show(mcp({ truncated: true, bytes: 40000 }))
    const meta = mcpOverlay.root.querySelector('.network-preview-meta')!
    expect(meta.textContent).toContain('字节数：40000 字节')
    expect(meta.textContent).toContain('已截断')
    // 抓页浮层一字不改：既有标题，且没有 MCP 说明行。
    const fetchOverlay = show()
    expect(fetchOverlay.root.querySelector('h2')!.textContent).toBe('外部内容（低信任·未核对）')
    expect(fetchOverlay.root.querySelector('.network-preview-notice')).toBeNull()
  })
})
