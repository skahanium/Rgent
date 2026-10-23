// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { start } from '../../src/renderer/src/shell.ts'

/** 真实外壳 + 假 editor/API：抓页事件不再进底栏，总闸小球可点。 */
const editorHarness = vi.hoisted(() => ({ text: '', change: null as ((text: string) => void) | null, focus: vi.fn() }))
vi.mock('../../src/renderer/src/view/editor.ts', () => ({
  mountEditor: (_root: HTMLElement, change: (text: string) => void) => {
    editorHarness.change = change
    const dom = document.createElement('div'), scrollDOM = document.createElement('div')
    return {
      view: { dom, contentDOM: dom, scrollDOM, compositionStarted: false, dispatch: () => {}, state: { doc: { length: 0 } } },
      getText: () => editorHarness.text,
      setText: (value: string) => { editorHarness.text = value },
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
let networkEnabled = false

beforeEach(() => {
  handlers = {}
  networkEnabled = false
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
    networkConfig: vi.fn(async (value?: { enabled?: boolean }) => {
      if (value && typeof value.enabled === 'boolean') networkEnabled = value.enabled
      return { ok: true, config: { enabled: networkEnabled, provider: null, hasKey: false } }
    }),
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

describe('network chrome after status-bar strip', () => {
  it('does not dump fetch summaries into the bar', async () => {
    await start(root)
    emitNetwork({ taskId: 'task-1', id: 'preview-1', kind: 'fetch', host: 'example.com', path: '/page', bytes: 1234, truncated: false, outcome: 'ok', at: '2026-10-20T00:00:00.000Z' })
    expect(root.querySelector('.status-task-network')).toBeNull()
    expect(root.querySelector('.status-task-network-view')).toBeNull()
    expect(root.querySelector('.status-vault')).toBeNull()
    expect(document.querySelector<HTMLElement>('.task-dock')?.dataset.kind).toBe('others')
  })

  it('toggles the device gate from the right-side ball', async () => {
    await start(root)
    await vi.waitFor(() => expect(root.querySelector('.status-dot')).not.toBeNull())
    const button = root.querySelector<HTMLButtonElement>('.status-dot')!
    expect(button.dataset.state).toBe('offline')
    button.click()
    await vi.waitFor(() => expect(api.networkConfig).toHaveBeenCalledWith({ enabled: true }))
    await vi.waitFor(() => expect(button.dataset.state).toBe('online'))
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })
})
