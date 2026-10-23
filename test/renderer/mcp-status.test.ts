// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { start } from '../../src/renderer/src/shell.ts'

/** 真实外壳 + 假 editor/API：MCP／联网事件不再进底栏；无当前篇时浮层写「另有 N 项」。 */
const editorHarness = vi.hoisted(() => ({ text: '', change: null as ((text: string) => void) | null, focus: vi.fn() }))
vi.mock('../../src/renderer/src/view/editor.ts', () => ({
  mountEditor: (_root: HTMLElement, change: (text: string) => void) => {
    editorHarness.change = change
    const dom = document.createElement('div'), scrollDOM = document.createElement('div')
    let text = ''
    return {
      view: { dom, contentDOM: dom, scrollDOM, compositionStarted: false, dispatch: () => {}, state: { doc: { length: 0 } } },
      getText: () => editorHarness.text,
      setText: (value: string) => { text = value; editorHarness.text = value },
      insertAtSelection: () => false,
      applyExternalText: () => {},
      slashCommandStart: () => null,
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
    networkConfig: async () => ({ ok: true, config: { enabled: false, provider: null, hasKey: false } }),
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

describe('MCP chrome after status-bar strip', () => {
  it('keeps MCP host text out of the bar and shows the dock for other notes', async () => {
    await start(root)
    emit({ network: mcpEvent({ bytes: 1234 }) })
    expect(root.querySelector('.status-task-network')).toBeNull()
    expect(root.querySelector('.status-task-network-stop')).toBeNull()
    expect(root.querySelector('.status-task-network-view')).toBeNull()
    expect(root.querySelector('.status-vault')).toBeNull()
    expect(root.dataset.vault).toBe('notes')
    expect(document.querySelector<HTMLElement>('.task-dock')?.dataset.kind).toBe('others')
    expect(document.querySelector('.task-dock-others')?.textContent).toBe('另有 1 项')
  })

  it('hides the dock when the task ends', async () => {
    await start(root)
    emit({ network: mcpEvent() })
    expect(document.querySelector<HTMLElement>('.task-dock')?.hidden).toBe(false)
    emit({ status: 'completed' })
    expect(document.querySelector<HTMLElement>('.task-dock')?.hidden).toBe(true)
    expect(root.querySelector('.status-task')).toBeNull()
  })
})
