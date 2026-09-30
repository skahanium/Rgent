import { createHash } from 'node:crypto'
import type { TreeEntry } from '../shared/ipc.ts'
import { secureFsFor } from './secure-fs.ts'
import {
  hasHiddenSegment,
  isHiddenName,
  isNotePath,
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
  return readDir(root, '')
}

async function readDir(root: string, dir: string): Promise<TreeEntry[]> {
  const entries = secureFsFor(root).list(dir)
  const visible = entries.filter((entry) => !isHiddenName(entry.name))
  visible.sort((a, b) => {
    const dirA = a.kind === 'dir' ? 0 : 1
    const dirB = b.kind === 'dir' ? 0 : 1
    if (dirA !== dirB) return dirA - dirB
    return a.name.localeCompare(b.name, 'zh')
  })
  const out: TreeEntry[] = []
  for (const entry of visible) {
    const relPath = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.kind === 'dir') {
      out.push({
        name: entry.name,
        relPath,
        kind: 'dir',
        children: await readDir(root, relPath)
      })
      continue
    }
    out.push({
      name: entry.name,
      relPath,
      kind: entry.kind === 'file' && isNotePath(relPath) ? 'note' : 'file'
    })
  }
  return out
}

export async function readNote(root: string, relPath: string): Promise<string> {
  if (!isNotePath(relPath)) throw new VaultPathError('不是笔记')
  mustResolve(root, relPath)
  try {
    return secureFsFor(root).readText(relPath)
  } catch (error) {
    if (error instanceof Error && error.message === 'UNSAFE_PATH') throw new VaultPathError('不能读写符号链接笔记')
    throw error
  }
}

export function revisionOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export type NoteVersion = { revision: string; objectVersion: string }

export async function readNoteSnapshot(root: string, relPath: string): Promise<NoteVersion & { content: string }> {
  if (!isNotePath(relPath)) throw new VaultPathError('不是笔记')
  mustResolve(root, relPath)
  try {
    const snapshot = secureFsFor(root).readSnapshot(relPath)
    const content = snapshot.bytes.toString('utf8')
    return { content, revision: revisionOf(content), objectVersion: snapshot.objectVersion }
  } catch (error) {
    if (error instanceof Error && error.message === 'UNSAFE_PATH') throw new VaultPathError('不能读写符号链接笔记')
    throw error
  }
}

export function writeNote(root: string, relPath: string, content: string, expectedRevision: string): Promise<string>
export function writeNote(root: string, relPath: string, content: string, expectedRevision: string, expectedObjectVersion: string): Promise<NoteVersion>
export async function writeNote(root: string, relPath: string, content: string, expectedRevision: string, expectedObjectVersion?: string): Promise<string | NoteVersion> {
  if (!isNotePath(relPath)) throw new VaultPathError('不是笔记')
  mustResolve(root, relPath)
  let key: string
  try {
    key = secureFsFor(root).resolve(relPath).map((part) => part.id).join('/')
  } catch (error) {
    if (error instanceof Error && error.message === 'UNSAFE_PATH') throw new VaultPathError('不能读写符号链接笔记')
    throw error
  }
  return serializedWrite(key, async () => {
    const saved = await writeNoteNow(root, relPath, content, expectedRevision, expectedObjectVersion)
    return expectedObjectVersion === undefined ? saved.revision : saved
  })
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

async function writeNoteNow(root: string, relPath: string, content: string, expectedRevision: string, expectedObjectVersion?: string): Promise<NoteVersion> {
  const fs = secureFsFor(root)
  const snapshot = fs.readSnapshot(relPath)
  if (expectedObjectVersion !== undefined && snapshot.objectVersion !== expectedObjectVersion) throw new VaultPathError('PATH_CHANGED')
  const original = snapshot.bytes.toString('utf8')
  if (revisionOf(original) !== expectedRevision) throw new VaultPathError('CONFLICT')
  const objectVersion = fs.replace(relPath, original, content, expectedObjectVersion ?? snapshot.objectVersion)
  return { revision: revisionOf(content), objectVersion }
}

function verifiedParent(root: string, parent: string): void {
  if (!parent) return
  mustResolve(root, parent)
  const resolved = secureFsFor(root).resolve(parent)
  if (resolved.at(-1)?.kind !== 'dir') throw new VaultPathError('目标不是文件夹')
}

export async function createNote(root: string, name: string, parent = ''): Promise<string> {
  const fileName = sanitizeNoteName(name)
  verifiedParent(root, parent)
  const relPath = parent ? `${parent}/${fileName}` : fileName
  mustResolve(root, relPath)
  try {
    secureFsFor(root).create(relPath)
  } catch (err) {
    if (err instanceof Error && err.message === 'EEXIST') throw new VaultPathError('已有同名笔记')
    throw err
  }
  return relPath
}

export async function createFolder(root: string, name: string, parent = ''): Promise<string> {
  verifiedParent(root, parent)
  const folderName = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/u, '_') || '未命名文件夹'
  const relPath = parent ? `${parent}/${folderName}` : folderName
  mustResolve(root, relPath)
  try {
    secureFsFor(root).createDirectory(relPath)
  } catch (err) {
    if (err instanceof Error && err.message === 'EEXIST') throw new VaultPathError('已有同名文件夹')
    throw err
  }
  return relPath
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
