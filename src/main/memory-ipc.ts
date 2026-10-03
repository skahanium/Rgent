import { MEMORY_ERROR_CODES } from '../shared/memory-errors.ts'
import type { MemoryConfigRequest, MemoryPreview, MemoryResult, MemoryView } from '../shared/memory.ts'
import type { ModelConfigStore } from './model-config.ts'
import type { VaultSession } from './vault.ts'
const codes = new Set<string>(MEMORY_ERROR_CODES)
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

export type MemoryIpcPorts={vault():VaultSession|null;config():ModelConfigStore|null;service():unknown;recheck(vault:VaultSession,session:string):Promise<void>}
/** Transitional diagnostic surface; no old previews, data or permits remain usable. */
export function createMemoryIpc(ports:MemoryIpcPorts){return {clear(){},async handle(_owner:string,op:MemoryOperation,value:unknown):Promise<MemoryResult<MemoryView|MemoryPreview>>{
 try{const request=parseMemoryRequest(op,value);if(!request)throw Error('BAD_REQUEST')
  const vault=ports.vault();if(!vault)throw Error('NO_VAULT');vault.assertSession(request.sessionId as string)
  const config=ports.config();if(!config)throw Error('MEMORY_CONFIG_UNAVAILABLE')
  const context=vault.memoryContext()
  if(op==='config'){const change=request as unknown as MemoryConfigRequest
   if(change.target==='default')config.setMemoryDefault(change.modelId)
   else if(change.target==='limits')config.updateMemoryLimits(change.limits)
   else {if(change.vault.enabled)throw Error('MEMORY_RETIRED');config.setVaultMemory(context.vaultKey,change.vault)}
  }else if(op!=='get')throw Error('MEMORY_RETIRED')
  const cfg=config.getMemoryConfig(context.vaultKey)
  return {ok:true,value:{sessionId:context.sessionId,revision:null,objectVersion:null,config:cfg,recipient:null,status:'invalid',reason:vault.memoryDiagnosis()??'MEMORY_RETIRED',entries:[],jobs:[],running:{permits:0,pending:0,active:0}}}
 }catch(e){return {ok:false,error:publicMemoryError(e)}}
}}}
