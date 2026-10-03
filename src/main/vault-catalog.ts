import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { vaultRootIdentity } from './watch.ts'
import type { VaultCatalogEntry, VaultCatalogView, VaultTarget, VaultWorkspace } from '../shared/vault-management.ts'

const LIMIT = 128
const MAX_FILE_BYTES = 4_194_304
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
interface CatalogData { version: 1; entries: VaultCatalogEntry[]; lastVaultId: string | null }
interface WorkspaceData { version: 1; entries: Array<{ path: string; rootIdentity: string; workspace: VaultWorkspace }> }
interface Snapshot { raw: string | null; revision: string; unreadable: boolean }

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value) }
function label(value: unknown): value is string { return text(value, 80) && value.trim().length > 0 }
function rootPath(value: unknown): value is string { return text(value, 4096) && path.isAbsolute(value) && path.resolve(value) === value }
function identity(value: unknown): value is string { return typeof value === 'string' && /^\d+:\d+$/.test(value) && value.length <= 128 }
function nested(a: string, b: string): boolean {
  const rel = path.relative(a, b)
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))
}
function position(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000 }
function scroll(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000_000 }
function relPath(value: unknown): string | null {
  if (!text(value, 4096)) return null
  const rel = value.replaceAll('\\', '/')
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) return null
  const result = rel.split('/').filter(part => part !== '' && part !== '.').join('/')
  if (result.startsWith('/') || /^[a-zA-Z]:/.test(result)) return null
  return result && /\.md$/i.test(result) ? result : null
}
function workspaceValue(value: unknown): VaultWorkspace {
  const data = object(value) ? value : {}
  const tabs: VaultWorkspace['tabs'] = []
  const seen = new Set<string>()
  if (Array.isArray(data.tabs)) for (const item of data.tabs.slice(0, 256)) {
    if (!object(item)) continue
    const rel = relPath(item.relPath)
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    const tab: VaultWorkspace['tabs'][number] = { relPath: rel }
    if (object(item.selection) && position(item.selection.anchor) && position(item.selection.head)) tab.selection = { anchor: item.selection.anchor, head: item.selection.head }
    if (scroll(item.scrollTop)) tab.scrollTop = item.scrollTop
    tabs.push(tab)
    if (tabs.length === 64) break
  }
  const active = relPath(data.active)
  return { version: 1, tabs, active: active && seen.has(active) ? active : null, sidebarHidden: data.sidebarHidden === true, treeScroll: scroll(data.treeScroll) ? data.treeScroll : 0, resourceScroll: scroll(data.resourceScroll) ? data.resourceScroll : 0 }
}
function snapshot(file: string): Snapshot {
  try {
    const stat = fs.lstatSync(file, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(MAX_FILE_BYTES)) return { raw: null, revision: `invalid:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`, unreadable: true }
    const raw = fs.readFileSync(file, 'utf8')
    const revision = createHash('sha256').update(`${stat.dev}:${stat.ino}:`).update(raw).digest('hex')
    return { raw, revision, unreadable: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: null, revision: 'missing', unreadable: false }
    return { raw: null, revision: 'unreadable', unreadable: true }
  }
}
function parseCatalog(source: Snapshot): CatalogData | null {
  if (source.unreadable) return null
  if (source.raw === null) return { version: 1, entries: [], lastVaultId: null }
  try {
    const value: unknown = JSON.parse(source.raw)
    if (!object(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > LIMIT) return null
    const entries: VaultCatalogEntry[] = []
    for (const item of value.entries) {
      if (!object(item) || !text(item.id, 128) || !label(item.label) || !rootPath(item.path) || !identity(item.rootIdentity) || typeof item.pinned !== 'boolean' || !(item.lastUsed === null || (typeof item.lastUsed === 'number' && Number.isSafeInteger(item.lastUsed) && item.lastUsed >= 0))) return null
      if (entries.some(entry => entry.id === item.id || entry.rootIdentity === item.rootIdentity || nested(entry.path, item.path as string) || nested(item.path as string, entry.path))) return null
      entries.push({ id: item.id, label: item.label, path: item.path, rootIdentity: item.rootIdentity, pinned: item.pinned, lastUsed: item.lastUsed })
    }
    if (value.lastVaultId !== null && !(typeof value.lastVaultId === 'string' && entries.some(entry => entry.id === value.lastVaultId))) return null
    return { version: 1, entries, lastVaultId: value.lastVaultId as string | null }
  } catch { return null }
}
function parseWorkspaces(source: Snapshot): WorkspaceData | null {
  if (source.unreadable) return null
  if (source.raw === null) return { version: 1, entries: [] }
  try {
    const value: unknown = JSON.parse(source.raw)
    if (!object(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > LIMIT) return null
    const entries: WorkspaceData['entries'] = []
    for (const item of value.entries) {
      if (!object(item) || !rootPath(item.path) || !identity(item.rootIdentity) || !object(item.workspace) || item.workspace.version !== 1 || entries.some(entry => entry.path === item.path && entry.rootIdentity === item.rootIdentity)) return null
      entries.push({ path: item.path, rootIdentity: item.rootIdentity, workspace: workspaceValue(item.workspace) })
    }
    return { version: 1, entries }
  } catch { return null }
}

/** 仅设备目录和工作区。根预检不打开 VaultSession，不迁移、不读取库正文。 */
export class VaultCatalog {
  private readonly file: string
  private readonly workspaceFile: string
  constructor(userData: string) {
    this.file = path.join(userData, 'vault-catalog.json')
    this.workspaceFile = path.join(userData, 'vault-workspaces.json')
  }
  view(): VaultCatalogView {
    const source = snapshot(this.file); const data = parseCatalog(source)
    return { entries: data?.entries ?? [], lastVaultId: data?.lastVaultId ?? null, diagnostic: data ? null : 'VAULT_CATALOG_INVALID', revision: source.revision }
  }
  inspect(input: string): VaultTarget {
    if (!text(input, 4096)) throw new Error('VAULT_TARGET_INVALID')
    const canonical = fs.realpathSync.native(input)
    if (!rootPath(canonical)) throw new Error('VAULT_TARGET_INVALID')
    fs.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK)
    const rootIdentity = vaultRootIdentity(canonical)
    const entry = this.view().entries.find(item => item.path === canonical && item.rootIdentity === rootIdentity)
    const basename = path.basename(canonical).slice(0, 80)
    return { path: canonical, rootIdentity, label: entry?.label ?? (label(basename) ? basename : '笔记库'), id: entry?.id ?? null }
  }
  private checked(target: VaultTarget): VaultTarget {
    if (!object(target) || !rootPath(target.path) || !identity(target.rootIdentity) || !label(target.label) || !(target.id === null || text(target.id, 128))) throw new Error('VAULT_TARGET_INVALID')
    const current = this.inspect(target.path)
    if (current.path !== target.path || current.rootIdentity !== target.rootIdentity) throw new Error('VAULT_REPLACED')
    return target
  }
  private writable(revision?: string): { source: Snapshot; data: CatalogData } {
    const source = snapshot(this.file); const data = parseCatalog(source)
    if (!data) throw new Error('VAULT_CATALOG_INVALID')
    if (revision !== undefined && revision !== source.revision) throw new Error('VAULT_CATALOG_CONFLICT')
    return { source, data }
  }
  private compatible(entries: VaultCatalogEntry[], target: VaultTarget, exclude?: string): VaultCatalogEntry | undefined {
    for (const entry of entries) {
      if (entry.id === exclude) continue
      if (entry.path === target.path) {
        if (entry.rootIdentity !== target.rootIdentity) throw new Error('VAULT_REPLACED')
        return entry
      }
      if (entry.rootIdentity === target.rootIdentity) throw new Error('VAULT_RELOCATE_REQUIRED')
      if (nested(entry.path, target.path) || nested(target.path, entry.path)) throw new Error('VAULT_NESTED')
    }
    return undefined
  }
  private entry(data: CatalogData, target: VaultTarget): VaultCatalogEntry {
    this.checked(target)
    const existing = this.compatible(data.entries, target)
    if (target.id !== null && existing?.id !== target.id) throw new Error('VAULT_REPLACED')
    if (existing) return existing
    if (data.entries.length >= LIMIT) throw new Error('VAULT_CATALOG_LIMIT')
    const result = { id: randomUUID(), label: target.label, path: target.path, rootIdentity: target.rootIdentity, pinned: false, lastUsed: null }
    data.entries.push(result)
    return result
  }
  register(target: VaultTarget): VaultCatalogEntry {
    const { source, data } = this.writable(); const length = data.entries.length
    const entry = this.entry(data, target)
    if (length !== data.entries.length) this.save(this.file, data, source, 'VAULT_CATALOG_CONFLICT', () => { this.checked(target) })
    return { ...entry }
  }
  update(id: string, patch: { label?: string; pinned?: boolean }, revision: string): VaultCatalogView {
    if (typeof revision !== 'string') throw new Error('VAULT_CATALOG_CONFLICT')
    const { source, data } = this.writable(revision)
    const entry = data.entries.find(item => item.id === id)
    if (!entry) throw new Error('VAULT_NOT_REGISTERED')
    if (!object(patch) || Object.keys(patch).some(key => key !== 'label' && key !== 'pinned') || (patch.label !== undefined && !label(patch.label)) || (patch.pinned !== undefined && typeof patch.pinned !== 'boolean')) throw new Error('VAULT_CATALOG_PATCH_INVALID')
    if (patch.label !== undefined) entry.label = patch.label
    if (patch.pinned !== undefined) entry.pinned = patch.pinned
    this.save(this.file, data, source, 'VAULT_CATALOG_CONFLICT')
    return this.view()
  }
  remove(id: string, revision: string): VaultCatalogView {
    if (typeof revision !== 'string') throw new Error('VAULT_CATALOG_CONFLICT')
    const { source, data } = this.writable(revision)
    if (!data.entries.some(item => item.id === id)) throw new Error('VAULT_NOT_REGISTERED')
    data.entries = data.entries.filter(item => item.id !== id)
    if (data.lastVaultId === id) data.lastVaultId = null
    this.save(this.file, data, source, 'VAULT_CATALOG_CONFLICT')
    return this.view()
  }
  relocate(id: string, target: VaultTarget, revision: string): VaultCatalogView {
    if (typeof revision !== 'string') throw new Error('VAULT_CATALOG_CONFLICT')
    const { source, data } = this.writable(revision); this.checked(target)
    const entry = data.entries.find(item => item.id === id)
    if (!entry) throw new Error('VAULT_NOT_REGISTERED')
    if (this.compatible(data.entries, target, id)) throw new Error('VAULT_ALREADY_REGISTERED')
    entry.path = target.path; entry.rootIdentity = target.rootIdentity; entry.lastUsed = null
    if (data.lastVaultId === id) data.lastVaultId = null
    this.save(this.file, data, source, 'VAULT_CATALOG_CONFLICT', () => { this.checked(target) })
    return this.view()
  }
  committed(target: VaultTarget): VaultCatalogEntry {
    const { source, data } = this.writable(); const entry = this.entry(data, target)
    entry.lastUsed = Date.now(); data.lastVaultId = entry.id
    this.save(this.file, data, source, 'VAULT_CATALOG_CONFLICT', () => { this.checked(target) })
    return { ...entry }
  }
  workspace(target: VaultTarget): VaultWorkspace | null {
    this.checked(target)
    const data = parseWorkspaces(snapshot(this.workspaceFile))
    return data?.entries.find(item => item.path === target.path && item.rootIdentity === target.rootIdentity)?.workspace ?? null
  }
  saveWorkspace(target: VaultTarget, value: unknown): void {
    this.checked(target)
    const source = snapshot(this.workspaceFile); const data = parseWorkspaces(source)
    if (!data) throw new Error('VAULT_WORKSPACE_INVALID')
    const workspace = workspaceValue(value)
    const existing = data.entries.find(item => item.path === target.path && item.rootIdentity === target.rootIdentity)
    if (existing) existing.workspace = workspace
    else {
      if (data.entries.length >= LIMIT) throw new Error('VAULT_WORKSPACE_LIMIT')
      data.entries.push({ path: target.path, rootIdentity: target.rootIdentity, workspace })
    }
    this.save(this.workspaceFile, data, source, 'VAULT_WORKSPACE_CONFLICT', () => { this.checked(target) })
  }
  private save(file: string, data: CatalogData | WorkspaceData, before: Snapshot, conflict: string, check?: () => void): void {
    const encoded = JSON.stringify(data)
    if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) throw new Error(file === this.workspaceFile ? 'VAULT_WORKSPACE_LIMIT' : 'VAULT_CATALOG_LIMIT')
    const temporary = path.join(path.dirname(file), `.vault-${randomUUID()}.tmp`)
    let fd: number | null = null
    try {
      fd = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(fd, encoded, 'utf8'); fs.fsyncSync(fd)
      fs.closeSync(fd); fd = null
      if (snapshot(file).revision !== before.revision) throw new Error(conflict)
      check?.()
      fs.renameSync(temporary, file)
    } catch (error) {
      if (fd !== null) fs.closeSync(fd)
      try { fs.unlinkSync(temporary) } catch { /* 只清理本次临时文件。 */ }
      throw error
    }
  }
}
