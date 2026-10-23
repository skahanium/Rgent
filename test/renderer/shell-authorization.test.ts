// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { start } from '../../src/renderer/src/shell.ts'
import type { AgentAuthorizationPreview, AgentAuthorizationRequest, AgentStartRequest, NoteSnapshot } from '../../src/shared/ipc.ts'

/**
 * 真实外壳 + 假 editor/API：四档授权卡的档位透传、自动档不记忆与自动新建通知。
 * 卡片自身的渲染与交互在 authorization-popover.test.ts 里钉住；这里只测接线。
 */
const editorHarness = vi.hoisted(() => ({
  text: '',
  change: null as ((text: string) => void) | null,
  dom: null as unknown as HTMLElement,
  focus: vi.fn()
}))
vi.mock('../../src/renderer/src/view/editor.ts', () => ({
  mountEditor: (_root: HTMLElement, change: (text: string) => void) => {
    editorHarness.change = change
    editorHarness.dom = document.createElement('div')
    const dom = editorHarness.dom, scrollDOM = document.createElement('div')
    return {
      view: { dom, contentDOM: dom, scrollDOM, compositionStarted: false, dispatch: () => {}, state: { doc: { length: 0 }, selection: { main: { head: 0 } } }, coordsAtPos: () => null },
      getText: () => editorHarness.text,
      setText: (value: string) => { editorHarness.text = value },
      insertAtSelection: () => false,
      applyExternalText: () => {},
      // 口令在空段首：Enter 时把它当成一条待发送的 `/` 命令。
      slashCommandStart: () => editorHarness.text.startsWith('/') ? 0 : null,
      setReadOnly: () => {}, setTheme: () => {}, setActiveTaskIds: () => {}, setNoteHost: () => {},
      onStateChange: () => {}, onViewportChange: () => {}, focus: editorHarness.focus,
      selectionRange: () => ({ anchor: editorHarness.text.length, head: editorHarness.text.length }),
      selectionInfo: () => ({ line: 1, column: 1 }),
      headings: () => [], viewport: () => ({ from: 0, to: 0 }), caret: () => 0, markers: () => []
    }
  }
}))
vi.mock('../../src/renderer/src/view/read-only.ts', () => ({ renderReadOnlyMarkdown: vi.fn(), disposeReadOnlyImages: () => {} }))

let handlers: Record<string, Function>, api: any, root: HTMLElement
let files: Map<string, { content: string; revision: string; objectVersion: string }>
let revisionSerial = 0

const modelConfig = {
  providers: [{ provider: 'deepseek' as const, configured: true, baseURL: 'https://api.deepseek.com', hasKey: true, modelCount: 1 }],
  models: [{ id: 'm1', provider: 'deepseek' as const, modelId: 'deepseek-chat', contextTokens: 65536 }],
  defaultModelId: 'm1',
  limits: { none: { seconds: 180, steps: 4, tools: 0 }, local: { seconds: 300, steps: 12, tools: 24 }, network: { seconds: 600, steps: 20, tools: 40 } }
}

const snapshotOf = (relPath: string): NoteSnapshot => {
  const file = files.get(relPath)
  if (!file) throw Error('NOTE_MISSING')
  return { content: file.content, revision: file.revision, objectVersion: file.objectVersion, sessionId: 's' }
}
const previewFor = (request: AgentAuthorizationRequest, id: string): AgentAuthorizationPreview => ({
  id, sessionId: 's', origin: request.relPath,
  sources: [{ sourceId: 'a', relPath: '甲.md', title: '甲', revision: 'r', objectVersion: 'o', sessionId: 's', fingerprint: 'x', tier: 'reference' }],
  recipient: { modelId: 'deepseek-chat', host: 'api.deepseek.com', provider: 'deepseek' },
  level: request.level,
  write: request.level === 'write' || request.level === 'auto',
  autoApproveWrites: request.level === 'auto'
})

beforeEach(() => {
  handlers = {}; revisionSerial = 0
  files = new Map([['甲.md', { content: '', revision: 'r0', objectVersion: 'o0' }]])
  editorHarness.text = ''; editorHarness.change = null
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
  let previewSerial = 0
  const fallback = async () => null
  api = new Proxy({
    vaultGet: async () => ({ status: 'ready', sessionId: 's', rootName: 'notes' }),
    vaultWorkspaceGet: async () => ({ version: 1, tabs: [{ relPath: '甲.md' }], active: '甲.md', sidebarHidden: true, treeScroll: 0, resourceScroll: 0 }),
    vaultWorkspaceSave: vi.fn(async () => true),
    treeList: vi.fn(async () => [...files.keys()].map(relPath => ({ name: relPath.split('/').pop()!, relPath, kind: 'note' }))),
    backlinks: async () => [],
    permissionsGet: async () => ({ status: 'ready', entries: [] }),
    lifecycleStatus: async () => ({ status: 'ready', sessionId: 's' }),
    modelConfigGet: async () => ({ ok: true, config: modelConfig }),
    memoryGet: async () => ({ ok: false }),
    agentTasks: async () => [],
    noteRead: vi.fn(async (relPath: string) => snapshotOf(relPath)),
    noteInspect: vi.fn(async (request: { relPath: string; objectVersion: string }) => {
      const file = files.get(request.relPath)
      return file && file.objectVersion === request.objectVersion
        ? { status: 'ready', snapshot: { ...file, sessionId: 's' } }
        : { status: 'missing', sessionId: 's', relPath: request.relPath, objectVersion: request.objectVersion }
    }),
    noteWrite: vi.fn(async (request: { relPath: string; content: string; expectedRevision: string }) => {
      const file = files.get(request.relPath)
      if (!file) return { ok: false, error: 'NOTE_MISSING' }
      if (file.revision !== request.expectedRevision) return { ok: false, error: 'CONFLICT' }
      file.content = request.content; file.revision = `r${++revisionSerial}`; file.objectVersion = `o${revisionSerial}`
      return { ok: true, revision: file.revision, sessionId: 's', objectVersion: file.objectVersion }
    }),
    agentAuthorizationPreview: vi.fn(async (request: AgentAuthorizationRequest) => ({ ok: true as const, preview: previewFor(request, `p${++previewSerial}`) })),
    agentAuthorizationDiscard: vi.fn(async () => {}),
    agentStart: vi.fn(async (_request: AgentStartRequest) => ({ ok: true as const, id: 'task-1' })),
    agentWriteConfirm: vi.fn(async () => ({ ok: true })),
    onMenu: (channel: string, fn: Function) => { handlers[channel] = fn; return () => {} },
    flushDone: vi.fn(), lifecycleFlushDone: vi.fn(), vaultTransitionDone: vi.fn(async () => true)
  }, { get: (target, key: string) => key in target ? (target as any)[key] : key.startsWith('on') ? (fn: Function) => { handlers[key] = fn; return () => {} } : fallback })
  window.rgent = api
  root = document.createElement('main'); document.body.append(root)
})
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.clearAllTimers() })

const waitForNote = async (): Promise<void> => {
  await start(root)
  await vi.waitFor(() => expect(root.querySelector('.tab')?.getAttribute('data-rel')).toBe('甲.md'))
  await vi.waitFor(() => expect(root.querySelector('.status-dot')).not.toBeNull())
}
const typeSlash = (prompt: string): void => {
  editorHarness.text = `/${prompt}`
  editorHarness.change!(editorHarness.text)
  editorHarness.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}
const waitForCard = async (): Promise<HTMLElement> => {
  await vi.waitFor(() => expect(document.querySelector('.overlay-authorization')).not.toBeNull())
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  return document.querySelector<HTMLElement>('.overlay-authorization')!
}
const endTask = (id = 'task-1'): void => { handlers.onAgentEvent({ id, relPath: '甲.md', status: 'completed', sessionId: 's' }) }

it('passes the chosen level through preview and start without network or MCP flags', async () => {
  await waitForNote()
  typeSlash('问题一')
  await waitForCard()
  expect(api.agentAuthorizationPreview.mock.calls.at(-1)![0]).toMatchObject({ references: [], level: 'read' })
  expect(api.agentAuthorizationPreview.mock.calls.at(-1)![0]).not.toHaveProperty('network')
  expect(api.agentAuthorizationPreview.mock.calls.at(-1)![0]).not.toHaveProperty('mcp')

  document.querySelector<HTMLButtonElement>('.authorization-level[data-level="write"]')!.click()
  await vi.waitFor(() => expect(api.agentAuthorizationPreview.mock.calls.at(-1)![0].level).toBe('write'))
  document.querySelector<HTMLButtonElement>('.authorization-send')!.click()
  await vi.waitFor(() => expect(api.agentStart).toHaveBeenCalledTimes(1))
  const started = api.agentStart.mock.calls[0]![0]
  expect(started).toMatchObject({ previewId: expect.any(String), level: 'write' })
  expect(started).not.toHaveProperty('network')
  expect(started).not.toHaveProperty('mcp')
  expect(started).not.toHaveProperty('references')

  // 同会话下一场沿用上次手动档位（可写），不需要重新点档。
  endTask()
  typeSlash('问题二')
  await waitForCard()
  await vi.waitFor(() => expect(api.agentAuthorizationPreview.mock.calls.at(-1)![0].level).toBe('write'))
  expect(document.querySelector<HTMLButtonElement>('.authorization-level[data-level="write"]')!.getAttribute('aria-checked')).toBe('true')
})

it('never carries the auto level into the next session', async () => {
  await waitForNote()
  typeSlash('自动一场')
  await waitForCard()
  document.querySelector<HTMLButtonElement>('.authorization-level[data-level="auto"]')!.click()
  await vi.waitFor(() => expect(api.agentAuthorizationPreview.mock.calls.at(-1)![0].level).toBe('auto'))
  document.querySelector<HTMLButtonElement>('.authorization-send')!.click()
  await vi.waitFor(() => expect(api.agentStart).toHaveBeenCalledTimes(1))
  expect(api.agentStart.mock.calls[0]![0].level).toBe('auto')

  endTask()
  typeSlash('下一场')
  await waitForCard()
  // 自动档收口成「可写」：下一场仍是逐次确认，不是自动批准。
  await vi.waitFor(() => expect(api.agentAuthorizationPreview.mock.calls.at(-1)![0].level).toBe('write'))
  expect(document.querySelector<HTMLButtonElement>('.authorization-level[data-level="auto"]')!.getAttribute('aria-checked')).toBe('false')
  expect(document.querySelector<HTMLButtonElement>('.authorization-level[data-level="write"]')!.getAttribute('aria-checked')).toBe('true')
})

it('shows one actionable notice when the auto level creates a note', async () => {
  await waitForNote()
  files.set('folder/新篇.md', { content: '自动新建的正文', revision: 'r-new', objectVersion: 'o-new' })
  handlers.onAgentEvent({ id: 'task-2', relPath: '甲.md', status: 'running', sessionId: 's', created: { relPath: 'folder/新篇.md' } })
  const notice = document.querySelector<HTMLElement>('.notice')!
  expect(notice).not.toBeNull()
  expect(notice.querySelector('.notice-title')!.textContent).toBe('已新建《新篇》')
  expect(notice.querySelector('.notice-detail')!.textContent).toBe('已按自动档创建；可以打开查看。')
  const open = notice.querySelector<HTMLButtonElement>('.notice-action')!
  expect(open.textContent).toBe('打开')
  open.click()
  await vi.waitFor(() => expect(api.noteRead).toHaveBeenCalledWith('folder/新篇.md'))
  await vi.waitFor(() => expect(editorHarness.text).toBe('自动新建的正文'))
  expect(root.querySelectorAll('.tab')).toHaveLength(2)
})

it('ignores a created notice from a foreign vault session', async () => {
  await waitForNote()
  handlers.onAgentEvent({ id: 'task-3', relPath: '甲.md', status: 'running', sessionId: 'other', created: { relPath: '别库.md' } })
  expect(document.querySelector('.notice')).toBeNull()
})
