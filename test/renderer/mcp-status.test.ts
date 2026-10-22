// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { start } from '../../src/renderer/src/shell.ts'

/** 真实外壳 + 假 editor/API：MCP 事件也算联网活动，但状态行是 `MCP <server>/<tool>：…`；
 *  只有成功且带预览 id（宿主确实缓存了结果）的事件才出现「查看」，「停止联网」照常出现；
 *  任务结束清理。 */
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
      onStateChange: () => {}, focus: editorHarness.focus,
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
    networkPreview: vi.fn(async () => ({ ok: false })),
    networkStop: vi.fn(async () => true),
    flushDone: vi.fn(), lifecycleFlushDone: vi.fn(), vaultTransitionDone: vi.fn(async () => true)
  }, { get: (target, key: string) => key in target ? (target as any)[key] : key.startsWith('on') ? (fn: Function) => { handlers[key] = fn; return () => {} } : fallback })
  window.rgent = api
  root = document.createElement('main')
  document.body.append(root)
})
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

const emit = (opts: { status?: string; network?: unknown; id?: string }): void => {
  handlers.onAgentEvent({ id: opts.id ?? 'task-1', relPath: 'a.md', status: opts.status ?? 'running', sessionId: 's', ...(opts.network !== undefined ? { network: opts.network } : {}) })
}

const mcpEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  taskId: 'task-1',
  kind: 'mcp',
  host: 'mcp.example.com',
  path: '/mcp',
  server: '示例服务器',
  tool: 'read_page',
  outcome: 'ok',
  at: '2026-10-21T00:00:00.000Z',
  ...over
})

const statusText = (): string | null => root.querySelector('.status-task-network')?.textContent ?? null

describe('MCP status row', () => {
  it('shows the server/tool, size and low-trust mark on success; without a preview id there is no view button', async () => {
    await start(root)
    emit({ network: mcpEvent({ bytes: 1234 }) })
    expect(statusText()).toBe('MCP 示例服务器/read_page：已执行（1.2 KB，低信任）')
    // 这条事件没有预览 id（结果未缓存）：不能出现「查看」。
    expect(root.querySelector('.status-task-network-view')).toBeNull()
    // 停止联网仍按网络事件逻辑出现（MCP 事件也算联网活动）。
    expect(root.querySelector<HTMLButtonElement>('.status-task-network-stop')).not.toBeNull()
  })

  it('marks truncation and omits the size when the event has no bytes', async () => {
    await start(root)
    emit({ network: mcpEvent({ bytes: 2048, truncated: true }) })
    expect(statusText()).toBe('MCP 示例服务器/read_page：已执行（2.0 KB，低信任，已截断）')
    emit({ network: mcpEvent({ outcome: 'ok', at: '2026-10-21T00:00:01.000Z' }) })
    expect(statusText()).toBe('MCP 示例服务器/read_page：已执行（低信任）')
  })

  it('shows a refusal with the fixed code and still offers stop, not view', async () => {
    await start(root)
    emit({ network: mcpEvent({ outcome: 'refused', code: 'MCP_TIMEOUT' }) })
    expect(statusText()).toBe('MCP 示例服务器/read_page：未执行（MCP_TIMEOUT）')
    expect(root.querySelector('.status-task-network-view')).toBeNull()
    expect(root.querySelector<HTMLButtonElement>('.status-task-network-stop')).not.toBeNull()
  })

  it('hides the fetch preview button once the latest network event is MCP', async () => {
    await start(root)
    emit({ network: { taskId: 'task-1', id: 'preview-1', kind: 'fetch', host: 'example.com', path: '/page', bytes: 1234, outcome: 'ok', at: '2026-10-21T00:00:00.000Z' } })
    expect(root.querySelector('.status-task-network-view')).not.toBeNull()
    emit({ network: mcpEvent() })
    expect(statusText()).toContain('MCP 示例服务器/read_page：已执行')
    // 这次 MCP 事件没有预览 id：不能把上一次抓页的「查看」错配到这次调用。
    expect(root.querySelector('.status-task-network-view')).toBeNull()
  })

  it('opens the MCP preview overlay from 查看 and shows MCP server/tool with the notice', async () => {
    await start(root)
    api.networkPreview.mockResolvedValue({
      ok: true,
      preview: {
        id: 'mcp-preview-1',
        kind: 'mcp',
        url: 'mcp:示例服务器/read_page',
        host: 'mcp.example.com',
        title: '示例服务器/read_page',
        server: '示例服务器',
        tool: 'read_page',
        text: '外部结果正文。',
        bytes: 1234,
        truncated: false,
        fetchedAt: '2026-10-21T00:00:00.000Z',
        lowTrust: true
      }
    })
    emit({ network: mcpEvent({ id: 'mcp-preview-1', bytes: 1234 }) })
    const view = root.querySelector<HTMLButtonElement>('.status-task-network-view')
    expect(view).not.toBeNull()
    expect(view!.getAttribute('aria-label')).toContain('MCP 示例服务器/read_page')
    view!.click()
    await vi.waitFor(() => expect(api.networkPreview).toHaveBeenCalledWith({ taskId: 'task-1', id: 'mcp-preview-1' }))
    const overlay = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('.overlay-network-preview')
      if (!element) throw new Error('MCP preview overlay not open')
      return element
    })
    expect(overlay.querySelector('h2')!.textContent).toBe('MCP 示例服务器/read_page')
    expect(overlay.querySelector('.network-preview-text')!.textContent).toBe('外部结果正文。')
    expect(overlay.querySelector('.network-preview-notice')!.textContent).toBe('外部只读内容，低信任，未核对；账本只记调用不记正文；预览最多显示 32 KiB')
  })

  it('clears the MCP status row and its stop button when the task ends', async () => {
    await start(root)
    emit({ network: mcpEvent() })
    expect(statusText()).not.toBeNull()
    expect(root.querySelector('.status-task-network-stop')).not.toBeNull()
    emit({ status: 'completed' })
    expect(statusText()).toBeNull()
    expect(root.querySelector('.status-task-network-stop')).toBeNull()
    expect(root.querySelector('.status-task')).toBeNull()
  })
})

describe('mcp status tool errors', () => {
  it('marks a tool-level error result instead of claiming a clean execution', async () => {
    await start(root)
    emit({ network: { taskId: 'task-1', kind: 'mcp', host: 'mcp.example', path: '', server: 'deepwiki', tool: 'read', outcome: 'ok', bytes: 100, toolError: true, at: new Date().toISOString() } })
    expect(statusText()).toContain('工具报错')
  })
})
