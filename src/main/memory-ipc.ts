import {randomUUID} from 'node:crypto'
import type {WorkingMemoryConsolidation} from './working-memory-consolidation.ts'
import type {WorkingInput,WorkingSnapshot} from './working-memory-store.ts'
import type {WorkingMemoryService} from './working-memory-service.ts'
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
export type MemoryOperation = 'get' | 'config' | 'manual' | 'commit' | 'edit' | 'disable' | 'forget' | 'restore' | 'retry' | 'cancel' | 'maintenance'
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
  } else if(op==='maintenance') {
    allowed.push('action','revision','objectVersion','watermark','taskId','materialVersion')
    if(!['watermark','reset','reset-config','undo'].includes(String(value.action))||value.revision!==null&&!hash(value.revision)||value.objectVersion!==null&&!str(value.objectVersion,512)||value.action==='watermark'&&(!Number.isSafeInteger(value.watermark)||Number(value.watermark)<0)||value.action!=='watermark'&&value.watermark!==undefined)return null
    if(value.action==='undo'&&(!str(value.taskId)||!hash(value.materialVersion)))return null
    if(value.action!=='undo'&&(value.taskId!==undefined||value.materialVersion!==undefined))return null
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

export type MemoryIpcPorts={
 vault():VaultSession|null;config():ModelConfigStore|null;service():WorkingMemoryService|null
 engine?():WorkingMemoryConsolidation|null
 invalidate?():void
 recheck(vault:VaultSession,session:string):Promise<void>
}
type HeldPreview={owner:string;expires:number;preview:MemoryPreview;basis?:WorkingSnapshot;input?:WorkingInput;item?:import('../shared/memory.ts').MemoryItemRequest;binding?:{revision:string|null;objectVersion:string|null};watermark?:number;signature?:string;job?:{taskId:string;materialVersion:string}}
/** Main owns single-use previews; renderer supplies only bounded choices and object/version proofs. */
export function createMemoryIpc(ports:MemoryIpcPorts){
 const previews=new Map<string,HeldPreview>()
 const clear=()=>previews.clear()
 const hold=(held:Omit<HeldPreview,'expires'>)=>{for(const [id,p] of previews)if(p.expires<Date.now())previews.delete(id);if(previews.size>=128)throw Error('MEMORY_QUEUE_FULL');previews.set(held.preview.id,{...held,expires:Date.now()+120000});return {ok:true as const,value:held.preview}}
 const view=async(service:WorkingMemoryService)=>{const value=await service.view();value.running=ports.engine?.()?.state()??value.running;for(const job of value.jobs)job.undoable=!!job.materialVersion&&!!ports.engine?.()?.canUndo(job.taskId,job.materialVersion);return {ok:true as const,value}}
 return {clear,async handle(owner:string,op:MemoryOperation,value:unknown):Promise<MemoryResult<MemoryView|MemoryPreview>>{
  try{
   const request=parseMemoryRequest(op,value);if(!request)throw Error('BAD_REQUEST')
   const vault=ports.vault(),service=ports.service();if(!vault||!service)throw Error('NO_VAULT');const session=request.sessionId as string;vault.assertSession(session)
   const context=vault.memoryContext(),config=ports.config()
   if(op==='get')return view(service)
   if(op==='manual'){
    const source=await service.manualSource(request as unknown as import('../shared/memory.ts').MemoryManualRequest)
    const parents=await service.entries(source.memoryDeps.map(d=>d.id));if(source.memoryDeps.some(d=>!parents.some(e=>e.id===d.id&&e.version===d.version&&e.status==='active')))throw Error('MEMORY_DEPENDENCY_CHANGED')
    const input:WorkingInput={content:source.text,layer:source.classification==='command'?'core':'demand',scope:'本库',sources:[source],semantic:source.classification==='command'?'standing':'fact',attribution:'人明确记住的材料',reviewAt:null}
    const preview:MemoryPreview={id:randomUUID(),sessionId:session,kind:'manual',content:input.content,layer:input.layer,scope:input.scope,sources:[source],warning:'确认只记住列出的材料；记忆许可不扩大读库范围。未采纳 AI 回答不能成为事实来源。'}
    return hold({owner,preview,input,basis:service.snapshot()})
   }
   if(op==='restore'){
    const item=request as unknown as import('../shared/memory.ts').MemoryItemRequest,basis=service.snapshot(),entry=basis.record.entries.find(e=>e.id===item.id&&e.version===item.version)
    if(!entry||item.revision!==basis.revision||item.objectVersion!==basis.objectVersion)throw Error('MEMORY_CHANGED')
    for(const source of entry.sources)if(!await service.verifySource(source))throw Error('MEMORY_SOURCE_CHANGED')
    const preview:MemoryPreview={id:randomUUID(),sessionId:session,kind:entry.status==='disputed'||entry.status==='pending'?'confirm':'restore',content:entry.content,layer:entry.layer,scope:entry.scope,sources:entry.sources,warning:'请核对原话、归属与适用范围；本次确认清除复核期限，仍须通过来源和依赖核验。',...(entry.pendingTarget?{previousContent:basis.record.entries.find(e=>e.id===entry.pendingTarget!.id)?.content}:{})}
    return hold({owner,preview,item,basis})
   }
   if(op==='retry'){
    const engine=ports.engine?.();if(!engine)throw Error('MEMORY_RETRY_UNAVAILABLE')
    const taskId=request.taskId as string,materialVersion=request.materialVersion as string,receipt=service.snapshot().record.jobs.find(j=>j.taskId===taskId&&j.materialVersion===materialVersion&&['rejected','interrupted'].includes(j.outcome))
    if(!receipt)throw Error('MEMORY_RETRY_UNAVAILABLE')
    const saved=await service.savedMaterial(vault.ledgerTaskPath(taskId),taskId);if(saved.materialVersion!==materialVersion)throw Error('MEMORY_MATERIAL_CHANGED')
    const cfg=engine.disclosure(),source=await service.sourceForPrompt(saved.origin.relPath,taskId)
    return hold({owner,signature:cfg.signature,job:{taskId,materialVersion},preview:{id:randomUUID(),sessionId:session,kind:'retry',content:'重新核验原任务的获准材料后，取得新的有限整理许可；不会复活旧授权。',layer:'demand',scope:'本库',sources:[source],warning:'已清理或失效的材料不能重试；不会补采其它历史。',recipient:cfg.recipient,limits:cfg.limits}})
   }
   if(op==='maintenance'){
    if(request.action==='undo'){
     const engine=ports.engine?.();if(!engine||!engine.canUndo(request.taskId as string,request.materialVersion as string))throw Error('MEMORY_RETRY_UNAVAILABLE')
     return hold({owner,job:{taskId:request.taskId as string,materialVersion:request.materialVersion as string},preview:{id:randomUUID(),sessionId:session,kind:'undo',content:'撤销本场自动新增或更正的记忆；已被再次修改的条目将拒绝覆盖。',layer:'demand',scope:'本库',sources:[],warning:'仅当前打开期间最近八场变更可直接撤销；不会修改原笔记或账本。新增条目会移除并阻止原依据自动重新生成。'}})
    }
    if(request.action==='reset-config'){
     if(!config)throw Error('MEMORY_CONFIG_UNAVAILABLE');const actual=config.memoryConfigDiagnosis()
     if(actual.revision!==request.revision||request.objectVersion!==null)throw Error('MEMORY_CONFIG_CONFLICT')
     return hold({owner,binding:{revision:actual.revision,objectVersion:null},preview:{id:randomUUID(),sessionId:session,kind:'reset-config',content:'重建设备记忆配置：默认记忆模型为空，所有库记忆许可关闭，覆盖与整理上限恢复默认。',layer:'demand',scope:'设备',sources:[],warning:'本机所有库的记忆配置将重置；库内记忆、笔记、账本、回答模型与密钥不变。原配置不会自动覆盖或作为许可重新启用。'}})
    }
    const binding={revision:request.revision as string|null,objectVersion:request.objectVersion as string|null},action=request.action as 'watermark'|'reset'
    const actual=action==='reset'?vault.memoryDiagnostic():service.snapshot()
    if(actual.revision!==binding.revision||actual.objectVersion!==binding.objectVersion)throw Error('MEMORY_CONFLICT')
    const watermark=action==='watermark'?request.watermark as number:vault.materialCeiling()
    if(action==='watermark'&&(watermark<service.snapshot().record.watermark||watermark>vault.materialCeiling()))throw Error('BAD_REQUEST')
    return hold({owner,binding,watermark,preview:{id:randomUUID(),sessionId:session,kind:action,content:action==='reset'?'清空本库记忆并关闭许可；以当前材料序号建立新的学习水位。':'推进自动学习水位到材料序号 '+watermark,layer:'demand',scope:'本库',sources:[],warning:action==='reset'?'原笔记与账本不变；记忆正文不保留旧副本，需重新配置开启。此前材料不会自动重新学习，不保证清除外部备份或已发送资料。':'现有记忆保留；此序号及以前的材料不再自动生成记忆。能够被水位替代的逐条阻断记录才会回收。'}})
   }
   if(op==='commit'){
    const p=previews.get(request.id as string);previews.delete(request.id as string)
    if(!p||p.owner!==owner||p.expires<Date.now()||p.preview.sessionId!==session)throw Error('STALE_PREVIEW')
    if(p.preview.kind==='undo'){const engine=ports.engine?.();if(!engine)throw Error('MEMORY_RETRY_UNAVAILABLE');await engine.undo(p.job!.taskId,p.job!.materialVersion);ports.invalidate?.();await ports.recheck(vault,session);return view(service)}
    if(p.preview.kind==='reset-config'){
     if(!config)throw Error('MEMORY_CONFIG_UNAVAILABLE');clear();ports.invalidate?.();config.resetMemoryConfig(p.binding!.revision);await ports.recheck(vault,session);return view(service)
    }
    if(p.preview.kind==='retry'){await ports.engine!()!.retry(p.job!.taskId,p.job!.materialVersion,p.signature!);return view(service)}
    if(p.preview.kind==='reset'||p.preview.kind==='watermark'){
     clear();ports.invalidate?.()
     if(p.preview.kind==='reset'){
      let current:import('../shared/memory.ts').PublicMemoryConfig|undefined
      try{current=config?.getMemoryConfig(context.vaultKey)}catch{/* Bad independent configuration is already fail closed. */}
      if(current)config!.setVaultMemory(context.vaultKey,{...current.vault,enabled:false})
      await service.reset(p.binding!)
     }else await service.advance(p.watermark!,p.binding!)
    }else if(p.input){
     const input={...p.input,content:request.content===undefined?p.input.content:request.content as string,layer:request.layer===undefined?p.input.layer:request.layer as 'core'|'demand',scope:request.scope===undefined?p.input.scope:request.scope as string}
     for(const source of input.sources){if(!await service.verifySource(source))throw Error('MEMORY_SOURCE_CHANGED');const parents=await service.entries(source.memoryDeps.map(d=>d.id));if(source.memoryDeps.some(d=>!parents.some(e=>e.id===d.id&&e.version===d.version&&e.status==='active')))throw Error('MEMORY_DEPENDENCY_CHANGED')}
     await vault.memoryMutation(store=>store.add(p.basis!,input,true))
    }else await service.confirm(p.item!)
   }else if(op==='config'){
    if(!config)throw Error('MEMORY_CONFIG_UNAVAILABLE');const change=request as unknown as MemoryConfigRequest
    if(change.target==='default')config.setMemoryDefault(change.modelId)
    else if(change.target==='limits')config.updateMemoryLimits(change.limits)
    else{if(change.vault.enabled)await service.initialize();config.setVaultMemory(context.vaultKey,change.vault)}
    clear();ports.engine?.()?.cancel()
   }else if(op==='cancel'){
    const receipt=service.snapshot().record.jobs.find(j=>j.taskId===request.taskId&&j.materialVersion===request.materialVersion)
    if(!receipt)throw Error('MEMORY_JOB_UNAVAILABLE');ports.engine?.()?.cancel(receipt.taskId)
   }else if(op==='edit'||op==='disable'||op==='forget'){
    const item=request as unknown as import('../shared/memory.ts').MemoryItemRequest
    if(op==='forget'){clear();ports.invalidate?.();await service.forget(item)}
    else await service.edit(item,op==='disable'?{status:'disabled'}:{content:request.content as string,layer:request.layer as 'core'|'demand',scope:request.scope as string})
   }
   await ports.recheck(vault,session)
   return view(service)
  }catch(e){return {ok:false,error:publicMemoryError(e)}}
 }}
}
