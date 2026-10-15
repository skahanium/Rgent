import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { it, expect, vi } from 'vitest'
import { VaultSession } from '../../src/main/vault.ts'
import { WorkingMemoryService } from '../../src/main/working-memory-service.ts'
import { serializeStoredVault } from '../../src/main/notes-fs.ts'
import { markPrompt, upsertAiAnswer } from '../../src/main/host-source.ts'
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
async function journal(root: string): Promise<{ version: number; active: unknown; missing?: unknown[] }> {
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

it('fails closed for the disappeared object: no rebuild of the path, sources invalid but never forgotten', async () => {
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
    await expect(f.vault.create('a')).rejects.toThrow('PATH_RESERVED')
    await expect(f.vault.createWithContent('a', '', '新正文')).rejects.toThrow('PATH_RESERVED')
    expect(await readdir(f.root)).toEqual(expect.arrayContaining(['a']))
    expect((await readdir(f.root)).filter(name => name === 'a.md')).toEqual([])
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

it('shows no deletion entry anywhere while the trash gate stays shut', async () => {
  // 设备级模型密钥的删除不属于笔记库删除入口；这里禁的是库内对象与废纸篓的任何入口。
  const channels = Object.entries(IPC).filter(([key, value]) => /trash/i.test(`${key} ${value}`) || /^(note|folder|tree|vault|lifecycle|ledger):.*(delete|remove|trash)/i.test(String(value)))
  expect(channels).toEqual([])
  const files = await readdir(path.join(process.cwd(), 'src'), { recursive: true, withFileTypes: true })
  for (const file of files) {
    if (!file.isFile()) continue
    const text = await readFile(path.join(file.parentPath, file.name), 'utf8')
    expect(text).not.toContain('TRASH_GATE_OPEN')
  }
})
