import {requireOrdinaryNotes} from './notes-fs.ts'
import {createHash,randomUUID} from 'node:crypto'
import type {VaultSession} from './vault.ts'
import type {ModelConfigStore} from './model-config.ts'
import type {WorkingSource,WorkingEntry,WorkingSnapshot,WorkingInput,WorkingMemoryStore} from './working-memory-store.ts'
import type {MemoryContext,MemoryView,MemoryItemRequest,MemoryManualRequest} from '../shared/memory.ts'
import {stateFromStatus,statusFromState} from './working-memory-store.ts'
import {compile} from '../markdown/index.ts'
import {historicalBodyTasks} from './host-context.ts'
import {bodyFingerprint} from './ledger-provenance.ts'
import {modelTierFor} from './permissions.ts'
import {conservativeTokens} from './context-budget.ts'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const recentExpired=(entry:WorkingEntry)=>entry.category==='recent'&&Date.parse((entry as import('./working-memory-store.ts').WorkingRecent).recent.createdAt)<=Date.now()-14*86400000
export class WorkingMemoryService{
 private boundContext:MemoryContext|null=null
 constructor(readonly vault:VaultSession,private readonly config:()=>ModelConfigStore|null){if(vault.root)this.boundContext=vault.memoryContext()}
 context(){
  if(this.boundContext)this.vault.assertSession(this.boundContext.sessionId)
  const current=this.vault.memoryContext()
  if(!this.boundContext)this.boundContext=current
  if(current.vaultKey!==this.boundContext.vaultKey)throw Error('VAULT_CHANGED')
  return {...this.boundContext}
 }
 private mutate<T>(operation:(store:WorkingMemoryStore)=>T|Promise<T>):Promise<T>{
  const context=this.context()
  return this.vault.memoryMutation(store=>{this.vault.assertSession(context.sessionId);this.context();return operation(store)})
 }
 async initialize(){return this.mutate(store=>store.initialize())}
 async interruptOutstanding(){return this.mutate(store=>store.interrupted(store.read()))}
 snapshot(){this.context();return this.vault.memorySnapshot()}
 async verifySource(source:WorkingSource,recovery?:{record:()=>Promise<import('./ledger-store.ts').LedgerRecord>;contexts:()=>Promise<import('./host-context.ts').ContextChapter[]>;unique:true}):Promise<boolean>{
  const context=this.context()
  if(hash(source.text)!==source.hash)return false
  try{const root=this.vault.requireUsableRoot(),classified=await modelTierFor(root,source.relPath)
   this.vault.assertSession(context.sessionId)
   requireOrdinaryNotes(root,[source.relPath]);if(!classified)return false
   const note=await this.vault.read(source.relPath);this.vault.assertSession(context.sessionId)
   if(!this.vault.acceptsObject(source.relPath,source.objectVersion,note.objectVersion))return false
   for(const dep of source.sourceDeps){requireOrdinaryNotes(root,[dep.relPath]);const status=await modelTierFor(root,dep.relPath);this.vault.assertSession(context.sessionId);if(!status)return false;const original=await this.vault.read(dep.relPath);this.vault.assertSession(context.sessionId);if(!this.vault.acceptsObject(dep.relPath,dep.objectVersion,original.objectVersion)||bodyFingerprint(original.content)!==dep.bodyHash)return false}
   let raw:string
   if(source.kind==='ledger'){
    if(!source.taskId)return false;const record=recovery?await recovery.record():await this.vault.ledgerRecord(source.relPath,source.taskId)
    this.vault.assertSession(context.sessionId)
    if(record.state==='cleared')return !recovery // the retained memory is independently licensed; raw cleanup is not forgetting
    if(record.state!=='saved')return false
    const chapter=(recovery?await recovery.contexts():this.vault.ledgerContextForRecord(record)).find(c=>c.taskId===source.taskId);this.vault.assertSession(context.sessionId);if(!chapter||chapter.eligible===false||chapter.fields?.status!=='valid'||source.classification!=='command')return false;raw=chapter.text
    const field=chapter.fields.prompt;let start=source.start
    if(raw.slice(start,source.end)!==source.text){start=raw.indexOf(source.text);if(start<0||raw.indexOf(source.text,start+1)>=0)return false}
    if(start<field.start||start+source.text.length>field.end)return false
   }else{
    const parsed=compile(note.content);if(parsed.stale)return false;raw=parsed.partition.body
    let start=source.start;if(raw.slice(source.start,source.end)!==source.text){start=raw.indexOf(source.text);if(start<0||raw.indexOf(source.text,start+1)>=0)return false}
    const block=parsed.index.blocks.find(b=>b.range.start<=start&&b.range.end>=start+source.text.length)
    if(!block||block.identity==='ai'||source.classification==='command'&&block.identity!=='command')return false
   }
   if(recovery){const first=raw.indexOf(source.text);if(first<0||raw.indexOf(source.text,first+1)>=0)return false}
   if(raw.slice(source.start,source.end)===source.text&&hash(source.text)===source.hash)return true
   const first=raw.indexOf(source.text);return first>=0&&raw.indexOf(source.text,first+1)<0&&hash(source.text)===source.hash
  }catch{return false}
 }
 async entries(ids?:readonly string[]):Promise<WorkingEntry[]>{
  const context=this.context(),basis=this.snapshot(),all=[...basis.record.entries,...basis.record.recent]
  const wanted=ids?all.filter(e=>ids.includes(e.id)):all
  const result:WorkingEntry[]=[]
  for(const original of wanted){const entry=structuredClone(original)
   if(recentExpired(entry)){entry.status='obsolete';entry.reason=null}
   if(entry.status==='active'&&entry.reviewAt&&Date.parse(entry.reviewAt)<=Date.now()){entry.status='review';entry.reason='MEMORY_CONFIRMATION_REQUIRED'}
   if(entry.status==='active'&&!await this.verifyEntry(entry,all)){entry.status='paused';entry.reason='MEMORY_SOURCE_CHANGED'}
   result.push(entry)
  }
  this.vault.assertSession(context.sessionId)
  const latest=this.snapshot().record,current=[...latest.entries,...latest.recent]
  // Async source proofs can overlap a queued edit of an upstream entry. Check only
  // the proven dependency closure against the final snapshot, not its file revision.
  const dependenciesCurrent=(entry:WorkingEntry,seen=new Set<string>()):boolean=>{
   if(seen.has(entry.id))return false;seen.add(entry.id)
   return entry.sources.every(s=>s.memoryDeps.every(dep=>{
    const parent=current.find(e=>e.id===dep.id&&e.version===dep.version&&e.status==='active')
    return !!parent&&!recentExpired(parent)&&(!parent.reviewAt||Date.parse(parent.reviewAt)>Date.now())&&dependenciesCurrent(parent,new Set(seen))
   }))
  }
  const checked=result.filter(e=>current.some(now=>now.id===e.id&&now.version===e.version)).map(e=>{
   if(e.status==='active'&&e.reviewAt&&Date.parse(e.reviewAt)<=Date.now()){e.status='review';e.reason='MEMORY_CONFIRMATION_REQUIRED'}
   if(e.status==='active'&&!dependenciesCurrent(e)){e.status='paused';e.reason='MEMORY_DEPENDENCY_CHANGED'}
   if(recentExpired(e)){e.status='obsolete';e.reason=null}
   e.state=stateFromStatus(e.status,e.state);e.status=statusFromState(e.state)
   return e
  })
  return checked
 }
 async consolidationCandidates(sources:readonly WorkingSource[],ids?:readonly string[]):Promise<WorkingEntry[]>{
  const all=(await this.entries(ids)).filter(e=>e.category!=='recent'),candidates:WorkingEntry[]=[]
  for(const e of all){if(e.status==='active'){candidates.push(e);continue}
   if(['review','obsolete','disputed','deferred'].includes(e.status)&&sources.some(s=>!e.sources.some(old=>old.materialId===s.materialId))&&await this.verifyEntry(e,all))candidates.push(e)
  }
  return candidates
 }
 async candidateCurrent(entry:WorkingEntry):Promise<boolean>{
  const record=this.snapshot().record,all=[...record.entries,...record.recent],now=all.find(e=>e.id===entry.id&&e.version===entry.version&&(e.status===entry.status||entry.status==='review'&&e.status==='active'&&!!e.reviewAt&&Date.parse(e.reviewAt)<=Date.now()))
  return !!now&&await this.verifyEntry(now,all)
 }
 private async verifyEntry(entry:WorkingEntry,all:WorkingEntry[],seen=new Set<string>()):Promise<boolean>{
  if(seen.has(entry.id))return false;seen.add(entry.id)
  if(recentExpired(entry)||!entry.sources.length)return false
  if(entry.category==='recent'){const recent=entry as import('./working-memory-store.ts').WorkingRecent;try{const saved=await this.savedMaterial(recent.sources.find(s=>s.kind==='ledger'&&s.taskId===recent.recent.taskId)!.relPath,recent.recent.taskId);if(saved.noteId!==recent.recent.noteId||saved.materialVersion!==recent.recent.materialVersion)return false}catch{return false}}
  for(const s of entry.sources){if(!await this.verifySource(s))return false;for(const dep of s.memoryDeps){const parent=all.find(e=>e.id===dep.id&&e.version===dep.version&&e.status==='active');if(!parent||parent.reviewAt&&Date.parse(parent.reviewAt)<=Date.now()||!await this.verifyEntry(parent,all,new Set(seen)))return false}}
  return true
 }
 async view():Promise<MemoryView>{
  const context=this.context(),config=this.config();let configError:string|undefined
  let cfg:import('../shared/memory.ts').PublicMemoryConfig={defaultModelId:null,limits:{seconds:120,calls:2,tools:0},vault:{enabled:false,override:{mode:'inherit'}},effectiveModelId:null,modelStatus:'unavailable'}
  try{if(!config)throw Error('MEMORY_CONFIG_UNAVAILABLE');cfg=config.getMemoryConfig(context.vaultKey)}catch{configError='MEMORY_CONFIG_UNAVAILABLE'}
  let configDiagnosis:import('../shared/memory.ts').MemoryView['configDiagnosis']
  if(configError&&config)try{configDiagnosis=config.memoryConfigDiagnosis()}catch{/* Local memory remains viewable when the independent device file cannot be read. */}
  let credential:import('./model-config.ts').ModelCredential|null=null;try{credential=cfg.modelStatus==='ready'?config!.memoryCredential(context.vaultKey):null}catch{configError='MEMORY_MODEL_UNAVAILABLE'}
  let retirement:MemoryView['retirement']
  if(this.vault.memoryDiagnosis())try{const target=await this.vault.memoryRetirementPreview();retirement={revision:target.revision,objectVersion:target.objectVersion,bytes:target.bytes}}catch{/* Unknown legacy bytes remain preserved and cannot be retried. */}
  let basis:WorkingSnapshot,entries:WorkingEntry[]
  try{basis=this.snapshot();entries=await this.entries();basis=this.snapshot()}catch(e){this.vault.assertSession(context.sessionId);const materials=this.vault.materialState(),retirementFailure=this.vault.memoryDiagnosis(),bindingFailure=this.vault.memoryBindingDiagnosis();return {sessionId:context.sessionId,revision:null,objectVersion:null,config:cfg,recipient:credential?{modelId:credential.modelId,host:new URL(credential.baseURL).host}:null,status:'invalid',reason:e instanceof Error?e.message:'MEMORY_STORAGE_INVALID',materialStatus:materials.status,...(retirementFailure?{retirementFailure,...(retirement?{retirement}:{})}:{}),...(bindingFailure?{bindingFailure}:{}),entries:[],jobs:[],running:{permits:0,pending:0,active:0},diagnosis:this.vault.memoryDiagnostic(),...(configDiagnosis?{configDiagnosis}:{})}}
  const materials=this.vault.materialState(),retirementFailure=this.vault.memoryDiagnosis(),bindingFailure=this.vault.memoryBindingDiagnosis()
  return {sessionId:context.sessionId,revision:basis.revision,objectVersion:basis.objectVersion,config:cfg,recipient:credential?{modelId:credential.modelId,host:new URL(credential.baseURL).host}:null,status:'ready',...(configError?{reason:configError}:materials.status==='invalid'?{reason:materials.reason}:{}),materialStatus:materials.status,...(retirementFailure?{retirementFailure,...(retirement?{retirement}:{})}:{}),...(bindingFailure?{bindingFailure}:{}),entries:entries.map(e=>({...e,sources:e.sources.map(s=>({relPath:s.relPath,kind:s.kind,taskId:s.taskId,text:s.text,classification:s.classification}))})),jobs:basis.record.jobs.map(j=>({...j,retryable:materials.status!=='invalid'&&['interrupted','rejected'].includes(j.outcome)&&cfg.vault.enabled&&!!credential})),running:{permits:0,pending:0,active:0},...(materials.status!=='invalid'?{learning:{watermark:basis.record.watermark,nextSequence:Math.max(basis.record.nextSequence,materials.sequence)}}:{}),diagnosis:this.vault.memoryDiagnostic(),...(configDiagnosis?{configDiagnosis}:{})}
 }
 private bind(request:MemoryItemRequest){this.vault.assertSession(request.sessionId);const basis=this.snapshot();if(basis.revision!==request.revision||basis.objectVersion!==request.objectVersion)throw Error('MEMORY_CONFLICT');const entry=[...basis.record.entries,...basis.record.recent].find(e=>e.id===request.id&&e.version===request.version);if(!entry)throw Error('MEMORY_CHANGED');return {basis,entry}}
 async edit(request:MemoryItemRequest,change:Partial<WorkingInput>&{status?:WorkingEntry['status']}){const committed=await this.mutate(store=>{const {basis}=this.bind(request);return store.edit(basis,request.id,request.version,change)});await this.recheckDeferred().catch(()=>{});return committed}
 async forget(request:MemoryItemRequest){const committed=await this.mutate(store=>{const {basis}=this.bind(request);return store.forget(basis,request.id,request.version)});await this.recheckDeferred().catch(()=>{});return committed}
 async recheckDeferred(){
  const context=this.context(),basis=this.snapshot(),ready:WorkingEntry[]=[]
  for(const e of basis.record.entries.filter(e=>e.status==='deferred'))if((!e.reviewAt||Date.parse(e.reviewAt)>Date.now())&&await this.verifyEntry(e,basis.record.entries))ready.push(e)
  this.vault.assertSession(context.sessionId)
  if(!ready.length)return
  await this.mutate(store=>{
   let current=store.read(),cost=current.record.entries.filter(e=>e.status==='active'&&e.layer==='core').reduce((n,e)=>n+conservativeTokens(e.content),0)
   for(const candidate of ready){const e=current.record.entries.find(e=>e.id===candidate.id&&e.version===candidate.version&&e.status==='deferred');if(!e)continue
    const tokens=conservativeTokens(e.content);if(e.layer==='core'&&cost+tokens>2048)continue
    current=store.edit(current,e.id,e.version,{status:'active'});if(e.layer==='core')cost+=tokens
   }
  })
 }
 async advance(watermark:number,binding:{revision:string|null;objectVersion:string|null}){
  this.context()
  return this.vault.memoryMutation(store=>{const ceiling=this.vault.materialCeiling();if(!Number.isSafeInteger(watermark)||watermark>ceiling)throw Error('BAD_REQUEST');const basis=store.read();if(basis.revision!==binding.revision||basis.objectVersion!==binding.objectVersion)throw Error('MEMORY_CONFLICT');basis.record.nextSequence=Math.max(basis.record.nextSequence,ceiling);return store.advance(basis,watermark)},true)
 }
 async reset(binding:{revision:string|null;objectVersion:string|null}){this.context();return this.vault.memoryReset(binding)}
 async manualSource(request:MemoryManualRequest):Promise<WorkingSource>{
  this.context();this.vault.assertSession(request.sessionId);const note=await this.vault.read(request.relPath);this.context()
  if(note.objectVersion!==request.objectVersion||note.revision!==request.revision)throw Error('MEMORY_SOURCE_CHANGED')
  if(request.kind==='ledger'){
   const source=await this.sourceForPrompt(request.relPath,request.taskId!)
   if(request.start<source.start||request.end>source.end)throw Error('MEMORY_SOURCE_UNCONFIRMED')
   source.text=source.text.slice(request.start-source.start,request.end-source.start);source.start=request.start;source.end=request.end;source.hash=hash(source.text);return source
  }
  const parsed=compile(note.content),block=parsed.index.blocks.find(b=>b.range.start<=request.start&&b.range.end>=request.end)
  if(parsed.stale||!block||block.identity==='ai')throw Error('MEMORY_SOURCE_UNCONFIRMED')
  const chapters=await this.vault.ledgerContexts(request.relPath),tasks=historicalBodyTasks(parsed,chapters).get(block.range.start)??[]
  const inherited=tasks.map(id=>chapters.find(c=>c.taskId===id))
  if(inherited.some(c=>!c||c.eligible===false||!c.provenance))throw Error('MEMORY_SOURCE_UNCONFIRMED')
  const sourceDeps=inherited.flatMap(c=>c!.provenance!.sources),memoryDeps=inherited.flatMap(c=>c!.provenance!.version===2?c!.provenance!.memoryDeps:[])
  const source=await this.sourceForFragment({...note,relPath:request.relPath,permissionTier:'reference',kind:'body',classification:block.identity==='command'?'command':'human',taskId:null,start:request.start,end:request.end,text:note.content.slice(request.start,request.end),hash:hash(note.content.slice(request.start,request.end)),sourceDeps,memoryDeps})
  if(tasks.length)source.classification='adopted-ai'
  if(Buffer.byteLength(source.text)>4096)throw Error('MEMORY_CONTENT_LIMIT');return source
 }
 async confirm(request:MemoryItemRequest){const {basis,entry}=this.bind(request);for(const s of entry.sources){if(!await this.verifySource(s))throw Error('MEMORY_SOURCE_CHANGED');for(const dep of s.memoryDeps){const parent=(await this.entries([dep.id])).find(e=>e.id===dep.id&&e.version===dep.version&&e.status==='active');if(!parent)throw Error('MEMORY_DEPENDENCY_CHANGED')}}
  return this.mutate(store=>store.confirm(basis,entry.id,entry.version))
 }
 async sourceForFragment(fragment:import('./host-material.ts').SentFragment):Promise<WorkingSource>{
  this.context()
  if(fragment.classification==='ai')throw Error('MEMORY_SOURCE_UNCONFIRMED')
  let materialId:string,sequence:number,basisGroups:string[]|undefined,start=fragment.start,end=fragment.end
  if(fragment.kind==='ledger'){if(!fragment.taskId)throw Error('MEMORY_MATERIAL_UNVERIFIED');const r=await this.vault.ledgerRecord(fragment.relPath,fragment.taskId);if(r.state!=='saved'||r.sequence<1)throw Error('MEMORY_MATERIAL_UNVERIFIED');materialId=fragment.taskId+'/prompt';sequence=r.sequence}
  else{const u=await this.vault.materialUnit(fragment.relPath,fragment.start,fragment.end,fragment);materialId=u.id;sequence=u.age;basisGroups=u.basisGroups;start=u.start;end=u.end}
  const source:WorkingSource={id:randomUUID(),version:1,relPath:fragment.relPath,objectVersion:fragment.objectVersion,revision:fragment.revision,permissionTier:fragment.permissionTier,kind:fragment.kind,taskId:fragment.taskId,taskMaterialHash:null,classification:fragment.classification==='command'?'command':'human',start,end,text:fragment.text,hash:fragment.hash,basisHash:hash(materialId),materialId,sequence,...(basisGroups?.length?{basisGroups}:{}),sourceDeps:fragment.sourceDeps.map(d=>({...d,permissionTier:'reference' as const})),memoryDeps:fragment.memoryDeps.map(d=>({id:d.id,version:d.version}))}
  return this.renewSavedBinding(source)
 }
 /** Persist only continuity already proven by this session's successful save receipts.
  * A restarted session cannot manufacture this association from equal text or paths. */
 async renewSavedBinding(source:WorkingSource):Promise<WorkingSource>{
  if(!await this.verifySource(source))throw Error('MEMORY_SOURCE_CHANGED')
  const renewed=structuredClone(source),note=await this.vault.read(source.relPath);this.context()
  if(!this.vault.acceptsObject(source.relPath,source.objectVersion,note.objectVersion))throw Error('MEMORY_SOURCE_CHANGED')
  renewed.objectVersion=note.objectVersion;renewed.revision=note.revision
  for(const dep of renewed.sourceDeps){const current=await this.vault.read(dep.relPath);this.context();if(!this.vault.acceptsObject(dep.relPath,dep.objectVersion,current.objectVersion)||bodyFingerprint(current.content)!==dep.bodyHash)throw Error('MEMORY_SOURCE_CHANGED');dep.objectVersion=current.objectVersion}
  if(!await this.verifySource(renewed))throw Error('MEMORY_SOURCE_CHANGED');return renewed
 }
 async savedMaterial(relPath:string,taskId:string):Promise<import('./host-material.ts').SavedTaskMaterial>{
  const context=this.context(),record=await this.vault.ledgerRecord(relPath,taskId);this.context()
  const note=await this.vault.read(relPath);this.context()
  const chapter=this.vault.ledgerContextForRecord(record).find(c=>c.taskId===taskId);this.context()
  if(record.state!=='saved'||!record.chapter||!chapter)throw Error('MEMORY_JOB_UNAVAILABLE');const c=record.chapter,material=c.material??{fragments:[],truncated:true},ledgerHash=hash(chapter.text.trimEnd())
  return {taskId,noteId:record.noteId,startedAt:c.startedAt,context,origin:{relPath,sessionId:context.sessionId,objectVersion:note.objectVersion,revision:note.revision},status:c.status,prompt:c.prompt,answer:c.answer,ledgerHash,materialVersion:hash(JSON.stringify([taskId,ledgerHash,material])),material,sourceDeps:c.provenance?.sources??[],memoryDeps:c.provenance?.version===2?c.provenance.memoryDeps:[]}
 }
 /** Derived history obeys forgetting even when the original task never used memory. */
 async summaryAllowed(relPath:string,taskIds:readonly string[]):Promise<boolean>{
  try{
   this.context();const basis=this.vault.memorySnapshot(),record=basis.record
   const forgotten=new Set(record.forgotten.flatMap(f=>f.materialIds))
   const covered=await this.vault.summaryMaterials(relPath,taskIds,[...forgotten].filter(id=>!id.endsWith('/prompt')),record.watermark);this.context();if(covered.ceiling<record.watermark||covered.materialIds.some(id=>forgotten.has(id))||record.watermark>0&&covered.sequences.some(sequence=>sequence<=record.watermark))return false
   // A concurrent forget/reset cannot be approved using the earlier control snapshot.
   this.context();const current=this.vault.memorySnapshot().record;return JSON.stringify([current.identity,current.watermark,current.forgotten])===JSON.stringify([record.identity,record.watermark,record.forgotten])
  }catch{return false}
 }
 async sourceForPrompt(relPath:string,taskId:string):Promise<WorkingSource>{
  this.context();const note=await this.vault.read(relPath);this.context()
  const record=await this.vault.ledgerRecord(relPath,taskId);this.context()
  const chapter=this.vault.ledgerContextForRecord(record).find(c=>c.taskId===taskId);this.context()
  if(record.state!=='saved'||!record.chapter||!chapter||chapter.fields?.status!=='valid'||record.sequence<1)throw Error('MEMORY_MATERIAL_UNVERIFIED')
  const field=chapter.fields.prompt,text=field.text,id=randomUUID()
  const source:WorkingSource={id,version:1,relPath,objectVersion:note.objectVersion,revision:note.revision,permissionTier:'reference',kind:'ledger',taskId,taskMaterialHash:hash(chapter.text),classification:'command',start:field.start,end:field.end,text,hash:hash(text),basisHash:hash(taskId+'/prompt'),materialId:taskId+'/prompt',sequence:record.sequence,sourceDeps:[],memoryDeps:[]}
  if(!await this.verifySource(source))throw Error('MEMORY_SOURCE_CHANGED');this.context();return source
 }
}
