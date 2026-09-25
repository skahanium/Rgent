import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadPermissions, modelTierFor, setPermission, tierFor } from '../../src/main/permissions.ts'
import { listVaultTree, readNoteSnapshot, writeNote } from '../../src/main/notes-fs.ts'
import { VaultIndex } from '../../src/main/vault-index.ts'
import { SecureVaultFs } from '../../src/main/secure-fs.ts'

const file = (root: string) => path.join(root, '.rgent-permissions')

describe('permission policy', () => {
  it('defaults to reference only when the list is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-policy-'))
    expect(await loadPermissions(root)).toEqual({ status: 'ready', entries: [] })
    expect(tierFor('a.md', [])).toBe('reference')
  })

  it('treats damaged or unreadable existing lists as invalid without altering them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-policy-'))
    await mkdir(path.join(root, '工作'))
    await writeFile(path.join(root, '工作', 'a.md'), '人可搜', 'utf8')
    await writeFile(file(root), '{broken', 'utf8')
    expect((await loadPermissions(root)).status).toBe('invalid')
    await expect(modelTierFor(root, '工作/a.md')).rejects.toThrow('PERMISSIONS_INVALID')
    const index = new VaultIndex(() => root, () => listVaultTree(root))
    expect(await index.search('人可搜')).toHaveLength(1)
    const snapshot = await readNoteSnapshot(root, '工作/a.md')
    await writeNote(root, '工作/a.md', '人可写', snapshot.revision)
    expect((await readNoteSnapshot(root, '工作/a.md')).content).toBe('人可写')
    await expect(setPermission(root, '工作', 'forbidden')).rejects.toThrow('PERMISSIONS_INVALID')
    expect(await readFile(file(root), 'utf8')).toBe('{broken')
    await writeFile(file(root), JSON.stringify({ '../outside': 'forbidden' }), 'utf8')
    expect((await loadPermissions(root)).status).toBe('invalid')
    await writeFile(file(root), JSON.stringify({ 工作: 'unknown' }), 'utf8')
    expect((await loadPermissions(root)).status).toBe('invalid')
  })

  it('uses the most specific direct rule and applies note rules to same-name attachments', () => {
    const entries = [
      { relPath: '工作', tier: 'forbidden' as const },
      { relPath: '工作/公开.md', tier: 'reference' as const },
      { relPath: '工作/公开/图片', tier: 'follow' as const },
      { relPath: '工作/公开', tier: 'reference' as const }
    ]
    expect(tierFor('工作/秘密.md', entries)).toBe('forbidden')
    expect(tierFor('工作/公开.md', entries)).toBe('reference')
    expect(tierFor('工作/公开/a.png', entries)).toBe('reference')
    expect(tierFor('工作/公开/图片/a.png', entries)).toBe('follow')
    expect(tierFor('工作/公开.md/a.png', entries)).toBe('forbidden')
    expect(tierFor('工作/公开的.md', entries)).toBe('forbidden')
  })

  it('does not apply a folder rule to its same-name note', () => {
    const entries = [{ relPath: '工作/X', tier: 'forbidden' as const }]
    expect(tierFor('工作/X.md', entries)).toBe('reference')
    expect(tierFor('工作/X/a.png', entries)).toBe('forbidden')
  })

  it('prefers a direct folder rule over a same-length rule derived from its note', () => {
    const entries = [
      { relPath: '工作/X', tier: 'follow' as const },
      { relPath: '工作/X.md', tier: 'forbidden' as const }
    ]
    expect(tierFor('工作/X/a.png', entries)).toBe('follow')
    expect(tierFor('工作/X.md', entries)).toBe('forbidden')
    expect(tierFor('工作/X/a.png', [...entries].reverse())).toBe('follow')
  })

  it('writes folder rules atomically, reloads external edits, and leaves human search intact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-policy-'))
    await mkdir(path.join(root, '工作'))
    await writeFile(path.join(root, '工作', 'a.md'), '禁区词', 'utf8')
    const saved = await setPermission(root, '工作', 'forbidden')
    expect(saved.status).toBe('ready')
    expect(tierFor('工作/a.md', saved.status === 'ready' ? saved.entries : [])).toBe('forbidden')
    const index = new VaultIndex(() => root, () => listVaultTree(root))
    expect(await index.search('禁区词')).toHaveLength(1)
    await writeFile(file(root), JSON.stringify({ 工作: 'follow' }), 'utf8')
    const reloaded = await loadPermissions(root)
    expect(reloaded.status).toBe('ready')
    expect(tierFor('工作/a.md', reloaded.status === 'ready' ? reloaded.entries : [])).toBe('follow')
    expect(await modelTierFor(root, '工作/a.md')).toBe('follow')
    await writeFile(file(root), JSON.stringify({ 工作: 'forbidden' }), 'utf8')
    await expect(modelTierFor(root, '工作/a.md')).rejects.toThrow('FORBIDDEN')
  })

  it('rejects symlinked folders and permission files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-policy-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'rgent-out-'))
    await symlink(outside, path.join(root, 'link'))
    await expect(setPermission(root, 'link', 'forbidden')).rejects.toThrow(/符号链接/)
    await symlink(path.join(outside, 'other'), file(root))
    expect((await loadPermissions(root)).status).toBe('invalid')
  })

  it('does not lose a rule when two folder changes arrive together', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-policy-'))
    await mkdir(path.join(root, '甲'))
    await mkdir(path.join(root, '乙'))
    await Promise.all([
      setPermission(root, '甲', 'forbidden'),
      setPermission(root, '乙', 'follow')
    ])
    const state = await loadPermissions(root)
    expect(state.status).toBe('ready')
    if (state.status !== 'ready') return
    expect(tierFor('甲/a.md', state.entries)).toBe('forbidden')
    expect(tierFor('乙/a.md', state.entries)).toBe('follow')
  })

  it('does not overwrite an external list edit between reading and committing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-policy-'))
    await mkdir(path.join(root, '工作'))
    await writeFile(file(root), JSON.stringify({ 工作: 'forbidden' }), 'utf8')
    const original = SecureVaultFs.prototype.readText
    let changed = false
    const spy = vi.spyOn(SecureVaultFs.prototype, 'readText').mockImplementation(function (this: SecureVaultFs, relPath) {
      const value = original.call(this, relPath)
      if (relPath === '.rgent-permissions' && !changed) {
        changed = true
        writeFileSync(file(root), '{broken', 'utf8')
      }
      return value
    })
    try {
      await expect(setPermission(root, '工作', 'follow')).rejects.toThrow()
      expect(await readFile(file(root), 'utf8')).toBe('{broken')
    } finally {
      spy.mockRestore()
    }
  })

  it('does not weaken a folder rule through a real filesystem case alias', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-policy-'))
    await mkdir(path.join(root, 'Secret'))
    await writeFile(path.join(root, 'Secret', 'a.md'), 'secret', 'utf8')
    await writeFile(file(root), JSON.stringify({ Secret: 'forbidden' }), 'utf8')
    const alias = path.join(root, 'secret', 'a.md')
    const same = await stat(alias).then(async (info) => {
      const original = await stat(path.join(root, 'Secret', 'a.md'))
      return info.dev === original.dev && info.ino === original.ino
    }).catch(() => false)
    if (!same) return // case-sensitive volume: these are distinct paths
    await expect(modelTierFor(root, 'secret/a.md')).rejects.toThrow('FORBIDDEN')
  })

  it('carries a note rule to a differently cased same-name attachment folder', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-policy-'))
    await writeFile(path.join(root, 'X.md'), 'note', 'utf8')
    await mkdir(path.join(root, 'x'))
    await writeFile(path.join(root, 'x', 'pic.png'), 'image', 'utf8')
    await writeFile(file(root), JSON.stringify({ 'X.md': 'forbidden' }), 'utf8')
    const sameFolder = await stat(path.join(root, 'X')).then(async (info) => {
      const actual = await stat(path.join(root, 'x'))
      return info.dev === actual.dev && info.ino === actual.ino
    }).catch(() => false)
    if (!sameFolder) return
    await expect(modelTierFor(root, 'x/pic.png')).rejects.toThrow('FORBIDDEN')
  })

  it('uses a Unicode alias only when the filesystem resolves it to the same folder', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-policy-'))
    const composed = 'Caf\u00e9'
    const decomposed = 'Cafe\u0301'
    await mkdir(path.join(root, composed))
    await writeFile(path.join(root, composed, 'a.md'), 'note', 'utf8')
    await writeFile(file(root), JSON.stringify({ [composed]: 'forbidden' }), 'utf8')
    const same = await stat(path.join(root, decomposed)).then(async (info) => {
      const actual = await stat(path.join(root, composed))
      return info.dev === actual.dev && info.ino === actual.ino
    }).catch(() => false)
    if (!same) return
    await expect(modelTierFor(root, `${decomposed}/a.md`)).rejects.toThrow('FORBIDDEN')
  })
})
