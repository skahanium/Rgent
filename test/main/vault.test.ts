import { chmod, symlink, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNote, listVaultTree, parseStoredVault, readNote, readNoteSnapshot, serializeStoredVault, writeNote } from '../../src/main/notes-fs.ts'
import { isVaultImagePath, readVaultMedia, resolveInVault, sanitizeNoteName, vaultMediaPath } from '../../src/main/paths.ts'
import { collectNotePaths, collectRelPaths } from '../../src/renderer/src/tree.ts'
import { joinVaultRel, parseVaultMediaUrl, vaultMediaUrl } from '../../src/shared/vault-rel.ts'

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
    await expect(createNote(root, '初稿')).rejects.toThrow(/同名/)
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

  it('does not treat symlinked notes or directories as vault notes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-vault-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'rgent-out-'))
    await writeFile(path.join(outside, 'secret.md'), '库外秘密', 'utf8')
    await symlink(path.join(outside, 'secret.md'), path.join(root, 'link.md'))
    await symlink(outside, path.join(root, 'linked-dir'))
    const tree = await listVaultTree(root)
    expect(tree.find((item) => item.name === 'link.md')?.kind).toBe('file')
    expect(tree.find((item) => item.name === 'linked-dir')?.kind).toBe('file')
    await expect(readNote(root, 'link.md')).rejects.toThrow(/符号链接/)
    await expect(readNote(root, 'linked-dir/secret.md')).rejects.toThrow(/符号链接/)
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
