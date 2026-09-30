import { describe, expect, it } from 'vitest'
import { reconcileNote, type ReconcileChoice } from '../../src/renderer/src/note-reconcile.ts'
import type { NoteSnapshot, NoteWriteRequest, NoteWriteResult } from '../../src/shared/ipc.ts'
import type { Tab } from '../../src/renderer/src/tabs.ts'

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
