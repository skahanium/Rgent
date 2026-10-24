import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecureVaultFs, closeSecureFs, secureFsFor } from '../../src/main/secure-fs.ts'
import { TrashStore, TRASH_DIR, TRASH_OPERATIONS_ON_THIS_PLATFORM, TRASH_RETENTION_MS, validTrashMeta } from '../../src/main/trash-store.ts'
import { serializeStoredVault } from '../../src/main/notes-fs.ts'
import { VaultSession } from '../../src/main/vault.ts'

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../../src/main/watch.ts', async importOriginal => ({ ...await importOriginal<typeof import('../../src/main/watch.ts')>(), watchVault: () => () => {} }))

const roots: string[] = []
async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-trash-'))
  roots.push(root)
  await writeFile(path.join(root, 'a.md'), '正文')
  await mkdir(path.join(root, 'a'))
  await writeFile(path.join(root, 'a', '附件.txt'), '附件正文')
  return root
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    closeSecureFs(root)
    await rm(root, { recursive: true, force: true })
  }
})

/** 原生 `trash` 的替身：核身份、真的把对象移走、返回一个假落点。
 *  任何用例都不许把测试库的条目送进真实系统废纸篓。 */
function mockNativeTrash(root: string) {
  const calls: { relPath: string; expectedId: string }[] = []
  const spy = vi.spyOn(SecureVaultFs.prototype, 'trash').mockImplementation((relPath: string, expectedId: string) => {
    const leaf = secureFsFor(root).resolve(relPath).at(-1)
    if (!leaf || leaf.id !== expectedId) throw new Error('PATH_CHANGED')
    calls.push({ relPath, expectedId })
    rmSync(path.join(root, relPath), { recursive: true, force: true })
    return path.join(root, '..', 'os-trash', relPath)
  })
  return { spy, calls }
}

function entryDirs(root: string): Promise<string[]> {
  return readdir(path.join(root, TRASH_DIR)).catch(() => [] as string[])
}

describe('in-vault trash store', () => {
  it('moves a note and its companion folder into the hidden store and lists them', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    const result = store.delete('a.md', { source: 'human' })
    expect(result.meta).toMatchObject({
      version: 1, originalRelPath: 'a.md', kind: 'note', attachmentRelPath: 'a', state: 'trashed', source: 'human'
    })
    expect(result.landing).toBe(`${TRASH_DIR}/${result.meta.trashId}`)
    expect(existsSync(path.join(root, 'a.md'))).toBe(false)
    expect(existsSync(path.join(root, 'a'))).toBe(false)
    // 保持原名：payload 里还是 `a.md` 与 `a/附件.txt`。
    expect(await readFile(path.join(root, TRASH_DIR, result.meta.trashId, 'payload', 'a.md'), 'utf8')).toBe('正文')
    expect(await readFile(path.join(root, TRASH_DIR, result.meta.trashId, 'payload', 'a', '附件.txt'), 'utf8')).toBe('附件正文')
    const meta = JSON.parse(await readFile(path.join(root, TRASH_DIR, result.meta.trashId, 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(meta).sort()).toEqual(['attachmentRelPath', 'bytes', 'contentHash', 'deletedAt', 'kind', 'objectVersion', 'originalRelPath', 'source', 'state', 'trashId', 'version'])

    const listed = store.list()
    expect(listed.entries).toHaveLength(1)
    expect(listed.entries[0]).toMatchObject({
      id: result.meta.trashId, originalRelPath: 'a.md', name: 'a.md', kind: 'note', state: 'ok', source: 'human',
      deletedAt: result.meta.deletedAt
    })
    expect(listed.entries[0]!.expiresAt).toBe(new Date(Date.parse(result.meta.deletedAt) + TRASH_RETENTION_MS).toISOString())
    expect(listed.entries[0]!.bytes).toBe(result.meta.bytes)
    expect(listed.bytes).toBe(result.meta.bytes)
    expect(listed.entries[0]!.bytes).toBeGreaterThan(Buffer.byteLength('正文'))
    // 不再是库里的普通路径：树扫描与笔记读取都到不了。
    expect(secureFsFor(root).list('').some((entry) => entry.name === TRASH_DIR)).toBe(true)
  })

  it('stores an optional permission tier while old meta without it stays readable', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    const result = store.delete('a.md', { source: 'human', permissionTier: 'forbidden' })
    expect(result.meta.permissionTier).toBe('forbidden')
    const raw = JSON.parse(await readFile(path.join(root, TRASH_DIR, result.meta.trashId, 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(raw.permissionTier).toBe('forbidden')
    expect(validTrashMeta(raw)).toBe(true)
    // 旧 meta（没有 permissionTier）仍是有效条目，不因新增可选字段变坏。
    const { permissionTier: _permissionTier, ...legacy } = raw
    expect(validTrashMeta(legacy)).toBe(true)
    await writeFile(path.join(root, TRASH_DIR, result.meta.trashId, 'meta.json'), `${JSON.stringify({ ...legacy, permissionTier: 'unknown' })}\n`)
    expect(store.list().entries[0]).toMatchObject({ id: result.meta.trashId, state: 'damaged' })
  })

  it('restores in place and leaves no entry behind', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    const id = store.delete('a.md', { source: 'human' }).meta.trashId
    const trash = mockNativeTrash(root)
    expect(store.restore(id)).toEqual({ ok: true, relPath: 'a.md', copied: false })
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('正文')
    expect(await readFile(path.join(root, 'a', '附件.txt'), 'utf8')).toBe('附件正文')
    expect(await entryDirs(root)).toEqual([])
    expect(trash.calls).toHaveLength(1)
    expect(trash.calls[0]!.relPath).toBe(`${TRASH_DIR}/${id}`)
    expect(store.list().entries).toEqual([])
  })

  it('accepts a companion folder whose spelling differs only by case', async (ctx) => {
    const root = await vault()
    await writeFile(path.join(root, 'B.md'), '大写正文')
    await mkdir(path.join(root, 'b'))
    await writeFile(path.join(root, 'b', 'x.txt'), '附件')
    let canonical: string | undefined
    try { canonical = secureFsFor(root).resolve('B').at(-1)?.name } catch { canonical = undefined }
    // 大小写敏感文件系统上没有这个别名，跳过（CI 的 macOS／Windows 卷有）。
    if (canonical !== 'b') ctx.skip()
    const store = new TrashStore(root)
    const result = store.delete('B.md', { source: 'human' })
    // 记的是磁盘上的实际名字；校验按「同名」接受，不会被当成坏条目。
    expect(result.meta.attachmentRelPath).toBe('b')
    const listed = store.list()
    expect(listed.entries).toEqual([expect.objectContaining({ id: result.meta.trashId, state: 'ok', originalRelPath: 'B.md' })])
    mockNativeTrash(root)
    expect(store.restore(result.meta.trashId)).toEqual({ ok: true, relPath: 'B.md', copied: false })
    expect(await readFile(path.join(root, 'B.md'), 'utf8')).toBe('大写正文')
    expect(await readFile(path.join(root, 'b', 'x.txt'), 'utf8')).toBe('附件')
  })

  it('restores a copy when the original path is taken, renaming the attachment folder too', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    const id = store.delete('a.md', { source: 'human' }).meta.trashId
    await writeFile(path.join(root, 'a.md'), '新写的')
    await mkdir(path.join(root, 'a'))
    await writeFile(path.join(root, 'a', '新.txt'), '新的附件')
    mockNativeTrash(root)
    expect(store.restore(id)).toEqual({ ok: true, relPath: 'a（恢复）.md', copied: true })
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('新写的')
    expect(await readFile(path.join(root, 'a', '新.txt'), 'utf8')).toBe('新的附件')
    expect(await readFile(path.join(root, 'a（恢复）.md'), 'utf8')).toBe('正文')
    expect(await readFile(path.join(root, 'a（恢复）', '附件.txt'), 'utf8')).toBe('附件正文')
  })

  it('rebuilds a missing parent directory before restoring in place', async () => {
    const root = await vault()
    await mkdir(path.join(root, 'box'))
    await writeFile(path.join(root, 'box', 'b.md'), '盒子里的正文')
    const store = new TrashStore(root)
    const id = store.delete('box/b.md', { source: 'human' }).meta.trashId
    await rm(path.join(root, 'box'), { recursive: true, force: true })
    mockNativeTrash(root)
    expect(store.restore(id)).toEqual({ ok: true, relPath: 'box/b.md', copied: false })
    expect(await readFile(path.join(root, 'box', 'b.md'), 'utf8')).toBe('盒子里的正文')
  })

  it('sends the entry directory to the native trash on explicit purge and keeps it on failure', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    const id = store.delete('a.md', { source: 'human' }).meta.trashId
    const failing = vi.spyOn(SecureVaultFs.prototype, 'trash').mockImplementation(() => { throw new Error('IO_ERROR') })
    expect(store.purge(id)).toEqual({ ok: false, error: 'IO_ERROR' })
    expect(existsSync(path.join(root, TRASH_DIR, id, 'meta.json'))).toBe(true)
    failing.mockRestore()
    const trash = mockNativeTrash(root)
    expect(store.purge(id)).toEqual({ ok: true, removed: true })
    expect(trash.calls[0]!.relPath).toBe(`${TRASH_DIR}/${id}`)
    expect(await entryDirs(root)).toEqual([])
    // 已经不在了：再删一次是幂等的「没有可删的」，不是错误。
    expect(store.purge(id)).toEqual({ ok: true, removed: false })
  })

  it('sweeps entries older than 30 days from the oldest, and leaves fresh ones alone', async () => {
    const root = await vault()
    const old = new TrashStore(root, { now: () => new Date('2026-01-01T00:00:00.000Z') })
    const oldId = old.delete('a.md', { source: 'human' }).meta.trashId
    const fresh = new TrashStore(root, { now: () => new Date('2026-03-01T00:00:00.000Z') })
    await writeFile(path.join(root, 'b.md'), '另一个')
    const freshId = fresh.delete('b.md', { source: 'human' }).meta.trashId
    mockNativeTrash(root)
    const report = fresh.sweep()
    expect(report.purged).toEqual([oldId])
    expect(report.failed).toEqual([])
    expect(await entryDirs(root)).toEqual([freshId])
  })

  it('sweeps the oldest entries until the byte budget fits', async () => {
    const root = await vault()
    const store = new TrashStore(root, { bytesLimit: 20 })
    const first = store.delete('a.md', { source: 'human' }).meta
    await writeFile(path.join(root, 'b.md'), '一二三四')
    const second = store.delete('b.md', { source: 'human' }).meta
    expect(first.bytes + second.bytes).toBeGreaterThan(20)
    mockNativeTrash(root)
    const report = store.sweep()
    expect(report.purged).toEqual([first.trashId])
    expect(report.bytes).toBe(second.bytes)
    expect(await entryDirs(root)).toEqual([second.trashId])
  })

  it('counts damaged entries against the sweep capacity without auto-purging them', async () => {
    const root = await vault()
    const store = new TrashStore(root, { bytesLimit: 40 })
    const damaged = '33333333-3333-3333-3333-333333333333'
    await mkdir(path.join(root, TRASH_DIR, damaged, 'payload'), { recursive: true })
    await writeFile(path.join(root, TRASH_DIR, damaged, 'payload', '残留.bin'), 'x'.repeat(200))
    await writeFile(path.join(root, 'b.md'), 'y'.repeat(200))
    const fresh = store.delete('b.md', { source: 'human' }).meta
    mockNativeTrash(root)
    const report = store.sweep()
    // 半截／损坏条目占用 200 B，已超过 40 B 预算；只清可清的完整条目，不自动送走 damaged。
    expect(report.purged).toEqual([fresh.trashId])
    expect(report.bytes).toBe(200)
    expect(await entryDirs(root)).toEqual([damaged])
  })

  it('keeps unreadable entries as damaged instead of dropping them', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    const good = store.delete('a.md', { source: 'human' }).meta
    // 一个目录坏了 meta（未知字段），一个目录干脆没有 meta：都要出现在列表里。
    const broken = '11111111-1111-1111-1111-111111111111'
    await mkdir(path.join(root, TRASH_DIR, broken, 'payload'), { recursive: true })
    await writeFile(path.join(root, TRASH_DIR, broken, 'payload', 'x.md'), '残留')
    await writeFile(path.join(root, TRASH_DIR, broken, 'meta.json'), JSON.stringify({ ...good, trashId: broken, extra: true }))
    const bare = '22222222-2222-2222-2222-222222222222'
    await mkdir(path.join(root, TRASH_DIR, bare, 'payload'), { recursive: true })
    await writeFile(path.join(root, TRASH_DIR, bare, 'payload', 'y.md'), '没有元数据')
    const listed = store.list()
    expect(listed.entries).toHaveLength(3)
    const damaged = listed.entries.filter((entry) => entry.state === 'damaged')
    expect(damaged.map((entry) => entry.id).sort()).toEqual([bare, broken].sort())
    // meta 读不懂就不再信任其中任何字段（原路径宁可留空），但条目本身仍在列表里。
    for (const entry of damaged) {
      expect(entry.originalRelPath).toBe('')
      expect(entry.name).toBe(entry.id)
    }
    expect(listed.bytes).toBe(good.bytes + Buffer.byteLength('残留') + Buffer.byteLength('没有元数据'))
    // 坏条目不会被自动清理（没有可信的删除时间），但可以明确删除。
    mockNativeTrash(root)
    expect(store.sweep()).toMatchObject({ purged: [] })
    expect(listed.entries.some((entry) => entry.id === good.trashId && entry.state === 'ok')).toBe(true)
    // 不能还原的 damaged 条目仍可整体移入系统废纸篓，不能无路可走。
    expect(store.purge(broken)).toEqual({ ok: true, removed: true })
    expect(existsSync(path.join(root, TRASH_DIR, broken))).toBe(false)
    expect(await entryDirs(root)).toContain(bare)
  })

  it('rolls back every moved object when the journal write fails', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    mockNativeTrash(root)
    expect(() => store.delete('a.md', {
      source: 'ai', taskId: 'task-1', record: () => { throw new Error('JOURNAL_WRITE_FAILED') }
    })).toThrow('TRASH_PARTIAL')
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('正文')
    expect(await readFile(path.join(root, 'a', '附件.txt'), 'utf8')).toBe('附件正文')
    expect(store.list().entries).toEqual([])
    expect(await entryDirs(root)).toEqual([])
  })

  it('keeps the payload and marks the entry damaged when a rollback cannot finish', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    mockNativeTrash(root)
    expect(() => store.delete('a.md', {
      source: 'human',
      record: () => {
        // 回滚前有人占了原路径：笔记回不去，条目必须保留下来而不是被清掉。
        writeFileSync(path.join(root, 'a.md'), '顶替')
        throw new Error('JOURNAL_WRITE_FAILED')
      }
    })).toThrow('TRASH_PARTIAL')
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('顶替')
    const listed = store.list()
    expect(listed.entries).toHaveLength(1)
    expect(listed.entries[0]!.state).toBe('damaged')
    const meta = JSON.parse(await readFile(path.join(root, TRASH_DIR, listed.entries[0]!.id, 'meta.json'), 'utf8')) as { state: string }
    expect(meta.state).toBe('damaged')
    // 载荷还在：绝不因为回滚失败就丢对象。
    expect(await readFile(path.join(root, TRASH_DIR, listed.entries[0]!.id, 'payload', 'a.md'), 'utf8')).toBe('正文')
  })

  it('repairs a half-done moving entry at open time and records the journal line', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    // 手工造一个「已经移进 payload、meta 还是 moving」的半截条目（等同进程在移动后崩掉）。
    const id = store.delete('a.md', { source: 'human' }).meta.trashId
    const metaPath = path.join(root, TRASH_DIR, id, 'meta.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    await writeFile(metaPath, `${JSON.stringify({ ...meta, state: 'moving' })}\n`)
    const report = store.reconcile([])
    expect(report.completed).toEqual([id])
    expect(report.upsert).toHaveLength(1)
    expect(report.upsert[0]).toMatchObject({ trashId: id, relPath: 'a.md' })
    expect(report.damaged).toEqual([])
    expect(store.list().entries[0]).toMatchObject({ id, state: 'ok' })
  })

  it('keeps a half-moved entry damaged when the attachment folder never reached the payload', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    const id = store.delete('a.md', { source: 'human' }).meta.trashId
    // 模拟「笔记已搬进 payload、附件夹还没搬」时进程退出：夹子仍在原路径，payload 只有笔记。
    await rename(path.join(root, TRASH_DIR, id, 'payload', 'a'), path.join(root, 'a'))
    const metaPath = path.join(root, TRASH_DIR, id, 'meta.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    await writeFile(metaPath, `${JSON.stringify({ ...meta, state: 'moving' })}\n`)

    const report = store.reconcile([])
    expect(report.completed).toEqual([])
    expect(report.upsert).toEqual([])
    expect(report.damaged).toEqual([id])
    expect(report.issues).toContain(`attachment-missing:${id}`)
    const listed = store.list()
    expect(listed.entries[0]).toMatchObject({ id, state: 'damaged', bytes: Buffer.byteLength('正文') })
    expect(listed.bytes).toBe(Buffer.byteLength('正文'))
    expect(JSON.parse(await readFile(metaPath, 'utf8')).state).toBe('damaged')
    // 附件夹还在原路径：对账没有把它搬进 payload，也没有当成完整删除。
    expect(await readFile(path.join(root, 'a', '附件.txt'), 'utf8')).toBe('附件正文')
  })

  it('rolls a moving entry back when the object never left the original path', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    const id = store.delete('a.md', { source: 'human' }).meta.trashId
    // 还原到「移动没发生」的样子：载荷原样搬回原位（保留 inode）、meta 停在 moving。
    await rename(path.join(root, TRASH_DIR, id, 'payload', 'a.md'), path.join(root, 'a.md'))
    await rename(path.join(root, TRASH_DIR, id, 'payload', 'a'), path.join(root, 'a'))
    mockNativeTrash(root)
    const metaPath = path.join(root, TRASH_DIR, id, 'meta.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    await writeFile(metaPath, `${JSON.stringify({ ...meta, state: 'moving' })}\n`)
    const report = store.reconcile([{ trashId: id, relPath: 'a.md', objectVersion: String(meta.objectVersion), contentHash: String(meta.contentHash), at: String(meta.deletedAt) }])
    expect(report.rolledBack).toEqual([id])
    expect(report.remove).toEqual([id])
    expect(report.damaged).toEqual([])
    expect(await entryDirs(root)).toEqual([])
  })

  it('returns the attachment folder when only the note rolled back', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    const meta = store.delete('a.md', { source: 'human' }).meta
    // 笔记回到原位、附件夹仍留在 payload：这是回滚中断的半截状态。
    await rename(path.join(root, TRASH_DIR, meta.trashId, 'payload', 'a.md'), path.join(root, 'a.md'))
    const metaPath = path.join(root, TRASH_DIR, meta.trashId, 'meta.json')
    const moving = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    await writeFile(metaPath, `${JSON.stringify({ ...moving, state: 'moving' })}\n`)
    mockNativeTrash(root)
    const report = store.reconcile([{ trashId: meta.trashId, relPath: 'a.md', objectVersion: meta.objectVersion, contentHash: meta.contentHash, at: meta.deletedAt }])
    expect(report.rolledBack).toEqual([meta.trashId])
    expect(report.remove).toEqual([meta.trashId])
    expect(report.damaged).toEqual([])
    expect(await readFile(path.join(root, 'a', '附件.txt'), 'utf8')).toBe('附件正文')
    expect(await entryDirs(root)).toEqual([])
  })

  it('returns the attachment folder when a restore stopped after moving the note back', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    const meta = store.delete('a.md', { source: 'human' }).meta
    await rename(path.join(root, TRASH_DIR, meta.trashId, 'payload', 'a.md'), path.join(root, 'a.md'))
    mockNativeTrash(root)
    const report = store.reconcile([{ trashId: meta.trashId, relPath: 'a.md', objectVersion: meta.objectVersion, contentHash: meta.contentHash, at: meta.deletedAt }])
    expect(report.restored).toEqual([meta.trashId])
    expect(report.remove).toEqual([meta.trashId])
    expect(report.damaged).toEqual([])
    expect(await readFile(path.join(root, 'a', '附件.txt'), 'utf8')).toBe('附件正文')
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('正文')
    expect(await entryDirs(root)).toEqual([])
  })

  it('reports journal entries whose directory is gone without dropping them', async () => {
    const root = await vault()
    const store = new TrashStore(root)
    const id = store.delete('a.md', { source: 'human' }).meta.trashId
    mockNativeTrash(root)
    expect(store.purge(id)).toEqual({ ok: true, removed: true })
    const record = { trashId: id, relPath: 'a.md', objectVersion: '1:1', contentHash: 'a'.repeat(64), at: '2026-10-01T00:00:00.000Z' }
    const report = store.reconcile([record])
    expect(report.missingEntries).toEqual([id])
    expect(report.remove).toEqual([])
    const listed = store.list([record])
    expect(listed.entries).toEqual([expect.objectContaining({ id, state: 'damaged', originalRelPath: 'a.md' })])
  })
})

describe('in-vault trash through the session queue', () => {
  async function session() {
    const base = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-trash-session-'))
    roots.push(base)
    const root = path.join(base, 'vault')
    await mkdir(root)
    await writeFile(path.join(root, '原篇.md'), 'first')
    await writeFile(path.join(base, 'vault.json'), serializeStoredVault(root))
    const emit = vi.fn()
    const vaultSession = new VaultSession(base, emit)
    vaultSession.restore()
    return { base, root, vaultSession, emit }
  }

  it('settles two concurrent deletes of the same note with one winner', async () => {
    if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) return
    const { root, vaultSession } = await session()
    try {
      const [first, second] = await Promise.all([
        vaultSession.trashDelete('原篇.md'), vaultSession.trashDelete('原篇.md')
      ])
      expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
      const failed = [first, second].find((result) => !result.ok)
      expect(failed).toMatchObject({ ok: false })
      expect(await entryDirs(root)).toHaveLength(1)
      const listed = await vaultSession.trashList()
      if (!listed.ok) throw new Error(listed.error)
      expect(listed.entries).toHaveLength(1)
    } finally { vaultSession.dispose() }
  })
})
