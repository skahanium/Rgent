import { mkdir, readdir, readFile, stat, writeFile, lstat, realpath, open, rename, unlink } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import type { TreeEntry } from '../shared/ipc.ts'
import {
  hasHiddenSegment,
  isHiddenName,
  isNotePath,
  relFromAbs,
  resolveInVault,
  sanitizeNoteName
} from './paths.ts'

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultPathError'
  }
}

function mustResolve(root: string, relPath: string): string {
  const abs = resolveInVault(root, relPath)
  if (!abs) throw new VaultPathError('路径超出库根')
  if (hasHiddenSegment(relPath) && relPath.length > 0) throw new VaultPathError('不能读写隐藏路径')
  return abs
}

export async function listVaultTree(root: string): Promise<TreeEntry[]> {
  return readDir(root, root)
}

async function readDir(root: string, dir: string): Promise<TreeEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const visible = entries.filter((entry) => !isHiddenName(entry.name))
  visible.sort((a, b) => {
    const dirA = a.isDirectory() ? 0 : 1
    const dirB = b.isDirectory() ? 0 : 1
    if (dirA !== dirB) return dirA - dirB
    return a.name.localeCompare(b.name, 'zh')
  })
  const out: TreeEntry[] = []
  for (const entry of visible) {
    const abs = path.join(dir, entry.name)
    const relPath = relFromAbs(root, abs)
    if (entry.isDirectory()) {
      out.push({
        name: entry.name,
        relPath,
        kind: 'dir',
        children: await readDir(root, abs)
      })
      continue
    }
    out.push({
      name: entry.name,
      relPath,
      kind: !entry.isSymbolicLink() && isNotePath(relPath) ? 'note' : 'file'
    })
  }
  return out
}

export async function readNote(root: string, relPath: string): Promise<string> {
  if (!isNotePath(relPath)) throw new VaultPathError('不是笔记')
  const abs = await existingNotePath(root, relPath)
  return readFile(abs, 'utf8')
}

export function revisionOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export async function readNoteSnapshot(root: string, relPath: string): Promise<{ content: string; revision: string }> {
  const content = await readNote(root, relPath)
  return { content, revision: revisionOf(content) }
}

export async function writeNote(root: string, relPath: string, content: string, expectedRevision: string): Promise<string> {
  if (!isNotePath(relPath)) throw new VaultPathError('不是笔记')
  const key = mustResolve(root, relPath)
  return serializedWrite(key, async () => writeNoteNow(root, relPath, content, expectedRevision))
}

const writes = new Map<string, Promise<void>>()

async function serializedWrite<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writes.get(key)
  let release = (): void => {}
  const turn = new Promise<void>((resolve) => { release = resolve })
  writes.set(key, turn)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (writes.get(key) === turn) writes.delete(key)
  }
}

async function writeNoteNow(root: string, relPath: string, content: string, expectedRevision: string): Promise<string> {
  const abs = await existingNotePath(root, relPath)
  const original = await readFile(abs, 'utf8')
  if (revisionOf(original) !== expectedRevision) throw new VaultPathError('CONFLICT')
  await atomicReplaceFile(abs, content, async () => {
    const checked = await existingNotePath(root, relPath)
    if (checked !== abs || revisionOf(await readFile(abs, 'utf8')) !== expectedRevision) {
      throw new VaultPathError('CONFLICT')
    }
  })
  return revisionOf(content)
}

async function existingNotePath(root: string, relPath: string): Promise<string> {
  const lexical = mustResolve(root, relPath)
  const rootReal = await realpath(root)
  const parts = path.relative(path.resolve(root), lexical).split(path.sep)
  let cursor = rootReal
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part)
    const info = await lstat(cursor)
    if (info.isSymbolicLink()) throw new VaultPathError('不能读写符号链接笔记')
    if (index < parts.length - 1 && !info.isDirectory()) throw new VaultPathError('不是笔记')
    if (index === parts.length - 1 && !info.isFile()) throw new VaultPathError('不是笔记')
  }
  return cursor
}

/** 同目录替换；写入或校验失败时原文件仍在，临时文件会删除。 */
export async function atomicReplaceFile(abs: string, content: string, beforeRename?: () => Promise<void>): Promise<void> {
  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomUUID()}.tmp`)
  const current = await lstat(abs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (current && (!current.isFile() || current.isSymbolicLink())) throw new VaultPathError('不能替换符号链接')
  let created = false
  try {
    const handle = await open(temp, 'wx', current?.mode ?? 0o600)
    created = true
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await beforeRename?.()
    await rename(temp, abs)
    created = false
  } finally {
    if (created) await unlink(temp).catch(() => {})
  }
}

export async function createNote(root: string, name: string): Promise<string> {
  const fileName = sanitizeNoteName(name)
  const abs = mustResolve(root, fileName)
  try {
    await stat(abs)
    throw new VaultPathError('已有同名笔记')
  } catch (err) {
    if (err instanceof VaultPathError) throw err
  }
  await mkdir(path.dirname(abs), { recursive: true })
  try {
    await writeFile(abs, '', { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new VaultPathError('已有同名笔记')
    throw err
  }
  return fileName
}

export type StoredVault = { path: string }

export function parseStoredVault(raw: string | null): StoredVault | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as { path?: unknown }
    if (typeof data.path === 'string' && data.path.length > 0) return { path: data.path }
  } catch {
    return null
  }
  return null
}

export function serializeStoredVault(vaultPath: string): string {
  return JSON.stringify({ path: vaultPath })
}
