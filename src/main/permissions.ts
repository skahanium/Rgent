import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { atomicReplaceFile } from './notes-fs.ts'
import { resolveInVault } from './paths.ts'
import type { PermissionEntry, PermissionState, PermissionTier } from '../shared/ipc.ts'

export type { PermissionEntry, PermissionState, PermissionTier } from '../shared/ipc.ts'

const FILE_NAME = '.rgent-permissions'

function validRelPath(relPath: string): boolean {
  if (!relPath || relPath.includes('\\') || relPath.includes(':') || relPath.startsWith('/')) return false
  return relPath.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))
}

export function tierFor(relPath: string, entries: readonly PermissionEntry[]): PermissionTier {
  let winner: { tier: PermissionTier; length: number; direct: boolean } | null = null
  for (const entry of entries) {
    const key = entry.relPath
    const note = key.toLowerCase().endsWith('.md')
    const exact = relPath === key
    const folder = note ? key.slice(0, -3) : key
    const matchesFolder = relPath === folder || relPath.startsWith(`${folder}/`)
    if (!exact && !matchesFolder) continue
    const length = exact ? key.length : folder.length
    const direct = exact || !note
    if (!winner || length > winner.length || (length === winner.length && direct && !winner.direct)) {
      winner = { tier: entry.tier, length, direct }
    }
  }
  return winner?.tier ?? 'reference'
}

/** 未来每个模型出口在使用内容或工具前调用；不缓存，也不降级为默认档。 */
export async function modelTierFor(root: string, relPath: string): Promise<Exclude<PermissionTier, 'forbidden'>> {
  if (!validRelPath(relPath)) throw new Error('BAD_PATH')
  const state = await loadPermissions(root)
  if (state.status === 'invalid') throw new Error('PERMISSIONS_INVALID')
  const tier = tierFor(relPath, state.entries)
  if (tier === 'forbidden') throw new Error('FORBIDDEN')
  return tier
}

export async function loadPermissions(root: string): Promise<PermissionState> {
  const abs = path.join(root, FILE_NAME)
  let raw: string
  try {
    const info = await lstat(abs)
    if (!info.isFile() || info.isSymbolicLink()) return { status: 'invalid', error: '权限名单不是普通文件' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'ready', entries: [] }
    return { status: 'invalid', error: '权限名单无法读取' }
  }
  try {
    raw = await readFile(abs, 'utf8')
  } catch {
    return { status: 'invalid', error: '权限名单无法读取' }
  }
  try {
    const data: unknown = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('非对象')
    const entries: PermissionEntry[] = []
    for (const [relPath, tier] of Object.entries(data)) {
      if (!validRelPath(relPath) || (tier !== 'reference' && tier !== 'follow' && tier !== 'forbidden')) {
        throw new Error('无效条目')
      }
      entries.push({ relPath, tier })
    }
    return { status: 'ready', entries }
  } catch {
    return { status: 'invalid', error: '权限名单格式无效' }
  }
}

export async function setPermission(root: string, relPath: string, tier: PermissionTier): Promise<PermissionState> {
  if (!validRelPath(relPath)) throw new Error('BAD_PATH')
  if (tier !== 'reference' && tier !== 'follow' && tier !== 'forbidden') throw new Error('BAD_TIER')
  const abs = resolveInVault(root, relPath)
  if (!abs) throw new Error('BAD_PATH')
  const rootReal = await realpath(root)
  let cursor = rootReal
  for (const part of relPath.split('/')) {
    cursor = path.join(cursor, part)
    const info = await lstat(cursor)
    if (info.isSymbolicLink()) throw new Error('不能设置符号链接文件夹')
    if (!info.isDirectory()) throw new Error('只能对文件夹设档')
  }
  return serializedSet(rootReal, async () => {
    const current = await loadPermissions(rootReal)
    if (current.status === 'invalid') throw new Error('PERMISSIONS_INVALID')
    const next = new Map(current.entries.map((entry) => [entry.relPath, entry.tier]))
    next.set(relPath, tier)
    const entries = [...next.entries()].map(([name, value]) => ({ relPath: name, tier: value }))
    await atomicReplaceFile(path.join(rootReal, FILE_NAME), `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`, async () => {
      const latest = await loadPermissions(rootReal)
      if (latest.status === 'invalid' || JSON.stringify(latest.entries) !== JSON.stringify(current.entries)) {
        throw new Error('PERMISSIONS_CONFLICT')
      }
    })
    return { status: 'ready', entries }
  })
}

const pendingSets = new Map<string, Promise<void>>()

async function serializedSet<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = pendingSets.get(root)
  let release = (): void => {}
  const turn = new Promise<void>((resolve) => { release = resolve })
  pendingSets.set(root, turn)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (pendingSets.get(root) === turn) pendingSets.delete(root)
  }
}
