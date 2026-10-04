import { chmod, stat, symlink, link, mkdtemp, mkdir, readFile, writeFile, rename, unlink, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dialog } from 'electron'
import { secureFsFor } from '../../src/main/secure-fs.ts'
import { TaskAuthorizationRegistry } from '../../src/main/task-authorization.ts'
import { modelTierFor } from '../../src/main/permissions.ts'
import { VaultSession } from '../../src/main/vault.ts'
import { markPrompt,upsertAiAnswer } from '../../src/main/host-source.ts'
import { VaultLifecycle } from '../../src/main/vault-lifecycle.ts'
import { watchVault } from '../../src/main/watch.ts'
import * as notesFs from '../../src/main/notes-fs.ts'
import { createFolder, createNote, listVaultTree, parseStoredVault, readNote, readNoteSnapshot, serializeStoredVault, writeNote } from '../../src/main/notes-fs.ts'
import { isVaultImagePath, readVaultMedia, resolveInVault, sanitizeNoteName, vaultMediaPath } from '../../src/main/paths.ts'
import { collectNotePaths, collectRelPaths } from '../../src/renderer/src/tree.ts'
import { joinVaultRel, parseVaultMediaUrl, vaultMediaUrl } from '../../src/shared/vault-rel.ts'

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../../src/main/watch.ts', async importOriginal => ({ ...await importOriginal<typeof import('../../src/main/watch.ts')>(), watchVault: vi.fn(() => () => {}) }))
afterEach(() => { vi.restoreAllMocks() })

async function setup() {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'rgent-session-'))
  const first = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
  const second = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
  await writeFile(path.join(first, '原篇.md'), 'first')
  await writeFile(path.join(second, '原篇.md'), 'second')
  const emit = vi.fn()
  const session = new VaultSession(userData, emit)
  const attach = async (root: string) => {
    await writeFile(path.join(userData, 'vault.json'), serializeStoredVault(root))
    return session.restore()
  }
  return { session, emit, attach, first, second }
}

describe('VaultSession isolation', () => {
  it('opens an unregistered ordinary note without publishing ledger files', async () => {
    const {session,attach,first}=await setup()
    try{await attach(first);const note=await session.readOpened('原篇.md');expect(note.content).toBe('first');await new Promise<void>(r=>setImmediate(r));await expect(stat(path.join(first,'.rgent','registry.json'))).rejects.toMatchObject({code:'ENOENT'})}finally{session.dispose()}
  })
  it('reads editable body despite a broken registry and preserves a mixed-line-ending legacy tail on save',async()=>{
    const {session,attach,first}=await setup(),tail='<!-- rgent:ledger:v1 -->\r\n不可解析历史\n末尾\r',body='\ufeff正文\r\n\n'
    try{await attach(first);await writeFile(path.join(first,'原篇.md'),body+tail);await mkdir(path.join(first,'.rgent'),{recursive:true});await writeFile(path.join(first,'.rgent','registry.json'),'{bad')
      const opened=await session.readOpened('原篇.md');expect(opened.content).toBe(body);expect(opened.ledger?.status).toBe('invalid');expect(await readFile(path.join(first,'原篇.md'),'utf8')).toBe(body+tail)
      await session.write('原篇.md','\ufeff修改\r\n\n',opened.revision,opened);expect(await readFile(path.join(first,'原篇.md'),'utf8')).toBe('\ufeff修改\r\n\n'+tail);expect(await readFile(path.join(first,'.rgent','registry.json'),'utf8')).toBe('{bad')
    }finally{session.dispose()}
  })
  it('does not hide an external legacy-tail change behind a body-only save',async()=>{
    const {session,attach,first}=await setup(),raw='正文\n<!-- rgent:ledger:v1 -->\n旧记录'
    try{await attach(first);await writeFile(path.join(first,'原篇.md'),raw);const note=await session.readOpened('原篇.md');await writeFile(path.join(first,'原篇.md'),raw+'外部追加');await expect(session.write('原篇.md','修改\n',note.revision,note)).rejects.toThrow('CONFLICT');expect(await readFile(path.join(first,'原篇.md'),'utf8')).toBe(raw+'外部追加')}finally{session.dispose()}
  })
  it('migrates only in explicit task preparation and returns a bound revision receipt',async()=>{
    const {session,attach,first}=await setup(),raw='正文\r\n<!-- rgent:ledger:v1 -->\r\n旧历史\n'
    try{await attach(first);await writeFile(path.join(first,'原篇.md'),raw);const before=await session.readOpened('原篇.md');const receipt=await session.prepareTaskSource({relPath:'原篇.md',sessionId:before.sessionId,objectVersion:before.objectVersion,expectedRevision:before.revision},await migrationGrant(session,'原篇.md'))
      expect(receipt.previousRevision).toBe(before.revision);expect(receipt.revision).not.toBe(before.revision);expect((await session.readOpened('原篇.md')).content).toBe('正文\r\n');expect(await session.ledgerContexts('原篇.md')).toHaveLength(1)
      await expect(session.prepareTaskSource({relPath:'原篇.md',sessionId:before.sessionId,objectVersion:before.objectVersion,expectedRevision:before.revision},await migrationGrant(session,'原篇.md'))).rejects.toThrow('CONFLICT')
    }finally{session.dispose()}
  })
  it('keeps an opaque navigation key across restore, current state and picks while separating same-name libraries', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'rgent-navigation-'))
    const first = path.join(userData, 'first', '笔记库')
    const second = path.join(userData, 'second', '笔记库')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(path.join(userData, 'vault.json'), serializeStoredVault(first))
    const session = new VaultSession(userData, vi.fn())
    const restarted = new VaultSession(userData, vi.fn())
    try {
      const restored = session.restore()
      expect(restored).toMatchObject({ status: 'ready', navigationKey: expect.stringMatching(/^[a-f0-9]{64}$/) })
      if (restored.status !== 'ready') throw new Error('EXPECTED_READY')
      expect(JSON.stringify(restored)).not.toContain(first)
      expect(session.currentState()).toMatchObject({ navigationKey: restored.navigationKey })
      expect(restarted.restore()).toMatchObject({ navigationKey: restored.navigationKey })
      restarted.dispose()
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [first + path.sep] })
      expect(await session.pick(null)).toMatchObject({ navigationKey: restored.navigationKey })
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [second] })
      const picked = await session.pick(null)
      expect(picked).toMatchObject({ status: 'ready', rootName: restored.rootName, navigationKey: expect.any(String) })
      if (picked.status !== 'ready') throw new Error('EXPECTED_READY')
      expect(picked.navigationKey).not.toBe(restored.navigationKey)
      expect(session.currentState()).toMatchObject({ navigationKey: picked.navigationKey })
      expect(restarted.restore()).toMatchObject({ navigationKey: picked.navigationKey })
    } finally { session.dispose(); restarted.dispose(); await rm(userData, { recursive: true, force: true }) }
  })

  it('uses the canonical root for navigation preferences and omits the key when that root is unavailable', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'rgent-navigation-alias-'))
    const root = path.join(userData, 'vault')
    const alias = path.join(userData, 'alias')
    const gone = path.join(userData, 'gone')
    await mkdir(root)
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const session = new VaultSession(userData, vi.fn())
    try {
      expect(session.currentState()).not.toHaveProperty('navigationKey')
      await writeFile(path.join(userData, 'vault.json'), serializeStoredVault(root))
      const direct = session.restore()
      expect(direct).toMatchObject({ status: 'ready', navigationKey: expect.any(String) })
      if (direct.status !== 'ready') throw new Error('EXPECTED_READY')
      await writeFile(path.join(userData, 'vault.json'), serializeStoredVault(alias))
      expect(session.restore()).toMatchObject({ navigationKey: direct.navigationKey })
      await rename(root, gone)
      expect(session.currentState()).toEqual({ status: 'needs-pick', reason: 'missing' })
      expect(session.restore()).toEqual({ status: 'needs-pick', reason: 'missing' })
      await mkdir(root)
      expect(session.currentState()).toEqual({ status: 'needs-pick', reason: 'missing' })
    } finally { session.dispose(); await rm(userData, { recursive: true, force: true }) }
  })

  it('restarts watching if a read detects a lost root before the polling callback', async () => {
    const { session, attach, first } = await setup(); const gone = first + '-read-gap'
    try {
      await attach(first)
      const original = await session.readOpened('原篇.md')
      await session.memoryMutation(store=>store.initialize())
      const memory=session.memorySnapshot()
      const historyKey=await session.ledgerKey('原篇.md')
      const watched = vi.mocked(watchVault).mock.calls.length
      await rename(first, gone)
      expect((await session.noteStatus('原篇.md', original)).status).not.toBe('ready')
      await rename(gone, first)
      expect((await session.noteStatus('原篇.md', original)).status).toBe('ready')
      expect(vi.mocked(watchVault).mock.calls.length).toBe(watched + 1)
      expect(await session.ledgerKey('原篇.md')).toBe(historyKey)
      expect(session.memorySnapshot().revision).toBe(memory.revision)
      await expect(session.ledgerContexts('原篇.md')).resolves.toEqual([])
    } finally { session.dispose() }
  })
  it('retains verified objects and session when the library disappears, and rechecks restoration', async () => {
    const { session, emit, attach, first } = await setup()
    const gone = first + '-gone'
    try {
      await attach(first)
      const original = await session.read('原篇.md')
      await rename(first, gone)
      vi.mocked(watchVault).mock.calls.at(-1)![1](null)
      expect(emit).toHaveBeenCalledWith('vault:lost')
      expect(session.sessionId()).toBe(original.sessionId)
      expect(session.latestFor('原篇.md', original.objectVersion)?.content).toBe(original.content)
      expect((await session.noteStatus('原篇.md', original)).status).not.toBe('ready')
      await mkdir(first)
      await writeFile(path.join(first, '原篇.md'), 'unrelated root')
      await expect(session.tree()).rejects.toThrow('NOTE_UNREADABLE')
      await expect(session.permissions()).rejects.toThrow('NOTE_UNREADABLE')
      await expect(session.search('unrelated')).rejects.toThrow('NOTE_UNREADABLE')
      await expect(session.create('accidental')).rejects.toThrow('NOTE_UNREADABLE')
      await expect(session.createFolder('accidental')).rejects.toThrow('NOTE_UNREADABLE')
      await expect(session.setPermission('原篇.md', 'forbidden')).rejects.toThrow('NOTE_UNREADABLE')
      expect((await session.noteStatus('原篇.md', original)).status).not.toBe('ready')
      await rm(first, { recursive: true })
      await rename(gone, first)
      expect((await session.noteStatus('原篇.md', original)).status).toBe('ready')
    } finally { session.dispose() }
  })
  it('compresses only completed seven-day records after open, keeping the same path and exact logical bytes',async()=>{
    const {session,attach,first}=await setup()
    try{
      await attach(first)
      const source=markPrompt('/问',{taskId:'old-task',range:{start:0,end:2},expectedText:'/问',promptText:'问'})
      const original=await session.readOpened('原篇.md');await session.write('原篇.md',source,original.revision,original)
      const note=await session.read('原篇.md'),answer='无损保留。'.repeat(1000)
      await session.ledgerPrepare('原篇.md',{taskId:'old-task',startedAt:new Date(Date.now()-8*86400000).toISOString(),status:'completed',prompt:'问',answer})
      const saved=await session.write('原篇.md',upsertAiAnswer(note.content,{taskId:'old-task',answer}),note.revision,note)
      await session.ledgerComplete('原篇.md','old-task',saved.revision)
      const before=await session.ledgerRecord('原篇.md','old-task'),owner=(await session.ledgerPage('原篇.md',null)).noteId
      const file=path.join(first,'.rgent','ledgers',owner,'old-task.json'),raw=await readFile(file,'utf8')
      await session.readOpened('原篇.md');await new Promise<void>(r=>setImmediate(r));await session.ledgerKey('原篇.md')
      const compressed=await readFile(file,'utf8')
      expect(JSON.parse(compressed).codec).toBe('gzip');expect(Buffer.byteLength(compressed)).toBeLessThan(Buffer.byteLength(raw))
      expect(await session.ledgerRecord('原篇.md','old-task')).toEqual(before)
      expect((await session.read('原篇.md')).revision).toBe(saved.revision)
    }finally{session.dispose()}
  })
  it('keeps explicit fixed-record memory reset reachable while preserving a failed structure recovery',async()=>{
    const {session,attach,first}=await setup()
    const damaged='{"version":1,"active":"broken"}'
    await writeFile(path.join(first,'.rgent-lifecycle'),damaged)
    try{
      await attach(first);await session.permissions()
      await writeFile(path.join(first,'.rgent-memory'),'broken fixed memory')
      const diagnosis=session.memoryDiagnostic()
      await expect(session.memoryMutation(store=>store.initialize())).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
      const reset=await session.memoryReset(diagnosis)
      expect(reset.record.entries).toEqual([])
      expect(await readFile(path.join(first,'.rgent-lifecycle'),'utf8')).toBe(damaged)
      await expect(session.memoryMutation(store=>store.initialize())).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
    }finally{session.dispose()}
  })

  it('binds reads to the current session and rejects same-byte external replacements', async () => {
    const { session, attach, first } = await setup()
    try {
      await attach(first)
      const initial = await session.read('原篇.md')
      expect(initial.sessionId).toBe(session.captureSession())
      await rename(path.join(first, '原篇.md'), path.join(first, 'held.md'))
      await writeFile(path.join(first, '原篇.md'), initial.content)
      await expect(session.write('原篇.md', 'overwrite', initial.revision, initial)).rejects.toThrow('NOTE_REPLACED')
      expect(await readFile(path.join(first, '原篇.md'), 'utf8')).toBe(initial.content)
    } finally { session.dispose() }
  })

  it('accepts only application-proven atomic-save successors and keeps the original snapshot', async () => {
    const { session, attach, first } = await setup()
    try {
      await attach(first)
      const initial = await session.read('原篇.md')
      const saved = await session.write('原篇.md', 'new body', initial.revision, initial)
      expect(saved.objectVersion).not.toBe(initial.objectVersion)
      expect(session.acceptsObject('原篇.md', initial.objectVersion, saved.objectVersion)).toBe(true)
      expect(session.latestFor('原篇.md', initial.objectVersion)?.content).toBe('new body')
      await attach(first)
      await expect(session.write('原篇.md', 'old session', saved.revision, initial)).rejects.toThrow('VAULT_CHANGED')
    } finally { session.dispose() }
  })

  it('reports missing watched notes without recreating their files', async () => {
    const { session, emit, attach, first } = await setup()
    try {
      await attach(first)
      const initial = await session.read('原篇.md')
      await unlink(path.join(first, '原篇.md'))
      const callback = vi.mocked(watchVault).mock.calls.at(-1)![1]
      callback('原篇.md')
      await new Promise((resolve) => setTimeout(resolve, 110))
      expect(emit).toHaveBeenCalledWith('note:external-change', expect.objectContaining({ relPath: '原篇.md', sessionId: initial.sessionId, state: 'missing', objectVersion: initial.objectVersion }))
      await expect(session.write('原篇.md', 'draft', initial.revision, initial)).rejects.toThrow('NOTE_MISSING')
    } finally { session.dispose() }
  })

  it('retains unresolved original snapshots and refuses a third unrelated object binding', async () => {
    const { session, attach, first } = await setup()
    try {
      await attach(first)
      const initial = await session.read('原篇.md')
      await rename(path.join(first, '原篇.md'), path.join(first, 'held-1.md'))
      await writeFile(path.join(first, '原篇.md'), 'second')
      const second = await session.read('原篇.md')
      await rename(path.join(first, '原篇.md'), path.join(first, 'held-2.md'))
      await writeFile(path.join(first, '原篇.md'), 'third')
      await expect(session.read('原篇.md')).rejects.toThrow('OBJECT_BINDING_LIMIT')
      expect(session.latestFor('原篇.md', initial.objectVersion)?.content).toBe(initial.content)
      expect(session.latestFor('原篇.md', second.objectVersion)?.content).toBe('second')
    } finally { session.dispose() }
  })

  it('continues only native-confirmed object successors from structural link repairs', async () => {
    const { session, attach, first } = await setup()
    try {
      await writeFile(path.join(first, '原篇.md'), '[[原篇]]')
      await writeFile(path.join(first, 'refs.md'), '[[原篇]]')
      await attach(first)
      const original = await session.read('原篇.md')
      const refs = await session.read('refs.md')
      const preview = await session.previewRelocation({ kind: 'note', source: '原篇.md', target: '新篇.md' })
      await session.commitRelocation(preview.id, true)
      const moved = await session.read('新篇.md')
      const repaired = await session.read('refs.md')
      expect(session.acceptsObject('新篇.md', original.objectVersion, moved.objectVersion)).toBe(true)
      expect(session.acceptsObject('refs.md', refs.objectVersion, repaired.objectVersion)).toBe(true)
      expect(session.latestFor('新篇.md', original.objectVersion)?.content).toBe('[[新篇]]')
      await expect(session.write('refs.md', 'human edit', repaired.revision, refs)).resolves.toMatchObject({ sessionId: refs.sessionId })
    } finally { session.dispose() }
  })

  it('rejects a preview waiting for recovery when the vault changes', async () => {
    let finish!: (value: null) => void
    const pending = new Promise<null>((resolve) => { finish = resolve })
    vi.spyOn(VaultLifecycle.prototype, 'recover').mockReturnValueOnce(pending).mockResolvedValue(null)
    const { session, attach, first, second } = await setup()
    try {
      await attach(first)
      const preview = session.previewRelocation({ kind: 'note', source: '原篇.md', target: '新篇.md' })
      await attach(second)
      finish(null)
      await expect(preview).rejects.toThrow('VAULT_CHANGED')
      expect(await readFile(path.join(second, '原篇.md'), 'utf8')).toBe('second')
    } finally { session.dispose() }
  })

  it.each(['success', 'failure'])('ignores late recovery %s from a previous vault', async (outcome) => {
    let finish!: (value: { moved: []; unrepaired: [] } | null) => void
    let fail!: (error: Error) => void
    const pending = new Promise<{ moved: []; unrepaired: [] } | null>((resolve, reject) => { finish = resolve; fail = reject })
    vi.spyOn(VaultLifecycle.prototype, 'recover').mockReturnValueOnce(pending).mockResolvedValue(null)
    const { session, emit, attach, first, second } = await setup()
    try {
      await attach(first)
      await attach(second)
      emit.mockClear()
      if (outcome === 'success') finish({ moved: [], unrepaired: [] })
      else fail(new Error('OLD_RECOVERY_FAILURE'))
      await Promise.resolve()
      await Promise.resolve()
      expect(emit).not.toHaveBeenCalled()
      expect((await session.previewRelocation({ kind: 'note', source: '原篇.md', target: '新篇.md' })).source).toBe('原篇.md')
    } finally { session.dispose() }
  })

  it('binds status and retries to the session even when reopening the same vault', async () => {
    const { session, attach, first } = await setup()
    try {
      await attach(first)
      const token = session.captureSession()
      expect((await session.lifecycleStatus()).sessionId).toBe(token)
      await attach(first)
      expect(() => session.assertSession(token)).toThrow('VAULT_CHANGED')
      await expect(session.lifecycleRetry({ sessionId: token, revision: 'old' })).rejects.toThrow('VAULT_CHANGED')
    } finally { session.dispose() }
  })

  it('drains the previous session before selecting the same library again', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'rgent-session-'))
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    await writeFile(path.join(userData, 'vault.json'), serializeStoredVault(root))
    const drain = vi.fn(async () => {})
    const session = new VaultSession(userData, vi.fn(), drain)
    try {
      session.restore()
      const originalSession = session.captureSession()
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [root] })
      await session.pick(null)
      expect(drain).toHaveBeenCalledWith(root)
      expect(session.captureSession()).not.toBe(originalSession)
    } finally { session.dispose() }
  })

  it('discards a delayed note notification from the previous vault', async () => {
    const { session, emit, attach, first, second } = await setup()
    let finish!: (value: { content: string; revision: string; objectVersion: string }) => void
    const pending = new Promise<{ content: string; revision: string; objectVersion: string }>((resolve) => { finish = resolve })
    try {
      await attach(first)
      vi.spyOn(notesFs, 'readNoteSnapshot').mockReturnValueOnce(pending)
      const callback = vi.mocked(watchVault).mock.calls.at(-1)![1]
      callback('原篇.md')
      await new Promise((resolve) => setTimeout(resolve, 100))
      await attach(second)
      emit.mockClear()
      finish({ content: 'first secret', revision: 'old', objectVersion: 'old-object' })
      await Promise.resolve()
      await Promise.resolve()
      expect(emit).not.toHaveBeenCalled()
    } finally { session.dispose() }
  })
})

describe('vault paths', () => {
  it('keeps paths inside the vault root', () => {
    const root = path.join('/tmp', 'vault-root')
    expect(resolveInVault(root, 'a.md')).toBe(path.resolve(root, 'a.md'))
    expect(resolveInVault(root, 'folder/note.md')).toBe(path.resolve(root, 'folder', 'note.md'))
  })

  it('rejects escapes and absolute paths', () => {
    const root = path.join('/tmp', 'vault-root')
    expect(resolveInVault(root, '../secret.md')).toBeNull()
    expect(resolveInVault(root, 'a/../../etc/passwd')).toBeNull()
    expect(resolveInVault(root, '/etc/passwd')).toBeNull()
  })

  it('joins note-relative media inside the vault and rejects escapes', () => {
    expect(joinVaultRel('工作/会议纪要.md', 'pic.png', 'note')).toBe('工作/pic.png')
    expect(joinVaultRel('工作/会议纪要.md', '../pic.png', 'note')).toBe('pic.png')
    expect(joinVaultRel('工作/会议纪要.md', '../../secret.png', 'note')).toBeNull()
    expect(joinVaultRel('工作/会议纪要.md', 'pic.png', 'vault')).toBe('pic.png')
    expect(joinVaultRel('工作/会议纪要.md', '../x.png', 'vault')).toBeNull()
    expect(joinVaultRel('a.md', 'https://example.com/x.png', 'note')).toBeNull()
  })

  it('only serves image files from inside the vault', () => {
    const root = path.join('/tmp', 'vault-root')
    expect(isVaultImagePath('pic.png')).toBe(true)
    expect(isVaultImagePath('note.md')).toBe(false)
    expect(vaultMediaPath(root, 'folder/pic.png')).toBe(path.resolve(root, 'folder', 'pic.png'))
    expect(vaultMediaPath(root, '../pic.png')).toBeNull()
    expect(vaultMediaPath(root, 'note.md')).toBeNull()
  })

  it('encodes vault media urls without letting other schemes through', () => {
    expect(parseVaultMediaUrl(vaultMediaUrl('工作/pic.png'))).toBe('工作/pic.png')
    expect(parseVaultMediaUrl('https://example.com/x.png')).toBeNull()
  })

  it('refuses to serve hidden media over the vault protocol', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    await mkdir(path.join(root, '.hidden'), { recursive: true })
    await writeFile(path.join(root, '.secret.png'), 'secret-root', 'utf8')
    await writeFile(path.join(root, '.hidden', 'x.png'), 'secret-dir', 'utf8')
    expect(readVaultMedia(root, '.secret.png')).toEqual({ error: 403 })
    expect(readVaultMedia(root, '.hidden/x.png')).toEqual({ error: 403 })
    expect(vaultMediaPath(root, '.secret.png')).toBeNull()
    // 非隐藏的照常可读，别把这道口子开成一律拒绝。
    await writeFile(path.join(root, 'ok.png'), 'ok', 'utf8')
    expect(readVaultMedia(root, 'ok.png')).toEqual({ bytes: Buffer.from('ok') })
  })

  it('refuses vault media that only stays inside the root via a symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'rgent-out-'))
    const secret = path.join(outside, 'secret.png')
    await writeFile(secret, 'secret', 'utf8')
    const link = path.join(root, 'pic.png')
    await symlink(secret, link)
    expect(readVaultMedia(root, 'pic.png')).toEqual({ error: 403 })
  })

  it('serves a real in-vault image path after confinement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    const file = path.join(root, 'pic.png')
    await writeFile(file, 'png', 'utf8')
    const resolved = readVaultMedia(root, 'pic.png')
    expect('bytes' in resolved ? resolved.bytes.toString('utf8') : resolved).toBe('png')
  })

  it('sanitizes note names', () => {
    expect(sanitizeNoteName('会议纪要')).toBe('会议纪要.md')
    expect(sanitizeNoteName('a/b.md')).toBe('a_b.md')
    expect(sanitizeNoteName('')).toBe('未命名.md')
  })
})

describe('notes-fs', () => {
  it('lists notes, shows other files, hides dotfiles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    await writeFile(path.join(root, 'hello.md'), '# hi\n', 'utf8')
    await writeFile(path.join(root, 'photo.png'), '', 'utf8')
    await writeFile(path.join(root, '.secret.md'), 'nope', 'utf8')
    await mkdir(path.join(root, 'sub'))
    await writeFile(path.join(root, 'sub', 'nested.md'), 'n', 'utf8')
    await mkdir(path.join(root, '.hidden-dir'))
    await writeFile(path.join(root, '.hidden-dir', 'x.md'), 'x', 'utf8')

    const tree = await listVaultTree(root)
    const names = flatten(tree).map((entry) => entry.relPath).sort()
    expect(names).toEqual(['hello.md', 'photo.png', 'sub', 'sub/nested.md'])
    expect(tree.find((entry) => entry.relPath === 'hello.md')?.kind).toBe('note')
    expect(tree.find((entry) => entry.relPath === 'photo.png')?.kind).toBe('file')
  })

  it('classifies companion folders by native spelling rather than string case guesses', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-companion-'))
    try {
      await writeFile(path.join(root, 'Exact.md'), 'note')
      await mkdir(path.join(root, 'Exact'))
      await writeFile(path.join(root, 'Alias.md'), 'note')
      await mkdir(path.join(root, 'alias'))
      await mkdir(path.join(root, 'orphan'))
      const nativeAlias = await stat(path.join(root, 'Alias')).then(async info => {
        const actual = await stat(path.join(root, 'alias')); return info.dev === actual.dev && info.ino === actual.ino
      }).catch(() => false)
      const result = await listVaultTree(root)
      expect(result.find(entry => entry.name === 'Exact')).toMatchObject({ attachmentOf: 'Exact.md' })
      expect(result.find(entry => entry.name === 'alias')?.attachmentOf).toBe(nativeAlias ? 'Alias.md' : undefined)
      expect(result.find(entry => entry.name === 'orphan')).not.toHaveProperty('attachmentOf')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('refuses to read outside the vault', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    await expect(readNote(root, '../escape.md')).rejects.toThrow(/超出/)
    await expect(readNote(root, 'photo.png')).rejects.toThrow(/不是笔记/)
  })

  it('creates and writes notes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    const rel = await createNote(root, '初稿')
    expect(rel).toBe('初稿.md')
    const initial = await readNoteSnapshot(root, rel)
    const revision = await writeNote(root, rel, '正文', initial.revision)
    expect(revision).toBe((await readNoteSnapshot(root, rel)).revision)
    expect(await readNote(root, rel)).toBe('正文')
    await writeNote(root, rel, '', revision)
    expect(await readNote(root, rel)).toBe('')
    await expect(createNote(root, '初稿')).rejects.toThrow(/同名/)
  })

  it('creates notes and folders under an existing directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    await mkdir(path.join(root, '工作'))
    expect(await createNote(root, '计划', '工作')).toBe('工作/计划.md')
    expect(await createFolder(root, '资料', '工作')).toBe('工作/资料')
    expect((await listVaultTree(root))[0]?.children?.map((entry) => entry.name)).toEqual(['资料', '计划.md'])
    await expect(createNote(root, '越界', '../外部')).rejects.toThrow()
  })

  it('keeps the note mode and leaves no temporary file behind when replacing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    const target = path.join(root, 'a.md')
    await writeFile(target, '旧稿', 'utf8')
    // 0666：只要 umask 不是 0，走「新建临时文件再改名」就会把 group/other 写位削掉。
    await chmod(target, 0o666)
    const initial = await readNoteSnapshot(root, 'a.md')
    await writeNote(root, 'a.md', '新稿', initial.revision)
    expect(await readFile(target, 'utf8')).toBe('新稿')
    expect((await stat(target)).mode & 0o777).toBe(0o666)
    expect((await listVaultTree(root)).map((entry) => entry.name)).toEqual(['a.md'])
  })

  it('refuses hidden paths and the permission list through the human write channel', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    await mkdir(path.join(root, '.hidden'), { recursive: true })
    await writeFile(path.join(root, '.secret.md'), '秘密', 'utf8')
    await writeFile(path.join(root, '.hidden', 'a.md'), '秘密', 'utf8')
    await writeFile(path.join(root, '.rgent-permissions'), '{}', 'utf8')

    await expect(readNote(root, '.secret.md')).rejects.toThrow(/隐藏/)
    await expect(writeNote(root, '.secret.md', '改', 'rev')).rejects.toThrow(/隐藏/)
    await expect(readNote(root, '.hidden/a.md')).rejects.toThrow(/隐藏/)
    await expect(writeNote(root, '.hidden/a.md', '改', 'rev')).rejects.toThrow(/隐藏/)

    // 权限名单不是 .md，先被「不是笔记」挡下；不管哪一条，人的写盘通道都碰不到它。
    await expect(writeNote(root, '.rgent-permissions', '{"工作":"forbidden"}', 'rev')).rejects.toThrow()
    await expect(readNote(root, '.rgent-permissions')).rejects.toThrow()
    expect(await readFile(path.join(root, '.rgent-permissions'), 'utf8')).toBe('{}')

    // 新建笔记也不能造出点号开头的文件名。
    expect(await createNote(root, '.secrets')).toBe('_secrets.md')
  })

  it('rejects a stale write and preserves the disk version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    await writeFile(path.join(root, 'a.md'), '初稿', 'utf8')
    const initial = await readNoteSnapshot(root, 'a.md')
    await writeFile(path.join(root, 'a.md'), '外部修改', 'utf8')
    await expect(writeNote(root, 'a.md', '窗口稿', initial.revision)).rejects.toThrow('CONFLICT')
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('外部修改')
  })

  it('serializes concurrent writes of the same revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    await writeFile(path.join(root, 'a.md'), '初稿', 'utf8')
    const initial = await readNoteSnapshot(root, 'a.md')
    const results = await Promise.allSettled([
      writeNote(root, 'a.md', '甲', initial.revision),
      writeNote(root, 'a.md', '乙', initial.revision)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(['甲', '乙']).toContain(await readFile(path.join(root, 'a.md'), 'utf8'))
  })

  it.skipIf(process.platform === 'win32')('keeps the original when the directory refuses a temporary file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    const target = path.join(root, 'a.md')
    await writeFile(target, '原文', 'utf8')
    const old = await readNoteSnapshot(root, 'a.md')
    await chmod(root, 0o555)
    try {
      await expect(writeNote(root, 'a.md', '新文', old.revision)).rejects.toThrow()
    } finally {
      await chmod(root, 0o755)
    }
    expect(await readFile(target, 'utf8')).toBe('原文')
    expect((await listVaultTree(root)).map((entry) => entry.name)).toEqual(['a.md'])
  })

  // 目录链接在两平台都能建（Windows 用 junction，不需要特权），
  // 它同时钉住 Windows 上「重解析点要映射成 UNSAFE_PATH」这条：
  // 映射缺失时这里抛的是裸 NTSTATUS，而 JS 层按 'UNSAFE_PATH' 判等，消息就不会是「符号链接」。
  it('does not treat a linked directory as vault notes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'rgent-out-'))
    await writeFile(path.join(outside, 'secret.md'), '库外秘密', 'utf8')
    await symlink(outside, path.join(root, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir')
    const tree = await listVaultTree(root)
    expect(tree.find((item) => item.name === 'linked-dir')?.kind).toBe('file')
    await expect(readNote(root, 'linked-dir/secret.md')).rejects.toThrow(/符号链接/)
    await expect(writeNote(root, 'linked-dir/secret.md', '覆盖', 'old')).rejects.toThrow(/符号链接/)
    expect(await readFile(path.join(outside, 'secret.md'), 'utf8')).toBe('库外秘密')
  })

  // 文件符号链接在 Windows 上要特权，所以只在非 Windows 跑。
  it.skipIf(process.platform === 'win32')('does not treat a linked note file as a vault note', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'rgent-out-'))
    await writeFile(path.join(outside, 'secret.md'), '库外秘密', 'utf8')
    await symlink(path.join(outside, 'secret.md'), path.join(root, 'link.md'))
    const tree = await listVaultTree(root)
    expect(tree.find((item) => item.name === 'link.md')?.kind).toBe('file')
    await expect(readNote(root, 'link.md')).rejects.toThrow(/符号链接/)
    await expect(writeNote(root, 'link.md', '覆盖', 'old')).rejects.toThrow(/符号链接/)
    expect(await readFile(path.join(outside, 'secret.md'), 'utf8')).toBe('库外秘密')
  })

  it('parses stored vault json', () => {
    expect(parseStoredVault(null)).toBeNull()
    expect(parseStoredVault('{')).toBeNull()
    expect(parseStoredVault(JSON.stringify({ path: '/tmp/lib' }))).toEqual({ path: '/tmp/lib' })
    expect(parseStoredVault(serializeStoredVault('/tmp/lib'))).toEqual({ path: '/tmp/lib' })
  })

  it('collects note paths and ignores non-notes', () => {
    const paths = collectNotePaths([
      { name: 'a.md', relPath: 'a.md', kind: 'note' },
      { name: 'pic.png', relPath: 'pic.png', kind: 'file' },
      {
        name: 'sub',
        relPath: 'sub',
        kind: 'dir',
        children: [{ name: 'b.md', relPath: 'sub/b.md', kind: 'note' }]
      }
    ])
    expect([...paths].sort()).toEqual(['a.md', 'sub/b.md'])
  })

  it('collects notes and other files for vault media lookups', () => {
    const paths = collectRelPaths([
      { name: 'a.md', relPath: 'a.md', kind: 'note' },
      { name: 'pic.png', relPath: 'pic.png', kind: 'file' },
      {
        name: 'sub',
        relPath: 'sub',
        kind: 'dir',
        children: [{ name: 'b.md', relPath: 'sub/b.md', kind: 'note' }]
      }
    ])
    expect([...paths].sort()).toEqual(['a.md', 'pic.png', 'sub/b.md'])
  })
})

function flatten(entries: { relPath: string; children?: unknown[] }[]): { relPath: string }[] {
  const out: { relPath: string }[] = []
  for (const entry of entries) {
    out.push(entry)
    if (entry.children) out.push(...flatten(entry.children as { relPath: string; children?: unknown[] }[]))
  }
  return out
}


it('verifies Agent source ancestry and companion ownership without recursively listing unrelated subtrees', async () => {
  expect(notesFs).toHaveProperty('requireOrdinaryNotes')
  const check = (notesFs as typeof notesFs & { requireOrdinaryNotes(root: string, paths: readonly string[]): void }).requireOrdinaryNotes
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-scoped-ownership-'))
  try {
    await mkdir(path.join(root, 'ordinary'))
    await writeFile(path.join(root, 'ordinary', 'read.md'), '正文')
    await mkdir(path.join(root, 'unrelated'))
    await mkdir(path.join(root, 'unrelated', 'deep'))
    const listings = vi.spyOn(secureFsFor(root), 'list')
    expect(() => check(root, ['ordinary/read.md'])).not.toThrow()
    expect(listings.mock.calls.map(call => call[0])).toEqual([''])
    await writeFile(path.join(root, 'ordinary.md'), '拥有附件目录')
    expect(() => check(root, ['ordinary/read.md'])).toThrow('OUTSIDE_TASK_SCOPE')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('uses actual native alias resolution for attachment ancestors and rejects missing, hidden and linked sources', async () => {
  expect(notesFs).toHaveProperty('requireOrdinaryNotes')
  const check = (notesFs as typeof notesFs & { requireOrdinaryNotes(root: string, paths: readonly string[]): void }).requireOrdinaryNotes
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-scoped-alias-'))
  try {
    await writeFile(path.join(root, 'Alias.md'), 'note')
    await mkdir(path.join(root, 'alias'))
    await mkdir(path.join(root, 'alias', 'nested'))
    await writeFile(path.join(root, 'alias', 'nested', 'read.md'), 'nested')
    const nativeAlias = await stat(path.join(root, 'Alias')).then(async info => {
      const actual = await stat(path.join(root, 'alias')); return info.dev === actual.dev && info.ino === actual.ino
    }).catch(() => false)
    if (nativeAlias) expect(() => check(root, ['alias/nested/read.md'])).toThrow('OUTSIDE_TASK_SCOPE')
    else expect(() => check(root, ['alias/nested/read.md'])).not.toThrow()
    await writeFile(path.join(root, '.hidden.md'), 'hidden')
    await symlink(path.join(root, 'Alias.md'), path.join(root, 'linked.md'))
    expect(() => check(root, ['missing.md'])).toThrow()
    expect(() => check(root, ['.hidden.md'])).toThrow()
    expect(() => check(root, ['linked.md'])).toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function migrationGrant(session:VaultSession,relPath:string){
 const note=await session.read(relPath),registry=new TaskAuthorizationRegistry({root:()=>session.root,session:()=>session.sessionId(),tree:()=>session.tree(),read:path=>session.read(path),tier:modelTierFor,assertOrdinaryNotes:paths=>session.requireOrdinaryNotes(paths),acceptsObject:(path,before,after)=>session.acceptsObject(path,before,after),configuration:()=>({credential:{provider:'custom',baseURL:'https://fixture.example/v1',modelId:'fixture',contextTokens:16000,apiKey:'fixture'},limits:{seconds:30,steps:4,tools:0}})})
 const request={...note,relPath,expectedRevision:note.revision,range:{start:0,end:2},expectedText:note.content.slice(0,2),promptText:'问',modelRecordId:'fixture',references:[]},preview=await registry.preview('owner',request)
 return registry.consume('owner',{...request,previewId:preview.id})
}
it('keeps open tab binding continuous after explicit batch migration and permits its next body save',async()=>{
 const {session,attach,first}=await setup();try{await attach(first);await writeFile(path.join(first,'原篇.md'),'正文\n<!-- rgent:ledger:v1 -->\n旧历史');const note=await session.readOpened('原篇.md')
  const batch=await session.ledgerMigrateBatch(null);expect(batch.failures).toEqual([]);const status=await session.noteStatus('原篇.md',note);expect(status.status).toBe('ready');if(status.status!=='ready')throw Error('EXPECTED_READY')
  await session.write('原篇.md','修改正文\n',status.snapshot.revision,note);expect(await readFile(path.join(first,'原篇.md'),'utf8')).toBe('修改正文\n');expect(await session.ledgerContexts('原篇.md')).toHaveLength(1)
 }finally{session.dispose()}
})
it.each(['forbidden','invalid','revoked','queued','during-check','after-read'] as const)('refuses task migration after authorization changes: %s',async change=>{
 const {session,attach,first}=await setup(),raw='正文\n<!-- rgent:ledger:v1 -->\n旧历史';try{await attach(first);await mkdir(path.join(first,'目录'));await writeFile(path.join(first,'目录/原篇.md'),raw);const note=await session.readOpened('目录/原篇.md'),grant=await migrationGrant(session,'目录/原篇.md')
  if(change==='forbidden')await writeFile(path.join(first,'.rgent-permissions'),JSON.stringify({'目录/原篇.md':'forbidden'}))
  if(change==='invalid')await writeFile(path.join(first,'.rgent-permissions'),'{bad')
  if(change==='revoked')grant.revoke()
  const permission=change==='queued'?session.setPermission('目录','forbidden'):Promise.resolve()
  if(change==='during-check'){const assert=grant.assertLive.bind(grant);vi.spyOn(grant,'assertLive').mockImplementation(async(...args)=>{await assert(...args);await writeFile(path.join(first,'.rgent-permissions'),JSON.stringify({'目录/原篇.md':'forbidden'}))})}
  if(change==='after-read'){const read=session.read.bind(session);vi.spyOn(session,'read').mockImplementation(async path=>{const snapshot=await read(path);grant.revoke();return snapshot})}
  await expect(session.prepareTaskSource({...note,relPath:'目录/原篇.md',expectedRevision:note.revision},grant)).rejects.toThrow();await permission
  expect(await readFile(path.join(first,'目录/原篇.md'),'utf8')).toBe(raw);await expect(stat(path.join(first,'.rgent','registry.json'))).rejects.toMatchObject({code:'ENOENT'})
 }finally{session.dispose()}
})

it('rechecks permission immediately before stripping the tail when it changes during archival',async()=>{
 const {session,attach,first}=await setup(),raw='正文\n<!-- rgent:ledger:v1 -->\n旧历史';try{await attach(first);await writeFile(path.join(first,'原篇.md'),raw);const note=await session.readOpened('原篇.md'),grant=await migrationGrant(session,'原篇.md'),fs=secureFsFor(first),replace=fs.replace.bind(fs)
  vi.spyOn(fs,'replace').mockImplementation((...args)=>{const result=replace(...args);if(args[0].endsWith('/legacy.json'))writeFileSync(path.join(first,'.rgent-permissions'),JSON.stringify({'原篇.md':'forbidden'}));return result})
  await expect(session.prepareTaskSource({...note,relPath:'原篇.md',expectedRevision:note.revision},grant)).rejects.toThrow('SOURCE_PERMISSION_CHANGED');expect(await readFile(path.join(first,'原篇.md'),'utf8')).toBe(raw);expect((await session.noteStatus('原篇.md',note)).status).toBe('ready')
 }finally{session.dispose()}
})
it('previews and explicitly restores a copied library while rejecting same-root note replacement',async()=>{
 const {session,attach,first,second}=await setup();const {LedgerStore}=await import('../../src/main/ledger-store.ts');const {vaultRootIdentity}=await import('../../src/main/watch.ts');const {cp}=await import('node:fs/promises')
 try{await attach(first);const store=new LedgerStore(secureFsFor(first),()=>{},undefined,()=>vaultRootIdentity(first));store.owner('原篇.md')
  const fs=secureFsFor(first),note=fs.readSnapshot('原篇.md');fs.replace('原篇.md','first','first',note.objectVersion)
  const refused=await session.ledgerRecoveryPreview('restore');expect(refused.rows[0].outcome).toBe('refused');expect(refused.canCommit).toBe(false)
  // A new explicit library copy has a distinct root and a complete descriptor tree.
  await cp(first,second,{recursive:true,force:true});await attach(second)
  const preview=await session.ledgerRecoveryPreview('restore');expect(preview.canCommit).toBe(true);expect(preview.rows[0].outcome).toBe('associate')
  expect((await session.readOpened('原篇.md')).ledger?.status).toBe('invalid')
  const result=await session.ledgerRecoveryCommit(preview.id);expect(result.status).toBe('complete');expect((await session.readOpened('原篇.md')).ledger?.status).toBe('verified')
  await expect(session.ledgerRecoveryCommit(preview.id)).rejects.toThrow('STALE_PREVIEW')
 }finally{session.dispose()}
})
it('rejects recovery preview when attachment subtree no longer matches recorded evidence',async()=>{
 const {session,attach,first,second}=await setup();const {LedgerStore}=await import('../../src/main/ledger-store.ts');const {vaultRootIdentity}=await import('../../src/main/watch.ts');const {cp}=await import('node:fs/promises')
 try{await mkdir(path.join(first,'原篇'));await writeFile(path.join(first,'原篇','asset.txt'),'original');const store=new LedgerStore(secureFsFor(first),()=>{},undefined,()=>vaultRootIdentity(first));store.owner('原篇.md')
  await cp(first,second,{recursive:true,force:true});await writeFile(path.join(second,'原篇','extra.txt'),'new');await attach(second)
  const preview=await session.ledgerRecoveryPreview('restore');expect(preview.rows[0].outcome).toBe('refused');expect(preview.rows[0].reasons).toContain('附件子树与历史证据不同')
 }finally{session.dispose()}
})
it('rejects recovery when the source changes after evidence reading but before preview capture',async()=>{
 const {session,attach,first,second}=await setup();const {LedgerStore}=await import('../../src/main/ledger-store.ts');const {vaultRootIdentity}=await import('../../src/main/watch.ts');const {cp}=await import('node:fs/promises')
 try{const store=new LedgerStore(secureFsFor(first),()=>{},undefined,()=>vaultRootIdentity(first));store.owner('原篇.md');await cp(first,second,{recursive:true,force:true});await attach(second)
  const fs=secureFsFor(second),read=fs.readSnapshot.bind(fs);let changed=false
  vi.spyOn(fs,'readSnapshot').mockImplementation(p=>{const d=read(p);if(p==='原篇.md'&&!changed){changed=true;writeFileSync(path.join(second,'原篇.md'),'external change')}return d})
  await expect(session.ledgerRecoveryPreview('restore')).rejects.toThrow('STALE_PREVIEW')
 }finally{session.dispose()}
})
it('keeps a multi-note copied-library recovery resumable after leaving and reopening the library',async()=>{
 const {session,attach,first,second}=await setup();const {LedgerStore}=await import('../../src/main/ledger-store.ts');const {vaultRootIdentity}=await import('../../src/main/watch.ts');const {cp}=await import('node:fs/promises')
 try{const store=new LedgerStore(secureFsFor(first),()=>{},undefined,()=>vaultRootIdentity(first));store.owner('原篇.md');for(let n=0;n<5;n++){await writeFile(path.join(first,`note${n}.md`),`body${n}`);store.owner(`note${n}.md`)}
  await cp(first,second,{recursive:true,force:true});await attach(second);const preview=await session.ledgerRecoveryPreview('restore'),progress=await session.ledgerRecoveryCommit(preview.id)
  expect(progress.status).toBe('pending');const pausedNote=await session.read('原篇.md');await expect(session.write('原篇.md','blocked edit',pausedNote.revision,pausedNote)).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED');await expect(modelTierFor(second,'原篇.md')).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED');expect((await session.readOpened('原篇.md')).content).toBe('first')
  await expect(session.memoryMutation(s=>s.initialize())).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED');await attach(first);await attach(second)
  const status=await session.lifecycleStatus();expect(status.status).toBe('pending');expect(status.revision).toBe(progress.revision)
  const done=await session.ledgerRecoveryResume(status.revision!);expect(done.status).toBe('complete');expect((await session.readOpened('原篇.md')).ledger?.status).toBe('verified')
 }finally{session.dispose()}
})
it('keeps old descriptors as history only and rejects same-body template ambiguity',async()=>{
 const {session,attach,first,second}=await setup();const {LedgerStore}=await import('../../src/main/ledger-store.ts');const {cp}=await import('node:fs/promises')
 try{new LedgerStore(secureFsFor(first),()=>{}).owner('原篇.md');await cp(first,second,{recursive:true,force:true});await attach(second)
  const historical=await session.ledgerRecoveryPreview('restore');expect(historical.rows[0].outcome).toBe('history-only')
  await writeFile(path.join(second,'另一个模板.md'),'first');const ambiguous=await session.ledgerRecoveryPreview('restore');expect(ambiguous.canCommit).toBe(false)
  expect(ambiguous.rows[0].reasons).toContain('同正文材料不能唯一对应')
 }finally{session.dispose()}
})
it('blocks ordinary saves after interrupted owner publication, then resumes and saves both drafts',async()=>{
 const {session,attach,first}=await setup();const {LedgerStore}=await import('../../src/main/ledger-store.ts');const {vaultRootIdentity}=await import('../../src/main/watch.ts')
 try{await attach(first);await writeFile(path.join(first,'other.md'),'other');const fs=secureFsFor(first),store=new LedgerStore(fs,()=>{},undefined,()=>vaultRootIdentity(first));store.owner('原篇.md')
  const note=await session.readOpened('原篇.md'),other=await session.readOpened('other.md'),replace=fs.replace.bind(fs)
  let fail=true;vi.spyOn(fs,'replace').mockImplementation((...args)=>{if(fail&&args[0]==='.rgent/registry.json')throw Error('injected registry failure');return replace(...args)})
  const saved=await session.write('原篇.md','first edit',note.revision,note)
  const status=await session.lifecycleStatus();expect(status.status).toBe('pending')
  const journal=await readFile(path.join(first,'.rgent-lifecycle'),'utf8')
  await expect(session.write('原篇.md','later draft',saved.revision,saved)).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
  await expect(session.write('other.md','other draft',other.revision,other)).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
  expect(await readFile(path.join(first,'.rgent-lifecycle'),'utf8')).toBe(journal)
  expect((await session.read('原篇.md')).content).toBe('first edit');expect((await session.read('other.md')).content).toBe('other')
  await expect(session.ledgerRecoveryResume(status.revision!)).rejects.toThrow();expect(await readFile(path.join(first,'.rgent-lifecycle'),'utf8')).toBe(journal)
  fail=false;expect((await session.ledgerRecoveryResume(status.revision!)).status).toBe('complete');expect((await session.ledgerPage('原篇.md',null)).maintenanceError).toBeUndefined()
  await session.write('原篇.md','later draft',saved.revision,saved);await session.write('other.md','other draft',other.revision,other)
  expect((await session.read('原篇.md')).content).toBe('later draft');expect((await session.read('other.md')).content).toBe('other draft')
 }finally{session.dispose()}
})
it('runs the production recovery coordination with dirty tabs and permits a safe switch only after saving them',async()=>{
 const {session,attach,first,second}=await setup();const {LedgerStore}=await import('../../src/main/ledger-store.ts'),{vaultRootIdentity}=await import('../../src/main/watch.ts'),{VaultStructureGate}=await import('../../src/main/vault-mutation-queue.ts'),{RecoveryDraftGate}=await import('../../src/shared/flush.ts'),{VaultSwitch}=await import('../../src/main/vault-switch.ts')
 try{await attach(first);await writeFile(path.join(first,'other.md'),'other');const fs=secureFsFor(first),store=new LedgerStore(fs,()=>{},undefined,()=>vaultRootIdentity(first));store.owner('原篇.md')
  const original=await session.read('原篇.md'),other=await session.read('other.md'),replace=fs.replace.bind(fs)
  let fail=true;vi.spyOn(fs,'replace').mockImplementation((...args)=>{if(fail&&args[0]==='.rgent/registry.json')throw Error('registry unavailable');return replace(...args)})
  const saved=await session.write('原篇.md','saved first',original.revision,original),drafts=[{relPath:'原篇.md',body:'later draft',binding:saved},{relPath:'other.md',body:'other draft',binding:other}]
  const gate=new VaultStructureGate(),renderer=new RecoveryDraftGate();let flushes=0
  const flush=async()=>{flushes++;try{for(const draft of drafts)await session.write(draft.relPath,draft.body,draft.binding.revision,draft.binding);drafts.length=0;return true}catch{return false}}
  const switcher=new VaultSwitch({check:()=>{if(gate.isBusy())throw Error('STRUCTURE_BUSY')},prepare:async()=>{},flush,commit:attach,release:()=>{}})
  await expect(switcher.run(second)).rejects.toThrow('UNSAVED_DRAFT');expect(drafts).toHaveLength(2);expect(session.root).toBe(first)
  const status=await session.lifecycleStatus(),context={sessionId:session.sessionId()!,operationId:'recovery'},deps={session:()=>session.sessionId(),composing:()=>false,changed:()=>{},settled:async()=>{},save:flush,dirty:()=>drafts.length>0}
  const resume=()=>gate.recover(first,{assert:()=>session.assertSession(context.sessionId),quiesce:async()=>{},prepare:()=>renderer.handle('recovery-resume',context,deps),drain:()=>session.idle(),release:()=>{void renderer.handle('recovery-release',context,deps)}},()=>session.ledgerRecoveryResume(status.revision!))
  const count=flushes;await expect(resume()).rejects.toThrow();expect(flushes).toBe(count);expect(drafts).toHaveLength(2)
  fail=false;expect((await resume()).status).toBe('complete');expect(flushes).toBe(count);expect(drafts).toHaveLength(2)
  expect((await switcher.run(second)).status).toBe('ready');expect(drafts).toHaveLength(0)
  expect(await readFile(path.join(first,'原篇.md'),'utf8')).toBe('later draft');expect(await readFile(path.join(first,'other.md'),'utf8')).toBe('other draft')
 }finally{session.dispose()}
})

/** Real session, grant and ledger IO; only the model stream and registry fault are controlled. */
async function pendingHostRecoveryFixture(relPath = '原篇.md') {
  const app = await setup()
  const { AgentHost } = await import('../../src/main/agent-host.ts')
  const { VaultStructureGate } = await import('../../src/main/vault-mutation-queue.ts')
  await mkdir(path.dirname(path.join(app.first, relPath)), { recursive: true })
  await writeFile(path.join(app.first, relPath), '/问\n')
  await app.attach(app.first)
  const note = await app.session.read(relPath), grant = await migrationGrant(app.session, relPath)
  const fs = secureFsFor(app.first), replace = fs.replace.bind(fs), gate = new VaultStructureGate()
  let fail = false, releaseStream = () => {}, streamStarted = () => {}
  let beforeTier: () => Promise<void> = async () => {}
  let afterTier: () => Promise<void> = async () => {}
  const streamHold = new Promise<void>(resolve => { releaseStream = resolve })
  const started = new Promise<void>(resolve => { streamStarted = resolve })
  vi.spyOn(fs, 'replace').mockImplementation((...args) => {
    if (fail && args[0] === '.rgent/registry.json') throw Error('registry unavailable')
    return replace(...args)
  })
  const authorize = vi.fn(async () => grant), dispatch = vi.fn(), events: unknown[] = []
  const host = new AgentHost({
    root: () => app.session.requireUsableRoot(), session: () => app.session.sessionId(), authorize,
    acceptsObject: (p, before, after) => app.session.acceptsObject(p, before, after),
    prepareSource: (input, permit) => app.session.prepareTaskSource({ ...input, sessionId: input.sessionId!, objectVersion: input.objectVersion!, expectedRevision: input.expectedRevision! }, permit!),
    read: p => app.session.read(p),
    write: (p, text, revision, binding) => {
      if (gate.blocksWrite(app.first, p)) throw Error('NOTE_BUSY')
      return app.session.write(p, text, revision, binding!)
    },
    tier: async (root, relPath) => { await beforeTier(); const tier = await modelTierFor(root, relPath); await afterTier(); return tier }, credential: () => grant.credential, limits: () => grant.limits,
    ledger: { prepare: (p, chapter, version, binding) => { if (!binding) throw Error('BAD_REQUEST'); return app.session.ledgerPrepare(p, chapter, version, binding) }, complete: (p, id, revision) => app.session.ledgerComplete(p, id, revision), contexts: p => app.session.ledgerContexts(p) },
    stream: async function* () { dispatch(); streamStarted(); await streamHold; fail = true; yield '完整待保存回答' },
    emit: event => { events.push(event) }
  })
  const input = { ...note, relPath: relPath, expectedRevision: note.revision, range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' }
  const task = await host.start(input)
  void task.done.catch(() => {})
  await started
  const recover = <T>(action: 'preview' | 'commit' | 'resume', run: () => Promise<T>, prepare = async () => true, release = () => {}) => {
    const deps = { host, action, isComplete: (result: T) => !!result && typeof result === 'object' && 'status' in result && result.status === 'complete', assert: () => app.session.assertSession(note.sessionId), quiesce: async () => {}, prepare, drain: () => app.session.idle(), release }
    return gate.recover(app.first, deps, run)
  }
  return { ...app, host, task, input, grant, authorize, dispatch, events, recover, gate,
    repairIO: () => { fail = false }, setBeforeTier: (hook: () => Promise<void>) => { beforeTier = hook }, setAfterTier: (hook: () => Promise<void>) => { afterTier = hook },
    finishPending: async () => { releaseStream(); await expect(task.done).rejects.toThrow(); expect(host.hasPending()).toBe(true); expect(host.active()).toHaveLength(0) }
  }
}

it('blocks active Host work in the production recovery coordinator', async () => {
  const app = await pendingHostRecoveryFixture()
  try {
    await expect(app.recover('resume', async () => 'must not run')).rejects.toThrow('STRUCTURE_BUSY')
  } finally { await app.finishPending(); app.session.dispose() }
})
it('preserves actual Host pending through failed resume, then saves it without a new grant or dispatch', async () => {
  const app = await pendingHostRecoveryFixture()
  try {
    await app.finishPending()
    const status = await app.session.lifecycleStatus(), journal = await readFile(path.join(app.first, '.rgent-lifecycle'), 'utf8')
    expect(JSON.parse(journal).active.kind).toBe('ledger-publication')
    expect(JSON.parse(journal).active.writes[0].receipt).toBeTruthy()
    expect(JSON.parse(journal).active.writes[1].receipt).toBeUndefined()
    await expect(app.host.retryPending()).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
    for (const action of ['preview', 'commit'] as const) await expect(app.recover(action, async () => 'must not rebind')).rejects.toThrow('STRUCTURE_BUSY')
    await expect(app.recover('resume', () => app.session.ledgerRecoveryResume(status.revision!))).rejects.toThrow()
    expect(app.host.hasPending()).toBe(true)
    expect(await readFile(path.join(app.first, '.rgent-lifecycle'), 'utf8')).toBe(journal)
    expect(JSON.stringify(app.events)).toContain('完整待保存回答')
    app.repairIO()
    expect((await app.recover('resume', () => app.session.ledgerRecoveryResume(status.revision!))).status).toBe('complete')
    expect(app.host.hasPending()).toBe(false)
    expect((await app.session.read('原篇.md')).content).toContain('完整待保存回答')
    expect(await app.session.ledgerContexts('原篇.md')).toHaveLength(1)
    expect(app.dispatch).toHaveBeenCalledTimes(1); expect(app.authorize).toHaveBeenCalledTimes(1)
    await expect(app.grant.assertLive('model')).rejects.toThrow()
  } finally { app.session.dispose() }
})
it('waits for an existing Host retry and rejects new retries and launches throughout recovery', async () => {
  const app = await pendingHostRecoveryFixture()
  try {
    await app.finishPending(); app.repairIO()
    const status = await app.session.lifecycleStatus()
    let releaseRetry = () => {}, enteredRetry = () => {}, enteredPrepare = () => {}, releasePrepare = () => {}
    const retryEntered = new Promise<void>(r => { enteredRetry = r }), retryHold = new Promise<void>(r => { releaseRetry = r })
    const prepareEntered = new Promise<void>(r => { enteredPrepare = r }), prepareHold = new Promise<void>(r => { releasePrepare = r })
    app.setBeforeTier(async () => { enteredRetry(); await retryHold })
    const retry = app.host.retryPending(); void retry.catch(() => {})
    let recovered = false, prepared = false
    const recovery = app.recover('resume', async () => { recovered = true; return app.session.ledgerRecoveryResume(status.revision!) }, async () => { prepared = true; enteredPrepare(); await prepareHold; return true })
    await new Promise<void>(r => setImmediate(r))
    expect(prepared).toBe(false); expect(recovered).toBe(false); await retryEntered
    await expect(app.host.retryPending()).rejects.toThrow('STRUCTURE_BUSY')
    await expect(app.host.start(app.input)).rejects.toThrow('STRUCTURE_BUSY')
    releaseRetry(); await expect(retry).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED'); await prepareEntered
    await expect(app.host.retryPending()).rejects.toThrow('STRUCTURE_BUSY')
    releasePrepare(); expect((await recovery).status).toBe('complete')
    await app.host.retryPending(); expect(app.host.hasPending()).toBe(false)
    expect(app.dispatch).toHaveBeenCalledTimes(1); expect(app.authorize).toHaveBeenCalledTimes(1)
  } finally { app.session.dispose() }
})
it.each(['session', 'object', 'permission'] as const)('refuses pending output before any ledger mutation after %s changes', async change => {
  const app = await pendingHostRecoveryFixture()
  try {
    await app.finishPending(); app.repairIO()
    const status = await app.session.lifecycleStatus()
    const hold = vi.spyOn(app.session, 'ledgerPrepare').mockRejectedValue(Error('IO_ERROR'))
    await app.recover('resume', () => app.session.ledgerRecoveryResume(status.revision!))
    hold.mockRestore()
    if (change === 'session') await app.attach(app.second)
    if (change === 'object') { await rename(path.join(app.first, '原篇.md'), path.join(app.first, 'old.md')); await writeFile(path.join(app.first, '原篇.md'), 'replacement') }
    if (change === 'permission') await writeFile(path.join(app.first, '.rgent-permissions'), JSON.stringify({ '原篇.md': 'forbidden' }))
    const prepare = vi.spyOn(app.session, 'ledgerPrepare'), before = await readFile(path.join(app.session.root!, '原篇.md'), 'utf8')
    await expect(app.host.retryPending()).rejects.toThrow()
    expect(prepare).not.toHaveBeenCalled()
    expect(await readFile(path.join(app.session.root!, '原篇.md'), 'utf8')).toBe(before)
    expect(app.host.hasPending()).toBe(true); expect(app.dispatch).toHaveBeenCalledTimes(1); expect(app.authorize).toHaveBeenCalledTimes(1)
  } finally { app.session.dispose() }
})
it('rechecks the session after waiting for an existing retry and releases both recovery gates on failure', async () => {
  const app = await pendingHostRecoveryFixture()
  try {
    await app.finishPending(); app.repairIO()
    let release = () => {}, entered = () => {}, ran = false
    const held = new Promise<void>(r => { release = r }), started = new Promise<void>(r => { entered = r })
    app.setBeforeTier(async () => { entered(); await held })
    const retry = app.host.retryPending(); void retry.catch(() => {}); await started
    const recovery = app.recover('resume', async () => { ran = true }); void recovery.catch(() => {})
    await app.attach(app.second); release()
    await expect(retry).rejects.toThrow()
    await expect(recovery).rejects.toThrow('VAULT_CHANGED')
    expect(ran).toBe(false); expect(app.gate.isBusy()).toBe(false); expect(app.host.hasPending()).toBe(true)
    await expect(app.host.retryPending()).rejects.toThrow('VAULT_CHANGED')
    expect(app.dispatch).toHaveBeenCalledTimes(1); expect(app.authorize).toHaveBeenCalledTimes(1)
  } finally { app.session.dispose() }
})
it('keeps successful journal recovery and visible pending when the subsequent Host save fails', async () => {
  const app = await pendingHostRecoveryFixture()
  try {
    await app.finishPending(); app.repairIO()
    const status = await app.session.lifecycleStatus()
    const save = vi.spyOn(app.session, 'ledgerPrepare').mockRejectedValue(Error('IO_ERROR'))
    expect((await app.recover('resume', () => app.session.ledgerRecoveryResume(status.revision!))).status).toBe('complete')
    expect(save).toHaveBeenCalledTimes(1)
    expect((await app.session.lifecycleStatus()).status).not.toBe('pending')
    expect(app.host.hasPending()).toBe(true); expect(JSON.stringify(app.events)).toContain('完整待保存回答')
    expect(app.dispatch).toHaveBeenCalledTimes(1); expect(app.authorize).toHaveBeenCalledTimes(1)
    save.mockRestore(); await app.host.retryPending(); expect(app.host.hasPending()).toBe(false)
  } finally { app.session.dispose() }
})
it('does not retry old Host output when the session is superseded as recovery gates release', async () => {
  const app = await pendingHostRecoveryFixture()
  try {
    await app.finishPending(); app.repairIO()
    const status = await app.session.lifecycleStatus(), save = vi.spyOn(app.session, 'ledgerPrepare')
    const result = await app.recover('resume', () => app.session.ledgerRecoveryResume(status.revision!), async () => true, () => app.session.dispose())
    expect(result.status).toBe('complete'); expect(save).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(path.join(app.first, '.rgent-lifecycle'), 'utf8')).active).toBeNull()
    expect(app.host.hasPending()).toBe(true); expect(app.dispatch).toHaveBeenCalledTimes(1); expect(app.authorize).toHaveBeenCalledTimes(1)
  } finally { app.session.dispose() }
})


it.each(['forbidden', 'follow', 'hardlink', 'object', 'session'] as const)('rejects old Host output at queued ledger prepare after %s wins the vault queue', async change => {
  const relPath = 'scope/原篇.md', app = await pendingHostRecoveryFixture(relPath)
  let releaseQueue = () => {}
  try {
    await app.finishPending(); app.repairIO()
    const status = await app.session.lifecycleStatus()
    const noSave = vi.spyOn(app.session, 'ledgerPrepare').mockRejectedValue(Error('IO_ERROR'))
    await app.recover('resume', () => app.session.ledgerRecoveryResume(status.revision!)); noSave.mockRestore()
    const fs = secureFsFor(app.first), writes = vi.spyOn(fs, 'replace').mockClear(), before = await readFile(path.join(app.first, relPath), 'utf8')
    let tiers = 0, enteredPrepare = () => {}, changed: Promise<unknown> = Promise.resolve()
    const prepareEntered = new Promise<void>(r => { enteredPrepare = r }), queueHold = new Promise<void>(r => { releaseQueue = r })
    const prepare = app.session.ledgerPrepare.bind(app.session)
    vi.spyOn(app.session, 'ledgerPrepare').mockImplementation((...args) => { const result = prepare(...args); enteredPrepare(); return result })
    app.setAfterTier(async () => {
      // Last Host tier result is already reference; both mutations enter the
      // real VaultMutationQueue before Host queues its ledger prepare.
      if (++tiers !== 2) return
      void app.session.memoryMutation(async () => { await queueHold }).catch(() => {})
      if (change === 'forbidden' || change === 'follow') changed = app.session.setPermission('scope', change)
      else changed = app.session.memoryMutation(async () => {
        if (change === 'hardlink') { await link(path.join(app.first, relPath), path.join(app.first, 'alias.md')); await writeFile(path.join(app.first, '.rgent-permissions'), JSON.stringify({'alias.md':'forbidden'})) }
        else if (change === 'object') { await rename(path.join(app.first, relPath), path.join(app.first, 'old.md')); await writeFile(path.join(app.first, relPath), before) }
        else await app.attach(app.second)
      })
      void changed.catch(() => {})
    })
    const retry = app.host.retryPending(); void retry.catch(() => {}); await prepareEntered
    releaseQueue(); await changed.catch(() => {})
    await expect(retry).rejects.toThrow()
    expect(writes.mock.calls.map(([p]) => p).filter(p => p !== '.rgent-permissions')).toEqual([])
    expect(await readFile(path.join(app.first, relPath), 'utf8')).toBe(before)
    expect(app.host.hasPending()).toBe(true); expect(JSON.stringify(app.events)).toContain('完整待保存回答')
    expect(app.dispatch).toHaveBeenCalledTimes(1); expect(app.authorize).toHaveBeenCalledTimes(1)
    await expect(app.grant.assertLive('model')).rejects.toThrow()
  } finally { releaseQueue(); app.session.dispose() }
})


it.each(['permission', 'invalid-permission', 'grant', 'object', 'revision', 'session'] as const)('rechecks %s synchronously after awaited queued prepare grant validation', async change => {
  const app = await setup()
  try {
    await app.attach(app.first)
    const note = await app.session.read('原篇.md'), grant = await migrationGrant(app.session, '原篇.md')
    const live = grant.assertLive.bind(grant), writes = vi.spyOn(secureFsFor(app.first), 'replace')
    vi.spyOn(grant, 'assertLive').mockImplementation(async (...args) => {
      await live(...args)
      if (change === 'permission') await writeFile(path.join(app.first, '.rgent-permissions'), JSON.stringify({'原篇.md':'forbidden'}))
      if (change === 'invalid-permission') await writeFile(path.join(app.first, '.rgent-permissions'), '{bad')
      if (change === 'grant') grant.revoke()
      if (change === 'object') { await rename(path.join(app.first, '原篇.md'), path.join(app.first, 'old.md')); await writeFile(path.join(app.first, '原篇.md'), note.content) }
      if (change === 'revision') await writeFile(path.join(app.first, '原篇.md'), note.content + '人的新稿')
      if (change === 'session') await app.attach(app.second)
    })
    const errors = {permission:'SOURCE_PERMISSION_CHANGED','invalid-permission':'SOURCE_PERMISSION_CHANGED',grant:'AUTHORIZATION_REVOKED',object:'NOTE_REPLACED',revision:'CONFLICT',session:'VAULT_CHANGED'}
    await expect(app.session.ledgerPrepare('原篇.md', {taskId:'queued-proof',startedAt:new Date().toISOString(),status:'completed',prompt:'问',answer:'旧回答'}, undefined, {...note,root:app.first,expectedRevision:note.revision,grant})).rejects.toThrow(errors[change])
    expect(grant.assertLive).toHaveBeenCalledTimes(1)
    expect(writes.mock.calls.map(([p]) => p)).toEqual([])
    await expect(stat(path.join(app.first, '.rgent', 'registry.json'))).rejects.toMatchObject({code:'ENOENT'})
  } finally { app.session.dispose() }
})


it.each(['forbidden', 'follow'] as const)('passes active checkpoint proof to the real queue and rejects queued %s permission', async tier => {
  const relPath = 'scope/原篇.md', app = await pendingHostRecoveryFixture(relPath)
  try {
    const prepare = app.session.ledgerPrepare.bind(app.session), writes = vi.spyOn(secureFsFor(app.first), 'replace').mockClear()
    let changed: Promise<unknown> = Promise.resolve(), first = true
    const queued = vi.spyOn(app.session, 'ledgerPrepare').mockImplementation((...args) => {
      if (first) {
        first = false
        expect(args[3]).toMatchObject({root:app.first,sessionId:app.input.sessionId,objectVersion:expect.any(String),expectedRevision:expect.any(String),grant:app.grant})
        changed = app.session.setPermission('scope', tier)
        void changed.catch(() => {})
      }
      return prepare(...args)
    })
    await app.finishPending(); await changed
    expect(queued).toHaveBeenCalledTimes(1)
    expect(writes.mock.calls.map(([p]) => p).filter(p => p !== '.rgent-permissions')).toEqual([])
    expect(app.host.hasPending()).toBe(true); expect(JSON.stringify(app.events)).toContain('完整待保存回答')
    expect(app.dispatch).toHaveBeenCalledTimes(1); expect(app.authorize).toHaveBeenCalledTimes(1)
    await expect(app.grant.assertLive('model')).rejects.toThrow()
  } finally { app.session.dispose() }
})


it('rejects an external permission change after queued tier reads without requiring a revoked finalization grant', async () => {
  const app = await setup()
  try {
    await app.attach(app.first)
    const note = await app.session.read('原篇.md'), fs = secureFsFor(app.first), read = fs.readText.bind(fs), writes = vi.spyOn(fs, 'replace')
    let permissionReads = 0
    vi.spyOn(fs, 'readText').mockImplementation(p => {
      try { return read(p) } finally {
        if (p === '.rgent-permissions' && ++permissionReads === 2) queueMicrotask(() => writeFileSync(path.join(app.first, '.rgent-permissions'), JSON.stringify({'原篇.md':'forbidden'})))
      }
    })
    await expect(app.session.ledgerPrepare('原篇.md', {taskId:'final-proof',startedAt:new Date().toISOString(),status:'completed',prompt:'问',answer:'旧回答'}, undefined, {...note,root:app.first,expectedRevision:note.revision})).rejects.toThrow('SOURCE_PERMISSION_CHANGED')
    expect(permissionReads).toBeGreaterThanOrEqual(2)
    expect(writes.mock.calls.map(([p]) => p)).toEqual([])
  } finally { app.session.dispose() }
})
