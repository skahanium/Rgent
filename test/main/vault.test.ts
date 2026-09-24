import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNote, listVaultTree, parseStoredVault, readNote, serializeStoredVault, writeNote } from '../../src/main/notes-fs.ts'
import { resolveInVault, sanitizeNoteName } from '../../src/main/paths.ts'
import { collectNotePaths } from '../../src/renderer/src/tree.ts'

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
    await writeNote(root, rel, '正文')
    expect(await readNote(root, rel)).toBe('正文')
    await expect(createNote(root, '初稿')).rejects.toThrow(/同名/)
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
})

function flatten(entries: { relPath: string; children?: unknown[] }[]): { relPath: string }[] {
  const out: { relPath: string }[] = []
  for (const entry of entries) {
    out.push(entry)
    if (entry.children) out.push(...flatten(entry.children as { relPath: string; children?: unknown[] }[]))
  }
  return out
}
