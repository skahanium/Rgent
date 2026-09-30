import { createHash, randomUUID } from 'node:crypto'
import type { AgentAuthorizationPreview, AgentAuthorizationRequest, AgentCommandRequest, AgentStartRequest, AuthorizedSource, NoteSnapshot, TreeEntry } from '../shared/ipc.ts'
import type { ModelCredential, RunLimits } from './model-config.ts'
import { noteTitle } from '../shared/vault-rel.ts'

export type AuthorizationAction = 'read' | 'model' | 'write'
export type AuthorizationConfiguration = { credential: ModelCredential; limits: RunLimits }
export type AuthorizationDependencies = {
  root(): string | null
  session(): string | null
  tree(): Promise<TreeEntry[]>
  read(path: string): Promise<NoteSnapshot>
  tier(root: string, path: string): Promise<'reference' | 'follow'>
  acceptsObject(path: string, expected: string, current: string): boolean
  ownerValid?: (owner:string)=>boolean
  configuration(extraReferences: boolean): AuthorizationConfiguration
}
export interface TaskGrant {
  readonly id: string
  readonly root: string
  readonly sessionId: string
  readonly origin: string
  readonly sources: readonly Readonly<AuthorizedSource>[]
  readonly credential: Readonly<ModelCredential>
  readonly limits: Readonly<RunLimits>
  assertLive(action: AuthorizationAction, path?: string, signal?: AbortSignal): Promise<void>
  validateSources(signal?: AbortSignal): Promise<void>
  assertWriteTarget(path: string): void
  acknowledgeOrigin(snapshot: NoteSnapshot): void
  revoke(): void
}
type Prepared = { owner: string; request: AgentCommandRequest; view: AgentAuthorizationPreview; root: string; config: AuthorizationConfiguration; configHash: string; expires: number }
const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
function command(request: AgentCommandRequest): AgentCommandRequest {
  return {relPath:request.relPath,sessionId:request.sessionId,objectVersion:request.objectVersion,expectedRevision:request.expectedRevision,
    range:{...request.range},expectedText:request.expectedText,promptText:request.promptText}
}
function safePath(value: unknown): value is string {
  return typeof value==='string' && value.length>0 && value.length<=4096 && !value.includes('\\') && !value.startsWith('/') &&
    !value.split('/').some(part=>!part || part==='.' || part==='..' || part.startsWith('.') || /[\u0000-\u001f\u007f:]/u.test(part))
}
export function isAuthorizationCommand(value: unknown): value is AgentCommandRequest {
  if (!value || typeof value!=='object') return false
  const r=value as Partial<AgentCommandRequest>
  return safePath(r.relPath) && typeof r.sessionId==='string' && typeof r.objectVersion==='string' && typeof r.expectedRevision==='string' &&
    typeof r.promptText==='string' && r.promptText.trim().length>0 && r.promptText.length<=20000 && typeof r.expectedText==='string' &&
    !!r.range && Number.isSafeInteger(r.range.start) && Number.isSafeInteger(r.range.end) && r.range.start>=0 && r.range.end>r.range.start
}

/** Ephemeral grants authorize purpose-bound operations, never a generic disk or network channel. */
export class TaskAuthorizationRegistry {
  private readonly previews = new Map<string, Prepared>()
  constructor(private readonly deps: AuthorizationDependencies) {}

  async preview(owner: string, request: AgentAuthorizationRequest): Promise<AgentAuthorizationPreview> {
    if (!owner || this.deps.ownerValid?.(owner)===false || !isAuthorizationCommand(request) || !Array.isArray(request.references) || request.references.length>1000 || !request.references.every(safePath)) throw Error('BAD_REQUEST')
    const root=this.deps.root(); const session=this.deps.session()
    if(!root)throw Error('NO_VAULT')
    if(session!==request.sessionId)throw Error('VAULT_CHANGED')
    const tree=await this.deps.tree()
    this.checkSession(root,session)
    const entries=new Map<string,TreeEntry>()
    function collect(items:TreeEntry[]) { for(const item of items){entries.set(item.relPath,item);if(item.children)collect(item.children)} }
    collect(tree)
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
      if(path===request.relPath && (snapshot.revision!==request.expectedRevision || !this.deps.acceptsObject(path,request.objectVersion,snapshot.objectVersion) && request.objectVersion!==snapshot.objectVersion))throw Error('STALE_AUTHORIZATION')
      if(path===request.relPath && snapshot.content.slice(request.range.start,request.range.end)!==request.expectedText)throw Error('STALE_AUTHORIZATION')
      sources.push({sourceId:randomUUID(),relPath:path,title:noteTitle(path),sessionId:session!,objectVersion:snapshot.objectVersion,revision:snapshot.revision,fingerprint:digest(snapshot.content),tier})
    }
    const config=structuredClone(this.deps.configuration(sources.length>1))
    const view:AgentAuthorizationPreview={id:randomUUID(),sessionId:session!,origin:request.relPath,sources,
      recipient:{modelId:config.credential.modelId,host:new URL(config.credential.baseURL).host,provider:config.credential.provider}}
    for(const [id,p]of this.previews)if(p.expires<Date.now() || p.owner===owner)this.previews.delete(id)
    this.previews.set(view.id,{owner,request:command(request),view:structuredClone(view),root,config,configHash:digest(config),expires:Date.now()+300000})
    return structuredClone(view)
  }

  discard(owner:string,id:string):void {if(this.previews.get(id)?.owner===owner)this.previews.delete(id)}

  async consume(owner: string, request: AgentStartRequest): Promise<TaskGrant> {
    const prepared=this.previews.get(request.previewId)
    if(this.deps.ownerValid?.(owner)===false || !prepared || prepared.owner!==owner || prepared.expires<Date.now())throw Error('INVALID_AUTHORIZATION')
    // A legitimate caller consumes once, including stale submissions; retries need a new displayed preview.
    this.previews.delete(request.previewId)
    if(!isAuthorizationCommand(request) || digest(command(request))!==digest(prepared.request))throw Error('STALE_AUTHORIZATION')
    this.checkSession(prepared.root,prepared.view.sessionId)
    if(digest(this.deps.configuration(prepared.view.sources.length>1))!==prepared.configHash)throw Error('STALE_AUTHORIZATION')
    const grant=new LiveGrant(this.deps,prepared)
    await grant.validateSources()
    return grant
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
  private live=true
  private readonly owner:string
  private originProof:AuthorizedSource
  constructor(private readonly deps:AuthorizationDependencies,prepared:Prepared){
    this.owner=prepared.owner;this.id=prepared.view.id;this.root=prepared.root;this.sessionId=prepared.view.sessionId;this.origin=prepared.view.origin
    this.sources=Object.freeze(prepared.view.sources.map(s=>Object.freeze({...s})))
    this.originProof={...this.sources.find(s=>s.relPath===this.origin)!}
    this.credential=Object.freeze({...prepared.config.credential});this.limits=Object.freeze({...prepared.config.limits})
  }
  revoke():void {this.live=false}
  assertWriteTarget(path:string):void {if(path!==this.origin)throw Error('OUTSIDE_TASK_SCOPE')}
  acknowledgeOrigin(snapshot:NoteSnapshot):void {
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
      if (!this.live || this.deps.ownerValid?.(this.owner) === false) throw Error('AUTHORIZATION_REVOKED')
      if (signal?.aborted) throw Error('TASK_CANCELLED')
      if (this.deps.root() !== this.root || this.deps.session() !== this.sessionId) throw Error('VAULT_CHANGED')
    }
    check()
    try {
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
          // Only a successful Host write receipt may replace this proof. A concurrent
          // verification must restart from it, rather than revoke a legitimate own save.
          if (source.relPath === this.origin && proof !== this.originProof) continue
          if (current.objectVersion !== proof.objectVersion && !this.deps.acceptsObject(proof.relPath, proof.objectVersion, current.objectVersion)) throw Error('SOURCE_REPLACED')
          if (current.revision !== proof.revision || digest(current.content) !== proof.fingerprint) throw Error('SOURCE_CHANGED')
          verified = true
          break
        }
        if (!verified) throw Error('SOURCE_BUSY')
      }
    }catch(error){this.live=false;throw error}
    check()
  }
}
