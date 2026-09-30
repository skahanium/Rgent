import { mkdtemp, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { mkdirSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { secureFsFor } from '../../src/main/secure-fs.ts'
import { VaultSession } from '../../src/main/vault.ts'
import { serializeStoredVault } from '../../src/main/notes-fs.ts'
import { composeSource, partitionSource } from '../../src/markdown/partition.ts'
import type { LedgerChapterWrite } from '../../src/main/host-source.ts'
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../../src/main/watch.ts', async importOriginal => ({ ...await importOriginal<typeof import('../../src/main/watch.ts')>(), watchVault: vi.fn(() => () => {}) }))
const cleanup: { session: VaultSession; base: string }[] = []
afterEach(async () => { for (const item of cleanup.splice(0)) { item.session.dispose(); await rm(item.base, { recursive: true, force: true }) } })
const original = 'old body\r\n<!-- rgent:ledger:v1 -->\r\nexisting ledger bytes\r\n'
const chapter: LedgerChapterWrite = { taskId: 'task-1', startedAt: 'now', status: 'failed', prompt: 'p', answer: 'pending answer' }
it.each(['```js\na', '<!-- unfinished', '<div>\ntext', '<div>complete</div>'])('refuses a draft that would absorb the verified ledger: %s', async body => {
  const { session, root, request } = await setup()
  await expect(session.previewSaveCopy({ ...request, body })).rejects.toThrow('LEDGER_BOUNDARY_INVALID')
  await expect(readFile(path.join(root, 'copy.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it.each(['```js\na', '<!-- unfinished', '<div>\ntext', '<div>complete</div>'])('refuses an ordinary write that would absorb existing ledger: %s', async body => {
  const { session, root, snapshot } = await setup(false)
  await expect(session.write('source.md', composeSource(body, partitionSource(original).ledger), snapshot.revision, snapshot)).rejects.toThrow('LEDGER_BOUNDARY_INVALID')
  expect(await readFile(path.join(root, 'source.md'), 'utf8')).toBe(original)
})
it('saves a corrected draft without rewriting the verified ledger or its CRLF bytes', async () => {
  const { session, root, snapshot } = await setup(false)
  const content = composeSource('```js\r\na\r\n```\r\n\r\n<div>complete</div>\r\n\r\n', partitionSource(original).ledger)
  await session.write('source.md', content, snapshot.revision, snapshot)
  expect(await readFile(path.join(root, 'source.md'), 'utf8')).toBe(content)
  expect(partitionSource(content).ledger).toBe(partitionSource(original).ledger)
})
async function setup(remove = true) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rgent-savecopy-'))
  const root = path.join(base, 'vault'); await mkdir(root)
  await writeFile(path.join(root, 'source.md'), original)
  await writeFile(path.join(base, 'vault.json'), serializeStoredVault(root))
  const session = new VaultSession(base, vi.fn()); session.restore()
  cleanup.push({ session, base })
  const snapshot = await session.read('source.md')
  if (remove) await unlink(path.join(root, 'source.md'))
  const request = { sessionId: snapshot.sessionId, objectVersion: snapshot.objectVersion, source: 'source.md', body: 'window draft\r\n', draftVersion: 'draft-1', target: 'copy.md' }
  return { session, root, base, snapshot, request }
}
it('saves a missing draft only to a new path with its verified ledger and pending Host chapters', async () => {
  const { session, root, request } = await setup()
  const preview = await session.previewSaveCopy(request, [chapter])
  expect(preview.pendingTaskIds).toEqual(['task-1'])
  const saved = await session.commitSaveCopy({ sessionId: request.sessionId, id: preview.id, draftVersion: request.draftVersion, body: request.body }, [chapter])
  expect(saved.taskIds).toEqual(['task-1'])
  expect(saved.snapshot.sessionId).toBe(request.sessionId)
  const content = await readFile(path.join(root, 'copy.md'), 'utf8')
  expect(partitionSource(content).body).toBe(request.body)
  expect(content).toContain(partitionSource(original).ledger)
  expect(content).toContain('pending answer')
  await expect(readFile(path.join(root, 'source.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('uses the verified original ledger after another object occupies the old path', async () => {
  const { session, root, request } = await setup()
  await writeFile(path.join(root, 'source.md'), 'stranger\n<!-- rgent:ledger:v1 -->\nwrong ledger')
  await session.read('source.md')
  const preview = await session.previewSaveCopy(request)
  const result = await session.commitSaveCopy({ sessionId: request.sessionId, id: preview.id, draftVersion: request.draftVersion, body: request.body })
  expect(result.snapshot.content).toContain('existing ledger bytes')
  expect(result.snapshot.content).not.toContain('wrong ledger')
  expect(await readFile(path.join(root, 'source.md'), 'utf8')).toContain('stranger')
})
it.each(['draft', 'pending', 'parent', 'target', 'session'] as const)('rejects a stale %s before creating the copy', async (change) => {
  const { session, root, request } = await setup()
  await mkdir(path.join(root, 'folder'))
  request.target = 'folder/copy.md'
  const preview = await session.previewSaveCopy(request, [chapter])
  if (change === 'parent') { await rename(path.join(root, 'folder'), path.join(root, 'old')); await mkdir(path.join(root, 'folder')) }
  if (change === 'target') await writeFile(path.join(root, request.target), 'occupied')
  if (change === 'session') session.restore()
  await expect(session.commitSaveCopy({ sessionId: request.sessionId, id: preview.id, draftVersion: change === 'draft' ? 'draft-2' : request.draftVersion, body: request.body }, change === 'pending' ? [{ ...chapter, answer: 'changed' }] : [chapter])).rejects.toThrow()
  if (change === 'target') expect(await readFile(path.join(root, request.target), 'utf8')).toBe('occupied')
  else await expect(readFile(path.join(root, request.target))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects the original path, injected ledger bytes, absent ledger basis and a live source', async () => {
  const { session, request } = await setup()
  await expect(session.previewSaveCopy({ ...request, target: 'SOURCE.md' })).rejects.toThrow('BAD_PATH')
  await expect(session.previewSaveCopy({ ...request, body: original })).rejects.toThrow('BAD_BODY')
  await expect(session.previewSaveCopy({ ...request, objectVersion: 'unverified' })).rejects.toThrow('LEDGER_BASIS_UNAVAILABLE')
  const live = await setup(false)
  await expect(live.session.previewSaveCopy(live.request)).rejects.toThrow('SOURCE_AVAILABLE')
})

it('keeps recovery records untouched and refuses save-copy while lifecycle verification is pending', async () => {
  const { session, root, request } = await setup()
  const journal = '{broken recovery record'
  await writeFile(path.join(root, '.rgent-lifecycle'), journal)
  await expect(session.previewSaveCopy(request)).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
  expect(await readFile(path.join(root, '.rgent-lifecycle'), 'utf8')).toBe(journal)
  await expect(readFile(path.join(root, 'copy.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects edited draft bytes even when the UI reuses an old draftVersion', async () => {
  const { session, root, request } = await setup()
  const preview = await session.previewSaveCopy(request)
  await expect(session.commitSaveCopy({ sessionId: request.sessionId, id: preview.id, draftVersion: request.draftVersion, body: 'edited after preview' })).rejects.toThrow('STALE_PREVIEW')
  await expect(readFile(path.join(root, 'copy.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports a changed parent after publication without clearing the preview or removing the created file', async () => {
  const { session, root, request } = await setup()
  await mkdir(path.join(root, 'folder'))
  request.target = 'folder/copy.md'
  const preview = await session.previewSaveCopy(request, [chapter])
  const fs = secureFsFor(root)
  const replace = fs.replace.bind(fs)
  fs.replace = ((...args) => {
    if (args[0] === request.target) {
      renameSync(path.join(root, 'folder'), path.join(root, 'original-folder'))
      mkdirSync(path.join(root, 'folder'))
    }
    return replace(...args)
  }) as typeof fs.replace
  try {
    await expect(session.commitSaveCopy({ sessionId: request.sessionId, id: preview.id, draftVersion: request.draftVersion, body: request.body }, [chapter])).rejects.toThrow('COPY_PARENT_CHANGED')
  } finally { fs.replace = replace }
  expect(session.saveCopyRequestById(preview.id)?.body).toBe(request.body)
  const published = await readFile(path.join(root, request.target), 'utf8')
  expect(published).toContain(request.body)
  expect(published).toContain(chapter.answer)
  await expect(readFile(path.join(root, 'source.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
