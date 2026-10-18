import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { vaultRootIdentity } from './watch.ts'
import type { VaultCatalogEntry, VaultCatalogView, VaultTarget, VaultWorkspace, VaultRootPreview } from '../shared/vault-management.ts'

const LIMIT = 128
const MAX_FILE_BYTES = 4_194_304
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
interface CatalogData { version: 1; entries: VaultCatalogEntry[]; lastVaultId: string | null }
interface WorkspaceData { version: 1; entries: Array<{ id?: string; path: string; rootIdentity: string; workspace: VaultWorkspace }> }
interface Snapshot { raw: string | null; revision: string; unreadable: boolean }

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value) }
function label(value: unknown): value is string { return text(value, 80) && value.trim().length > 0 }
function rootPath(value: unknown): value is string { return text(value, 4096) && path.isAbsolute(value) && path.resolve(value) === value }
/** 对象身份：POSIX 是 `十进制设备号:十进制 inode`，Windows 是 `16 位十六进制卷号:32 位十六进制文件 ID`。
 *  两种格式都要认，否则同一库重挂载的提示在 Windows 上永远不成立。 */
function identity(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false
  return /^\d+:\d+$/.test(value) || /^[0-9a-f]{16}:[0-9a-f]{32}$/.test(value)
}
/** 同 inode 可提示卷重新挂载的可能性，不能证明物理连续性或授权认领。 */
export function sameRootInode(a: string, b: string): boolean {
  return identity(a) && identity(b) && a.slice(a.indexOf(':') + 1) === b.slice(b.indexOf(':') + 1)
}
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
      if(item.displayVersion!==undefined&&item.displayVersion!==2||item.legacyDisplayKey!==undefined&&(typeof item.legacyDisplayKey!=='string'||!/^[a-f0-9]{64}$/.test(item.legacyDisplayKey)))return null
      entries.push({ ...(item.displayVersion===2?{displayVersion:2 as const}:{}),...(typeof item.legacyDisplayKey==='string'?{legacyDisplayKey:item.legacyDisplayKey}:{}), id: item.id, label: item.label, path: item.path, rootIdentity: item.rootIdentity, pinned: item.pinned, lastUsed: item.lastUsed })
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
      if (!object(item) || item.id !== undefined && !text(item.id,128) || !rootPath(item.path) || !identity(item.rootIdentity) || !object(item.workspace) || item.workspace.version !== 1 || !Array.isArray(item.workspace.tabs) || !(item.workspace.active===undefined||item.workspace.active===null||typeof item.workspace.active==='string') || entries.some(entry => item.id === undefined && entry.id === undefined && entry.path === item.path && entry.rootIdentity === item.rootIdentity)) return null
      // 已保存的tab身份不能通过过滤坏行变成空工作区；显示偏好仍沿原归一化。
      const tabs=item.workspace.tabs
      if(tabs.length>64||tabs.some(tab=>!object(tab)||!relPath(tab.relPath))||new Set(tabs.map(tab=>relPath((tab as Record<string,unknown>).relPath))).size!==tabs.length)return null
      if(item.id!==undefined&&entries.some(entry=>entry.id===item.id))return null
      entries.push({ ...(item.id?{id:item.id as string}:{}), path: item.path, rootIdentity: item.rootIdentity, workspace: workspaceValue(item.workspace) })
    }
    return { version: 1, entries }
  } catch { return null }
}

/** 仅设备目录和工作区。根预检不打开 VaultSession，不迁移、不读取库正文。 */
export class VaultCatalog {
  private readonly file: string
  private readonly workspaceFile: string
  private readonly rootPreviews=new Map<string,{view:VaultRootPreview;target:VaultTarget;revision:string;workspaceRevision:string;caller:string;sessionId:string|null;expires:number}>()
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
  /** Check the canonical existing parent and catalogue before any mkdir. */
  create(input: string): VaultTarget {
    if (!text(input, 4096) || !path.isAbsolute(input)) throw new Error('VAULT_TARGET_INVALID')
    const resolved = path.resolve(input), parent = fs.realpathSync.native(path.dirname(resolved))
    const canonical = path.join(parent, path.basename(resolved))
    if (!rootPath(canonical) || canonical === parent) throw new Error('VAULT_TARGET_INVALID')
    fs.accessSync(parent, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)
    const parentIdentity = vaultRootIdentity(parent)
    const { data } = this.writable()
    if (data.entries.length >= LIMIT) throw new Error('VAULT_CATALOG_LIMIT')
    for (const entry of data.entries) if (nested(entry.path, canonical) || nested(canonical, entry.path)) throw new Error('VAULT_NESTED')
    if (fs.realpathSync.native(path.dirname(resolved)) !== parent || vaultRootIdentity(parent) !== parentIdentity) throw new Error('VAULT_TARGET_CHANGED')
    fs.mkdirSync(canonical) // exclusive: never populate an existing folder
    return this.inspect(canonical)
  }
  private checked(target: VaultTarget): VaultTarget {
    if (!object(target) || !rootPath(target.path) || !identity(target.rootIdentity) || !label(target.label) || !(target.id === null || text(target.id, 128))) throw new Error('VAULT_TARGET_INVALID')
    const current = this.inspect(target.path)
    if (current.path !== target.path || current.rootIdentity !== target.rootIdentity || target.id !== null && current.id !== target.id) throw new Error('VAULT_REPLACED')
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
    if (existing) {if(!existing.displayVersion){existing.displayVersion=2;existing.legacyDisplayKey=createHash('sha256').update(existing.path).digest('hex')}return existing}
    if (data.entries.length >= LIMIT) throw new Error('VAULT_CATALOG_LIMIT')
    const result = { id: randomUUID(), label: target.label, path: target.path, rootIdentity: target.rootIdentity, pinned: false, lastUsed: null, displayVersion:2 as const }
    data.entries.push(result)
    return result
  }
  register(target: VaultTarget): VaultCatalogEntry {
    const { source, data } = this.writable(); const length = data.entries.length
    const entry = this.entry(data, target)
    if (length !== data.entries.length || JSON.stringify(data)!==source.raw) this.save(this.file, data, source, 'VAULT_CATALOG_CONFLICT', () => { this.checked(target) })
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
    this.migrateWorkspaceId(entry)
    if(!entry.displayVersion){entry.displayVersion=2;if(entry.rootIdentity===target.rootIdentity)entry.legacyDisplayKey=createHash('sha256').update(entry.path).digest('hex')}
    entry.path = target.path; entry.rootIdentity = target.rootIdentity; entry.lastUsed = null
    if (data.lastVaultId === id) data.lastVaultId = null
    this.save(this.file, data, source, 'VAULT_CATALOG_CONFLICT', () => { this.checked(target) })
    return this.view()
  }
  /** 同 inode 仅作诊断，普通打开不认领；令牌仅授权建立新的设备关联。 */
  previewRoot(id:string,target:VaultTarget,revision:string,owner:{caller:string;sessionId:string|null}):VaultRootPreview{
    const {data}=this.writable(revision),entry=data.entries.find(e=>e.id===id)
    if(!entry)throw Error('VAULT_NOT_REGISTERED')
    const current=this.inspect(target.path)
    if(current.path!==target.path||current.rootIdentity!==target.rootIdentity)throw Error('VAULT_TARGET_CHANGED')
    if(this.compatible(data.entries,current,id))throw Error('VAULT_ALREADY_REGISTERED')
    const source=snapshot(this.workspaceFile),workspaces=parseWorkspaces(source)
    const matches=workspaces?.entries.filter(e=>e.id===id||!e.id&&e.path===entry.path&&e.rootIdentity===entry.rootIdentity)??[]
    const view:VaultRootPreview={id:randomUUID(),entryId:id,path:current.path,previousPath:entry.path,previousIdentity:entry.rootIdentity,rootIdentity:current.rootIdentity,workspace:!workspaces?'unavailable':matches.length===1?'restore':'none',warning:'确认只建立新的设备库关联，不证明目录连续性。账本和记忆来源须独立核验；停止旧任务并保留待保存回答与窗口稿，另存正文须再次确认。'}
    const windowId=owner.caller.split(':')[0]
    for(const [key,item]of this.rootPreviews)if(item.expires<=Date.now())this.rootPreviews.delete(key)
    if([...this.rootPreviews.values()].filter(p=>p.caller.split(':')[0]===windowId).length>=4)throw Error('VAULT_PREVIEW_LIMIT')
    this.rootPreviews.set(view.id,{view,target:{...current,id},revision,workspaceRevision:source.revision,...owner,expires:Date.now()+120000})
    return {...view}
  }
  rootTarget(id:string,owner:{caller:string;sessionId:string|null}):VaultTarget{const p=this.rootPreviews.get(id);if(!p||p.expires<=Date.now()||p.caller!==owner.caller||p.sessionId!==owner.sessionId)throw Error('STALE_PREVIEW');return {...p.target}}
  cancelRoot(id:string,owner:{caller:string;sessionId:string|null}):void{const p=this.rootPreviews.get(id);this.rootPreviews.delete(id);if(!p||p.caller!==owner.caller||p.sessionId!==owner.sessionId)throw Error('STALE_PREVIEW')}
  invalidateRootPreviews():void{this.rootPreviews.clear()}
  confirmRoot(id:string,owner:{caller:string;sessionId:string|null}):VaultTarget{
    const p=this.rootPreviews.get(id);this.rootPreviews.delete(id)
    if(!p||p.expires<=Date.now()||p.caller!==owner.caller||p.sessionId!==owner.sessionId||snapshot(this.workspaceFile).revision!==p.workspaceRevision)throw Error('STALE_PREVIEW')
    const {source,data}=this.writable(p.revision),entry=data.entries.find(e=>e.id===p.view.entryId)
    if(!entry||entry.path!==p.view.previousPath||entry.rootIdentity!==p.view.previousIdentity)throw Error('STALE_PREVIEW')
    const current=this.inspect(p.target.path)
    if(current.path!==p.target.path||current.rootIdentity!==p.target.rootIdentity)throw Error('STALE_PREVIEW')
    if(this.compatible(data.entries,current,entry.id))throw Error('VAULT_ALREADY_REGISTERED')
    // 补旧工作区ID在目录变更前完成，已有ID不改路径或根身份；中断可按原登记重试。
    if(parseWorkspaces(snapshot(this.workspaceFile)))this.migrateWorkspaceId(entry)
    entry.path=current.path;entry.rootIdentity=current.rootIdentity;entry.lastUsed=null
    this.save(this.file,data,source,'VAULT_CATALOG_CONFLICT',()=>{const now=this.inspect(current.path);if(now.path!==current.path||now.rootIdentity!==current.rootIdentity)throw Error('VAULT_TARGET_CHANGED')})
    this.invalidateRootPreviews();return {...entry}
  }
  committed(target: VaultTarget): VaultCatalogEntry {    const { source, data } = this.writable(); const entry = this.entry(data, target)
    entry.lastUsed = Date.now(); data.lastVaultId = entry.id
    this.save(this.file, data, source, 'VAULT_CATALOG_CONFLICT', () => { this.checked(target) })
    return { ...entry }
  }
  private migrateWorkspaceId(entry: VaultCatalogEntry): void {
    if(entry.displayVersion&&entry.legacyDisplayKey!==createHash('sha256').update(entry.path).digest('hex'))return
    const source=snapshot(this.workspaceFile),data=parseWorkspaces(source)
    if(!data)throw Error('VAULT_WORKSPACE_INVALID')
    if(data.entries.some(item=>item.id===entry.id))return
    const legacy=data.entries.find(item=>!item.id&&item.path===entry.path&&item.rootIdentity===entry.rootIdentity)
    if(legacy){legacy.id=entry.id;this.save(this.workspaceFile,data,source,'VAULT_WORKSPACE_CONFLICT')}
  }
  displayKeys(target:VaultTarget):{key:string;legacy?:string}{
    this.checked(target)
    const entry=this.view().entries.find(e=>e.path===target.path&&e.rootIdentity===target.rootIdentity)
    if(!entry)throw Error('VAULT_NOT_REGISTERED')
    return {key:createHash('sha256').update('catalog:'+entry.id).digest('hex'),...(!entry.displayVersion?{legacy:createHash('sha256').update(entry.path).digest('hex')}:entry.legacyDisplayKey?{legacy:entry.legacyDisplayKey}:{})}
  }
  workspace(target: VaultTarget): VaultWorkspace | null {
    this.checked(target)
    const data = parseWorkspaces(snapshot(this.workspaceFile))
    const current=this.inspect(target.path),entry=this.view().entries.find(item=>item.id===current.id)
    return data?.entries.find(item => item.id ? item.id === current.id : (!entry || !entry.displayVersion || entry.legacyDisplayKey===createHash('sha256').update(entry.path).digest('hex')) && item.path === target.path && item.rootIdentity === target.rootIdentity)?.workspace ?? null
  }
  saveWorkspace(target: VaultTarget, value: unknown): void {
    this.checked(target)
    const source = snapshot(this.workspaceFile); const data = parseWorkspaces(source)
    if (!data) throw new Error('VAULT_WORKSPACE_INVALID')
    const workspace = workspaceValue(value)
    const id=this.inspect(target.path).id
    const entry=this.view().entries.find(item=>item.id===id)
    const existing = data.entries.find(item => item.id ? item.id === id : (!entry || !entry.displayVersion || entry.legacyDisplayKey===createHash('sha256').update(entry.path).digest('hex')) && item.path === target.path && item.rootIdentity === target.rootIdentity)
    if (existing) { existing.workspace = workspace; if(id)existing.id=id }
    else {
      if (data.entries.length >= LIMIT) throw new Error('VAULT_WORKSPACE_LIMIT')
      data.entries.push({ ...(id?{id}:{}), path: target.path, rootIdentity: target.rootIdentity, workspace })
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
