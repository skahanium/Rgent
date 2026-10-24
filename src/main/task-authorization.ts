import { createHash, randomUUID } from 'node:crypto'
import type { AgentAuthorizationPreview, AgentAuthorizationRequest, AgentCommandRequest, AgentMcpAvailability, AgentScopeLevel, AgentStartRequest, AuthorizedSource, NoteSnapshot, TreeEntry } from '../shared/ipc.ts'
import type { ModelCredential, RunLimits } from './model-config.ts'
import { noteTitle } from '../shared/vault-rel.ts'

export type AuthorizationAction = 'read' | 'model' | 'write'
/** 一场获准的 MCP 服务器：只读名字／主机／白名单工具，token 与 schema 不在授权里。 */
export type McpGrantServer = { readonly name: string; readonly host: string; readonly tools: readonly string[]; readonly searchChannel: boolean }
export type AuthorizationConfiguration = { credential: ModelCredential; limits: RunLimits }
export type AuthorizationDependencies = {
  root(): string | null
  session(): string | null
  tree(): Promise<TreeEntry[]>
  assertOrdinaryNotes?: (paths: readonly string[]) => Promise<void>
  read(path: string): Promise<NoteSnapshot>
  tier(root: string, path: string): Promise<'reference' | 'follow'>
  acceptsObject(path: string, expected: string, current: string): boolean
  ownerValid?: (owner:string)=>boolean
  memoryAuthorization?: (request:AgentCommandRequest)=>Promise<{signature:string;search:boolean;snapshotSignature?:string;disclosure?:AgentAuthorizationPreview['memory']}>
  /** 联网只读的可用性：`available` 管抓页，`search` 另要求服务与密钥可用；`native` 是模型自带联网选择。 */
  network?: () => { available: boolean; search: boolean; providerHost: string | null; native?: boolean; reason?: 'off' | 'not-configured' }
  /** 远端只读 MCP 的可用性：只在「有可解密的 token 且白名单非空」时为可用。 */
  mcp?: () => AgentMcpAvailability
  /** 本机是否已证明删除落点可用（库内已删除仍以系统废纸篓为最终出口）；预览只披露这个已有事实。 */
  deleteAvailable?: () => boolean
  configuration(extraReferences: boolean, modelRecordId: string, memorySearch?:boolean): AuthorizationConfiguration
}
/** 范围里的一篇笔记的元数据；列表只给路径与标题，正文另按 `validateRead` 逐篇核验。 */
export type ScopeNoteMeta = { relPath: string; title: string }
/** 活范围的一页：`offset/limit` 是元数据分页，不是正文分页；`total` 是本次实时枚举到的总数。 */
export type ScopePageRequest = { offset: number; limit: number }
export type ScopePage = { items: ScopeNoteMeta[]; total: number; complete: boolean }
/** 一次按需读的实际证明：权限、身份与修订都在调用那一刻核过，供账本与后续复核使用。 */
export type ScopeReadProof = {
  relPath: string
  sessionId: string
  objectVersion: string
  revision: string
  fingerprint: string
  tier: 'reference' | 'follow'
}
/** 一次按需读的正文与证明同源返回：核验与正文之间不再有第二个读窗口。 */
export type ScopeRead = { snapshot: NoteSnapshot; proof: ScopeReadProof }
/** 惰性范围：只冻结范围本身，不冻结来源清单。每次调用都用 `tree/read/tier` 实时核验。 */
export interface ScopeResolver {
  readonly scope: AgentScopeLevel
  readonly origin: string
  /** 范围的结构包含关系；只判路径，不判普通笔记／附件／权限，那些留给 `validateRead`。 */
  contains(relPath: string): boolean
  /** 逐篇核验：普通笔记、非附件、非禁区、会话未变、读前读后权限一致。 */
  validateRead(relPath: string, signal?: AbortSignal): Promise<ScopeRead>
  /** 实时枚举范围里的普通笔记（分页元数据），不冻结、不预读正文。 */
  list(page: ScopePageRequest): Promise<ScopePage>
  /** 结构操作（改名／挪／删）的目标：只在整库范围、非发起篇、普通笔记、可参考。 */
  assertStructuralTarget(relPath: string, signal?: AbortSignal): Promise<void>
  /** 引用修复来源：整库范围、非发起篇、普通笔记、当前可参考。会改正文，判据比结构目标更窄。 */
  assertLinkRepairSource(relPath: string, signal?: AbortSignal): Promise<void>
  /** 新建目标：只在发起篇所在目录；本篇范围不宣告建，调用也按越界拒。 */
  assertCreateTarget(relPath: string): Promise<void>
}
export interface TaskGrant {
  readonly id: string
  readonly root: string
  readonly sessionId: string
  readonly origin: string
  /** 作业范围：本篇／同册／整库。范围是冻结的，来源不是。 */
  readonly scope: AgentScopeLevel
  /** 预览时冻结的发起篇；其余来源按需快照，不在这里。 */
  readonly sources: readonly Readonly<AuthorizedSource>[]
  readonly credential: Readonly<ModelCredential>
  readonly limits: Readonly<RunLimits>
  readonly memorySnapshotSignature?:string
  /** 搜索/抓取闸（设备级）：任务开始时开启才有；撤销后为 undefined。 */
  readonly network?: Readonly<{ allowed: true; providerHost?: string }>
  /** 设备级 MCP：搜索类受闸，非搜索类不受；闸关时只剩非搜索组。 */
  readonly mcp?: Readonly<{ allowed: true; servers: readonly McpGrantServer[] }>
  assertActive(): void
  assertLive(action: AuthorizationAction, path?: string, signal?: AbortSignal): Promise<void>
  /** 未获准或已撤销联网时抛 `NETWORK_NOT_AUTHORIZED`，不改任务本身。 */
  assertNetwork(): void
  /** 「停止联网」只撤本场网络能力，不终止整场任务。 */
  revokeNetwork(): void
  /** 未获准或已撤销 MCP 时抛 `MCP_NOT_AUTHORIZED`，不改任务本身。 */
  assertMcp(): void
  /** 配置／白名单／凭据变化只撤 MCP，不取消任务。 */
  revokeMcp(): void
  /** 只核验范围合法性与发起篇快照；不比对全量来源（那是按需读的事）。 */
  validateSources(signal?: AbortSignal): Promise<void>
  /** 逐篇按需核验并记为实际来源；返回当次证明。 */
  validateRead(path: string, signal?: AbortSignal): Promise<ScopeRead>
  /** 范围里的普通笔记元数据页（实时枚举，不冻结）。 */
  list(page: ScopePageRequest, signal?: AbortSignal): Promise<ScopePage>
  contains(path: string): boolean
  /** 本场实际核验过的来源（含发起篇）；账本与受影响任务用它，而不是预览时的全量清单。 */
  actualSources(): readonly ScopeReadProof[]
  /** 结构操作目标：只在整库、非发起篇、普通笔记、可参考时放行。 */
  assertStructuralTarget(path: string, signal?: AbortSignal): Promise<void>
  /** 引用修复来源：整库、非发起篇、普通笔记、当前可参考；任一不满足整次结构操作失败。 */
  assertLinkRepairSource(path: string, signal?: AbortSignal): Promise<void>
  /** 新建目标：落点必须是发起篇所在目录。 */
  assertCreateTarget(path: string): Promise<void>
  assertWriteTarget(path: string): void
  /** 发起篇的现行核验基准：开场冻结，仅 acknowledgeOrigin 推进。 */
  readonly originProof: Readonly<AuthorizedSource>
  acknowledgeOrigin(snapshot: NoteSnapshot): void
  revoke(): void
}
/** 预览时冻结的联网可用性快照：start 必须逐项一致，防「确认后换目标主机或渠道」。 */
type NetworkAvailabilitySnapshot = { available: boolean; search: boolean; providerHost: string | null; native: boolean }
/** 预览时冻结的 MCP 可用性快照：服务器名／主机／白名单工具逐项一致才放行。
 *  只冻「有什么」，不冻 token 或服务器正文。 */
type Prepared = { owner: string; request: AgentCommandRequest; modelRecordId: string; view: AgentAuthorizationPreview; root: string; config: AuthorizationConfiguration; configHash: string; expires: number; memory?:{signature:string;search:boolean;snapshotSignature?:string}; scope: AgentScopeLevel; networkAvailable: NetworkAvailabilitySnapshot; mcpServers: readonly McpGrantServer[] }
const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const SCOPES: readonly AgentScopeLevel[] = ['note', 'folder', 'vault']
const MAX_SCOPE_META = 500
export const folderOf = (relPath: string): string => { const at = relPath.lastIndexOf('/'); return at < 0 ? '' : relPath.slice(0, at) }
function command(request: AgentCommandRequest): AgentCommandRequest {
  return {modelRecordId:request.modelRecordId,relPath:request.relPath,sessionId:request.sessionId,objectVersion:request.objectVersion,expectedRevision:request.expectedRevision,
    range:{...request.range},expectedText:request.expectedText,promptText:request.promptText}
}
function safePath(value: unknown): value is string {
  return typeof value==='string' && value.length>0 && value.length<=4096 && !value.includes('\\') && !value.startsWith('/') &&
    !value.split('/').some(part=>!part || part==='.' || part==='..' || part.startsWith('.') || /[\u0000-\u001f\u007f:]/u.test(part))
}
export function isAuthorizationCommand(value: unknown): value is AgentCommandRequest {
  if (!value || typeof value!=='object') return false
  const r=value as Partial<AgentCommandRequest>
  return typeof r.modelRecordId==='string' && /^[A-Za-z0-9-]{1,64}$/u.test(r.modelRecordId) && safePath(r.relPath) && typeof r.sessionId==='string' && typeof r.objectVersion==='string' && typeof r.expectedRevision==='string' &&
    typeof r.promptText==='string' && r.promptText.trim().length>0 && r.promptText.length<=20000 && typeof r.expectedText==='string' &&
    !!r.range && Number.isSafeInteger(r.range.start) && Number.isSafeInteger(r.range.end) && r.range.start>=0 && r.range.end>r.range.start
}

/** The native-backed tree establishes ownership, including filesystem aliases.
 * Dropping the whole attachment subtree prevents Markdown from becoming an Agent source. */
function ordinaryEntries(tree: TreeEntry[]): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>()
  const collect = (items: TreeEntry[]): void => {
    for (const item of items) {
      if (item.attachmentOf !== undefined) continue
      entries.set(item.relPath, item)
      if (item.children) collect(item.children)
    }
  }
  collect(tree)
  return entries
}
function assertOrdinaryNotes(entries: Map<string, TreeEntry>, paths: Iterable<string>): void {
  for (const path of paths) if (entries.get(path)?.kind !== 'note') throw Error('OUTSIDE_TASK_SCOPE')
}

/** 撤权、取消与换库不是「来源不合规」：这些控制错误必须原样透出，不能被归成范围拒绝。 */
function isLiveControlError(error: unknown): boolean {
  return error instanceof Error && (error.message === 'TASK_CANCELLED' || error.message === 'AUTHORIZATION_REVOKED' || error.message === 'VAULT_CHANGED')
}

async function verifyOrdinaryNotes(deps: AuthorizationDependencies, paths: readonly string[], check: () => void): Promise<void> {
  if (deps.assertOrdinaryNotes) await deps.assertOrdinaryNotes(paths)
  else {
    const tree = await deps.tree()
    check()
    assertOrdinaryNotes(ordinaryEntries(tree), paths)
  }
  check()
}

/** 惰性范围的唯一实现：不含任何来源清单，只有范围本身与实时的 tree/read/tier。 */
class LiveScopeResolver implements ScopeResolver {
  constructor(
    private readonly deps: Pick<AuthorizationDependencies, 'root' | 'session' | 'tree' | 'assertOrdinaryNotes' | 'read' | 'tier'>,
    readonly scope: AgentScopeLevel,
    readonly origin: string,
    private readonly guard: () => void
  ) {}

  contains(relPath: string): boolean {
    if (!safePath(relPath)) return false
    if (this.scope === 'note') return relPath === this.origin
    if (this.scope === 'vault') return true
    const folder = folderOf(this.origin)
    // 根目录不提供同册（预览与 consume 都以 FOLDER_SCOPE_AT_ROOT 拒）。
    if (!folder) return false
    return relPath === this.origin || relPath.startsWith(`${folder}/`)
  }

  private stop(signal?: AbortSignal): void {
    this.guard()
    if (signal?.aborted) throw Error('TASK_CANCELLED')
  }

  private async ordinary(path: string, signal?: AbortSignal): Promise<void> {
    this.stop(signal)
    await verifyOrdinaryNotes(this.deps as AuthorizationDependencies, [path], () => this.stop(signal))
  }

  async validateRead(relPath: string, signal?: AbortSignal): Promise<ScopeRead> {
    this.stop(signal)
    if (!this.contains(relPath)) throw Error('OUTSIDE_TASK_SCOPE')
    await this.ordinary(relPath, signal)
    const root = this.deps.root()
    if (!root) throw Error('NO_VAULT')
    const tier = await this.deps.tier(root, relPath)
    this.stop(signal)
    if (tier !== 'reference' && tier !== 'follow') throw Error('OUTSIDE_TASK_SCOPE')
    const snapshot = await this.deps.read(relPath)
    this.stop(signal)
    if (snapshot.sessionId !== this.deps.session()) throw Error('VAULT_CHANGED')
    const after = await this.deps.tier(root, relPath)
    this.stop(signal)
    if (after !== tier) throw Error('SOURCE_PERMISSION_CHANGED')
    // 读前读后都核一次归属：目录在这一刻变成附件夹也算失效。
    await this.ordinary(relPath, signal)
    return { snapshot, proof: { relPath, sessionId: snapshot.sessionId ?? this.deps.session() ?? '', objectVersion: snapshot.objectVersion, revision: snapshot.revision, fingerprint: digest(snapshot.content), tier } }
  }

  async list(page: ScopePageRequest): Promise<ScopePage> {
    this.guard()
    const offset = Number.isSafeInteger(page.offset) && page.offset > 0 ? page.offset : 0
    const limit = Math.max(1, Math.min(MAX_SCOPE_META, Number.isSafeInteger(page.limit) ? page.limit : MAX_SCOPE_META))
    const entries = ordinaryEntries(await this.deps.tree())
    this.guard()
    const notes = [...entries.values()]
      .filter(entry => entry.kind === 'note' && this.contains(entry.relPath))
      .map(entry => entry.relPath)
      .sort((a, b) => a === this.origin ? -1 : b === this.origin ? 1 : a.localeCompare(b))
    const items = notes.slice(offset, offset + limit).map(relPath => ({ relPath, title: noteTitle(relPath) }))
    return { items, total: notes.length, complete: offset + items.length >= notes.length }
  }

  async assertStructuralTarget(relPath: string, signal?: AbortSignal): Promise<void> {
    this.stop(signal)
    // 结构操作只在整库开放；同册／本篇不宣告也不放行。
    if (this.scope !== 'vault') throw Error('OUTSIDE_TASK_SCOPE')
    if (!this.contains(relPath)) throw Error('OUTSIDE_TASK_SCOPE')
    if (relPath === this.origin) throw Error('ORIGIN_LOCKED')
    if (!/\.md$/iu.test(relPath)) throw Error('OUTSIDE_TASK_SCOPE')
    await this.ordinary(relPath, signal)
    const root = this.deps.root()
    if (!root) throw Error('NO_VAULT')
    const tier = await this.deps.tier(root, relPath)
    this.stop(signal)
    // 必须遵循可读，但不能当结构对象（旧的门就是按 reference 卡）。
    if (tier !== 'reference') throw Error('OUTSIDE_TASK_SCOPE')
    const after = await this.deps.tier(root, relPath)
    this.stop(signal)
    if (after !== tier) throw Error('SOURCE_PERMISSION_CHANGED')
  }

  /** 引用修复来源的判据与结构目标分开：修复会写来源正文，所以来源必须整库、非发起篇、
   *  普通笔记、当前可参考；任一不满足，整次结构操作失败（不是只跳过这一条）。
   *  `LINK_REPAIR_OUT_OF_SCOPE` 表示当前就不在允许集合；`SOURCE_PERMISSION_CHANGED`
   *  表示两次核验之间档位变了。撤权／取消照旧原样透出，不折成范围拒绝。 */
  async assertLinkRepairSource(relPath: string, signal?: AbortSignal): Promise<void> {
    this.stop(signal)
    if (this.scope !== 'vault') throw Error('LINK_REPAIR_OUT_OF_SCOPE')
    if (!this.contains(relPath)) throw Error('LINK_REPAIR_OUT_OF_SCOPE')
    if (relPath === this.origin) throw Error('LINK_REPAIR_OUT_OF_SCOPE')
    if (!/\.md$/iu.test(relPath)) throw Error('LINK_REPAIR_OUT_OF_SCOPE')
    try { await this.ordinary(relPath, signal) }
    catch (error) {
      this.stop(signal)
      if (isLiveControlError(error)) throw error
      throw Error('LINK_REPAIR_OUT_OF_SCOPE')
    }
    const root = this.deps.root()
    if (!root) throw Error('LINK_REPAIR_OUT_OF_SCOPE')
    let tier: 'reference' | 'follow'
    try { tier = await this.deps.tier(root, relPath) }
    catch (error) {
      this.stop(signal)
      if (isLiveControlError(error)) throw error
      throw Error('LINK_REPAIR_OUT_OF_SCOPE')
    }
    this.stop(signal)
    if (tier !== 'reference') throw Error('LINK_REPAIR_OUT_OF_SCOPE')
    let after: 'reference' | 'follow'
    try { after = await this.deps.tier(root, relPath) }
    catch (error) {
      this.stop(signal)
      if (isLiveControlError(error)) throw error
      throw Error('SOURCE_PERMISSION_CHANGED')
    }
    this.stop(signal)
    if (after !== tier) throw Error('SOURCE_PERMISSION_CHANGED')
  }

  async assertCreateTarget(relPath: string): Promise<void> {
    this.guard()
    // 本篇不宣告建；落点固定在发起篇所在目录（合同：不让人挑目录）。
    if (this.scope === 'note') throw Error('OUTSIDE_TASK_SCOPE')
    if (!safePath(relPath)) throw Error('OUTSIDE_TASK_SCOPE')
    if (folderOf(relPath) !== folderOf(this.origin)) throw Error('OUTSIDE_TASK_SCOPE')
    if (relPath === this.origin) throw Error('TARGET_EXISTS')
  }
}

/** Ephemeral grants authorize purpose-bound operations, never a generic disk or network channel. */
export class TaskAuthorizationRegistry {
  private readonly previews = new Map<string, Prepared>()
  constructor(private readonly deps: AuthorizationDependencies) {}

  async preview(owner: string, request: AgentAuthorizationRequest): Promise<AgentAuthorizationPreview> {
    if (!owner || this.deps.ownerValid?.(owner)===false || !isAuthorizationCommand(request)) throw Error('BAD_REQUEST')
    // 旧四档与参考数组不再是授权形态：带着它们来就拒，而不是静默忽略。
    if ('references' in request || 'level' in request) throw Error('BAD_REQUEST')
    if (!SCOPES.includes(request.scope)) throw Error('BAD_REQUEST')
    const root=this.deps.root(); const session=this.deps.session()
    if(!root)throw Error('NO_VAULT')
    if(session!==request.sessionId)throw Error('VAULT_CHANGED')
    this.checkSession(root,session)
    // 同册＝发起篇所在目录；根目录笔记不提供同册（不是错误范围，是没这个选项）。
    if (request.scope === 'folder' && !folderOf(request.relPath)) throw Error('FOLDER_SCOPE_AT_ROOT')
    // 只解析发起篇，不枚举 folder/vault 的其他来源。
    const origin = await this.readOrigin(root, session, request)
    const memory=await this.deps.memoryAuthorization?.(command(request))
    this.checkSession(root,session)
    // 读搜是否宣告由范围决定：本篇只有回答写回，同册／整库才有读库搜库。
    const library = request.scope !== 'note'
    const config=structuredClone(this.deps.configuration(library, request.modelRecordId,memory?.search===true))
    // 联网可用性由主进程判定；抓页只看总闸，搜索另看服务配置。任一项不可用时勾选不生效，
    // start 也会因与预览不一致被拒。
    const availability = this.networkAvailability()
    const mcpServers = this.mcpGrantServers()
    const view:AgentAuthorizationPreview={id:randomUUID(),sessionId:session!,origin:request.relPath,sources:[origin],
      recipient:{modelId:config.credential.modelId,host:new URL(config.credential.baseURL).host,provider:config.credential.provider},
      scope:request.scope,
      canCreate:request.scope!=='note',
      canStructure:request.scope==='vault',
      canDelete:request.scope==='vault',
      deleteEnabled:this.deps.deleteAvailable?.()===true,
      ...(memory?.disclosure?{memory:{...memory.disclosure,search:{available:memory.search,calls:memory.search?4:0,sharedTools:config.limits.tools}}}:{})}
    for(const [id,p]of this.previews)if(p.expires<Date.now() || p.owner===owner)this.previews.delete(id)
    this.previews.set(view.id,{owner,request:command(request),view:structuredClone(view),modelRecordId:request.modelRecordId,root,config,configHash:digest(config),expires:Date.now()+300000,memory:memory?{signature:memory.signature,search:memory.search,...(memory.snapshotSignature?{snapshotSignature:memory.snapshotSignature}:{})}:undefined,scope:request.scope,networkAvailable:{available:availability.available,search:availability.search,providerHost:availability.providerHost,native:availability.native},mcpServers:mcpServers.map(server=>({...server,tools:[...server.tools]}))})
    return structuredClone(view)
  }

  /** 发起篇的预览快照：仍是唯一在预览期读取的正文。 */
  private async readOrigin(root: string, session: string, request: AgentAuthorizationRequest): Promise<AuthorizedSource> {
    const path = request.relPath
    await verifyOrdinaryNotes(this.deps, [path], () => this.checkSession(root, session))
    const tier = this.deps.tier(root, path)
    const first = await tier
    this.checkSession(root, session)
    if (first !== 'reference') throw Error('NOTE_NOT_REFERENCE')
    const snapshot = await this.deps.read(path)
    this.checkSession(root, session)
    if (snapshot.sessionId !== session) throw Error('VAULT_CHANGED')
    const latest = await this.deps.tier(root, path)
    this.checkSession(root, session)
    if (first !== latest) throw Error('STALE_AUTHORIZATION')
    const stale = snapshot.revision !== request.expectedRevision
      || (request.objectVersion !== snapshot.objectVersion && !this.deps.acceptsObject(path, request.objectVersion, snapshot.objectVersion))
    if (stale) throw Error('STALE_AUTHORIZATION')
    if (snapshot.content.slice(request.range.start, request.range.end) !== request.expectedText) throw Error('STALE_AUTHORIZATION')
    await verifyOrdinaryNotes(this.deps, [path], () => this.checkSession(root, session))
    return { sourceId: randomUUID(), relPath: path, title: noteTitle(path), sessionId: session, objectVersion: snapshot.objectVersion, revision: snapshot.revision, fingerprint: digest(snapshot.content), tier: first }
  }

  private networkAvailability(): { available: boolean; search: boolean; providerHost: string | null; native: boolean; reason?: 'off' | 'not-configured' } {
    try {
      const value = this.deps.network?.()
      if (!value) return { available: false, search: false, providerHost: null, native: false, reason: 'off' }
      const available = value.available === true
      // 搜索不可能独立于抓页可用：总闸关或本场未获准时一并置 false。
      return { available, search: available && value.search === true, providerHost: value.providerHost, native: available && value.native === true, ...(value.reason ? { reason: value.reason } : {}) }
    } catch { return { available: false, search: false, providerHost: null, native: false, reason: 'off' } }
  }

  /** 设备级 MCP 快照：启用＋白名单非空；搜索类带标记，闸关时由 LiveGrant 过滤。 */
  private mcpGrantServers(): readonly McpGrantServer[] {
    try {
      const value = this.deps.mcp?.()
      if (!value || value.available !== true || !Array.isArray(value.servers)) return []
      return value.servers.map(server => Object.freeze({ name: server.name, host: server.host, tools: Object.freeze([...server.tools]), searchChannel: server.searchChannel === true }))
    } catch { return [] }
  }

  clear(): void { this.previews.clear() }

  discard(owner:string,id:string):void {if(this.previews.get(id)?.owner===owner)this.previews.delete(id)}

  async consume(owner: string, request: AgentStartRequest): Promise<TaskGrant> {
    const prepared=this.previews.get(request.previewId)
    if(this.deps.ownerValid?.(owner)===false || !prepared || prepared.owner!==owner || prepared.expires<Date.now())throw Error('INVALID_AUTHORIZATION')
    // A legitimate caller consumes once, including stale submissions; retries need a new displayed preview.
    this.previews.delete(request.previewId)
    if(!isAuthorizationCommand(request) || request.modelRecordId!==prepared.modelRecordId || digest(command(request))!==digest(prepared.request))throw Error('STALE_AUTHORIZATION')
    // 范围必须与预览一致；本篇／同册／整库的差别不能靠 start 事后改。
    if (!SCOPES.includes(request.scope) || request.scope!==prepared.scope) throw Error('INVALID_AUTHORIZATION')
    if (request.scope === 'folder' && !folderOf(request.relPath)) throw Error('FOLDER_SCOPE_AT_ROOT')
    // 闸与 MCP 都是设备级：预览后换服务商／关闸／改动服务器，都要求重新预览。
    const availability=this.networkAvailability(), frozen=prepared.networkAvailable
    if(availability.available!==frozen.available||availability.search!==frozen.search||availability.providerHost!==frozen.providerHost||availability.native!==frozen.native)throw Error('INVALID_AUTHORIZATION')
    const mcp=this.mcpGrantServers()
    if(digest(mcp)!==digest(prepared.mcpServers))throw Error('INVALID_AUTHORIZATION')
    this.checkSession(prepared.root,prepared.view.sessionId)
    const library = prepared.scope !== 'note'
    if(digest(this.deps.configuration(library, prepared.modelRecordId,prepared.memory?.search===true))!==prepared.configHash)throw Error('STALE_AUTHORIZATION')
    await this.checkMemory(prepared)
    const grant=new LiveGrant(this.deps,prepared)
    await grant.validateSources()
    this.checkSession(prepared.root,prepared.view.sessionId)
    if(digest(this.deps.configuration(library, prepared.modelRecordId,prepared.memory?.search===true))!==prepared.configHash){
      grant.revoke()
      throw Error('STALE_AUTHORIZATION')
    }
    try { await this.checkMemory(prepared) } catch(error){grant.revoke();throw error}
    grant.assertActive()
    if(digest(this.deps.configuration(library,prepared.modelRecordId,prepared.memory?.search===true))!==prepared.configHash){grant.revoke();throw Error('STALE_AUTHORIZATION')}
    return grant
  }
  private async checkMemory(prepared:Prepared):Promise<void>{
    const current=await this.deps.memoryAuthorization?.(prepared.request)
    if(digest(current?{signature:current.signature,search:current.search,snapshotSignature:current.snapshotSignature}:null)!==digest(prepared.memory??null))throw Error('STALE_AUTHORIZATION')
    this.checkSession(prepared.root,prepared.view.sessionId)
  }
  private checkSession(root:string,session:string|null):void { if(this.deps.root()!==root || this.deps.session()!==session)throw Error('VAULT_CHANGED') }
}

class LiveGrant implements TaskGrant {
  readonly id: string
  readonly root: string
  readonly sessionId: string
  readonly origin: string
  readonly scope: AgentScopeLevel
  readonly sources: readonly Readonly<AuthorizedSource>[]
  readonly credential: Readonly<ModelCredential>
  readonly limits: Readonly<RunLimits>
  readonly memorySnapshotSignature?:string
  private live=true
  /** 搜索/抓取闸：停止后只关搜索/抓取类能力（含搜索类 MCP），任务照常收尾。 */
  private networkLive=false
  /** 设备级 MCP：配置变化撤销全部；搜索类另受闸控制。 */
  private mcpLive=false
  private readonly networkHost:string|null
  private readonly mcpServers:readonly McpGrantServer[]
  private readonly owner:string
  private readonly resolver: ScopeResolver
  /** 实际核验过的来源：账本与受影响任务只认这一份，不再有预览期全量清单。 */
  private readonly actual=new Map<string,ScopeReadProof>()
  originProof:AuthorizedSource
  constructor(private readonly deps:AuthorizationDependencies,prepared:Prepared){
    this.memorySnapshotSignature=prepared.memory?.snapshotSignature
    this.owner=prepared.owner;this.id=prepared.view.id;this.root=prepared.root;this.sessionId=prepared.view.sessionId;this.origin=prepared.view.origin
    this.scope=prepared.scope
    // 预览里只有发起篇：其余来源按需快照，不冻结。
    this.sources=Object.freeze(prepared.view.sources.map(s=>Object.freeze({...s})))
    this.originProof={...this.sources.find(s=>s.relPath===this.origin)!}
    this.credential=Object.freeze({...prepared.config.credential});this.limits=Object.freeze({...prepared.config.limits})
    this.networkLive=prepared.networkAvailable.available;this.networkHost=prepared.networkAvailable.providerHost
    // 冻结的是预览时那一版服务器与白名单工具；start 已经比对过，这里不再回存储重算。
    this.mcpLive=prepared.mcpServers.length>0
    this.mcpServers=Object.freeze(prepared.mcpServers.map(server=>Object.freeze({name:server.name,host:server.host,tools:Object.freeze([...server.tools]),searchChannel:server.searchChannel})))
    this.resolver=new LiveScopeResolver(deps,prepared.scope,prepared.view.origin,()=>this.assertActive())
  }
  get network(): Readonly<{allowed:true;providerHost?:string}>|undefined {
    return this.networkLive ? {allowed:true,...(this.networkHost?{providerHost:this.networkHost}:{})} : undefined
  }
  get mcp(): Readonly<{allowed:true;servers:readonly McpGrantServer[]}>|undefined {
    if(!this.mcpLive)return undefined
    const servers=this.mcpServers.filter(server=>!server.searchChannel||this.networkLive)
    return servers.length?{allowed:true,servers}:undefined
  }
  revoke():void {this.live=false}
  assertNetwork():void {
    if(!this.networkLive)throw Error('NETWORK_NOT_AUTHORIZED')
    this.assertActive()
  }
  revokeNetwork():void {this.networkLive=false}
  assertMcp():void {
    if(!this.mcpLive)throw Error('MCP_NOT_AUTHORIZED')
    this.assertActive()
  }
  revokeMcp():void {this.mcpLive=false}
  assertActive():void {
    if(!this.live||this.deps.ownerValid?.(this.owner)===false)throw Error('AUTHORIZATION_REVOKED')
    if(this.deps.root()!==this.root||this.deps.session()!==this.sessionId)throw Error('VAULT_CHANGED')
  }
  assertWriteTarget(path:string):void {if(path!==this.origin)throw Error('OUTSIDE_TASK_SCOPE')}
  contains(path:string):boolean {return this.resolver.contains(path)}
  actualSources():readonly ScopeReadProof[] {
    const origin=this.originProof
    return [{relPath:origin.relPath,sessionId:origin.sessionId,objectVersion:origin.objectVersion,revision:origin.revision,fingerprint:origin.fingerprint,tier:origin.tier},
      ...[...this.actual.values()].filter(proof=>proof.relPath!==this.origin)]
  }
  async validateRead(path:string,signal?:AbortSignal):Promise<ScopeRead>{
    this.assertActive()
    if(signal?.aborted)throw Error('TASK_CANCELLED')
    if(path===this.origin)return this.validateOrigin(signal)
    const read=await this.resolver.validateRead(path,signal)
    this.actual.set(path,{...read.proof})
    return read
  }
  async list(page:ScopePageRequest,signal?:AbortSignal):Promise<ScopePage>{
    this.assertActive()
    if(signal?.aborted)throw Error('TASK_CANCELLED')
    const result=await this.resolver.list(page)
    this.assertActive()
    return result
  }
  assertStructuralTarget(path:string,signal?:AbortSignal):Promise<void>{return this.resolver.assertStructuralTarget(path,signal)}
  assertLinkRepairSource(path:string,signal?:AbortSignal):Promise<void>{return this.resolver.assertLinkRepairSource(path,signal)}
  assertCreateTarget(path:string):Promise<void>{return this.resolver.assertCreateTarget(path)}
  acknowledgeOrigin(snapshot:NoteSnapshot):void {
    this.assertActive()
    if(snapshot.sessionId!==this.sessionId)throw Error('VAULT_CHANGED')
    this.originProof={...this.originProof,objectVersion:snapshot.objectVersion,revision:snapshot.revision,fingerprint:digest(snapshot.content)}
  }
  /** 发起篇的核验基准只在宿主写入回执时推进；并发核验从旧基准重试，不误伤自己的保存。 */
  private async validateOrigin(signal?:AbortSignal):Promise<ScopeRead>{
    const check = () => {
      this.assertActive()
      if (signal?.aborted) throw Error('TASK_CANCELLED')
    }
    await verifyOrdinaryNotes(this.deps,[this.origin],check)
    for(let attempt=0;attempt<8;attempt++){
      check()
      const proof=this.originProof
      const tier=await this.deps.tier(this.root,proof.relPath)
      check()
      if(tier!==proof.tier)throw Error('SOURCE_PERMISSION_CHANGED')
      const current=await this.deps.read(proof.relPath)
      check()
      const after=await this.deps.tier(this.root,proof.relPath)
      check()
      if(after!==proof.tier)throw Error('SOURCE_PERMISSION_CHANGED')
      if(current.sessionId!==this.sessionId)throw Error('VAULT_CHANGED')
      if(this.originProof!==proof)continue
      if(current.objectVersion!==proof.objectVersion&&!this.deps.acceptsObject(proof.relPath,proof.objectVersion,current.objectVersion))throw Error('SOURCE_REPLACED')
      if(current.revision!==proof.revision||digest(current.content)!==proof.fingerprint)throw Error('SOURCE_CHANGED')
      await verifyOrdinaryNotes(this.deps,[this.origin],check)
      // 发起篇就是 `sources` 里那一份，不重复记进实际来源表。
      return {snapshot:current,proof:{relPath:this.origin,sessionId:this.sessionId,objectVersion:current.objectVersion,revision:current.revision,fingerprint:digest(current.content),tier:proof.tier}}
    }
    throw Error('SOURCE_BUSY')
  }
  async assertLive(action:AuthorizationAction,path?:string,signal?:AbortSignal):Promise<void>{
    if(!this.live)throw Error('AUTHORIZATION_REVOKED')
    if(!['read','model','write'].includes(action))throw Error('ACTION_NOT_ALLOWED')
    if(action==='write')this.assertWriteTarget(path??'')
    if(action==='read'){await this.validateRead(path??'',signal);return}
    await this.validateSources(signal)
  }
  /** 只核验范围与发起篇快照；同册／整库的其他来源在读的那一刻逐篇核验。 */
  async validateSources(signal?:AbortSignal):Promise<void>{
    const check = () => {
      this.assertActive()
      if (signal?.aborted) throw Error('TASK_CANCELLED')
    }
    check()
    try {
      // 范围合法性：同册的发起篇不能在根目录（预览已拒，这里再核一次）。
      if (this.scope === 'folder' && !folderOf(this.origin)) throw Error('FOLDER_SCOPE_AT_ROOT')
      check()
      await this.validateOrigin(signal)
    }catch(error){this.live=false;throw error}
    check()
  }
}
