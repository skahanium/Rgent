import { createHash } from 'node:crypto'
import type { TreeEntry } from '../shared/ipc.ts'
import { secureFsFor } from './secure-fs.ts'
import {
  hasHiddenSegment,
  isHiddenName,
  isNotePath,
  resolveInVault,
  sanitizeFolderName,
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
  // Use the same native resolution as lifecycle/permissions, including aliases
  // that only the actual filesystem can recognize. This is display metadata.
  if (out.some(entry => entry.kind === 'dir')) {
    const fs = secureFsFor(root)
    for (const note of out.filter(entry => entry.kind === 'note')) {
      try {
        const resolved = fs.resolve(note.relPath.slice(0, -3))
        if (resolved.at(-1)?.kind !== 'dir') continue
        const actual = resolved.map(part => part.name).join('/')
        const folder = out.find(entry => entry.kind === 'dir' && entry.relPath === actual)
        if (folder) folder.attachmentOf = note.relPath
      } catch (error) {
        if (error instanceof Error && (error.message === 'ENOENT' || error.message === 'UNSAFE_PATH')) continue
        throw error
      }
    }
  }
  return out
}

/** Main-process Agent guard: inspect only approved note ancestors and their siblings.
 * Native IDs and resolution establish companion ownership (including aliases), not string casing.
 * Results are shared only within this synchronous check and never cached across calls. */
export function requireOrdinaryNotes(root: string, paths: readonly string[]): void {
  const fs = secureFsFor(root)
  const proofs = paths.map(relPath => {
    if (!isNotePath(relPath)) throw new VaultPathError('OUTSIDE_TASK_SCOPE')
    mustResolve(root, relPath)
    const parts = fs.resolve(relPath)
    if (parts.at(-1)?.kind !== 'file') throw new VaultPathError('OUTSIDE_TASK_SCOPE')
    return { relPath, parts }
  })
  const foldersByParent = new Map<string, Set<string>>()
  for (const { parts } of proofs) {
    for (let index = 0; index < parts.length - 1; index++) {
      const parent = parts.slice(0, index).map(part => part.name).join('/')
      const ids = foldersByParent.get(parent) ?? new Set<string>()
      ids.add(parts[index]!.id)
      foldersByParent.set(parent, ids)
    }
  }
  for (const [parent, ancestorIds] of foldersByParent) {
    for (const entry of fs.list(parent)) {
      if (entry.kind !== 'file' || isHiddenName(entry.name) || !isNotePath(entry.name)) continue
      const stem = entry.name.slice(0, -3)
      const candidate = parent ? `${parent}/${stem}` : stem
      let folder
      try { folder = fs.resolve(candidate).at(-1) }
      catch (error) {
        if (error instanceof Error && error.message === 'ENOENT') continue
        throw error // Ownership that cannot be verified does not become permission.
      }
      if (folder?.kind === 'dir' && ancestorIds.has(folder.id)) throw new VaultPathError('OUTSIDE_TASK_SCOPE')
    }
  }
  for (const { relPath, parts } of proofs) {
    const current = fs.resolve(relPath)
    if (current.length !== parts.length || parts.some((part, index) =>
      current[index]?.id !== part.id || current[index]?.name !== part.name || current[index]?.kind !== part.kind)) {
      throw new VaultPathError('PATH_CHANGED')
    }
  }
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

/** 「建」用的原子创建：正文与文件一次出现，中途失败不留空笔记。
 *  原生层先在同目录写 O_EXCL 临时文件，再用排他发布把它接到目标名——目标已存在即失败
 *  （绝不覆盖），任何失败都会清掉临时文件。因此不需要（也没有）删除路径来回收半成品。 */
export async function createNoteWithBody(root: string, name: string, parent = '', content: string): Promise<{ relPath: string; revision: string; objectVersion: string }> {
  const fileName = sanitizeNoteName(name)
  verifiedParent(root, parent)
  const relPath = parent ? `${parent}/${fileName}` : fileName
  mustResolve(root, relPath)
  try {
    const objectVersion = secureFsFor(root).replace(relPath, null, content)
    return { relPath, revision: revisionOf(content), objectVersion }
  } catch (err) {
    if (err instanceof Error && (err.message === 'CONFLICT' || err.message === 'EEXIST')) throw new VaultPathError('已有同名笔记')
    throw err
  }
}

export async function createFolder(root: string, name: string, parent = ''): Promise<string> {
  verifiedParent(root, parent)
  const folderName = sanitizeFolderName(name)
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
