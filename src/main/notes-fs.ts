import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
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
      kind: isNotePath(relPath) ? 'note' : 'file'
    })
  }
  return out
}

export async function readNote(root: string, relPath: string): Promise<string> {
  if (!isNotePath(relPath)) throw new VaultPathError('不是笔记')
  const abs = mustResolve(root, relPath)
  const info = await stat(abs)
  if (!info.isFile()) throw new VaultPathError('不是笔记')
  return readFile(abs, 'utf8')
}

export async function writeNote(root: string, relPath: string, content: string): Promise<void> {
  if (!isNotePath(relPath)) throw new VaultPathError('不是笔记')
  const abs = mustResolve(root, relPath)
  await writeFile(abs, content, 'utf8')
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
