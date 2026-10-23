// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { start } from '../../src/renderer/src/shell.ts'
import type { AgentAuthorizationPreview, AgentAuthorizationRequest, AgentStartRequest, NoteSnapshot } from '../../src/shared/ipc.ts'

/**
 * 真实外壳 + 假 editor/API：三档作业范围的静默提交、按 tab 记忆、零确认新建通知、
 * 库内删除与 note:deleted。授权卡／写确认卡／删除确认卡已移除，这里同时钉住「没有浮层」。
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
let started = 0

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
  id, sessionId: 's', origin: request.relPath, sources: [],
  recipient: { modelId: 'deepseek-chat', host: 'api.deepseek.com', provider: 'deepseek' },
  scope: request.scope,
  canCreate: true, canStructure: true, canDelete: true
})

beforeEach(() => {
  handlers = {}; revisionSerial = 100; started = 0
  files = new Map([
    ['甲.md', { content: '', revision: 'r0', objectVersion: 'o0' }],
    ['资料/乙.md', { content: '', revision: 'r1', objectVersion: 'o1' }]
  ])
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
    vaultWorkspaceGet: async () => ({ version: 1, tabs: [{ relPath: '甲.md' }, { relPath: '资料/乙.md' }], active: '甲.md', sidebarHidden: true, treeScroll: 0, resourceScroll: 0 }),
    vaultWorkspaceSave: vi.fn(async () => true),
    treeList: vi.fn(async () => [
      ...[...files.keys()].filter(relPath => !relPath.includes('/')).map(relPath => ({ name: relPath, relPath, kind: 'note' })),
      ...[...new Set([...files.keys()].filter(relPath => relPath.includes('/')).map(relPath => relPath.split('/')[0]!))].map(folder => ({
        name: folder, relPath: folder, kind: 'dir',
        children: [...files.keys()].filter(relPath => relPath.startsWith(`${folder}/`)).map(relPath => ({
          name: relPath.split('/').pop()!, relPath, kind: 'note'
        }))
      }))
    ]),
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
    humanTrashOnThisPlatform: true,
    vaultTrashDelete: vi.fn(async () => ({ ok: true })),
    vaultCatalog: async () => ({ revision: 'r1', diagnostic: null, lastVaultId: null, activeId: null, entries: [] }),
    agentAuthorizationPreview: vi.fn(async (request: AgentAuthorizationRequest) => ({ ok: true as const, preview: previewFor(request, `p${++previewSerial}`) })),
    agentAuthorizationDiscard: vi.fn(async () => {}),
    agentStart: vi.fn(async (_request: AgentStartRequest) => ({ ok: true as const, id: `task-${++started}` })),
    onMenu: (channel: string, fn: Function) => { handlers[channel] = fn; return () => {} },
    flushDone: vi.fn(), lifecycleFlushDone: vi.fn(), vaultTransitionDone: vi.fn(async () => true)
  }, { get: (target, key: string) => key in target ? (target as any)[key] : key.startsWith('on') ? (fn: Function) => { handlers[key] = fn; return () => {} } : fallback })
  window.rgent = api
  root = document.createElement('main'); document.body.append(root)
})
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.clearAllTimers() })

const waitForNote = async (relPath = '甲.md'): Promise<void> => {
  await start(root)
  await vi.waitFor(() => expect(root.querySelector('.tab')?.getAttribute('data-rel')).toBe(relPath))
  await vi.waitFor(() => expect(root.querySelector('.status-dot')).not.toBeNull())
}
const typeSlash = (prompt: string): void => {
  editorHarness.text = `/${prompt}`
  editorHarness.change!(editorHarness.text)
  editorHarness.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}
const chooseScope = async (scope: 'note' | 'folder' | 'vault'): Promise<void> => {
  root.querySelector<HTMLButtonElement>('.status-scope-button')!.click()
  const item = [...root.querySelectorAll<HTMLButtonElement>('.status-scope-option')]
    .find(button => button.dataset.scopeOption === scope)!
  item.click()
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('.status-scope-button')!.dataset.scope).toBe(scope))
}
const currentScope = (): string => root.querySelector<HTMLButtonElement>('.status-scope-button')!.dataset.scope ?? ''
const endTask = (id = 'task-1'): void => { handlers.onAgentEvent({ id, relPath: '甲.md', status: 'completed', sessionId: 's' }) }

it('submits silently with the default note scope and never opens a card', async () => {
  await waitForNote()
  typeSlash('问题一')
  await vi.waitFor(() => expect(api.agentAuthorizationPreview).toHaveBeenCalledTimes(1))
  const previewRequest = api.agentAuthorizationPreview.mock.calls[0]![0]
  expect(previewRequest).toMatchObject({ scope: 'note' })
  expect(previewRequest).not.toHaveProperty('references')
  expect(previewRequest).not.toHaveProperty('level')
  expect(previewRequest).not.toHaveProperty('network')
  expect(previewRequest).not.toHaveProperty('mcp')
  expect(document.querySelector('.overlay-authorization')).toBeNull()
  expect(document.querySelector('.write-confirm')).toBeNull()
  expect(document.querySelector('.overlay-write-confirm')).toBeNull()

  await vi.waitFor(() => expect(api.agentStart).toHaveBeenCalledTimes(1))
  const startedRequest = api.agentStart.mock.calls[0]![0]
  expect(startedRequest).toMatchObject({ previewId: 'p1', scope: 'note' })
  expect(startedRequest).not.toHaveProperty('level')
  expect(startedRequest).not.toHaveProperty('references')
  expect(startedRequest).not.toHaveProperty('network')
  expect(startedRequest).not.toHaveProperty('mcp')
})

it('remembers the scope per tab and sends the chosen level', async () => {
  await waitForNote()
  await chooseScope('vault')
  expect(currentScope()).toBe('vault')
  typeSlash('整库一场')
  await vi.waitFor(() => expect(api.agentStart).toHaveBeenCalledTimes(1))
  expect(api.agentAuthorizationPreview.mock.calls.at(-1)![0].scope).toBe('vault')
  expect(api.agentStart.mock.calls.at(-1)![0].scope).toBe('vault')
  endTask()
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.task-dock')!.dataset.kind).toBe('hidden'))

  // 切到同库的另一篇：默认又是本篇；切回来仍记得整库。
  root.querySelector<HTMLButtonElement>('.tab[data-rel="资料/乙.md"]')!.click()
  await vi.waitFor(() => expect(root.querySelector('.tab[aria-selected="true"]')?.getAttribute('data-rel')).toBe('资料/乙.md'))
  expect(currentScope()).toBe('note')
  typeSlash('同册默认')
  await vi.waitFor(() => expect(api.agentStart).toHaveBeenCalledTimes(2))
  expect(api.agentStart.mock.calls.at(-1)![0].scope).toBe('note')

  root.querySelector<HTMLButtonElement>('.tab[data-rel="甲.md"]')!.click()
  await vi.waitFor(() => expect(currentScope()).toBe('vault'))
})

it('lets a folder note use 同册 but disables it on a root note', async () => {
  await waitForNote()
  // 根目录笔记：同册禁用，选了也不生效。
  root.querySelector<HTMLButtonElement>('.status-scope-button')!.click()
  const rootFolder = [...root.querySelectorAll<HTMLButtonElement>('.status-scope-option')].find(button => button.dataset.scopeOption === 'folder')!
  expect(rootFolder.disabled).toBe(true)
  expect(rootFolder.title).toContain('根目录笔记没有同册')
  rootFolder.click()
  expect(currentScope()).toBe('note')
  root.querySelector<HTMLButtonElement>('.status-scope-button')!.click()

  // 目录里的笔记可以选同册，并原样进入预览与启动请求。
  root.querySelector<HTMLButtonElement>('.tab[data-rel="资料/乙.md"]')!.click()
  await vi.waitFor(() => expect(root.querySelector('.tab[aria-selected="true"]')?.getAttribute('data-rel')).toBe('资料/乙.md'))
  await chooseScope('folder')
  typeSlash('同册一场')
  await vi.waitFor(() => expect(api.agentStart).toHaveBeenCalledTimes(1))
  expect(api.agentAuthorizationPreview.mock.calls.at(-1)![0]).toMatchObject({ scope: 'folder', relPath: '资料/乙.md' })
  expect(api.agentStart.mock.calls.at(-1)![0]).toMatchObject({ scope: 'folder', relPath: '资料/乙.md' })
})

it('shows a plain notice and no card when previewing the scope fails', async () => {
  api.agentAuthorizationPreview.mockResolvedValueOnce({ ok: false, error: 'STALE_AUTHORIZATION' })
  await waitForNote()
  typeSlash('失败一场')
  await vi.waitFor(() => expect(root.querySelector('.status-host-notice')?.textContent).toContain('本场范围或对象在确认后发生变化'))
  expect(api.agentStart).not.toHaveBeenCalled()
  expect(document.querySelector('.overlay-authorization')).toBeNull()
  expect(document.querySelector('.write-confirm')).toBeNull()
})

it('discards a preview and does not start when the draft changes while previewing', async () => {
  let finish!: (value: unknown) => void
  api.agentAuthorizationPreview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await waitForNote()
  typeSlash('准备中')
  await vi.waitFor(() => expect(api.agentAuthorizationPreview).toHaveBeenCalledTimes(1))
  editorHarness.text = '/准备中 又改了'
  editorHarness.change!(editorHarness.text)
  finish({ ok: true, preview: previewFor(api.agentAuthorizationPreview.mock.calls[0]![0], 'p-stale') })
  await vi.waitFor(() => expect(api.agentAuthorizationDiscard).toHaveBeenCalledWith('p-stale'))
  expect(api.agentStart).not.toHaveBeenCalled()
  expect(root.querySelector('.status-host-notice')?.textContent).toContain('本场范围或对象在确认后发生变化')
})

it('keeps the created notice and opens the new note without a write confirmation card', async () => {
  await waitForNote()
  files.set('资料/新篇.md', { content: '静默新建的正文', revision: 'r-new', objectVersion: 'o-new' })
  handlers.onAgentEvent({ id: 'task-created', relPath: '甲.md', status: 'running', sessionId: 's', created: { relPath: '资料/新篇.md' } })
  const notice = root.querySelector<HTMLElement>('.notice')!
  expect(notice).not.toBeNull()
  expect(notice.querySelector('.notice-title')!.textContent).toBe('已新建《新篇》')
  expect(notice.querySelector('.notice-detail')!.textContent).toBe('已按本场范围创建；可以打开查看。')
  expect(document.querySelector('.write-confirm')).toBeNull()
  const open = notice.querySelector<HTMLButtonElement>('.notice-action')!
  expect(open.textContent).toBe('打开')
  open.click()
  await vi.waitFor(() => expect(api.noteRead).toHaveBeenCalledWith('资料/新篇.md'))
  await vi.waitFor(() => expect(editorHarness.text).toBe('静默新建的正文'))
})

it('ignores a created notice from a foreign vault session', async () => {
  await waitForNote()
  handlers.onAgentEvent({ id: 'task-3', relPath: '甲.md', status: 'running', sessionId: 'other', created: { relPath: '别库.md' } })
  expect(document.querySelector('.notice')).toBeNull()
})

it('deletes a note through the in-vault trash without a confirmation card', async () => {
  await waitForNote()
  await vi.waitFor(() => expect(root.querySelector('.tree-note[data-path="甲.md"]')).not.toBeNull())
  root.querySelector('.tree-note[data-path="甲.md"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
  const remove = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '删除')!
  expect(remove).not.toBeUndefined()
  remove.click()
  await vi.waitFor(() => expect(api.vaultTrashDelete).toHaveBeenCalledWith('甲.md'))
  await vi.waitFor(() => expect(root.querySelectorAll('.tab')).toHaveLength(1))
  expect(root.querySelector('.tab[aria-selected="true"]')?.getAttribute('data-rel')).toBe('资料/乙.md')
  const notice = document.querySelector<HTMLElement>('.notice')!
  expect(notice.querySelector('.notice-title')!.textContent).toBe('已移到已删除')
  expect(notice.querySelector('.notice-detail')!.textContent).toContain('30 天')
  expect(notice.querySelector<HTMLButtonElement>('.notice-action')!.textContent).toBe('打开')
  expect(document.querySelector('.write-confirm')).toBeNull()
  expect(document.querySelector('.overlay-write-confirm')).toBeNull()
})

it('reports a failed delete as a notice and keeps the tab', async () => {
  api.vaultTrashDelete.mockResolvedValueOnce({ ok: false, error: 'IO_ERROR' })
  await waitForNote()
  await vi.waitFor(() => expect(root.querySelector('.tree-note[data-path="甲.md"]')).not.toBeNull())
  root.querySelector('.tree-note[data-path="甲.md"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
  ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '删除')!.click()
  await vi.waitFor(() => expect(document.querySelector('.notice-title')?.textContent).toBe('删除没有完成'))
  expect(document.querySelectorAll('.tab')).toHaveLength(2)
})

it('closes the tab and drops task state when the host reports the note deleted', async () => {
  await waitForNote()
  handlers.onAgentEvent({ id: 'running-1', relPath: '甲.md', status: 'running', sessionId: 's' })
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.task-dock')!.dataset.kind).toBe('generating'))
  handlers.onNoteDeleted({ relPath: '甲.md', sessionId: 's', trashId: 'trash-1' })
  await vi.waitFor(() => expect(root.querySelectorAll('.tab')).toHaveLength(1))
  expect(root.querySelector('.tab[aria-selected="true"]')?.getAttribute('data-rel')).toBe('资料/乙.md')
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.task-dock')!.dataset.kind).toBe('hidden'))
})

it('ignores note:deleted from a foreign vault session', async () => {
  await waitForNote()
  handlers.onNoteDeleted({ relPath: '甲.md', sessionId: 'other', trashId: 'trash-x' })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(root.querySelectorAll('.tab')).toHaveLength(2)
})

it('changes only the next session when the scope is switched during a running task', async () => {
  await waitForNote()
  typeSlash('第一场')
  await vi.waitFor(() => expect(api.agentStart).toHaveBeenCalledTimes(1))
  expect(api.agentStart.mock.calls.at(-1)![0].scope).toBe('note')
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.task-dock')!.dataset.kind).toBe('generating'))
  await chooseScope('vault')
  expect(api.agentStart).toHaveBeenCalledTimes(1)
  endTask()
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.task-dock')!.dataset.kind).toBe('hidden'))
  typeSlash('第二场')
  await vi.waitFor(() => expect(api.agentStart).toHaveBeenCalledTimes(2))
  expect(api.agentStart.mock.calls.at(-1)![0].scope).toBe('vault')
})

it('falls back to 本篇 when a folder note moves to the vault root', async () => {
  await waitForNote()
  root.querySelector<HTMLButtonElement>('.tab[data-rel="资料/乙.md"]')!.click()
  await vi.waitFor(() => expect(root.querySelector('.tab[aria-selected="true"]')?.getAttribute('data-rel')).toBe('资料/乙.md'))
  await chooseScope('folder')
  const file = files.get('资料/乙.md')!
  files.delete('资料/乙.md')
  files.set('乙.md', file)
  handlers.onNoteRelocated({ moved: [{ from: '资料/乙.md', to: '乙.md' }], sessionId: 's' })
  await vi.waitFor(() => expect(root.querySelector('.tab[aria-selected="true"]')?.getAttribute('data-rel')).toBe('乙.md'))
  await vi.waitFor(() => expect(currentScope()).toBe('note'))
  root.querySelector<HTMLButtonElement>('.status-scope-button')!.click()
  const folder = [...root.querySelectorAll<HTMLButtonElement>('.status-scope-option')].find(button => button.dataset.scopeOption === 'folder')!
  expect(folder.disabled).toBe(true)
  root.querySelector<HTMLButtonElement>('.status-scope-button')!.click()
  typeSlash('根目录一场')
  await vi.waitFor(() => expect(api.agentStart).toHaveBeenCalledTimes(1))
  expect(api.agentStart.mock.calls.at(-1)![0]).toMatchObject({ scope: 'note', relPath: '乙.md' })
})

it('forgets the scope when its tab is closed and a fresh tab opens on the same path', async () => {
  await waitForNote()
  await chooseScope('vault')
  root.querySelector<HTMLElement>('.tab[data-rel="甲.md"]')!.parentElement!.querySelector<HTMLButtonElement>('.tab-close')!.click()
  await vi.waitFor(() => expect(root.querySelector('.tab[data-rel="甲.md"]')).toBeNull())
  await vi.waitFor(() => expect(root.querySelector('.tree-note[data-path="甲.md"]')).not.toBeNull())
  root.querySelector<HTMLButtonElement>('.tree-note[data-path="甲.md"]')!.click()
  await vi.waitFor(() => expect(root.querySelector('.tab[aria-selected="true"]')?.getAttribute('data-rel')).toBe('甲.md'))
  expect(currentScope()).toBe('note')
})

it('resumes with the scope captured when the task was paused', async () => {
  await waitForNote()
  typeSlash('暂停一场')
  await vi.waitFor(() => expect(api.agentStart).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.task-dock')!.dataset.kind).toBe('generating'))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  handlers.onAgentEvent({ id: 'task-1', relPath: '甲.md', status: 'cancelled', sessionId: 's' })
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.task-dock')!.dataset.kind).toBe('paused'))
  // 暂停后手动改成整库：重发仍用暂停那一场的本篇，不被当前按钮状态改写。
  await chooseScope('vault')
  root.querySelector<HTMLButtonElement>('.task-dock-resume')!.click()
  await vi.waitFor(() => expect(api.agentAuthorizationPreview).toHaveBeenCalledTimes(2))
  expect(api.agentAuthorizationPreview.mock.calls.at(-1)![0].scope).toBe('note')
  await vi.waitFor(() => expect(api.agentStart).toHaveBeenCalledTimes(2))
  expect(api.agentStart.mock.calls.at(-1)![0].scope).toBe('note')
})
