import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {VaultSession} from '../src/main/vault.ts'
import {WorkingMemoryService} from '../src/main/working-memory-service.ts'
import {WorkingMemoryConsolidation} from '../src/main/working-memory-consolidation.ts'
import {TaskMaterialTracker} from '../src/main/host-material.ts'
import {serializeStoredVault} from '../src/main/notes-fs.ts'
import {markPrompt,upsertAiAnswer} from '../src/main/host-source.ts'
import {createMemoryUsePermit} from '../src/main/memory-use.ts'
import {buildHostContext} from '../src/main/host-context.ts'
import {AgentHost} from '../src/main/agent-host.ts'
import {TaskAuthorizationRegistry} from '../src/main/task-authorization.ts'
import {modelTierFor} from '../src/main/permissions.ts'
import type {LedgerRecord} from '../src/main/ledger-store.ts'
import {conservativeTokens} from '../src/main/context-budget.ts'
import type {ModelCredential} from '../src/main/model-config.ts'
import type {ModelStepInput,ModelStepEvent} from '../src/main/model-stream.ts'
import type {MemoryQualityCase} from '../test/fixtures/memory-quality.ts'

/** Genuine production saving/consolidation/use in one disposable fictional vault. */
export async function runMemoryQualityCase(spec:MemoryQualityCase,credential:ModelCredential,
 stream:(input:ModelStepInput)=>AsyncIterable<ModelStepEvent>,signal:AbortSignal){
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-memory-quality-')),root=path.join(base,'vault')
 let vault:VaultSession|null=null,engine:WorkingMemoryConsolidation|null=null
 try{
  await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root))
  const taskId='quality-'+spec.id,rawPrompt='/'+spec.prompt
  const source=spec.body+'\n\n'+markPrompt(rawPrompt,{taskId,range:{start:0,end:rawPrompt.length},expectedText:rawPrompt,promptText:spec.prompt})
  await writeFile(path.join(root,'fiction.md'),source)
  if(spec.seed)await writeFile(path.join(root,'baseline.md'),spec.seed.content)
  vault=new VaultSession(base,()=>{});vault.restore()
  const session=vault,service=new WorkingMemoryService(session,()=>null);await service.initialize()
  if(spec.seed){const seed=spec.seed,note=await session.readOpened('baseline.md'),seedSource=await service.manualSource({...note,relPath:'baseline.md',kind:'body',start:0,end:note.content.length})
   await session.memoryMutation(store=>store.add(store.read(),{...seed,sources:[seedSource],reviewAt:null},true))}
  const before=service.snapshot().record.entries
  engine=new WorkingMemoryConsolidation({service:()=>service,configuration:()=>({enabled:true,signature:'fictional-evaluation',credential,limits:{seconds:120,calls:2,tools:0}}),stream:input=>stream({...input,signal:AbortSignal.any([input.signal,signal])}),changed:()=>{}})
  const activeEngine=engine,cancel=()=>activeEngine.cancel(undefined,'MEMORY_CANCELLED');signal.addEventListener('abort',cancel,{once:true})
  try{
   if(signal.aborted)throw Error('MEMORY_CANCELLED')
   engine.capture(taskId)
   const note=await session.readOpened('fiction.md'),tracker=new TaskMaterialTracker()
   tracker.body(note.content,{start:0,end:note.content.length},{relPath:'fiction.md',sessionId:note.sessionId!,objectVersion:note.objectVersion,revision:note.revision});tracker.commit()
   await session.ledgerPrepare('fiction.md',{taskId,startedAt:new Date().toISOString(),status:'completed',prompt:spec.prompt,answer:spec.answer,material:tracker.snapshot()})
   const saved=await session.write('fiction.md',upsertAiAnswer(note.content,{taskId,answer:spec.answer}),note.revision,note)
   await session.ledgerComplete('fiction.md',taskId,saved.revision)
   const material=await service.savedMaterial('fiction.md',taskId)
   await engine.handoff(material);await engine.idle()
   const entries=await service.entries(),receipt=service.snapshot().record.jobs.find(j=>j.taskId===taskId)??null
   const port={context:()=>service.context(),config:()=>({enabled:true,revision:1}),entries:(ids?:readonly string[])=>service.entries(ids)}
   const permit=await createMemoryUsePermit(port,credential,spec.prompt,spec.body)
   const current=await session.read('fiction.md')
   const context=buildHostContext({source:current.content,chapters:[],prompt:spec.prompt,placement:current.content.length,inputBudgetTokens:Math.max(1,Math.min(16384,credential.contextTokens-8192)),countTokens:conservativeTokens,memory:permit.recall})
   if(context.status==='ready'){permit.stage(context.memoryIds);await permit.assertCurrent(credential);permit.markSent()}
   // This follow-up is an actual Host task with a controlled stream, never a paid quality sample.
   let followup:{mode:'controlled-production-host';sent:{system:string;prompt:string}[];ledger:LedgerRecord}|null=null
   if(!signal.aborted){
    const relPath='followup.md',prompt=spec.prompt,raw='/'+prompt
    await writeFile(path.join(root,relPath),spec.body+'\n\n'+raw+'\n')
    const sent:{system:string;prompt:string}[]=[]
    const authorization=new TaskAuthorizationRegistry({root:()=>root,session:()=>session.sessionId(),tree:()=>session.tree(),read:rel=>session.readOpened(rel),tier:modelTierFor,
     acceptsObject:(rel,expected,current)=>session.acceptsObject(rel,expected,current),configuration:()=>({credential,limits:{seconds:120,steps:1,tools:0}})})
    const next=await session.readOpened(relPath),start=next.content.lastIndexOf(raw)
    const command={...next,modelRecordId:'quality-controlled',expectedRevision:next.revision,relPath,range:{start,end:start+raw.length},expectedText:raw,promptText:prompt}
    const preview=await authorization.preview('quality-evaluator',{...command,references:[]})
    const host=new AgentHost({root:()=>root,session:()=>session.sessionId(),
     acceptsObject:(rel,expected,current)=>session.acceptsObject(rel,expected,current),
     read:rel=>session.readOpened(rel),write:(rel,text,revision,binding)=>{if(!binding)throw Error('NOTE_REPLACED');return session.write(rel,text,revision,binding)},
     authorize:()=>authorization.consume('quality-evaluator',{...command,previewId:preview.id}),
     tier:modelTierFor,credential:()=>credential,limits:()=>({seconds:120,steps:1,tools:0}),memory:port,
     ledger:{prepare:(rel,chapter,version)=>session.ledgerPrepare(rel,chapter,version),complete:(rel,id,revision)=>session.ledgerComplete(rel,id,revision),contexts:rel=>session.ledgerContexts(rel)},
     stream:async function*(input){sent.push({system:input.system,prompt:input.prompt});yield '受控闭环验证回答；不代表真实模型质量。'},emit:()=>{}})
    const task=await host.start({...command,previewId:preview.id})
    const stop=()=>host.cancel(task.id);signal.addEventListener('abort',stop,{once:true})
    try{if(signal.aborted)stop();await task.done;followup={mode:'controlled-production-host',sent,ledger:await session.ledgerRecord(relPath,task.id)}}
    finally{signal.removeEventListener('abort',stop)}
   }
   const provenance=followup?.ledger.chapter?.provenance
   const dependencies=provenance?.version===2?provenance.memoryDeps:[]
   const entry=entries.find(e=>dependencies.some(d=>d.id===e.id))
   const proof: {revoked:boolean;relearningBlocked:boolean;replay:{attempted:boolean;calls:number;remaining:string[];receipt:unknown}|null}|null=entry?{revoked:false,relearningBlocked:false,replay:null}:null
   if(entry&&proof){const basis=service.snapshot();await service.forget({sessionId:service.context().sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:entry.id,version:entry.version})
    try{await permit.assertCurrent(credential)}catch{proof.revoked=true}
    // Force a genuine new consolidation attempt using the original saved material and forgotten evidence.
    // The controlled response requests the same entry, exercising production source and commit gates.
    let calls=0,validReplay=false
    const replay=new WorkingMemoryConsolidation({service:()=>service,configuration:()=>({enabled:true,signature:'controlled-replay',credential,limits:{seconds:120,calls:2,tools:0}}),changed:()=>{},
     stream:async function*(input){calls++;const payload=JSON.parse(String(input.messages[0]!.content)) as {sources:{id:string;text:string}[]}
      const sourceIds=payload.sources.filter(s=>entry.sources.some(old=>old.text===s.text)).map(s=>s.id)
      validReplay=sourceIds.length>0
      yield {type:'text',text:JSON.stringify({proposals:[{action:'add',content:entry.content,layer:entry.layer,semantic:entry.semantic,scope:entry.scope,attribution:entry.attribution,reviewAt:entry.reviewAt,sourceIds}]})}
      yield {type:'finish',reason:'stop'}}})
    const stopReplay=()=>replay.cancel();signal.addEventListener('abort',stopReplay,{once:true})
    try{if(signal.aborted)throw Error('MEMORY_CANCELLED');replay.capture(taskId);await replay.handoff(material);await replay.idle()
     const remaining=(await service.entries()).filter(e=>e.id===entry.id||e.content===entry.content).map(e=>e.id)
     const replayReceipt=service.snapshot().record.jobs.find(j=>j.taskId===taskId)??null
     proof.replay={attempted:true,calls,remaining,receipt:replayReceipt}
     proof.relearningBlocked=calls>0&&validReplay&&remaining.length===0&&replayReceipt?.outcome==='applied'&&replayReceipt.reason==='MEMORY_OUTPUT_INVALID'
    }finally{signal.removeEventListener('abort',stopReplay);replay.close();await replay.idle()}
   }
   return {completed:receipt?.outcome==='applied'&&!receipt.reason,before,entries,receipt,context,dependencies,followup,forget:proof,material:{taskId:material.taskId,materialVersion:material.materialVersion,status:material.status,fragments:material.material.fragments.map(f=>({classification:f.classification,text:f.text,kind:f.kind}))}}
  }finally{signal.removeEventListener('abort',cancel)}
 }finally{engine?.close();await engine?.idle();vault?.dispose();await rm(base,{recursive:true,force:true})}
}
