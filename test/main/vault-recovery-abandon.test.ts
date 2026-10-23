import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultSession } from '../../src/main/vault.ts'
import { LedgerStore } from '../../src/main/ledger-store.ts'
import { serializeStoredVault } from '../../src/main/notes-fs.ts'
import { markPrompt, upsertAiAnswer } from '../../src/main/host-source.ts'
import { draftSource } from './draft-fixture.ts'
import { vaultRootIdentity } from '../../src/main/watch.ts'
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../../src/main/watch.ts', async importOriginal => ({ ...await importOriginal<typeof import('../../src/main/watch.ts')>(), watchVault: () => () => {} }))

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

async function journal(root: string): Promise<{ version: number; active: unknown; missing?: unknown[] }> {
  return JSON.parse(await readFile(path.join(root, '.rgent-lifecycle'), 'utf8'))
}

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rgent-recovery-abandon-'))
  const root = path.join(base, 'vault')
  await mkdir(root)
  await writeFile(path.join(base, 'vault.json'), serializeStoredVault(root))
  const marked = markPrompt(draftSource('以后用中文').source, { taskId: 'task', ...draftSource('以后用中文'), expectedText: '以后用中文', promptText: '以后用中文' })
  await writeFile(path.join(root, 'a.md'), marked)
  const vault = new VaultSession(base, vi.fn())
  vault.restore()
  let note = await vault.readOpened('a.md')
  await vault.ledgerPrepare('a.md', { taskId: 'task', startedAt: new Date().toISOString(), status: 'completed', prompt: '以后用中文', answer: '好的' })
  const saved = await vault.write('a.md', upsertAiAnswer(note.content, { taskId: 'task', answer: '好的' }), note.revision, note)
  await vault.ledgerComplete('a.md', 'task', saved.revision)
  note = await vault.read('a.md')
  const stash = path.join(base, 'stash')
  await mkdir(stash)
  return { base, root, stash, vault, note }
}

describe('abandoning recovery', () => {
  const bases: string[] = []
  afterEach(async () => {
    for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true }).catch(() => {})
  })

  it('clears the missing record, releases the path and writes an auditable humanabandon chapter', async () => {
    const f = await fixture()
    bases.push(f.base)
    try {
      await rename(path.join(f.root, 'a.md'), path.join(f.stash, 'a.md'))
      expect((await f.vault.noteStatus('a.md', { sessionId: f.note.sessionId, objectVersion: f.note.objectVersion })).status).toBe('missing')
      const scan = await f.vault.recoveryScan()
      expect(scan.rows[0]).toMatchObject({ relPath: 'a.md', canAbandon: true })

      const result = await f.vault.recoveryAbandon('a.md')
      expect(result).toEqual({ verdict: 'abandoned', cleared: true })
      expect((await journal(f.root)).missing ?? []).toEqual([])
      await expect(f.vault.createWithContent('a', '', '放弃恢复后的同名新笔记')).resolves.toMatchObject({ relPath: 'a.md' })

      const ledgers = path.join(f.root, '.rgent', 'ledgers')
      const ownerId = (await readdir(ledgers)).find(name => name !== '.DS_Store')!
      const files = await readdir(path.join(ledgers, ownerId))
      const chapterFile = files.find(name => /^humanabandon-/.test(name))!
      expect(chapterFile).toBeTruthy()
      expect(chapterFile).not.toBe('humantrash.json')
      const record = JSON.parse(await readFile(path.join(ledgers, ownerId, chapterFile), 'utf8')) as { chapter: { prompt: string; answer: string } }
      expect(record.chapter.prompt).toContain('人放弃恢复')
      expect(record.chapter.answer).toContain('路径释放')
      expect(record.chapter.answer).toContain('系统废纸篓')
    } finally { f.vault.dispose() }
  })

  it('reports a degraded ledger trace without rolling the cleared record back', async () => {
    const f = await fixture()
    bases.push(f.base)
    const spy = vi.spyOn(LedgerStore.prototype, 'recordRecoveryAbandon').mockImplementation(() => { throw new Error('LEDGER_RECORD_LIMIT') })
    try {
      await rename(path.join(f.root, 'a.md'), path.join(f.stash, 'a.md'))
      expect((await f.vault.noteStatus('a.md', { sessionId: f.note.sessionId, objectVersion: f.note.objectVersion })).status).toBe('missing')
      const result = await f.vault.recoveryAbandon('a.md')
      expect(result).toEqual({ verdict: 'abandoned', cleared: true, degraded: 'ledger-failed' })
      expect((await journal(f.root)).missing ?? []).toEqual([])
      await expect(f.vault.createWithContent('a', '', '记录已清，路径已放开')).resolves.toMatchObject({ relPath: 'a.md' })
    } finally {
      spy.mockRestore()
      f.vault.dispose()
    }
  })

  it('abandons an unregistered record without inventing a ledger failure', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'rgent-recovery-abandon-'))
    const root = path.join(base, 'vault')
    await mkdir(root)
    await writeFile(path.join(base, 'vault.json'), serializeStoredVault(root))
    const content = '没有账本树的笔记\n'
    await writeFile(path.join(root, 'r.md'), content)
    const info = statSync(path.join(root, 'r.md'), { bigint: true })
    await writeFile(path.join(root, '.rgent-lifecycle'), JSON.stringify({
      version: 1, active: null,
      missing: [{
        relPath: 'r.md', noteId: 'unregistered-note', objectVersion: `${info.dev}:${info.ino}`, bodyRevision: hash(content),
        attachments: [], rootIdentity: vaultRootIdentity(root), permissionTier: 'reference',
        detectedAt: '2026-10-18T00:00:00.000Z', cause: 'external'
      }]
    }))
    const vault = new VaultSession(base, vi.fn())
    vault.restore()
    bases.push(base)
    try {
      await expect(vault.recoveryAbandon('r.md')).resolves.toEqual({ verdict: 'abandoned', cleared: true })
      expect((await journal(root)).missing ?? []).toEqual([])
      await rename(path.join(root, 'r.md'), path.join(base, 'kept.md'))
      await expect(vault.createWithContent('r', '', '同名新笔记')).resolves.toMatchObject({ relPath: 'r.md' })
    } finally { vault.dispose() }
  })

  it('refuses to abandon a path that has no missing record or is not a note path', async () => {
    const f = await fixture()
    bases.push(f.base)
    try {
      await expect(f.vault.recoveryAbandon('a.md')).rejects.toThrow('STALE_PREVIEW')
      await expect(f.vault.recoveryAbandon('a')).rejects.toThrow('BAD_PATH')
    } finally { f.vault.dispose() }
  })
})
