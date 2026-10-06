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
const chapter: LedgerChapterWrite = { taskId: 'task-1', startedAt: '2026-10-03T00:00:00.000Z', status: 'failed', prompt: 'p', answer: 'pending answer' }
it.each(['```js\na', '<!-- unfinished', '<div>\ntext', '<div>complete</div>'])('saves unfinished Markdown safely because historical bytes are separate: %s', async body => {
  const { session, root, request } = await setup()
  const preview=await session.previewSaveCopy({ ...request, body })
  await session.commitSaveCopy({sessionId:request.sessionId,id:preview.id,draftVersion:request.draftVersion,body})
  expect(await readFile(path.join(root,'copy.md'),'utf8')).toBe(body)
  expect((await session.ledgerPage('copy.md',null)).records[0]?.legacyRaw).toContain('existing ledger bytes')
})
it.each(['```js\na', '<!-- unfinished', '<div>\ntext', '<div>complete</div>'])('refuses an ordinary write that would absorb existing ledger: %s', async body => {
  const { session, root, snapshot } = await setup(false)
  await expect(session.write('source.md', body, snapshot.revision, snapshot)).rejects.toThrow('LEDGER_BOUNDARY_INVALID')
  expect(await readFile(path.join(root, 'source.md'), 'utf8')).toBe(original)
})
it('saves a corrected draft without rewriting the verified ledger or its CRLF bytes', async () => {
  const { session, root, snapshot } = await setup(false)
  const body = '```js\r\na\r\n```\r\n\r\n<div>complete</div>\r\n\r\n'
  const content = composeSource(body, partitionSource(original).ledger)
  await session.write('source.md', body, snapshot.revision, snapshot)
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
  expect(partitionSource(content).ledger).toBeNull()
  const history=await session.ledgerPage('copy.md',null)
  expect(history.records.some(r=>r.legacyRaw?.includes('existing ledger bytes'))).toBe(true)
  expect(history.records.find(r=>r.taskId==='task-1')?.chapter?.answer).toBe('pending answer')
  await expect(readFile(path.join(root, 'source.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('uses the verified original ledger after another object occupies the old path', async () => {
  const { session, root, request } = await setup()
  await writeFile(path.join(root, 'source.md'), 'stranger\n<!-- rgent:ledger:v1 -->\nwrong ledger')
  await session.read('source.md')
  const preview = await session.previewSaveCopy(request)
  const result = await session.commitSaveCopy({ sessionId: request.sessionId, id: preview.id, draftVersion: request.draftVersion, body: request.body })
  expect(result.snapshot.content).toBe(request.body)
  expect((await session.ledgerPage('copy.md',null)).records[0]?.legacyRaw).toContain('existing ledger bytes')
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
  expect(published).not.toContain(chapter.answer) // pending Host material and preview remain; no historical bytes in body
  await expect(readFile(path.join(root, 'source.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves isolated old-root proof for a separately confirmed body-only copy despite damaged new registry',async()=>{
 const {session,root,base,snapshot}=await setup(false),api=session as any
 expect(typeof api.protectRootDrafts).toBe('function')
 api.protectRootDrafts(snapshot.sessionId)
 await rename(root,root+'-old');await mkdir(root);await writeFile(path.join(root,'source.md'),'replacement must stay')
 const {vaultRootIdentity}=await import('../../src/main/watch.ts')
 await session.openVerified(root,vaultRootIdentity(root))
 await writeFile(path.join(root,'.rgent-ledger-registry'),'broken')
 const request={sessionId:session.sessionId()!,sourceSessionId:snapshot.sessionId,objectVersion:snapshot.objectVersion,source:'source.md',target:'held.md',body:'protected draft',draftVersion:'held'}
 const preview=await session.previewSaveCopy(request)
 expect(preview.pendingTaskIds).toEqual([]);expect(preview.warning).toContain('只保留正文')
 const saved=await session.commitSaveCopy({sessionId:request.sessionId,id:preview.id,draftVersion:'held',body:request.body})
 expect(saved.taskIds).toEqual([]);expect(await readFile(path.join(root,'held.md'),'utf8')).toBe(request.body)
 expect(await readFile(path.join(root,'source.md'),'utf8')).toBe('replacement must stay')
 expect(await readFile(path.join(root+'-old','source.md'),'utf8')).toBe(original)
 expect(await readFile(path.join(root,'.rgent-ledger-registry'),'utf8')).toBe('broken')
 await expect(session.write('source.md','forbidden',snapshot.revision,snapshot)).rejects.toThrow()
})

it('protects only requested open-object bases, rejects another root recovery until resolved, and clears every same-path version on explicit discard',async()=>{
 const {session,root,snapshot}=await setup(false),{vaultRootIdentity}=await import('../../src/main/watch.ts')
 await writeFile(path.join(root,'not-open.md'),'cached only');await session.read('not-open.md')
 session.protectRootDrafts(snapshot.sessionId,[{relPath:'source.md',objectVersion:snapshot.objectVersion}])
 expect(session.protectedRootSource(snapshot.sessionId,'not-open.md',(await session.read('not-open.md')).objectVersion)).toBeNull()
 await rename(root,root+'-old');await mkdir(root);await writeFile(path.join(root,'new.md'),'new')
 await session.openVerified(root,vaultRootIdentity(root));const newer=await session.read('new.md')
 expect(()=>session.protectRootDrafts(newer.sessionId,[{relPath:'new.md',objectVersion:newer.objectVersion}])).toThrow('UNSAVED_DRAFT')
 session.discardRootSource(snapshot.sessionId,'source.md',snapshot.objectVersion)
 expect(session.protectedSession()).toBeNull()
 expect(()=>session.protectRootDrafts(newer.sessionId,[{relPath:'new.md',objectVersion:newer.objectVersion}])).not.toThrow()
})
it('retains protected source proof and publishes no copy if the new root changes after body preview',async()=>{
 const {session,root,snapshot}=await setup(false),{vaultRootIdentity}=await import('../../src/main/watch.ts')
 session.protectRootDrafts(snapshot.sessionId,[{relPath:'source.md',objectVersion:snapshot.objectVersion}]);await rename(root,root+'-old');await mkdir(root);await session.openVerified(root,vaultRootIdentity(root))
 const request={sessionId:session.sessionId()!,sourceSessionId:snapshot.sessionId,objectVersion:snapshot.objectVersion,source:'source.md',target:'kept.md',draftVersion:'held',body:'kept draft'},preview=await session.previewSaveCopy(request)
 await rename(root,root+'-new');await mkdir(root)
 await expect(session.commitSaveCopy({sessionId:request.sessionId,id:preview.id,draftVersion:'held',body:request.body})).rejects.toThrow()
 expect(session.protectedRootSource(snapshot.sessionId,'source.md',snapshot.objectVersion)).not.toBeNull()
 await expect(readFile(path.join(root,'kept.md'),'utf8')).rejects.toThrow()
 await expect(readFile(path.join(root+'-new','kept.md'),'utf8')).rejects.toThrow()
})

it('rejects an owner replaced while protected copy waits for the write queue',async()=>{
 const {session,root,snapshot}=await setup(false),{vaultRootIdentity}=await import('../../src/main/watch.ts')
 session.protectRootDrafts(snapshot.sessionId,[{relPath:'source.md',objectVersion:snapshot.objectVersion}]);await rename(root,root+'-old');await mkdir(root);await session.openVerified(root,vaultRootIdentity(root))
 const request={sessionId:session.sessionId()!,sourceSessionId:snapshot.sessionId,objectVersion:snapshot.objectVersion,source:'source.md',target:'held.md',draftVersion:'held',body:'held draft'},preview=await session.previewSaveCopy(request)
 let valid=true,release!:()=>void
 const queued=session.memoryMutation(async()=>{await new Promise<void>(r=>release=r)})
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
 const copying=(session.commitSaveCopy as any)({sessionId:request.sessionId,id:preview.id,draftVersion:'held',body:request.body},[],()=>{if(!valid)throw Error('BAD_SENDER')})
 valid=false;release();await queued
 await expect(copying).rejects.toThrow('BAD_SENDER')
 await expect(readFile(path.join(root,'held.md'),'utf8')).rejects.toThrow()
})

it('drops isolated source proofs on disposal instead of retaining a hidden old-root recovery gate',async()=>{
 const {session,snapshot}=await setup(false);session.protectRootDrafts(snapshot.sessionId,[{relPath:'source.md',objectVersion:snapshot.objectVersion}]);session.dispose()
 expect(session.protectedRootSource(snapshot.sessionId,'source.md',snapshot.objectVersion)).toBeNull()
})
