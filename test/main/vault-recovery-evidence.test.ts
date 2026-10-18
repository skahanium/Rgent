import { createHash } from 'node:crypto'
import { sameRootInode } from '../../src/main/vault-catalog.ts'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultSession } from '../../src/main/vault.ts'
import { serializeStoredVault } from '../../src/main/notes-fs.ts'
import { markPrompt, upsertAiAnswer } from '../../src/main/host-source.ts'
import { vaultRootIdentity } from '../../src/main/watch.ts'
import { HUMAN_TRASH_ON_THIS_PLATFORM } from '../../src/shared/human-trash.ts'
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../../src/main/watch.ts', async importOriginal => ({ ...await importOriginal<typeof import('../../src/main/watch.ts')>(), watchVault: () => () => {} }))

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

async function journal(root: string): Promise<{ version: number; active: unknown; missing?: Record<string, unknown>[] }> {
  return JSON.parse(await readFile(path.join(root, '.rgent-lifecycle'), 'utf8'))
}

/** 把系统废纸篓里的落点原样放回：同一文件系统用 rename 保住 inode，跨卷才退回复制。 */
async function putBack(landing: string, target: string): Promise<void> {
  try { await rename(landing, target) }
  catch (error) {
    if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === 'EXDEV')) throw error
    await copyFile(landing, target)
    await rm(landing)
  }
}

async function emptyVault() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rgent-recovery-evidence-'))
  const root = path.join(base, 'vault')
  await mkdir(root)
  await writeFile(path.join(base, 'vault.json'), serializeStoredVault(root))
  const vault = new VaultSession(base, vi.fn())
  vault.restore()
  return { base, root, vault }
}

/** 登记一篇带同名附件夹的笔记（与既有恢复夹具同形），供删除/放回使用。 */
async function registeredVault() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rgent-recovery-evidence-'))
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
  return { base, root, vault, note }
}

/** 权限只能设在文件夹上：在 `box/` 里登记一篇笔记，再把整个文件夹设为 forbidden。 */
async function folderRegisteredVault() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rgent-recovery-evidence-'))
  const root = path.join(base, 'vault')
  await mkdir(root)
  await mkdir(path.join(root, 'box'))
  await writeFile(path.join(base, 'vault.json'), serializeStoredVault(root))
  const marked = markPrompt('/问', { taskId: 'task', range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
  await writeFile(path.join(root, 'box', 'b.md'), marked)
  const vault = new VaultSession(base, vi.fn())
  vault.restore()
  let note = await vault.readOpened('box/b.md')
  await vault.ledgerPrepare('box/b.md', { taskId: 'task', startedAt: new Date().toISOString(), status: 'completed', prompt: '问', answer: '答' })
  const saved = await vault.write('box/b.md', upsertAiAnswer(note.content, { taskId: 'task', answer: '答' }), note.revision, note)
  await vault.ledgerComplete('box/b.md', 'task', saved.revision)
  note = await vault.read('box/b.md')
  return { base, root, vault, note }
}

describe('recovery evidence and identity', () => {
  const bases: string[] = []
  const landings: string[] = []
  afterEach(async () => {
    for (const landing of landings.splice(0)) await rm(landing, { recursive: true, force: true }).catch(() => {})
    for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true }).catch(() => {})
  })

  it('restores an unregistered note after a human trash round trip and releases the path', async () => {
    if (!HUMAN_TRASH_ON_THIS_PLATFORM) return
    const f = await emptyVault()
    bases.push(f.base)
    const relPath = '未登记.md'
    try {
      await writeFile(path.join(f.root, relPath), '从未做过 / 发起篇的正文\n')
      const preview = await f.vault.previewTrash(relPath)
      const result = await f.vault.commitTrash(preview.id, true)
      expect(result.cancelled).toBe(false)
      landings.push(result.landing)
      const record = (await journal(f.root)).missing![0]!
      expect(record.cause).toBe('trash')
      await expect(f.vault.create('未登记')).rejects.toThrow('PATH_RESERVED')
      await putBack(result.landing, path.join(f.root, relPath))

      const scan = await f.vault.recoveryScan()
      expect(scan.rows).toHaveLength(1)
      expect(scan.rows[0]).toMatchObject({ relPath, verdict: 'restored', canRestore: true, canAbandon: true })
      expect((await f.vault.recoveryScan()).rows[0]!.message).not.toContain('账本登记')
      const confirmed = await f.vault.recoveryConfirm(relPath)
      expect(confirmed.restored).toBe(true)
      expect((await journal(f.root)).missing ?? []).toEqual([])

      // 记录清除后同名不再被保留：把恢复后的对象挪开，同名可以重新建。
      await rename(path.join(f.root, relPath), path.join(f.base, 'restored.md'))
      await expect(f.vault.createWithContent('未登记', '', '新的同名笔记')).resolves.toMatchObject({ relPath })
    } finally { f.vault.dispose() }
  })

  it('uses the attachment evidence captured at deletion instead of a stale owner snapshot', async () => {
    if (!HUMAN_TRASH_ON_THIS_PLATFORM) return
    const f = await registeredVault()
    bases.push(f.base)
    try {
      // 上一次登记之后只往附件夹里加文件，不保存笔记：owner 的附件证据已经过期。
      await writeFile(path.join(f.root, 'a', '删除前新增.txt'), '晚到的附件')
      const preview = await f.vault.previewTrash('a.md')
      const result = await f.vault.commitTrash(preview.id, true)
      expect(result.cancelled).toBe(false)
      landings.push(result.landing)
      expect(result.attachmentLanding).toBeTruthy()
      landings.push(result.attachmentLanding!)
      await putBack(result.landing, path.join(f.root, 'a.md'))
      await putBack(result.attachmentLanding!, path.join(f.root, 'a'))

      const scan = await f.vault.recoveryScan()
      expect(scan.rows[0]).toMatchObject({ relPath: 'a.md', verdict: 'restored', canRestore: true })
      expect((await f.vault.recoveryConfirm('a.md')).restored).toBe(true)
      expect((await journal(f.root)).missing ?? []).toEqual([])
    } finally { f.vault.dispose() }
  })

  it('tolerates a remounted volume when the inode and content still match the record', async () => {
    const f = await emptyVault()
    bases.push(f.base)
    const relPath = 'r.md'
    try {
      const content = '重挂载前后内容相同\n'
      await writeFile(path.join(f.root, relPath), content)
      // 身份必须取自产品的对象身份（POSIX 十进制、Windows 十六进制），不能用 Node 的 dev/ino 硬造。
      const opened = await f.vault.readOpened(relPath)
      const identity = opened.objectVersion
      const cut = identity.indexOf(':')
      const device = identity.slice(0, cut), inode = identity.slice(cut + 1)
      const bumped = /^\d+$/.test(device)
        ? String(Number(device) + 1)
        : (device[0] === 'f' ? 'e' : 'f') + device.slice(1)
      const remounted = `${bumped}:${inode}`
      await writeFile(path.join(f.root, '.rgent-lifecycle'), JSON.stringify({
        version: 1, active: null,
        missing: [{
          relPath, noteId: 'remount-note', objectVersion: remounted, bodyRevision: hash(content), attachments: [],
          rootIdentity: vaultRootIdentity(f.root), permissionTier: 'reference', detectedAt: '2026-10-18T00:00:00.000Z', cause: 'external'
        }]
      }))
      // 同一 inode、不同设备号在两种平台格式下都要被认成同一对象（Windows 是十六进制身份）。
      expect(sameRootInode(identity, remounted)).toBe(true)
      expect(sameRootInode('0123456789abcdef:' + 'a'.repeat(32), 'fedcba9876543210:' + 'a'.repeat(32))).toBe(true)
      expect(sameRootInode('16777232:1', '16777232:2')).toBe(false)
      const scan = await f.vault.recoveryScan()
      expect(scan.rows[0]!.verdict).not.toBe('object-replaced')
      expect(scan.rows[0]).toMatchObject({ verdict: 'restored', canRestore: true })
      expect((await f.vault.recoveryConfirm(relPath)).restored).toBe(true)
      expect((await f.vault.read(relPath)).content).toBe(content)
    } finally { f.vault.dispose() }
  })

  it('lets a forbidden note be deleted and restored while saying AI still cannot use it', async () => {
    if (!HUMAN_TRASH_ON_THIS_PLATFORM) return
    const f = await folderRegisteredVault()
    bases.push(f.base)
    try {
      await f.vault.setPermission('box', 'forbidden')
      const preview = await f.vault.previewTrash('box/b.md')
      const result = await f.vault.commitTrash(preview.id, true)
      expect(result.cancelled).toBe(false)
      landings.push(result.landing)
      expect(result.attachmentLanding).toBeNull()
      await putBack(result.landing, path.join(f.root, 'box', 'b.md'))

      const scan = await f.vault.recoveryScan()
      expect(['restored', 'permission-changed']).toContain(scan.rows[0]!.verdict)
      expect(scan.rows[0]!.canRestore).toBe(true)
      expect(scan.rows[0]!.message).toContain('AI')
      expect(scan.rows[0]!.message).toContain('禁止')
      const confirmed = await f.vault.recoveryConfirm('box/b.md')
      expect(confirmed.restored).toBe(true)
      expect(confirmed.message).toContain('AI')
      expect((await journal(f.root)).missing ?? []).toEqual([])
    } finally { f.vault.dispose() }
  })

  it('reports an unreadable permission list as permission-unreadable and recovers after it is repaired', async () => {
    const f = await registeredVault()
    bases.push(f.base)
    const stash = path.join(f.base, 'stash')
    await mkdir(stash)
    try {
      await rename(path.join(f.root, 'a.md'), path.join(stash, 'a.md'))
      expect((await f.vault.noteStatus('a.md', { sessionId: f.note.sessionId, objectVersion: f.note.objectVersion })).status).toBe('missing')
      await rename(path.join(stash, 'a.md'), path.join(f.root, 'a.md'))
      expect((await journal(f.root)).missing![0]!.cause).toBe('external')

      await writeFile(path.join(f.root, '.rgent-permissions'), '{ 这不是 JSON')
      const blocked = await f.vault.recoveryScan()
      expect(blocked.rows[0]).toMatchObject({ verdict: 'permission-unreadable', canRestore: false, canAbandon: true })
      expect((await f.vault.recoveryConfirm('a.md')).restored).toBe(false)

      await writeFile(path.join(f.root, '.rgent-permissions'), '{}\n')
      const repaired = await f.vault.recoveryScan()
      expect(repaired.rows[0]).toMatchObject({ verdict: 'restored', canRestore: true })
      expect((await f.vault.recoveryConfirm('a.md')).restored).toBe(true)
      expect((await journal(f.root)).missing ?? []).toEqual([])
    } finally { f.vault.dispose() }
  })

  it('reports a changed permission tier as restorable permission-changed and restores under the current tier', async () => {
    const f = await folderRegisteredVault()
    bases.push(f.base)
    const stash = path.join(f.base, 'stash')
    await mkdir(stash)
    try {
      await rename(path.join(f.root, 'box', 'b.md'), path.join(stash, 'b.md'))
      expect((await f.vault.noteStatus('box/b.md', { sessionId: f.note.sessionId, objectVersion: f.note.objectVersion })).status).toBe('missing')
      await f.vault.setPermission('box', 'forbidden')
      await rename(path.join(stash, 'b.md'), path.join(f.root, 'box', 'b.md'))
      const scan = await f.vault.recoveryScan()
      expect(scan.rows[0]).toMatchObject({ verdict: 'permission-changed', canRestore: true, canAbandon: true })
      expect(scan.rows[0]!.message).toContain('现行档')
      expect(scan.rows[0]!.message).toContain('AI')
      expect((await f.vault.recoveryConfirm('box/b.md')).restored).toBe(true)
      expect((await journal(f.root)).missing ?? []).toEqual([])
    } finally { f.vault.dispose() }
  })

  it('skips the tier comparison when the disappearance record could not read permissions', async () => {
    const f = await registeredVault()
    bases.push(f.base)
    const stash = path.join(f.base, 'stash')
    await mkdir(stash)
    try {
      await writeFile(path.join(f.root, '.rgent-permissions'), '{ 坏名单')
      await rename(path.join(f.root, 'a.md'), path.join(stash, 'a.md'))
      expect((await f.vault.noteStatus('a.md', { sessionId: f.note.sessionId, objectVersion: f.note.objectVersion })).status).toBe('missing')
      expect((await journal(f.root)).missing![0]).toMatchObject({ permissionTier: 'unknown', cause: 'external' })
      await writeFile(path.join(f.root, '.rgent-permissions'), '{}\n')
      await rename(path.join(stash, 'a.md'), path.join(f.root, 'a.md'))
      const scan = await f.vault.recoveryScan()
      expect(scan.rows[0]).toMatchObject({ verdict: 'restored', canRestore: true })
      expect(scan.rows[0]!.message).toContain('未知')
      expect((await f.vault.recoveryConfirm('a.md')).restored).toBe(true)
    } finally { f.vault.dispose() }
  })

  it('keeps owner and deletion record contradictions as ledger-unverified', async () => {
    const f = await registeredVault()
    bases.push(f.base)
    const stash = path.join(f.base, 'stash')
    await mkdir(stash)
    try {
      await rename(path.join(f.root, 'a.md'), path.join(stash, 'a.md'))
      expect((await f.vault.noteStatus('a.md', { sessionId: f.note.sessionId, objectVersion: f.note.objectVersion })).status).toBe('missing')
      await rename(path.join(stash, 'a.md'), path.join(f.root, 'a.md'))
      const ledgers = path.join(f.root, '.rgent', 'ledgers')
      const ownerId = (await readdir(ledgers)).find(name => name !== '.DS_Store')!
      const ownerPath = path.join(ledgers, ownerId, 'owner.json')
      const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Record<string, unknown>
      owner.bodyRevision = hash('与删除记录矛盾')
      await writeFile(ownerPath, JSON.stringify(owner))

      const scan = await f.vault.recoveryScan()
      expect(scan.rows[0]).toMatchObject({ verdict: 'ledger-unverified', canRestore: false })
      expect((await f.vault.recoveryConfirm('a.md')).restored).toBe(false)
      expect((await journal(f.root)).missing).toHaveLength(1)
    } finally { f.vault.dispose() }
  })

  it('reads an older journal entry without cause as an external disappearance', async () => {
    const f = await emptyVault()
    bases.push(f.base)
    const relPath = 'old.md'
    try {
      const content = '旧 journal 的正文\n'
      await writeFile(path.join(f.root, relPath), content)
      const identity = (await f.vault.readOpened(relPath)).objectVersion
      await writeFile(path.join(f.root, '.rgent-lifecycle'), JSON.stringify({
        version: 1, active: null,
        missing: [{
          relPath, noteId: 'old-note', objectVersion: identity, bodyRevision: hash(content), attachments: [],
          rootIdentity: vaultRootIdentity(f.root), permissionTier: 'reference', detectedAt: '2026-10-17T00:00:00.000Z'
        }]
      }))
      const scan = await f.vault.recoveryScan()
      expect(scan.rows[0]).toMatchObject({ relPath, verdict: 'restored', canRestore: true })
      expect((await f.vault.recoveryConfirm(relPath)).restored).toBe(true)
    } finally { f.vault.dispose() }
  })
})
