import { createHash, randomUUID } from 'node:crypto'
import type { AgentAuthorizationPreview, AgentAuthorizationRequest, AgentCommandRequest, AgentMcpAvailability, AgentMcpServerView, AgentStartRequest, AuthorizedSource, NoteSnapshot, TreeEntry } from '../shared/ipc.ts'
import type { ModelCredential, RunLimits } from './model-config.ts'
import { noteTitle } from '../shared/vault-rel.ts'

export type AuthorizationAction = 'read' | 'model' | 'write'
/** 一场获准的 MCP 服务器：只读名字／主机／白名单工具，token 与 schema 不在授权里。 */
export type McpGrantServer = { readonly name: string; readonly host: string; readonly tools: readonly string[] }
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
  /** 联网只读的可用性：`available` 管抓页，`search` 另要求服务与密钥可用；界面只拿摘要。 */
  network?: () => { available: boolean; search: boolean; providerHost: string | null; reason?: 'off' | 'not-configured' }
  /** 远端只读 MCP 的可用性：只在「有可解密的 token 且白名单非空」时为可用。 */
  mcp?: () => AgentMcpAvailability
  /** 本机是否已证明可送系统废纸篓；预览只披露这个已有事实，不改变删除门。 */
  deleteAvailable?: () => boolean
  configuration(extraReferences: boolean, modelRecordId: string, memorySearch?:boolean): AuthorizationConfiguration
}
export interface TaskGrant {
  readonly id: string
  readonly root: string
  readonly sessionId: string
  readonly origin: string
  readonly sources: readonly Readonly<AuthorizedSource>[]
  readonly credential: Readonly<ModelCredential>
  readonly limits: Readonly<RunLimits>
  readonly memorySnapshotSignature?:string
  /** 本场联网只读：只在预览时勾选、start 校验一致后才出现；撤销后为 undefined。 */
  readonly network?: Readonly<{ allowed: true; providerHost?: string }>
  /** 本场远端只读 MCP：冻结的是预览时看到的服务器与白名单工具；撤销后为 undefined。 */
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
  validateSources(signal?: AbortSignal): Promise<void>
  assertWriteTarget(path: string): void
  /** 发起篇的现行核验基准：开场冻结，仅 acknowledgeOrigin 推进。 */
  readonly originProof: Readonly<AuthorizedSource>
  acknowledgeOrigin(snapshot: NoteSnapshot): void
  revoke(): void
}
/** 预览时冻结的联网可用性快照：start 必须逐项一致，防「确认后换目标主机」。 */
type NetworkAvailabilitySnapshot = { available: boolean; search: boolean; providerHost: string | null }
/** 预览时冻结的 MCP 可用性快照：服务器名／主机／白名单工具逐项一致才放行。
 *  只冻「有什么」，不冻 token 或服务器正文。 */
type McpAvailabilitySnapshot = { available: boolean; servers: AgentMcpServerView[] }
type Prepared = { owner: string; request: AgentCommandRequest; modelRecordId: string; view: AgentAuthorizationPreview; root: string; config: AuthorizationConfiguration; configHash: string; expires: number; memory?:{signature:string;search:boolean;snapshotSignature?:string}; network: boolean; networkAvailability: NetworkAvailabilitySnapshot; mcp: boolean; mcpAvailability: McpAvailabilitySnapshot }
const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
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

async function verifyOrdinaryNotes(deps: AuthorizationDependencies, paths: readonly string[], check: () => void): Promise<void> {
  if (deps.assertOrdinaryNotes) await deps.assertOrdinaryNotes(paths)
  else {
    const tree = await deps.tree()
    check()
    assertOrdinaryNotes(ordinaryEntries(tree), paths)
  }
  check()
}

/** Ephemeral grants authorize purpose-bound operations, never a generic disk or network channel. */
export class TaskAuthorizationRegistry {
  private readonly previews = new Map<string, Prepared>()
  constructor(private readonly deps: AuthorizationDependencies) {}

  async preview(owner: string, request: AgentAuthorizationRequest): Promise<AgentAuthorizationPreview> {
    if (!owner || this.deps.ownerValid?.(owner)===false || !isAuthorizationCommand(request) || !Array.isArray(request.references) || request.references.length>1000 || !request.references.every(safePath)) throw Error('BAD_REQUEST')
    if (request.network !== undefined && typeof request.network !== 'boolean') throw Error('BAD_REQUEST')
    if (request.mcp !== undefined && typeof request.mcp !== 'boolean') throw Error('BAD_REQUEST')
    const root=this.deps.root(); const session=this.deps.session()
    if(!root)throw Error('NO_VAULT')
    if(session!==request.sessionId)throw Error('VAULT_CHANGED')
    const tree=await this.deps.tree()
    this.checkSession(root,session)
    const entries=ordinaryEntries(tree)
    const selected=new Set([request.relPath])
    for(const path of request.references){
      const entry=entries.get(path)
      if(!entry || entry.kind==='file')throw Error('OUTSIDE_TASK_SCOPE')
      if(entry.kind==='note')selected.add(path)
      else for(const item of entries.values())if(item.kind==='note' && item.relPath.startsWith(`${path}/`))selected.add(item.relPath)
    }
    if(selected.size>256)throw Error('AUTHORIZATION_SCOPE_TOO_LARGE')
    const sources:AuthorizedSource[]=[]
    for(const path of [...selected].sort((a,b)=>a===request.relPath?-1:b===request.relPath?1:a.localeCompare(b))){
      if(!safePath(path) || entries.get(path)?.kind!=='note')throw Error('OUTSIDE_TASK_SCOPE')
      const tier=await this.deps.tier(root,path)
      if(path===request.relPath && tier!=='reference')throw Error('NOTE_NOT_REFERENCE')
      const snapshot=await this.deps.read(path)
      const latestTier=await this.deps.tier(root,path)
      if(tier!==latestTier)throw Error('STALE_AUTHORIZATION')
      this.checkSession(root,session)
      if(snapshot.sessionId!==session)throw Error('VAULT_CHANGED')
      // 发起篇必须仍是同一个修订；对象版本只接受同一血脉或原值。
      const originStale = snapshot.revision!==request.expectedRevision
        || (request.objectVersion!==snapshot.objectVersion && !this.deps.acceptsObject(path,request.objectVersion,snapshot.objectVersion))
      if(path===request.relPath && originStale)throw Error('STALE_AUTHORIZATION')
      if(path===request.relPath && snapshot.content.slice(request.range.start,request.range.end)!==request.expectedText)throw Error('STALE_AUTHORIZATION')
      sources.push({sourceId:randomUUID(),relPath:path,title:noteTitle(path),sessionId:session!,objectVersion:snapshot.objectVersion,revision:snapshot.revision,fingerprint:digest(snapshot.content),tier})
    }
    await verifyOrdinaryNotes(this.deps, [...selected], () => this.checkSession(root, session))
    const memory=await this.deps.memoryAuthorization?.(command(request))
    this.checkSession(root,session)
    const config=structuredClone(this.deps.configuration(sources.length>1, request.modelRecordId,memory?.search===true))
    // 联网可用性由主进程判定；抓页只看总闸，搜索另看服务配置。任一项不可用时勾选不生效，
    // start 也会因与预览不一致被拒。
    const availability = this.networkAvailability()
    const requested = request.network === true && availability.available
    // 远端只读 MCP 同理：可用性由主进程判定（有可解密 token 且清单不超过 4 KiB），
    // 勾选不改变「本次预览看到了什么」，start 还要逐项比对。
    const mcpState = this.mcpAvailability()
    const mcpRequested = request.mcp === true && mcpState.available
    const view:AgentAuthorizationPreview={id:randomUUID(),sessionId:session!,origin:request.relPath,sources,
      recipient:{modelId:config.credential.modelId,host:new URL(config.credential.baseURL).host,provider:config.credential.provider},
      network:{available:availability.available,search:availability.search,providerHost:availability.providerHost,...(availability.reason?{reason:availability.reason}:{})},
      mcp:{available:mcpState.available,servers:mcpState.servers.map(server=>({...server,tools:[...server.tools]})),...(mcpState.reason?{reason:mcpState.reason}:{})},
      deleteEnabled:this.deps.deleteAvailable?.()===true,
      ...(memory?.disclosure?{memory:{...memory.disclosure,search:{available:memory.search,calls:memory.search?4:0,sharedTools:config.limits.tools}}}:{})}
    for(const [id,p]of this.previews)if(p.expires<Date.now() || p.owner===owner)this.previews.delete(id)
    this.previews.set(view.id,{owner,request:command(request),view:structuredClone(view),modelRecordId:request.modelRecordId,root,config,configHash:digest(config),expires:Date.now()+300000,memory:memory?{signature:memory.signature,search:memory.search,snapshotSignature:memory.snapshotSignature}:undefined,
      network:requested,networkAvailability:{available:availability.available,search:availability.search,providerHost:availability.providerHost},
      mcp:mcpRequested,mcpAvailability:{available:mcpState.available,servers:mcpState.servers.map(server=>({...server,tools:[...server.tools]}))}})
    return structuredClone(view)
  }

  private networkAvailability(): { available: boolean; search: boolean; providerHost: string | null; reason?: 'off' | 'not-configured' } {
    try {
      const value = this.deps.network?.()
      if (!value) return { available: false, search: false, providerHost: null, reason: 'off' }
      const available = value.available === true
      // 搜索不可能独立于抓页可用：总闸关或本场未获准时一并置 false。
      return { available, search: available && value.search === true, providerHost: value.providerHost, ...(value.reason ? { reason: value.reason } : {}) }
    } catch { return { available: false, search: false, providerHost: null, reason: 'off' } }
  }

  /** 可用性判定本身在 index.ts；这里只负责「不可用就一律按不可用记」与形状收敛。 */
  private mcpAvailability(): AgentMcpAvailability {
    try {
      const value = this.deps.mcp?.()
      const servers = Array.isArray(value?.servers) ? value.servers.map(server => ({ name: server.name, host: server.host, tools: [...server.tools] })) : []
      if (!value || value.available !== true) return { available: false, servers, reason: value?.reason ?? 'not-configured' }
      return { available: true, servers }
    } catch { return { available: false, servers: [], reason: 'not-configured' } }
  }

  clear(): void { this.previews.clear() }

  discard(owner:string,id:string):void {if(this.previews.get(id)?.owner===owner)this.previews.delete(id)}

  async consume(owner: string, request: AgentStartRequest): Promise<TaskGrant> {
    const prepared=this.previews.get(request.previewId)
    if(this.deps.ownerValid?.(owner)===false || !prepared || prepared.owner!==owner || prepared.expires<Date.now())throw Error('INVALID_AUTHORIZATION')
    // A legitimate caller consumes once, including stale submissions; retries need a new displayed preview.
    this.previews.delete(request.previewId)
    if(!isAuthorizationCommand(request) || request.modelRecordId!==prepared.modelRecordId || digest(command(request))!==digest(prepared.request))throw Error('STALE_AUTHORIZATION')
    // 网络勾选必须与预览时冻结的那一版一致：不一致按无效授权处理（防重放）。
    if(request.network!==undefined && typeof request.network!=='boolean')throw Error('INVALID_AUTHORIZATION')
    if((request.network===true)!==prepared.network)throw Error('INVALID_AUTHORIZATION')
    // 可用性快照逐项复核：预览后换服务商（目标主机变了）或关总闸，都要求重新预览，
    // 绝不静默按新配置启动。providerHost 也在比对里，口令卡显示的主机就是将要用的主机。
    const availability=this.networkAvailability(), frozen=prepared.networkAvailability
    if(availability.available!==frozen.available||availability.search!==frozen.search||availability.providerHost!==frozen.providerHost)throw Error('INVALID_AUTHORIZATION')
    // 远端只读 MCP 同一套纪律：勾选一致、可用性一致、服务器与白名单工具逐项一致。
    // 配置／白名单／凭据在预览后变过就要求重新预览，绝不按新清单静默启动。
    if(request.mcp!==undefined && typeof request.mcp!=='boolean')throw Error('INVALID_AUTHORIZATION')
    if((request.mcp===true)!==prepared.mcp)throw Error('INVALID_AUTHORIZATION')
    const mcp=this.mcpAvailability()
    if(mcp.available!==prepared.mcpAvailability.available||digest(mcp.servers)!==digest(prepared.mcpAvailability.servers))throw Error('INVALID_AUTHORIZATION')
    this.checkSession(prepared.root,prepared.view.sessionId)
    if(digest(this.deps.configuration(prepared.view.sources.length>1, prepared.modelRecordId,prepared.memory?.search===true))!==prepared.configHash)throw Error('STALE_AUTHORIZATION')
    await this.checkMemory(prepared)
    const grant=new LiveGrant(this.deps,prepared)
    await grant.validateSources()
    this.checkSession(prepared.root,prepared.view.sessionId)
    if(digest(this.deps.configuration(prepared.view.sources.length>1, prepared.modelRecordId,prepared.memory?.search===true))!==prepared.configHash){
      grant.revoke()
      throw Error('STALE_AUTHORIZATION')
    }
    try { await this.checkMemory(prepared) } catch(error){grant.revoke();throw error}
    grant.assertActive()
    if(digest(this.deps.configuration(prepared.view.sources.length>1,prepared.modelRecordId,prepared.memory?.search===true))!==prepared.configHash){grant.revoke();throw Error('STALE_AUTHORIZATION')}
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
  readonly sources: readonly Readonly<AuthorizedSource>[]
  readonly credential: Readonly<ModelCredential>
  readonly limits: Readonly<RunLimits>
  readonly memorySnapshotSignature?:string
  private live=true
  /** 联网能力独立于整场授权：停止联网只关这一项，任务照常收尾。 */
  private networkLive=false
  /** 远端只读 MCP 与联网是两条独立的门：任一条被撤都不影响另一条与整场授权。 */
  private mcpLive=false
  private readonly networkHost:string|null
  private readonly mcpServers:readonly McpGrantServer[]
  private readonly owner:string
  originProof:AuthorizedSource
  constructor(private readonly deps:AuthorizationDependencies,prepared:Prepared){
    this.memorySnapshotSignature=prepared.memory?.snapshotSignature
    this.owner=prepared.owner;this.id=prepared.view.id;this.root=prepared.root;this.sessionId=prepared.view.sessionId;this.origin=prepared.view.origin
    this.sources=Object.freeze(prepared.view.sources.map(s=>Object.freeze({...s})))
    this.originProof={...this.sources.find(s=>s.relPath===this.origin)!}
    this.credential=Object.freeze({...prepared.config.credential});this.limits=Object.freeze({...prepared.config.limits})
    this.networkLive=prepared.network;this.networkHost=prepared.networkAvailability.providerHost
    // 冻结的是预览时那一版服务器与白名单工具；start 已经比对过，这里不再回存储重算。
    this.mcpLive=prepared.mcp
    this.mcpServers=Object.freeze(prepared.mcpAvailability.servers.map(server=>Object.freeze({name:server.name,host:server.host,tools:Object.freeze([...server.tools])})))
  }
  get network(): Readonly<{allowed:true;providerHost?:string}>|undefined {
    return this.networkLive ? {allowed:true,...(this.networkHost?{providerHost:this.networkHost}:{})} : undefined
  }
  get mcp(): Readonly<{allowed:true;servers:readonly McpGrantServer[]}>|undefined {
    return this.mcpLive ? {allowed:true,servers:this.mcpServers} : undefined
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
  acknowledgeOrigin(snapshot:NoteSnapshot):void {
    this.assertActive()
    if(snapshot.sessionId!==this.sessionId)throw Error('VAULT_CHANGED')
    this.originProof={...this.originProof,objectVersion:snapshot.objectVersion,revision:snapshot.revision,fingerprint:digest(snapshot.content)}
  }
  async assertLive(action:AuthorizationAction,path?:string,signal?:AbortSignal):Promise<void>{
    if(!this.live)throw Error('AUTHORIZATION_REVOKED')
    if(!['read','model','write'].includes(action))throw Error('ACTION_NOT_ALLOWED')
    if(action==='write')this.assertWriteTarget(path??'')
    if(action==='read' && !this.sources.some(s=>s.relPath===path))throw Error('OUTSIDE_TASK_SCOPE')
    await this.validateSources(signal)
  }
  async validateSources(signal?:AbortSignal):Promise<void>{
    const check = () => {
      this.assertActive()
      if (signal?.aborted) throw Error('TASK_CANCELLED')
    }
    check()
    try {
      const paths = this.sources.map(source => source.relPath)
      await verifyOrdinaryNotes(this.deps, paths, check)
      for (const source of this.sources) {
        let verified = false
        for (let attempt = 0; attempt < 8; attempt++) {
          check()
          const proof = source.relPath === this.origin ? this.originProof : source
          const tier = await this.deps.tier(this.root, proof.relPath)
          check()
          if (tier !== proof.tier) throw Error('SOURCE_PERMISSION_CHANGED')
          const current = await this.deps.read(proof.relPath)
          check()
          const after = await this.deps.tier(this.root, proof.relPath)
          check()
          if (after !== proof.tier) throw Error('SOURCE_PERMISSION_CHANGED')
          if (current.sessionId !== this.sessionId) throw Error('VAULT_CHANGED')
          // Only a verified Host write or necessary migration receipt replaces this proof. A concurrent
          // verification must restart from it, rather than revoke a legitimate own save.
          if (source.relPath === this.origin && proof !== this.originProof) continue
          if (current.objectVersion !== proof.objectVersion && !this.deps.acceptsObject(proof.relPath, proof.objectVersion, current.objectVersion)) throw Error('SOURCE_REPLACED')
          if (current.revision !== proof.revision || digest(current.content) !== proof.fingerprint) throw Error('SOURCE_CHANGED')
          verified = true
          break
        }
        if (!verified) throw Error('SOURCE_BUSY')
      }
      await verifyOrdinaryNotes(this.deps, paths, check)
    }catch(error){this.live=false;throw error}
    check()
  }
}
