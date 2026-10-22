import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { it, expect, vi } from 'vitest'
import { VaultSession } from '../../src/main/vault.ts'
import { VaultLifecycle } from '../../src/main/vault-lifecycle.ts'
import { WorkingMemoryService } from '../../src/main/working-memory-service.ts'
import { serializeStoredVault } from '../../src/main/notes-fs.ts'
import { markPrompt, upsertAiAnswer } from '../../src/main/host-source.ts'
import { vaultRootIdentity } from '../../src/main/watch.ts'
import { IPC } from '../../src/shared/ipc.ts'
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../../src/main/watch.ts', async importOriginal => ({ ...await importOriginal<typeof import('../../src/main/watch.ts')>(), watchVault: () => () => {} }))

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** 登记一篇带同名附件夹的笔记，供外部消失与恢复核验使用。 */
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rgent-recovery-'))
  const root = path.join(base, 'vault')
  await mkdir(root)
  await writeFile(path.join(base, 'vault.json'), serializeStoredVault(root))
  await mkdir(path.join(root, 'a'))
  await writeFile(path.join(root, 'a', '附件.txt'), '附件正文')
  const marked = markPrompt('/以后用中文', { taskId: 'task', range: { start: 0, end: 6 }, expectedText: '/以后用中文', promptText: '以后用中文' })
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
  return { base, root, stash, vault, binding: { sessionId: note.sessionId, objectVersion: note.objectVersion }, content: note.content }
}

/** 外部消失：等价 Finder 把对象移出库根（保留原对象本身，便于原样放回）。 */
async function moveOut(root: string, stash: string, relPath: string): Promise<void> {
  const target = path.join(stash, relPath.replaceAll('/', '__'))
  await rename(path.join(root, relPath), target)
}
async function moveBack(root: string, stash: string, relPath: string): Promise<void> {
  await rename(path.join(stash, relPath.replaceAll('/', '__')), path.join(root, relPath))
}
async function journal(root: string): Promise<{ version: number; active: unknown; missing?: unknown[]; retired?: unknown[] }> {
  return JSON.parse(await readFile(path.join(root, '.rgent-lifecycle'), 'utf8'))
}

it('registers an external disappearance as a lifecycle record reusing the existing identity, hash and attachment evidence', async () => {
  const f = await fixture()
  try {
    const before = await f.vault.recoveryScan()
    expect(before.rows).toEqual([])
    await moveOut(f.root, f.stash, 'a.md')
    const status = await f.vault.noteStatus('a.md', f.binding)
    expect(status.status).toBe('missing')
    const scan = await f.vault.recoveryScan()
    expect(scan.sessionId).toBe(f.binding.sessionId)
    expect(scan.rows.map(row => row.relPath)).toEqual(['a.md'])
    expect(scan.rows[0]!.verdict).toBe('still-missing')
    expect(scan.rows[0]!.canRestore).toBe(false)
    const record = await journal(f.root)
    expect(record.version).toBe(1)
    expect(record.active).toBeNull()
    expect(record.missing).toHaveLength(1)
    const entry = record.missing![0] as Record<string, unknown>
    expect(entry.relPath).toBe('a.md')
    expect(entry.bodyRevision).toBe(hash(f.content))
    expect(entry.permissionTier).toBe('reference')
    expect(entry.objectVersion).toBe(f.binding.objectVersion)
    expect(entry.attachments).toEqual([
      { relPath: 'a', kind: 'dir' },
      { relPath: 'a/附件.txt', kind: 'file', hash: hash('附件正文') }
    ])
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('keeps the default create path reserved and the sources invalid but never forgotten', async () => {
  const f = await fixture()
  try {
    const service = new WorkingMemoryService(f.vault, () => null)
    const source = await service.sourceForPrompt('a.md', 'task')
    const entry = await f.vault.memoryMutation(store => store.add(store.read(), {
      content: '以后用中文', layer: 'core', scope: '本库', sources: [source], semantic: 'standing', attribution: '人', reviewAt: null
    }))
    expect(await service.verifySource(source)).toBe(true)
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    expect(await service.verifySource(source)).toBe(false)
    const paused = (await service.entries()).find(item => item.id === entry.id)
    expect(paused?.status).toBe('paused')
    expect(paused?.reason).toBe('MEMORY_SOURCE_CHANGED')
    expect(f.vault.memorySnapshot().record.entries.some(item => item.id === entry.id)).toBe(true)
    await expect(f.vault.write('a.md', '草稿', hash(f.content), f.binding)).rejects.toThrow()
    // 默认入口（无 humanInitiated 标记）行为不变：消失记录占着路径就拒，不重建。
    await expect(f.vault.create('a')).rejects.toThrow('PATH_RESERVED')
    expect(await readdir(f.root)).toEqual(expect.arrayContaining(['a']))
    expect((await readdir(f.root)).filter(name => name === 'a.md')).toEqual([])
    // 合同变更（有意）：人确认预览的「建」不再拒；它先退休旧记录再创建（详细断言见「建」放行用例）。
    expect((await f.vault.createWithContent('a', '', '新正文')).relPath).toBe('a.md')
    expect((await journal(f.root)).missing ?? []).toEqual([])
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('lets a person recreate the same path, retiring the old record and leaving no recovery row', async () => {
  const f = await fixture()
  try {
    const service = new WorkingMemoryService(f.vault, () => null)
    const source = await service.sourceForPrompt('a.md', 'task')
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    expect(await service.verifySource(source)).toBe(false)
    // 人在原路径新建同名笔记：成功、不弹确认、旧记录退休而不是继续占着路径。
    expect(await f.vault.create('a', '', { humanInitiated: true })).toBe('a.md')
    const record = await journal(f.root)
    expect(record.missing ?? []).toEqual([])
    expect(record.retired).toHaveLength(1)
    expect(record.retired![0]).toMatchObject({ relPath: 'a.md', reason: 'recreated' })
    expect(Number.isFinite(Date.parse((record.retired![0] as { retiredAt: string }).retiredAt))).toBe(true)
    const retired = new VaultLifecycle(f.root).retiredObjects()
    expect(retired.map(item => item.relPath)).toEqual(['a.md'])
    expect(retired[0]!.reason).toBe('recreated')
    // 新对象是全新身份：可读可写，重扫不再把它列成待恢复。
    const note = await f.vault.read('a.md')
    expect(note.content).toBe('')
    expect(await f.vault.write('a.md', '新正文', note.revision)).toMatch(/^[a-f0-9]{64}$/)
    expect((await f.vault.read('a.md')).content).toBe('新正文')
    expect((await f.vault.recoveryScan()).rows).toEqual([])
    // 旧来源不因新对象出现而复活。
    expect(await service.verifySource(source)).toBe(false)
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('lets the confirmed create tool recreate the path and still refuses the old object', async () => {
  const f = await fixture()
  try {
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    const created = await f.vault.createWithContent('a', '', '新正文')
    expect(created.relPath).toBe('a.md')
    expect(created.revision).toBe(hash('新正文'))
    expect((await journal(f.root)).missing ?? []).toEqual([])
    const retired = new VaultLifecycle(f.root).retiredObjects()
    expect(retired).toHaveLength(1)
    expect(retired[0]).toMatchObject({ relPath: 'a.md', reason: 'recreated' })
    expect((await f.vault.recoveryScan()).rows).toEqual([])
    expect((await f.vault.read('a.md')).content).toBe('新正文')
    // 旧对象回来不静默覆盖：旧正文写回磁盘后，旧 binding 与旧 revision 都不再被接受。
    await writeFile(path.join(f.root, 'a.md'), f.content)
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('replaced')
    await expect(f.vault.write('a.md', '旧草稿', hash(f.content), f.binding)).rejects.toThrow('NOTE_REPLACED')
    expect(await readFile(path.join(f.root, 'a.md'), 'utf8')).toBe(f.content)
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('lets a person create a folder that owns the vanished note name and retires its record', async () => {
  const f = await fixture()
  try {
    await rm(path.join(f.root, 'a'), { recursive: true })
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    // 同名附件夹与 `a.md` 是同一条记录；人新建文件夹同样退休它（默认入口两条都拒，见上一条用例）。
    expect(await f.vault.createFolder('a', '', { humanInitiated: true })).toBe('a')
    expect(await readdir(f.root)).toContain('a')
    const record = await journal(f.root)
    expect(record.missing ?? []).toEqual([])
    expect(record.retired).toHaveLength(1)
    expect(record.retired![0]).toMatchObject({ relPath: 'a.md', reason: 'recreated' })
    expect(new VaultLifecycle(f.root).retiredObjects().map(item => item.relPath)).toEqual(['a.md'])
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('keeps a retired identity out of recovery rows across repeated scans', async () => {
  const f = await fixture()
  try {
    await rm(path.join(f.root, 'a'), { recursive: true })
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    expect(await f.vault.createFolder('a', '', { humanInitiated: true })).toBe('a')
    // 人已放弃这条旧身份（原笔记文件确实仍不在）：重扫不许把同版本的消失记录再造回活跃列表，
    // 否则每次重扫都把已放弃的记录恢复成活跃死路，退休等于白做。
    expect((await f.vault.recoveryScan()).rows).toEqual([])
    expect((await f.vault.recoveryScan()).rows).toEqual([])
    const record = await journal(f.root)
    expect(record.missing ?? []).toEqual([])
    expect(record.retired).toHaveLength(1)
    expect(record.retired![0]).toMatchObject({ relPath: 'a.md', objectVersion: f.binding.objectVersion, reason: 'recreated' })
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('still records a disappeared identity that is not the retired one', async () => {
  const f = await fixture()
  try {
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    // 人重建同名笔记：旧身份（f.binding 的版本）退休，a.md 现在是一个新对象。
    const created = await f.vault.createWithContent('a', '', '新正文')
    expect(created.relPath).toBe('a.md')
    // 旧对象被登记到另一个路径，旧 owner 随身份让位；新对象随后被任务登记（owner 版本=新对象）。
    await rename(path.join(f.stash, 'a.md'), path.join(f.root, 'old.md'))
    await f.vault.ledgerPrepare('old.md', { taskId: 'task-old', startedAt: new Date().toISOString(), status: 'completed', prompt: '旧对象', answer: '已登记' })
    await f.vault.ledgerPrepare('a.md', { taskId: 'task-new', startedAt: new Date().toISOString(), status: 'completed', prompt: '新对象', answer: '已登记' })
    // 新身份再次移出库外：版本与退休记录不同，仍按外部消失登记（抑制只对旧身份）。
    await moveOut(f.root, f.stash, 'a.md')
    await expect(f.vault.read('a.md')).rejects.toThrow('NOTE_MISSING')
    const record = await journal(f.root)
    expect(record.missing).toHaveLength(1)
    expect((record.missing![0] as Record<string, unknown>).objectVersion).toBe(created.objectVersion)
    expect(record.retired).toHaveLength(1)
    expect((record.retired![0] as Record<string, unknown>).objectVersion).toBe(f.binding.objectVersion)
    expect((await f.vault.recoveryScan()).rows.map(row => row.relPath)).toContain('a.md')
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('rolls the retirement back when the create fails, keeping the record active', async () => {
  const f = await fixture()
  try {
    const record = {
      relPath: 'gone/a.md', noteId: 'note-gone', objectVersion: 'obj-gone', bodyRevision: hash('gone'),
      attachments: [], rootIdentity: vaultRootIdentity(f.root), permissionTier: 'reference' as const,
      detectedAt: '2026-10-22T00:00:00.000Z', cause: 'external' as const
    }
    await writeFile(path.join(f.root, '.rgent-lifecycle'), JSON.stringify({ version: 1, active: null, missing: [record] }))
    // 父目录不存在：退休成功之后创建必然失败，回滚必须把记录放回活跃列表。
    await expect(f.vault.create('a', 'gone', { humanInitiated: true })).rejects.toThrow()
    const after = await journal(f.root)
    expect(after.missing).toHaveLength(1)
    expect((after.missing![0] as Record<string, unknown>).relPath).toBe('gone/a.md')
    expect(after.retired ?? []).toEqual([])
    expect(new VaultLifecycle(f.root).retiredObjects()).toEqual([])
    await expect(f.vault.createWithContent('a', 'gone', '新正文')).rejects.toThrow()
    expect((await journal(f.root)).missing).toHaveLength(1)
    expect((await journal(f.root)).retired ?? []).toEqual([])
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('restores the object and its sources only after the recorded content, attachments and tier all verify', async () => {
  const f = await fixture()
  try {
    const service = new WorkingMemoryService(f.vault, () => null)
    const source = await service.sourceForPrompt('a.md', 'task')
    const entry = await f.vault.memoryMutation(store => store.add(store.read(), {
      content: '以后用中文', layer: 'core', scope: '本库', sources: [source], semantic: 'standing', attribution: '人', reviewAt: null
    }))
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    expect(await service.verifySource(source)).toBe(false)
    await moveBack(f.root, f.stash, 'a.md')
    const scan = await f.vault.recoveryScan()
    expect(scan.rows).toHaveLength(1)
    expect(scan.rows[0]!.verdict).toBe('restored')
    expect(scan.rows[0]!.canRestore).toBe(true)
    const confirmed = await f.vault.recoveryConfirm('a.md')
    expect(confirmed.restored).toBe(true)
    expect((await journal(f.root)).missing ?? []).toEqual([])
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('ready')
    expect(await service.verifySource(source)).toBe(true)
    expect((await service.entries()).find(item => item.id === entry.id)?.status).toBe('active')
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('keeps the object and its sources invalid when the restored content no longer matches the record', async () => {
  const f = await fixture()
  try {
    const service = new WorkingMemoryService(f.vault, () => null)
    const source = await service.sourceForPrompt('a.md', 'task')
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    await writeFile(path.join(f.stash, 'a.md'), `${f.content}\n外部加了一行`)
    await moveBack(f.root, f.stash, 'a.md')
    const scan = await f.vault.recoveryScan()
    expect(scan.rows[0]!.verdict).toBe('content-changed')
    expect(scan.rows[0]!.canRestore).toBe(false)
    const confirmed = await f.vault.recoveryConfirm('a.md')
    expect(confirmed.restored).toBe(false)
    expect((await journal(f.root)).missing).toHaveLength(1)
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('unreadable')
    expect(await service.verifySource(source)).toBe(false)
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('reports a missing attachment folder as degraded instead of passing the verification', async () => {
  const f = await fixture()
  try {
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    await rm(path.join(f.root, 'a'), { recursive: true })
    await moveBack(f.root, f.stash, 'a.md')
    const scan = await f.vault.recoveryScan()
    expect(scan.rows[0]!.verdict).toBe('attachments-missing')
    expect(scan.rows[0]!.canRestore).toBe(false)
    expect((await f.vault.recoveryConfirm('a.md')).restored).toBe(false)
    expect((await journal(f.root)).missing).toHaveLength(1)
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('refuses identity inheritance when the same path holds a different object with the same bytes', async () => {
  const f = await fixture()
  try {
    const service = new WorkingMemoryService(f.vault, () => null)
    const source = await service.sourceForPrompt('a.md', 'task')
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    await writeFile(path.join(f.root, 'a.md'), f.content)
    const scan = await f.vault.recoveryScan()
    expect(scan.rows[0]!.verdict).toBe('object-replaced')
    expect(scan.rows[0]!.canRestore).toBe(false)
    expect((await f.vault.recoveryConfirm('a.md')).restored).toBe(false)
    expect(await service.verifySource(source)).toBe(false)
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('keeps the disappearance record across an unrelated structural operation', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.root, 'b.md'), '另一篇正文')
    await f.vault.ledgerMigrateBatch(null)
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    const preview = await f.vault.previewRelocation({ kind: 'note', source: 'b.md', target: 'c.md' })
    await f.vault.commitRelocation(preview.id, false)
    expect((await f.vault.read('c.md')).content).toBe('另一篇正文')
    expect((await journal(f.root)).missing).toHaveLength(1)
    const scan = await f.vault.recoveryScan()
    expect(scan.rows.map(row => row.relPath)).toEqual(['a.md'])
    expect(scan.rows[0]!.verdict).toBe('still-missing')
    await expect(f.vault.create('a')).rejects.toThrow('PATH_RESERVED')
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('keeps an in-place but unverified object unavailable to reads, not only to status', async () => {
  const f = await fixture()
  try {
    const service = new WorkingMemoryService(f.vault, () => null)
    const source = await service.sourceForPrompt('a.md', 'task')
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    await rm(path.join(f.root, 'a'), { recursive: true })
    await moveBack(f.root, f.stash, 'a.md')
    // 同 inode 原位放回（verdict 的首个判据是对象身份，走到 attachments-missing 就证明身份没换），
    // 但附件夹仍缺、核验未过：读必须与 noteStatus 同判，不能靠身份相同短路。
    const scan = await f.vault.recoveryScan()
    expect(scan.rows[0]!.verdict).toBe('attachments-missing')
    expect(scan.rows[0]!.canRestore).toBe(false)
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('unreadable')
    await expect(f.vault.read('a.md')).rejects.toThrow('NOTE_UNREADABLE')
    await expect(f.vault.readOpened('a.md')).rejects.toThrow('NOTE_UNREADABLE')
    expect(await service.verifySource(source)).toBe(false)
    expect((await journal(f.root)).missing).toHaveLength(1)
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('keeps the disappearance record when another note publishes a ledger chapter', async () => {
  const f = await fixture()
  try {
    // 另一篇笔记先登记身份；账本发布写的是同一本 `.rgent-lifecycle`，与被消失的对象无关。
    await writeFile(path.join(f.root, 'b.md'), '另一篇正文')
    await f.vault.ledgerMigrateBatch(null)
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    await moveBack(f.root, f.stash, 'a.md')
    // 账本发布路径：新任务 prepare 走 publish() → recoverLedgerPublication，一路整篇重写
    // `.rgent-lifecycle`（写入计划、每条回执、active:null 三次）。它不认识的键（missing）必须原样留下。
    await f.vault.ledgerPrepare('b.md', { taskId: 'task-b', startedAt: new Date().toISOString(), status: 'completed', prompt: '另一问', answer: '另一答' })
    expect((await f.vault.ledgerRecord('b.md', 'task-b')).taskId).toBe('task-b')
    const after = await journal(f.root)
    expect(after.active).toBeNull()
    expect(after.missing).toHaveLength(1)
    expect((after.missing![0] as Record<string, unknown>).objectVersion).toBe(f.binding.objectVersion)
    expect((await f.vault.recoveryScan()).rows.map(row => row.relPath)).toEqual(['a.md'])
    await expect(f.vault.create('a')).rejects.toThrow('PATH_RESERVED')
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('refuses a new folder that would occupy the attachment identity of a disappeared note', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.root, 'b.md'), '另一篇正文')
    await f.vault.ledgerMigrateBatch(null)
    const note = await f.vault.read('b.md')
    await moveOut(f.root, f.stash, 'b.md')
    expect((await f.vault.noteStatus('b.md', note)).status).toBe('missing')
    expect((await journal(f.root)).missing).toHaveLength(1)
    // 同名附件夹也是被保留的身份：新建文件夹会占住它，恢复从此卡在 attachments-changed/missing。
    await expect(f.vault.createFolder('b')).rejects.toThrow('PATH_RESERVED')
    expect(await readdir(f.root)).not.toContain('b')
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('keeps PATH_RESERVED after the missing-record limit swallows a later disappearance', async () => {
  const f = await fixture()
  try {
    const filled = Array.from({ length: 64 }, (_, i) => ({
      relPath: `filler-${String(i).padStart(2, '0')}.md`,
      noteId: `note-${String(i).padStart(2, '0')}`,
      objectVersion: `obj-${String(i).padStart(2, '0')}`,
      bodyRevision: hash(`filler-${i}`),
      attachments: [] as const,
      rootIdentity: vaultRootIdentity(f.root),
      permissionTier: 'reference' as const,
      detectedAt: '2026-10-15T00:00:00.000Z'
    }))
    await writeFile(path.join(f.root, '.rgent-lifecycle'), JSON.stringify({ version: 1, active: null, missing: filled }))
    await moveOut(f.root, f.stash, 'a.md')
    expect((await f.vault.noteStatus('a.md', f.binding)).status).toBe('missing')
    expect((await journal(f.root)).missing).toHaveLength(64)
    await expect(f.vault.create('a')).rejects.toThrow('PATH_RESERVED')
    // 合同变更（有意）：记录没能落盘（超限，只留在内存 reservedMissing），没有可退休的证据可移；
    // 「建」仍拒，但改为如实上报恢复中断，而不是把无记录的路径当成 PATH_RESERVED。
    await expect(f.vault.createWithContent('a', '', '新正文')).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
    expect((await journal(f.root)).missing).toHaveLength(64)
    expect((await journal(f.root)).retired ?? []).toEqual([])
    await expect(f.vault.write('a.md', '草稿', hash(f.content), f.binding)).rejects.toThrow()
    expect(await readdir(f.root)).toEqual(expect.arrayContaining(['a']))
    expect((await readdir(f.root)).filter(name => name === 'a.md')).toEqual([])
  } finally { f.vault.dispose(); await rm(f.base, { recursive: true, force: true }) }
})

it('does not name TRASH_GATE_OPEN and does not give the model a trash IPC', async () => {
  const files = await readdir(path.join(process.cwd(), 'src'), { recursive: true, withFileTypes: true })
  for (const file of files) {
    if (!file.isFile()) continue
    const text = await readFile(path.join(file.parentPath, file.name), 'utf8')
    expect(text).not.toContain('TRASH_GATE_OPEN')
  }
  expect(IPC.noteTrashPreview).toBe('note:trash-preview')
  expect(IPC.noteTrashCommit).toBe('note:trash-commit')
  expect(Object.values(IPC).some((value) => /agent:.*trash|tool:.*delete/i.test(String(value)))).toBe(false)
})
