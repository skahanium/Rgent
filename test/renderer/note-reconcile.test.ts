// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { start } from '../../src/renderer/src/shell.ts'
import { reconcileNote, type ReconcileChoice } from '../../src/renderer/src/note-reconcile.ts'
import type { NoteSnapshot, NoteWriteRequest, NoteWriteResult } from '../../src/shared/ipc.ts'
import type { Tab } from '../../src/renderer/src/tabs.ts'

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

function fixture() {
  const tab: Tab = { relPath: '甲.md', content: '窗口', saved: '原文', ledger: null, revision: 'r0', dirty: true }
  let disk: NoteSnapshot = { content: '磁盘一', revision: 'r1', sessionId: 's', objectVersion: 'o' }
  let current = true
  const shown: string[] = []
  const writes: NoteWriteRequest[] = []
  const choices: ReconcileChoice[] = []
  const deps = {
    isCurrent: () => current,
    read: async () => disk,
    draft: () => tab.content,
    choose: async (_window: string, diskBody: string): Promise<ReconcileChoice> => {
      shown.push(diskBody)
      return choices.shift() ?? 'continue'
    },
    write: async (request: NoteWriteRequest): Promise<NoteWriteResult> => {
      writes.push(request)
      if (request.expectedRevision !== disk.revision) return { ok: false, error: 'CONFLICT' }
      disk = { content: request.content, revision: 'saved', sessionId: 's', objectVersion: 'o' }
      return { ok: true, revision: 'saved', sessionId: 's', objectVersion: 'o' }
    },
    applyDisk: (snapshot: NoteSnapshot) => {
      tab.content = snapshot.content
      tab.saved = snapshot.content
      tab.revision = snapshot.revision
      tab.dirty = false
    },
    applySaved: (body: string, ledger: string | null, revision: string) => {
      tab.content = body
      tab.saved = body
      tab.ledger = ledger
      tab.revision = revision
      tab.dirty = false
    }
  }
  return { tab, deps, shown, writes, choices, setDisk: (value: NoteSnapshot) => { disk = value }, setCurrent: (value: boolean) => { current = value } }
}

describe('reconcileNote', () => {
  it('reads the latest disk version when a queued notification is processed', async () => {
    const item = fixture()
    item.setDisk({ content: '磁盘二', revision: 'r2', sessionId: 's', objectVersion: 'o' })
    item.choices.push('disk')
    expect(await reconcileNote(item.tab, item.deps)).toBe('disk')
    expect(item.shown).toEqual(['磁盘二'])
    expect(item.tab.content).toBe('磁盘二')
  })

  it('reopens the preview when disk changes after the choice', async () => {
    const item = fixture()
    item.choices.push('disk', 'disk')
    const choose = item.deps.choose
    item.deps.choose = async (windowText, diskText) => {
      const choice = await choose(windowText, diskText)
      if (item.shown.length === 1) item.setDisk({ content: '磁盘二', revision: 'r2', sessionId: 's', objectVersion: 'o' })
      return choice
    }
    expect(await reconcileNote(item.tab, item.deps)).toBe('disk')
    expect(item.shown).toEqual(['磁盘一', '磁盘二'])
    expect(item.tab.content).toBe('磁盘二')
  })

  it('writes the window body against the displayed revision without changing tab state first', async () => {
    const item = fixture()
    item.choices.push('window')
    expect(await reconcileNote(item.tab, item.deps)).toBe('saved')
    expect(item.writes).toEqual([{ relPath: '甲.md', content: '窗口', expectedRevision: 'r1', sessionId: 's', objectVersion: 'o' }])
    expect(item.tab).toMatchObject({ content: '窗口', revision: 'saved', dirty: false })
  })

  it('keeps the draft and original revision when a non-conflict write fails', async () => {
    const item = fixture()
    item.choices.push('window')
    item.deps.write = async () => ({ ok: false, error: 'IO_ERROR' })
    expect(await reconcileNote(item.tab, item.deps)).toBe('error')
    expect(item.tab).toMatchObject({ content: '窗口', revision: 'r0', dirty: true })
  })

  it('shows the newer disk draft again after a write conflict', async () => {
    const item = fixture()
    item.choices.push('window', 'window')
    let attempts = 0
    const write = item.deps.write
    item.deps.write = async (request) => {
      if (attempts++ === 0) {
        item.setDisk({ content: '磁盘二', revision: 'r2', sessionId: 's', objectVersion: 'o' })
        return { ok: false, error: 'CONFLICT' }
      }
      return write(request)
    }
    expect(await reconcileNote(item.tab, item.deps)).toBe('saved')
    expect(item.shown).toEqual(['磁盘一', '磁盘二'])
    expect(item.writes).toEqual([{ relPath: '甲.md', content: '窗口', expectedRevision: 'r2', sessionId: 's', objectVersion: 'o' }])
  })

  it('ignores a notification after its tab or vault is replaced', async () => {
    const item = fixture()
    item.setCurrent(false)
    expect(await reconcileNote(item.tab, item.deps)).toBe('stale')
    expect(item.shown).toEqual([])
    expect(item.writes).toEqual([])
  })

  it('does not apply a choice when the tab closes during the preview', async () => {
    const item = fixture()
    item.deps.choose = async () => {
      item.setCurrent(false)
      return 'disk'
    }
    expect(await reconcileNote(item.tab, item.deps)).toBe('stale')
    expect(item.tab).toMatchObject({ content: '窗口', revision: 'r0', dirty: true })
  })

  it('leaves both drafts untouched when the user continues editing', async () => {
    const item = fixture()
    expect(await reconcileNote(item.tab, item.deps)).toBe('continued')
    expect(item.tab).toMatchObject({ content: '窗口', revision: 'r0', dirty: true })
  })
})
it('preserves a dirty draft and its basis when pending ledger recovery rejects a conflict write',async()=>{
 const item=fixture();item.choices.push('window')
 const outcome=await reconcileNote(item.tab,{...item.deps,write:async()=>({ok:false,error:'LIFECYCLE_RECOVERY_REQUIRED'})})
 expect(outcome).toBe('error');expect(item.tab.content).toBe('窗口');expect(item.tab.saved).toBe('原文');expect(item.tab.dirty).toBe(true)
})

describe('a note created over an unavailable tab', () => {
  let handlers: Record<string, Function>, api: any, root: HTMLElement
  let files: Map<string, { content: string; revision: string; objectVersion: string }>
  let revisionSerial = 0
  const nextRevision = (): string => `r${++revisionSerial}`
  const snapshotOf = (relPath: string): NoteSnapshot => {
    const file = files.get(relPath)
    if (!file) throw Error('NOTE_MISSING')
    return { content: file.content, revision: file.revision, objectVersion: file.objectVersion, sessionId: 's' }
  }

  beforeEach(() => {
    handlers = {}; revisionSerial = 0
    files = new Map([['甲.md', { content: '旧稿正文', revision: 'r-old', objectVersion: 'o-old' }]])
    editorHarness.text = ''; editorHarness.change = null
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
    const fallback = async () => null
    api = new Proxy({
      vaultGet: async () => ({ status: 'ready', sessionId: 's', rootName: 'notes' }),
      vaultWorkspaceGet: async () => ({ version: 1, tabs: [{ relPath: '甲.md' }], active: '甲.md', sidebarHidden: true, treeScroll: 0, resourceScroll: 0 }),
      vaultWorkspaceSave: vi.fn(async () => true),
      treeList: vi.fn(async () => [...files.keys()].map(relPath => ({ name: relPath.split('/').pop()!, relPath, kind: 'note' }))),
      backlinks: async () => [],
      permissionsGet: async () => ({ status: 'ready', entries: [] }),
      lifecycleStatus: async () => ({ status: 'ready', sessionId: 's' }),
      modelConfigGet: async () => ({ ok: false }),
      memoryGet: async () => ({ ok: false }),
      agentTasks: async () => [],
      onMenu: (channel: string, fn: Function) => { handlers[channel] = fn; return () => {} },
      noteRead: vi.fn(async (relPath: string) => snapshotOf(relPath)),
      noteInspect: vi.fn(async (request: { relPath: string; objectVersion: string }) => {
        const file = files.get(request.relPath)
        return file && file.objectVersion === request.objectVersion
          ? { status: 'ready', snapshot: { ...file, sessionId: 's' } }
          : { status: 'missing', sessionId: 's', relPath: request.relPath, objectVersion: request.objectVersion }
      }),
      noteCreateAt: vi.fn(async ({ name, parent, sessionId }: { name: string; parent: string; sessionId?: string }) => {
        if (sessionId !== 's') throw Error('VAULT_CHANGED')
        const relPath = `${parent ? `${parent}/` : ''}${name.trim().replace(/\.md$/i, '')}.md`
        if (files.has(relPath)) throw Error('EEXIST')
        files.set(relPath, { content: '', revision: nextRevision(), objectVersion: `o${revisionSerial}` })
        return relPath
      }),
      noteWrite: vi.fn(async (request: NoteWriteRequest) => {
        const file = files.get(request.relPath)
        if (!file) return { ok: false, error: 'NOTE_MISSING' }
        if (file.revision !== request.expectedRevision) return { ok: false, error: 'CONFLICT' }
        file.content = request.content
        file.revision = nextRevision(); file.objectVersion = `o${revisionSerial}`
        return { ok: true, revision: file.revision, sessionId: 's', objectVersion: file.objectVersion }
      }),
      flushDone: vi.fn(), lifecycleFlushDone: vi.fn(), vaultTransitionDone: vi.fn(async () => true),
      agentWriteConfirm: vi.fn(async () => ({ ok: true }))
    }, { get: (target, key: string) => key in target ? (target as any)[key] : key.startsWith('on') ? (fn: Function) => { handlers[key] = fn; return () => {} } : fallback })
    window.rgent = api
    root = document.createElement('main'); document.body.append(root)
  })
  afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.clearAllTimers() })

  async function markOldTabMissing(draft = '旧稿正文'): Promise<void> {
    await start(root)
    expect(root.querySelector<HTMLElement>('.note-unavailable')!.hidden).toBe(true)
    expect(files.delete('甲.md')).toBe(true)
    handlers.onNoteExternalChange({ relPath: '甲.md' })
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.note-unavailable')!.hidden).toBe(false))
    expect(root.querySelector('.note-unavailable')!.textContent).toContain('文件已消失')
    expect(editorHarness.text).toBe(draft)
  }

  async function createSameName(): Promise<void> {
    root.querySelector<HTMLButtonElement>('.tab-new')!.click()
    await vi.waitFor(() => expect(document.querySelector('#new-note-name')).not.toBeNull())
    ;(document.querySelector('#new-note-name') as HTMLInputElement).value = '甲'
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '创建')!.click()
  }

  it('saves the missing tab draft beside the new note and opens the new note in its place', async () => {
    await markOldTabMissing()
    await createSameName()
    await vi.waitFor(() => expect(files.get('甲（恢复的旧稿）.md')?.content).toBe('旧稿正文'))
    await vi.waitFor(() => expect(root.querySelectorAll('.tab')).toHaveLength(1))
    expect(api.noteCreateAt.mock.calls.map(([request]: any[]) => request.name)).toEqual(['甲', '甲（恢复的旧稿）'])
    expect(root.querySelector('.tab')!.getAttribute('data-rel')).toBe('甲.md')
    expect(root.querySelector<HTMLElement>('.note-unavailable')!.hidden).toBe(true)
    expect(editorHarness.text).toBe('')
    expect(root.querySelector('.status-host-notice')?.textContent).toContain('旧稿已另存为 甲（恢复的旧稿）.md')

    editorHarness.text = '新正文'
    editorHarness.change!('新正文')
    handlers['menu:save']()
    await vi.waitFor(() => expect(files.get('甲.md')!.content).toBe('新正文'))
    expect(api.noteWrite).toHaveBeenLastCalledWith(expect.objectContaining({ relPath: '甲.md', content: '新正文' }))
    expect(root.querySelector<HTMLElement>('.note-unavailable')!.hidden).toBe(true)
  })

  it('tries the next sibling name when the restored-draft name is already taken', async () => {
    files.set('甲（恢复的旧稿）.md', { content: '已有笔记', revision: 'r-taken', objectVersion: 'o-taken' })
    await markOldTabMissing()
    await createSameName()
    await vi.waitFor(() => expect(files.get('甲（恢复的旧稿 2）.md')?.content).toBe('旧稿正文'))
    expect(api.noteCreateAt.mock.calls.map(([request]: any[]) => request.name))
      .toEqual(['甲', '甲（恢复的旧稿）', '甲（恢复的旧稿 2）'])
    expect(root.querySelectorAll('.tab')).toHaveLength(1)
    expect(root.querySelector('.tab')!.getAttribute('data-rel')).toBe('甲.md')
    expect(root.querySelector<HTMLElement>('.note-unavailable')!.hidden).toBe(true)
  })

  it('keeps the old tab and draft when the restored-draft write fails', async () => {
    api.noteWrite = vi.fn(async () => ({ ok: false, error: 'IO_ERROR' }))
    const treeCalls = api.treeList.mock.calls.length
    await markOldTabMissing()
    await createSameName()
    await vi.waitFor(() => expect(root.querySelector('.status-host-notice')?.textContent)
      .toContain('同名笔记已建立，但旧标签仍占用该路径，请关闭旧标签后重新打开'))
    await vi.waitFor(() => expect(api.treeList.mock.calls.length).toBeGreaterThan(treeCalls))
    expect(root.querySelectorAll('.tab')).toHaveLength(1)
    expect(root.querySelector('.tab')!.getAttribute('data-rel')).toBe('甲.md')
    expect(root.querySelector<HTMLElement>('.note-unavailable')!.hidden).toBe(false)
    expect(editorHarness.text).toBe('旧稿正文')
    expect(files.get('甲.md')!.content).toBe('')
    expect(api.noteCreateAt.mock.calls.map(([request]: any[]) => request.name)).toEqual(['甲', '甲（恢复的旧稿）'])
  })

  it('closes an empty unavailable tab without creating a restored-draft note', async () => {
    files.set('甲.md', { content: '', revision: 'r-empty', objectVersion: 'o-empty' })
    await markOldTabMissing('')
    await createSameName()
    await vi.waitFor(() => expect(root.querySelector('.status-host-notice')?.textContent).toContain('原标签窗口稿为空，已关闭'))
    await vi.waitFor(() => expect(root.querySelectorAll('.tab')).toHaveLength(1))
    expect(api.noteCreateAt.mock.calls.map(([request]: any[]) => request.name)).toEqual(['甲'])
    expect([...files.keys()].filter(path => path.includes('恢复的旧稿'))).toEqual([])
    expect(root.querySelector('.tab')!.getAttribute('data-rel')).toBe('甲.md')
    expect(root.querySelector<HTMLElement>('.note-unavailable')!.hidden).toBe(true)
  })

  it('opens an AI-created note through the same hand-off instead of reusing the unusable tab', async () => {
    await markOldTabMissing()
    // 「建」由主进程在人工确认后落盘；这里模拟确认那一刻文件已经存在。
    files.set('甲.md', { content: 'AI 建的新笔记', revision: 'r-ai', objectVersion: 'o-ai' })
    handlers.onAgentWriteRequest({ kind: 'create', relPath: '甲.md', body: 'AI 建的新笔记' })
    await vi.waitFor(() => expect(document.querySelector('.write-confirm-accept')).not.toBeNull())
    ;(document.querySelector('.write-confirm-accept') as HTMLElement).click()
    await vi.waitFor(() => expect(files.get('甲（恢复的旧稿）.md')?.content).toBe('旧稿正文'))
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.note-unavailable')!.hidden).toBe(true))
    expect(root.querySelector('.tab')!.getAttribute('data-rel')).toBe('甲.md')
    expect(editorHarness.text).toBe('AI 建的新笔记')
    expect(api.agentWriteConfirm).toHaveBeenCalledWith(expect.objectContaining({ approved: true }))
  })
})
