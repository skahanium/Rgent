import { chmod, stat, symlink, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultSession } from '../../src/main/vault.ts'
import { VaultLifecycle } from '../../src/main/vault-lifecycle.ts'
import { watchVault } from '../../src/main/watch.ts'
import * as notesFs from '../../src/main/notes-fs.ts'
import { createFolder, createNote, listVaultTree, parseStoredVault, readNote, readNoteSnapshot, serializeStoredVault, writeNote } from '../../src/main/notes-fs.ts'
import { isVaultImagePath, readVaultMedia, resolveInVault, sanitizeNoteName, vaultMediaPath } from '../../src/main/paths.ts'
import { collectNotePaths, collectRelPaths } from '../../src/renderer/src/tree.ts'
import { joinVaultRel, parseVaultMediaUrl, vaultMediaUrl } from '../../src/shared/vault-rel.ts'

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../../src/main/watch.ts', () => ({ watchVault: vi.fn(() => () => {}) }))
afterEach(() => { vi.restoreAllMocks() })

describe('VaultSession isolation', () => {
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

  it('discards a delayed note notification from the previous vault', async () => {
    const { session, emit, attach, first, second } = await setup()
    let finish!: (value: { content: string; revision: string }) => void
    const pending = new Promise<{ content: string; revision: string }>((resolve) => { finish = resolve })
    try {
      await attach(first)
      vi.spyOn(notesFs, 'readNoteSnapshot').mockReturnValueOnce(pending)
      const callback = vi.mocked(watchVault).mock.calls.at(-1)![1]
      callback('原篇.md')
      await new Promise((resolve) => setTimeout(resolve, 100))
      await attach(second)
      emit.mockClear()
      finish({ content: 'first secret', revision: 'old' })
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
