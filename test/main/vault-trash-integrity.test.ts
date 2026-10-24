import { existsSync, rmSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecureVaultFs, closeSecureFs, secureFsFor } from '../../src/main/secure-fs.ts'
import { serializeStoredVault } from '../../src/main/notes-fs.ts'
import * as permissions from '../../src/main/permissions.ts'
import { tierFor } from '../../src/main/permissions.ts'
import { TRASH_DIR, TRASH_OPERATIONS_ON_THIS_PLATFORM } from '../../src/main/trash-store.ts'
import { LedgerStore } from '../../src/main/ledger-store.ts'
import { vaultRootIdentity } from '../../src/main/watch.ts'
import { VaultSession } from '../../src/main/vault.ts'

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../../src/main/watch.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/main/watch.ts')>(),
  watchVault: (_root: string, callback: (relPath: string | null) => void) => {
    watched.push(callback)
    return () => {}
  }
}))
const watched: ((relPath: string | null) => void)[] = []

const roots: string[] = []
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 原生 trash 替身：核身份后真移走，任何用例都不碰真实系统废纸篓。 */
function mockNativeTrash(root: string): void {
  vi.spyOn(SecureVaultFs.prototype, 'trash').mockImplementation((relPath: string, expectedId: string) => {
    const leaf = secureFsFor(root).resolve(relPath).at(-1)
    if (!leaf || leaf.id !== expectedId) throw new Error('PATH_CHANGED')
    rmSync(path.join(root, relPath), { recursive: true, force: true })
    return path.join(root, '..', 'os-trash', relPath)
  })
}

async function fixture(tier: 'reference' | 'follow' | 'forbidden' = 'forbidden') {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rgent-trash-integrity-'))
  roots.push(base)
  const root = path.join(base, 'vault')
  await mkdir(path.join(root, 'box'), { recursive: true })
  await writeFile(path.join(root, 'box', 'b.md'), '正文')
  await writeFile(path.join(base, 'vault.json'), serializeStoredVault(root))
  const emit = vi.fn()
  const vault = new VaultSession(base, emit)
  vault.restore()
  await vault.setPermission('box', tier)
  return { base, root, vault, emit }
}

async function deleteBoxNote(vault: VaultSession): Promise<string> {
  const result = await vault.trashDelete('box/b.md')
  if (!result.ok) throw new Error(result.error)
  return result.trashId!
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    closeSecureFs(root)
    await rm(root, { recursive: true, force: true })
  }
  watched.length = 0
})

describe('in-vault trash integrity', () => {
  it('restores in place with the deleted permission tier intact', async () => {
    if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) return
    const f = await fixture('forbidden')
    mockNativeTrash(f.root)
    try {
      const id = await deleteBoxNote(f.vault)
      const meta = JSON.parse(await readFile(path.join(f.root, TRASH_DIR, id, 'meta.json'), 'utf8')) as { permissionTier?: string }
      expect(meta.permissionTier).toBe('forbidden')

      const restored = await f.vault.trashRestore(id)
      if (!restored.ok) throw new Error(restored.error)
      expect(restored).toMatchObject({ relPath: 'box/b.md', copied: false })
      expect(restored.permission).toBeUndefined()
      expect(await readFile(path.join(f.root, 'box', 'b.md'), 'utf8')).toBe('正文')
      const permissions = await f.vault.permissions()
      expect(permissions.status).toBe('ready')
      if (permissions.status !== 'ready') return
      expect(tierFor('box/b.md', permissions.entries)).toBe('forbidden')
    } finally { f.vault.dispose() }
  })

  it('writes the original tier to the restored copy when the old rule is gone', async () => {
    if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) return
    const f = await fixture('forbidden')
    mockNativeTrash(f.root)
    try {
      const id = await deleteBoxNote(f.vault)
      // 原路径被新人占住；同时旧规则被删掉（只在测试夹具里直接动名单，产品写入仍走 setPermission）。
      await writeFile(path.join(f.root, 'box', 'b.md'), '新人')
      await writeFile(path.join(f.root, '.rgent-permissions'), '{}\n')

      const restored = await f.vault.trashRestore(id)
      if (!restored.ok) throw new Error(restored.error)
      expect(restored).toMatchObject({ relPath: 'box/b（恢复）.md', copied: true })
      expect(restored.permission).toEqual({
        original: 'forbidden', current: 'forbidden', outcome: 'restored', rulePath: 'box/b（恢复）.md'
      })
      expect(await readFile(path.join(f.root, 'box', 'b（恢复）.md'), 'utf8')).toBe('正文')
      const permissions = await f.vault.permissions()
      if (permissions.status !== 'ready') throw new Error(permissions.error)
      expect(tierFor('box/b（恢复）.md', permissions.entries)).toBe('forbidden')
      // 新人在原路径写的那篇没有被覆盖。
      expect(await readFile(path.join(f.root, 'box', 'b.md'), 'utf8')).toBe('新人')
    } finally { f.vault.dispose() }
  })

  it('keeps a tier a person set during deletion and reports it instead of overwriting', async () => {
    if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) return
    const f = await fixture('forbidden')
    mockNativeTrash(f.root)
    try {
      const id = await deleteBoxNote(f.vault)
      await f.vault.setPermission('box', 'follow')

      const restored = await f.vault.trashRestore(id)
      if (!restored.ok) throw new Error(restored.error)
      expect(restored.permission).toEqual({ original: 'forbidden', current: 'follow', outcome: 'kept-new' })
      const permissions = await f.vault.permissions()
      if (permissions.status !== 'ready') throw new Error(permissions.error)
      // 保留新人的档，没有静默降回原档。
      expect(tierFor('box/b.md', permissions.entries)).toBe('follow')
      expect(await readFile(path.join(f.root, 'box', 'b.md'), 'utf8')).toBe('正文')
    } finally { f.vault.dispose() }
  })

  it('keeps the restored file when writing the original permission tier fails', async () => {
    if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) return
    const f = await fixture('forbidden')
    mockNativeTrash(f.root)
    try {
      const id = await deleteBoxNote(f.vault)
      await writeFile(path.join(f.root, '.rgent-permissions'), '{}\n')
      vi.spyOn(permissions, 'setPermissionFile').mockRejectedValueOnce(new Error('IO_ERROR'))

      const restored = await f.vault.trashRestore(id)
      if (!restored.ok) throw new Error(restored.error)
      expect(restored.permission).toMatchObject({ outcome: 'unavailable', error: 'IO_ERROR', original: 'forbidden' })
      // 权限写失败不撤已还原的文件，也不留下半截名单写入。
      expect(await readFile(path.join(f.root, 'box', 'b.md'), 'utf8')).toBe('正文')
      expect(await readFile(path.join(f.root, '.rgent-permissions'), 'utf8')).toBe('{}\n')
    } finally { f.vault.dispose() }
  })

  it('does not invent a permission tier for a legacy meta without one', async () => {
    if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) return
    const f = await fixture('forbidden')
    mockNativeTrash(f.root)
    try {
      const id = await deleteBoxNote(f.vault)
      const metaPath = path.join(f.root, TRASH_DIR, id, 'meta.json')
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
      delete meta.permissionTier
      await writeFile(metaPath, `${JSON.stringify(meta)}\n`)
      await f.vault.setPermission('box', 'follow')

      const restored = await f.vault.trashRestore(id)
      if (!restored.ok) throw new Error(restored.error)
      expect(restored.permission).toBeUndefined()
      const permissions = await f.vault.permissions()
      if (permissions.status !== 'ready') throw new Error(permissions.error)
      expect(tierFor('box/b.md', permissions.entries)).toBe('follow')
    } finally { f.vault.dispose() }
  })

  it('suppresses external-change only while a trashed path stays missing, then notifies for a new object', async () => {
    if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) return
    const f = await fixture()
    mockNativeTrash(f.root)
    try {
      await f.vault.read('box/b.md')
      const id = await deleteBoxNote(f.vault)
      expect(id).toMatch(/^[a-f0-9-]{36}$/)
      f.emit.mockClear()
      const callback = watched.at(-1)!
      callback('box/b.md')
      await sleep(140)
      expect(f.emit).not.toHaveBeenCalledWith('note:external-change', expect.objectContaining({ relPath: 'box/b.md' }))

      await writeFile(path.join(f.root, 'box', 'b.md'), '原路径的新对象')
      callback('box/b.md')
      await sleep(140)
      expect(f.emit).toHaveBeenCalledWith('note:external-change', expect.objectContaining({ relPath: 'box/b.md' }))
      expect(existsSync(path.join(f.root, 'box', 'b.md'))).toBe(true)

      // 已经通知过的新对象再消失：旧删除记录不能继续把它吞掉，开着的 tab 必须先知道。
      f.emit.mockClear()
      await rm(path.join(f.root, 'box', 'b.md'), { force: true })
      callback('box/b.md')
      await sleep(140)
      expect(f.emit).toHaveBeenCalledWith('note:external-change', expect.objectContaining({ relPath: 'box/b.md', state: 'missing' }))
    } finally { f.vault.dispose() }
  })

  it('archives the old owner on delete and lets a same-name new note start fresh', async () => {
    if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) return
    const f = await fixture('reference')
    mockNativeTrash(f.root)
    try {
      const ledger = new LedgerStore(secureFsFor(f.root), () => {}, undefined, () => vaultRootIdentity(f.root))
      const old = ledger.owner('box/b.md')
      const id = await deleteBoxNote(f.vault)
      expect(ledger.historyEntryForTrash(id)).toMatchObject({ state: 'trashed', noteId: old.noteId })
      expect(await readFile(path.join(f.root, '.rgent', 'ledger-history', old.noteId, 'owner.json'), 'utf8')).toContain(old.noteId)

      await writeFile(path.join(f.root, 'box', 'b.md'), '新正文')
      expect((await f.vault.readOpened('box/b.md')).ledger?.status).toBe('unregistered')
      expect(await f.vault.ledgerContexts('box/b.md')).toEqual([])
      const replacement = ledger.owner('box/b.md')
      expect(replacement.noteId).not.toBe(old.noteId)
      expect(ledger.historyEntryForTrash(id)?.noteId).toBe(old.noteId)
    } finally { f.vault.dispose() }
  })


  it('lists and restores the archived ledger with the deleted note', async () => {
    if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) return
    const f = await fixture('reference')
    mockNativeTrash(f.root)
    try {
      const ledger = new LedgerStore(secureFsFor(f.root), () => {}, undefined, () => vaultRootIdentity(f.root))
      const old = ledger.owner('box/b.md')
      const id = await deleteBoxNote(f.vault)
      const listed = await f.vault.trashList()
      if (!listed.ok) throw new Error(listed.error)
      expect(listed.entries.find(entry => entry.id === id)?.hasLedger).toBe(true)
      expect(ledger.historyPage(id).ownership).toBe('verified')

      const restored = await f.vault.trashRestore(id)
      if (!restored.ok) throw new Error(restored.error)
      expect(restored).toMatchObject({ relPath: 'box/b.md', copied: false })
      expect((await f.vault.readOpened('box/b.md')).ledger?.status).toBe('verified')
      expect(ledger.historyEntryForTrash(id)).toBeNull()
      expect(ledger.owner('box/b.md').noteId).toBe(old.noteId)
    } finally { f.vault.dispose() }
  })

  it('restores archived history to a copy when the original path is occupied', async () => {
    if (!TRASH_OPERATIONS_ON_THIS_PLATFORM) return
    const f = await fixture('reference')
    mockNativeTrash(f.root)
    try {
      const ledger = new LedgerStore(secureFsFor(f.root), () => {}, undefined, () => vaultRootIdentity(f.root))
      const old = ledger.owner('box/b.md')
      const id = await deleteBoxNote(f.vault)
      await writeFile(path.join(f.root, 'box', 'b.md'), '新笔记')
      const restored = await f.vault.trashRestore(id)
      if (!restored.ok) throw new Error(restored.error)
      expect(restored).toMatchObject({ copied: true, relPath: 'box/b（恢复）.md' })
      expect((await f.vault.readOpened('box/b（恢复）.md')).ledger?.status).toBe('verified')
      expect((await f.vault.readOpened('box/b.md')).ledger?.status).toBe('unregistered')
      expect(ledger.owner('box/b（恢复）.md').noteId).toBe(old.noteId)
    } finally { f.vault.dispose() }
  })

})
