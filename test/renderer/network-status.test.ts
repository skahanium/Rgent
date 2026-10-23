// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { start } from '../../src/renderer/src/shell.ts'

/** 真实外壳 + 假 editor/API：验证状态行的「查看」只跟最近一次成功抓页的预览走，
 *  后续拒绝事件只改提示文本，不会把预览入口冲掉。 */
const editorHarness = vi.hoisted(() => ({ text: '', change: null as ((text: string) => void) | null, focus: vi.fn() }))
vi.mock('../../src/renderer/src/view/editor.ts', () => ({
  mountEditor: (_root: HTMLElement, change: (text: string) => void) => {
    editorHarness.change = change
    const dom = document.createElement('div'), scrollDOM = document.createElement('div')
    let text = ''
    return {
      view: { dom, contentDOM: dom, scrollDOM, compositionStarted: false },
      getText: () => editorHarness.text,
      setText: (value: string) => { text = value; editorHarness.text = value },
      setReadOnly: () => {}, setTheme: () => {}, setActiveTaskIds: () => {}, setNoteHost: () => {},
      onStateChange: () => {}, onViewportChange: () => {}, focus: editorHarness.focus,
      selectionRange: () => ({ anchor: 0, head: 0 }),
      selectionInfo: () => ({ line: 1, column: 1 }),
      headings: () => [], viewport: () => ({ from: 0, to: 0 }), caret: () => 0, markers: () => []
    }
  }
}))
vi.mock('../../src/renderer/src/view/read-only.ts', () => ({ renderReadOnlyMarkdown: vi.fn(), disposeReadOnlyImages: () => {} }))

let handlers: Record<string, Function>, api: any, root: HTMLElement

beforeEach(() => {
  handlers = {}
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
  const fallback = async () => null
  api = new Proxy({
    vaultGet: async () => ({ status: 'ready', sessionId: 's', rootName: 'notes' }),
    vaultWorkspaceGet: async () => null,
    vaultWorkspaceSave: vi.fn(async () => true),
    treeList: async () => [],
    backlinks: async () => [],
    permissionsGet: async () => ({ status: 'ready', entries: [] }),
    lifecycleStatus: async () => ({ status: 'ready', sessionId: 's' }),
    modelConfigGet: async () => ({ ok: false }),
    memoryGet: async () => ({ ok: false }),
    agentTasks: async () => [],
    networkPreview: vi.fn(async () => ({
      ok: true,
      preview: { id: 'preview-1', url: 'https://example.com/page', host: 'example.com', text: '外部正文', bytes: 1234, truncated: false, fetchedAt: '2026-10-20T00:00:00.000Z', lowTrust: true }
    })),
    networkStop: vi.fn(async () => true),
    flushDone: vi.fn(), lifecycleFlushDone: vi.fn(), vaultTransitionDone: vi.fn(async () => true)
  }, { get: (target, key: string) => key in target ? (target as any)[key] : key.startsWith('on') ? (fn: Function) => { handlers[key] = fn; return () => {} } : fallback })
  window.rgent = api
  root = document.createElement('main')
  document.body.append(root)
})
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

const emitNetwork = (network: unknown): void => {
  handlers.onAgentEvent({ id: 'task-1', relPath: 'a.md', status: 'running', sessionId: 's', network })
}

describe('network status row', () => {
  it('keeps the last successful fetch preview clickable after a later refused event', async () => {
    await start(root)
    emitNetwork({ taskId: 'task-1', id: 'preview-1', kind: 'fetch', host: 'example.com', path: '/page', bytes: 1234, truncated: false, outcome: 'ok', at: '2026-10-20T00:00:00.000Z' })
    expect(root.querySelector('.status-task-network')?.textContent).toBe('联网：example.com（1.2 KB，低信任）')
    const first = root.querySelector<HTMLButtonElement>('.status-task-network-view')
    expect(first).not.toBeNull()
    expect(first!.getAttribute('aria-label')).toContain('example.com')

    emitNetwork({ taskId: 'task-1', kind: 'fetch', host: 'bad.example', path: '/bad', outcome: 'refused', code: 'EGRESS_TIMEOUT', at: '2026-10-20T00:00:01.000Z' })
    expect(root.querySelector('.status-task-network')?.textContent).toBe('联网：bad.example（未执行：EGRESS_TIMEOUT）')
    const still = root.querySelector<HTMLButtonElement>('.status-task-network-view')
    expect(still).not.toBeNull()
    expect(still!.disabled).toBe(false)
    // 按钮仍指向成功那次抓页的主机，而不是最近拒绝事件的主机。
    expect(still!.getAttribute('aria-label')).toContain('example.com')
    expect(still!.getAttribute('aria-label')).not.toContain('bad.example')

    still!.click()
    await vi.waitFor(() => expect(api.networkPreview).toHaveBeenCalledWith({ taskId: 'task-1', id: 'preview-1' }))
    await vi.waitFor(() => expect(document.querySelector('.overlay-network-preview')).not.toBeNull())
  })
})

describe('reused fetch status', () => {
  it('says a reused fetch came from this task instead of pretending a fresh fetch', async () => {
    await start(root)
    emitNetwork({ taskId: 'task-1', kind: 'fetch', host: 'example.com', path: '/p', outcome: 'ok', bytes: 1234, reused: true, at: new Date().toISOString() })
    expect(root.querySelector('.status-task-network')?.textContent ?? '').toContain('未再次外发')
  })
})
