import { randomUUID } from 'node:crypto'
import type { MemoryCommitRequest, MemoryConfigRequest, MemoryEditRequest, MemoryEntry, MemoryEntryView, MemoryItemRequest, MemoryJobRequest, MemoryManualRequest, MemoryPreview, MemoryResult, MemorySessionRequest, MemorySnapshot, MemorySource, MemorySourceView, MemoryView } from '../shared/memory.ts'
import type { MemoryStore } from './memory-store.ts'
import type { ModelConfigStore } from './model-config.ts'
import type { MemoryConsolidationService } from './memory-consolidation.ts'
import type { VaultSession } from './vault.ts'

const codes = new Set(['MEMORY_RECORD_INVALID','MEMORY_SOURCE_NONCANONICAL','MEMORY_OUTPUT_TOKEN_LIMIT','MEMORY_INPUT_LIMIT','MEMORY_MODEL_CAPACITY','MEMORY_TARGET_INVALID','MEMORY_TOOLS_FORBIDDEN','MEMORY_JOB_BUSY','MEMORY_RELOCATION_IDENTITY_UNKNOWN','MEMORY_INVALID','MEMORY_REPLACED','MEMORY_CHANGED','MEMORY_MODEL_UNAVAILABLE','MEMORY_PERMISSION_DISABLED','MEMORY_CONSOLIDATION_FAILED','MEMORY_PERMISSION_CHANGED','MEMORY_DEADLINE','MEMORY_QUEUE_FULL','MEMORY_CALL_LIMIT','MEMORY_OUTPUT_LIMIT','MEMORY_SESSION_CLOSED','MEMORY_JOB_MISSING','BAD_REQUEST','STALE_SESSION','VAULT_CHANGED','NO_VAULT','STALE_PREVIEW','MEMORY_CONFLICT','MEMORY_UNAVAILABLE','MEMORY_CONFIG_UNAVAILABLE','NO_MEMORY_MODEL','UNKNOWN_MODEL','KEY_DECRYPT_FAILED','MEMORY_DISABLED','BAD_MEMORY_LIMITS','BAD_MEMORY_CONFIG','BAD_MEMORY_EDIT','MEMORY_PIN_FAILED','MEMORY_FILE_LIMIT','MEMORY_ENTRY_LIMIT','MEMORY_CONTENT_LIMIT','MEMORY_SOURCE_LIMIT','MEMORY_SOURCE_CHANGED','MEMORY_SOURCE_REPLACED','MEMORY_SOURCE_FORBIDDEN','MEMORY_SOURCE_PERMISSION','MEMORY_SOURCE_UNKNOWN','MEMORY_SOURCE_AMBIGUOUS','MEMORY_SOURCE_RANGE','MEMORY_SOURCE_UNCONFIRMED','MEMORY_SOURCE_IDENTITY_CHANGED','MEMORY_SOURCE_NOT_VERIFIED','MEMORY_DEPENDENCY_CHANGED','MEMORY_DEPENDENCY_INVALID','MEMORY_CONFIRMATION_REQUIRED','MEMORY_MATERIAL_FORGOTTEN','MEMORY_MATERIAL_UNVERIFIED','MEMORY_MATERIAL_CHANGED','MEMORY_JOB_UNAVAILABLE','MEMORY_RETRY_UNAVAILABLE','MEMORY_RETRY_BUSY','MEMORY_STORAGE_INVALID','MEMORY_STORAGE_REPLACED','MEMORY_STORAGE_CHANGED','MEMORY_REVOKED','MEMORY_CANCELLED','MEMORY_INTERRUPTED','NONCANONICAL_PATH','LIFECYCLE_RECOVERY_REQUIRED','BAD_MODEL_CONFIG','IO_ERROR'])
export function publicMemoryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const code = raw.split(':')[0]!
  return codes.has(code) ? code : 'MEMORY_UNAVAILABLE'
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/u.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))
const text = (v: unknown, max: number): v is string => typeof v === 'string' && Buffer.byteLength(v) <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v)
const note = (v: unknown): v is string => str(v, 4096) && !v.startsWith('/') && !v.includes('\\') && !/^[a-z]:/iu.test(v) && !v.split('/').some(p => !p || p === '..' || p === '.' || p.startsWith('.')) && v.endsWith('.md')
export type MemoryOperation = 'get' | 'config' | 'manual' | 'commit' | 'edit' | 'disable' | 'forget' | 'restore' | 'retry' | 'cancel'
export function parseMemoryRequest(op: MemoryOperation, value: unknown): Record<string, unknown> | null {
  if (!obj(value) || !str(value.sessionId)) return null
  let allowed = ['sessionId']
  if (op === 'config') {
    allowed.push('target')
    if (value.target === 'default') { allowed.push('modelId'); if (value.modelId !== null && !str(value.modelId,64)) return null }
    else if (value.target === 'vault') {
      allowed.push('vault'); const v=value.vault
      if (!obj(v) || !keys(v,['enabled','override']) || typeof v.enabled !== 'boolean' || !obj(v.override)) return null
      if(v.override.mode==='inherit'){if(!keys(v.override,['mode']))return null}
      else if(v.override.mode==='model'){if(!keys(v.override,['mode','modelId'])||!str(v.override.modelId,64))return null}
      else return null
    } else if (value.target === 'limits') {
      allowed.push('limits'); const v=value.limits
      if(!obj(v)||!keys(v,['seconds','calls','tools'])||!Number.isSafeInteger(v.seconds)||Number(v.seconds)<1||Number(v.seconds)>600||!Number.isSafeInteger(v.calls)||Number(v.calls)<1||Number(v.calls)>4||v.tools!==0)return null
    } else return null
  } else if(op==='manual') {
    allowed.push('relPath','objectVersion','revision','kind','taskId','start','end')
    if(!note(value.relPath)||!str(value.objectVersion,512)||!hash(value.revision)||!['body','ledger'].includes(String(value.kind))||!Number.isSafeInteger(value.start)||Number(value.start)<0||!Number.isSafeInteger(value.end)||Number(value.end)<=Number(value.start)||Number(value.end)-Number(value.start)>4096)return null
    if(value.kind==='ledger'?!str(value.taskId):value.taskId!==undefined)return null
  } else if(op==='commit') {
    allowed.push('id','content','layer','scope')
    if(!str(value.id)||value.content!==undefined&&!text(value.content,4096)||value.layer!==undefined&&!['core','demand'].includes(String(value.layer))||value.scope!==undefined&&!text(value.scope,512))return null
  } else if(op==='retry'||op==='cancel') {
    allowed.push('taskId','materialVersion'); if(!str(value.taskId)||!hash(value.materialVersion))return null
  } else if(op!=='get') {
    allowed.push('revision','objectVersion','id','version')
    if(value.revision!==null&&!hash(value.revision)||value.objectVersion!==null&&!str(value.objectVersion,512)||!str(value.id)||!Number.isSafeInteger(value.version)||Number(value.version)<1)return null
    if(op==='edit'){allowed.push('content','layer','scope');if(!text(value.content,4096)||!value.content.trim()||!['core','demand'].includes(String(value.layer))||!text(value.scope,512))return null}
  }
  return keys(value,allowed) ? value : null
}
const sourceView = (s: MemorySource): MemorySourceView => ({relPath:s.relPath,kind:s.kind,taskId:s.taskId,text:s.text,classification:s.classification})
const entryView = (e: MemoryEntry): MemoryEntryView => ({id:e.id,version:e.version,content:e.content,layer:e.layer,scope:e.scope,status:e.status,reason:e.reason?publicMemoryError(e.reason):null,updatedAt:e.updatedAt,sources:e.sources.map(sourceView),...(e.pendingTarget?{pendingTarget:{...e.pendingTarget}}:{})})
type PreviewAuthority = { owner: string; expires: number; snapshot: MemorySnapshot; view: MemoryPreview; source?: MemorySource; entry?: MemoryEntry; job?: MemoryJobRequest; retrySignature?: string }
export type MemoryIpcPorts = { vault(): VaultSession | null; config(): ModelConfigStore | null; service(): MemoryConsolidationService | null; recheck(vault: VaultSession, session: string): Promise<void> }
/** Bounded one-use previews stay in main; renderer never supplies sources or records. */
export function createMemoryIpc(ports: MemoryIpcPorts) {
  const previews = new Map<string, PreviewAuthority>()
  const current = (session:string) => {const vault=ports.vault();if(!vault)throw Error('NO_VAULT');vault.assertSession(session);return vault}
  const config = () => {const c=ports.config();if(!c)throw Error('MEMORY_CONFIG_UNAVAILABLE');return c}
  const check = (vault:VaultSession,session:string) => {if(vault!==ports.vault())throw Error('VAULT_CHANGED');vault.assertSession(session)}
  const expected = async (store:MemoryStore,r:MemoryItemRequest) => {const s=await store.managementSnapshot();if(s.revision!==r.revision||s.objectVersion!==r.objectVersion)throw Error('MEMORY_CONFLICT');return s}
  const rememberPreview = (authority:PreviewAuthority):MemoryPreview => {
    for(const [id,p] of previews)if(p.expires<Date.now()||p.snapshot.sessionId!==authority.snapshot.sessionId)previews.delete(id)
    if(previews.size>=64)previews.delete(previews.keys().next().value!)
    previews.set(authority.view.id,authority);return authority.view
  }
  async function view(vault:VaultSession,session:string):Promise<MemoryView>{
    const store=vault.memory(),c=config(),ctx=vault.memoryContext()
    let snapshot:MemorySnapshot|null=null,entries:MemoryEntryView[]=[],reason:string|undefined
    try{await store.list();snapshot=await store.managementSnapshot();entries=snapshot.record.entries.map(entryView)}catch(e){reason=publicMemoryError(e);try{snapshot=await store.managementSnapshot();entries=snapshot.record.entries.map(entryView)}catch{}}
    check(vault,session)
    const cfg=c.getMemoryConfig(ctx.vaultKey)
    let recipient:MemoryView['recipient']=null
    if(cfg.modelStatus==='ready'){const credential=c.memoryCredential(ctx.vaultKey);recipient={modelId:credential.modelId,host:new URL(credential.baseURL).host}}
    const jobViews: MemoryView['jobs'] = (snapshot?.record.jobs??[]).map(j=>({taskId:j.taskId,materialVersion:j.materialVersion,outcome:j.outcome,...(j.reason?{reason:publicMemoryError(j.reason)}:{}),retryable:!!j.material&&(j.outcome==='rejected'||j.outcome==='interrupted')}))
    for (const result of ports.service()?.results(session) ?? []) if (!jobViews.some(j=>j.taskId===result.taskId)) jobViews.push({taskId:result.taskId,materialVersion:result.materialVersion??null,outcome:result.status,reason:result.reason?publicMemoryError(result.reason):undefined,retryable:false})
    check(vault,session)
    return {sessionId:session,revision:snapshot?.revision??null,objectVersion:snapshot?.objectVersion??null,config:cfg,recipient,status:reason?'invalid':'ready',...(reason?{reason}:{}),entries,jobs:jobViews,running:ports.service()?.state()??{permits:0,pending:0,active:0}}
  }
  return {
    clear(){previews.clear()},
    async handle(owner:string,op:MemoryOperation,value:unknown):Promise<MemoryResult<MemoryView|MemoryPreview>>{
      try{
        const parsed=parseMemoryRequest(op,value);if(!parsed)throw Error('BAD_REQUEST')
        const r=parsed as unknown as MemorySessionRequest,vault=current(r.sessionId),store=vault.memory(),ctx=vault.memoryContext()
        if(op==='get')return {ok:true,value:await view(vault,r.sessionId)}
        if(op==='config'){
          const request=parsed as unknown as MemoryConfigRequest,c=config()
          if(request.target==='default')c.setMemoryDefault(request.modelId)
          else if(request.target==='limits')c.updateMemoryLimits(request.limits)
          else c.setVaultMemory(ctx.vaultKey,request.vault)
        } else if(op==='manual'){
          const request=parsed as unknown as MemoryManualRequest
          const snapshot=await store.snapshot(),source=await store.createManualSource(request)
          check(vault,r.sessionId)
          const preview:MemoryPreview={id:randomUUID(),sessionId:r.sessionId,kind:'manual',content:source.text,layer:'demand',scope:'当前库',sources:[sourceView(source)],warning:'确认后建立新的记忆依据；不会恢复已遗忘条目的旧版本。'}
          return {ok:true,value:rememberPreview({owner,expires:Date.now()+300000,snapshot,source,view:preview})}
        } else if(op==='restore'){
          const request=parsed as unknown as MemoryItemRequest,snapshot=await expected(store,request),entry=snapshot.record.entries.find(e=>e.id===request.id&&e.version===request.version)
          if(!entry)throw Error('MEMORY_CONFLICT')
          for(const source of entry.sources)if(!await store.verifySource(source))throw Error('MEMORY_SOURCE_CHANGED')
          check(vault,r.sessionId)
          const target=entry.pendingTarget?snapshot.record.entries.find(e=>e.id===entry.pendingTarget!.id&&e.version===entry.pendingTarget!.version):undefined
          if(entry.pendingTarget&&!target)throw Error('MEMORY_CONFLICT')
          const preview:MemoryPreview={id:randomUUID(),sessionId:r.sessionId,kind:entry.pendingTarget?'confirm':'restore',content:entry.content,layer:entry.layer,scope:entry.scope,sources:[...(target?.sources??[]),...entry.sources].map(sourceView),warning:entry.pendingTarget?'确认将以候选内容替换当前条目。':'来源已重新核验。确认后恢复这一版本的记忆。',...(target?{previousContent:target.content}:{})}
          return {ok:true,value:rememberPreview({owner,expires:Date.now()+300000,snapshot,entry,view:preview})}
        } else if(op==='retry'){
          const request=parsed as unknown as MemoryJobRequest,service=ports.service();if(!service)throw Error('MEMORY_UNAVAILABLE')
          const snapshot=await store.snapshot(),job=await store.job(request.taskId,request.materialVersion),retry=await service.retryPreview(request.taskId,request.materialVersion)
          if(!snapshot.record.jobs.find(j=>j.taskId===request.taskId&&j.materialVersion===request.materialVersion)?.material)throw Error(retry.reason??'MEMORY_RETRY_UNAVAILABLE')
          if(!retry.model||!config().getMemoryConfig(ctx.vaultKey).vault.enabled)throw Error('MEMORY_DISABLED')
          check(vault,r.sessionId)
          const preview:MemoryPreview={id:randomUUID(),sessionId:r.sessionId,kind:'retry',content:`仅重试这场已保存且仍可核验的有限材料。必要结果（未确认）：${job.material?.result??''}`,layer:'demand',scope:'当前库',sources:job.material!.sources.map(sourceView),warning:'独立整理授权：发送任务口令、必要结果、实际授权来源片段和相关记忆；不含思维链或完整历史。',recipient:{modelId:retry.model.modelId,host:retry.model.endpointHost},limits:retry.limits}
          return {ok:true,value:rememberPreview({owner,expires:Date.now()+300000,snapshot,job:request,retrySignature:JSON.stringify(retry),view:preview})}
        } else if(op==='commit'){
          const request=parsed as unknown as MemoryCommitRequest,p=previews.get(request.id)
          previews.delete(request.id)
          if(!p||p.owner!==owner||p.expires<Date.now()||p.snapshot.sessionId!==r.sessionId)throw Error('STALE_PREVIEW')
          check(vault,r.sessionId)
          if(p.source){
            if(!text(request.content,4096)||!request.content.trim()||!['core','demand'].includes(String(request.layer))||!text(request.scope,512))throw Error('BAD_REQUEST')
            await store.remember(p.snapshot,{content:request.content,layer:request.layer!,scope:request.scope,sources:[p.source],explicit:true})
          }else{
            if(request.content!==undefined||request.layer!==undefined||request.scope!==undefined)throw Error('BAD_REQUEST')
            if(p.job){const after=await store.snapshot();if(after.revision!==p.snapshot.revision||after.objectVersion!==p.snapshot.objectVersion)throw Error('MEMORY_CONFLICT');const service=ports.service()!;check(vault,r.sessionId);await service.retry(p.job.taskId,p.job.materialVersion,p.retrySignature)}
            else if(p.entry?.pendingTarget)await store.confirmPending(p.snapshot,p.entry.id,p.entry.version,p.entry.pendingTarget)
            else if(p.entry)await store.resume(p.snapshot,p.entry.id,p.entry.version)
            else throw Error('STALE_PREVIEW')
          }
        }else if(op==='cancel'){
          const request=parsed as unknown as MemoryJobRequest,snapshot=await store.managementSnapshot()
          if(!snapshot.record.jobs.some(j=>j.taskId===request.taskId&&j.materialVersion===request.materialVersion))throw Error('MEMORY_CONFLICT')
          check(vault,r.sessionId);ports.service()?.cancel(request.taskId)
        }else{
          const request=parsed as unknown as MemoryEditRequest,snapshot=await expected(store,request)
          check(vault,r.sessionId)
          if(op==='edit')await store.edit(snapshot,request.id,request.version,{content:request.content,layer:request.layer,scope:request.scope})
          else if(op==='forget')await store.forget(snapshot,request.id,request.version)
          else await store.toggle(snapshot,request.id,request.version,false)
        }
        check(vault,r.sessionId)
        await ports.recheck(vault,r.sessionId)
        check(vault,r.sessionId)
        return {ok:true,value:await view(vault,r.sessionId)}
      }catch(e){return {ok:false,error:publicMemoryError(e)}}
    }
  }
}
