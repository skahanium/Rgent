import path from 'node:path'
import { resolveInVault } from './paths.ts'
import { secureFsFor } from './secure-fs.ts'
import type { ResolvedComponent } from './secure-fs.ts'
import type { PermissionEntry, PermissionState, PermissionTier } from '../shared/ipc.ts'

export type { PermissionEntry, PermissionState, PermissionTier } from '../shared/ipc.ts'

const FILE_NAME = '.rgent-permissions'

function sameComponents(left: readonly ResolvedComponent[], right: readonly ResolvedComponent[]): boolean {
  return left.length === right.length && left.every((part, i) =>
    part.id === right[i].id && part.name === right[i].name && part.kind === right[i].kind)
}

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
  const fs = secureFsFor(root)
  let target
  try {
    target = fs.resolve(relPath)
  } catch {
    throw new Error('BAD_PATH')
  }
  const canonical = target.map((part) => part.name).join('/')
  for (const entry of state.entries) {
    const rule = fs.resolve(entry.relPath)
    if (rule.map((part) => part.name).join('/') !== entry.relPath) throw new Error('PERMISSIONS_INVALID')
    if (rule.at(-1)?.kind === 'file' && rule.at(-1)?.id === target.at(-1)?.id && entry.relPath !== canonical) {
      throw new Error('PERMISSIONS_INVALID')
    }
  }
  if (!sameComponents(target, fs.resolve(relPath))) throw new Error('PERMISSIONS_INVALID')
  const tier = tierFor(canonical, effectivePermissionEntries(root, state.entries))
  if (tier === 'forbidden') throw new Error('FORBIDDEN')
  return tier
}

export async function loadPermissions(root: string): Promise<PermissionState> {
  let raw: string | null
  try {
    raw = secureFsFor(root).readText(FILE_NAME)
  } catch (error) {
    if (error instanceof Error && error.message === 'ENOENT') raw = null
    else return { status: 'invalid', error: '权限名单无法读取' }
  }
  return parsePermissions(root, raw)
}

function parsePermissions(root: string, raw: string | null): PermissionState {
  if (raw === null) return { status: 'ready', entries: [] }
  try {
    const data: unknown = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('非对象')
    const entries: PermissionEntry[] = []
    const seen = new Map<string, PermissionTier>()
    const checked: { requested: string; components: ResolvedComponent[] }[] = []
    for (const [relPath, tier] of Object.entries(data)) {
      if (!validRelPath(relPath) || (tier !== 'reference' && tier !== 'follow' && tier !== 'forbidden')) {
        throw new Error('无效条目')
      }
      const resolved = secureFsFor(root).resolve(relPath)
      checked.push({ requested: relPath, components: resolved })
      const canonical = resolved.map((part) => part.name).join('/')
      const prior = seen.get(canonical)
      if (prior && prior !== tier) throw new Error('别名冲突')
      if (!prior) {
        seen.set(canonical, tier)
        entries.push({ relPath: canonical, tier })
      }
    }
    for (const item of checked) {
      if (!sameComponents(item.components, secureFsFor(root).resolve(item.requested))) {
        throw new Error('路径已变化')
      }
    }
    return { status: 'ready', entries }
  } catch {
    return { status: 'invalid', error: '权限名单格式无效' }
  }
}

/** Match a note's attachment folder by its actual filesystem spelling. */
export function effectivePermissionEntries(root: string, entries: readonly PermissionEntry[]): PermissionEntry[] {
  const fs = secureFsFor(root)
  const effective = [...entries]
  const direct = new Set(entries.map((entry) => entry.relPath))
  const derived = new Map<string, PermissionTier>()
  for (const entry of entries) {
    if (!entry.relPath.toLowerCase().endsWith('.md')) continue
    const stem = entry.relPath.slice(0, -3)
    let folder
    try {
      folder = fs.resolve(stem)
    } catch (error) {
      if (error instanceof Error && (error.message === 'ENOENT' || error.message === 'UNSAFE_PATH')) continue
      throw error
    }
    if (folder.at(-1)?.kind !== 'dir') continue
    const canonical = folder.map((part) => part.name).join('/')
    if (canonical === stem || direct.has(canonical)) continue
    const prior = derived.get(canonical)
    if (prior && prior !== entry.tier) throw new Error('PERMISSIONS_INVALID')
    if (!prior) {
      derived.set(canonical, entry.tier)
      effective.push({ relPath: canonical, tier: entry.tier })
    }
  }
  return effective
}

export async function setPermission(root: string, relPath: string, tier: PermissionTier): Promise<PermissionState> {
  if (!validRelPath(relPath)) throw new Error('BAD_PATH')
  if (tier !== 'reference' && tier !== 'follow' && tier !== 'forbidden') throw new Error('BAD_TIER')
  const abs = resolveInVault(root, relPath)
  if (!abs) throw new Error('BAD_PATH')
  const fs = secureFsFor(root)
  let components
  try {
    components = fs.resolve(relPath)
  } catch (error) {
    if (error instanceof Error && error.message === 'UNSAFE_PATH') throw new Error('不能设置符号链接文件夹')
    throw error
  }
  if (components.at(-1)?.kind !== 'dir') throw new Error('只能对文件夹设档')
  if (!sameComponents(components, fs.resolve(relPath))) throw new Error('PATH_CHANGED')
  const canonical = components.map((part) => part.name).join('/')
  return serializedSet(path.resolve(root), async () => {
    let currentRaw: string | null = null
    try {
      currentRaw = fs.readText(FILE_NAME)
    } catch (error) {
      if (!(error instanceof Error && error.message === 'ENOENT')) throw error
    }
    const current = parsePermissions(root, currentRaw)
    if (current.status === 'invalid') throw new Error('PERMISSIONS_INVALID')
    const next = new Map(current.entries.map((entry) => [entry.relPath, entry.tier]))
    next.set(canonical, tier)
    const entries = [...next.entries()].map(([name, value]) => ({ relPath: name, tier: value }))
    fs.replace(FILE_NAME, currentRaw, `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`)
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
