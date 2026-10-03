import {requireOrdinaryNotes} from './notes-fs.ts'
import {createHash,randomUUID} from 'node:crypto'
import type {VaultSession} from './vault.ts'
import type {ModelConfigStore} from './model-config.ts'
import type {WorkingSource,WorkingEntry,WorkingSnapshot,WorkingInput} from './working-memory-store.ts'
import type {MemoryView,MemoryItemRequest} from '../shared/memory.ts'
import {compile} from '../markdown/index.ts'
import {bodyFingerprint} from './ledger-provenance.ts'
import {modelTierFor} from './permissions.ts'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
export class WorkingMemoryService{
 constructor(readonly vault:VaultSession,private readonly config:()=>ModelConfigStore|null){}
 context(){return this.vault.memoryContext()}
 async initialize(){return this.vault.memoryMutation(store=>store.initialize())}
 snapshot(){return this.vault.memorySnapshot()}
 async verifySource(source:WorkingSource):Promise<boolean>{
  const context=this.context()
  try{const root=this.vault.requireUsableRoot(),classified=await modelTierFor(root,source.relPath)
   requireOrdinaryNotes(root,[source.relPath]);if(!classified)return false
   const note=await this.vault.read(source.relPath);this.vault.assertSession(context.sessionId)
   if(!this.vault.acceptsObject(source.relPath,source.objectVersion,note.objectVersion))return false
   for(const dep of source.sourceDeps){requireOrdinaryNotes(root,[dep.relPath]);const status=await modelTierFor(root,dep.relPath);if(!status)return false;const original=await this.vault.read(dep.relPath);if(!this.vault.acceptsObject(dep.relPath,dep.objectVersion,original.objectVersion)||bodyFingerprint(original.content)!==dep.bodyHash)return false}
   let raw:string
   if(source.kind==='ledger'){
    if(!source.taskId)return false;const record=await this.vault.ledgerRecord(source.relPath,source.taskId)
    if(record.state==='cleared')return true // the retained memory is independently licensed; raw cleanup is not forgetting
    if(record.state!=='saved')return false
    const chapter=(await this.vault.ledgerContexts(source.relPath)).find(c=>c.taskId===source.taskId);if(!chapter||chapter.eligible===false)return false;raw=chapter.text
   }else{
    const parsed=compile(note.content);if(parsed.stale)return false;raw=parsed.partition.body
    let start=source.start;if(raw.slice(source.start,source.end)!==source.text){start=raw.indexOf(source.text);if(start<0||raw.indexOf(source.text,start+1)>=0)return false}
    const block=parsed.index.blocks.find(b=>b.range.start<=start&&b.range.end>=start+source.text.length)
    if(!block||block.identity==='ai')return false
   }
   if(raw.slice(source.start,source.end)===source.text&&hash(source.text)===source.hash)return true
   const first=raw.indexOf(source.text);return first>=0&&raw.indexOf(source.text,first+1)<0&&hash(source.text)===source.hash
  }catch{return false}
 }
 async entries(ids?:readonly string[]):Promise<WorkingEntry[]>{
  const context=this.context(),basis=this.snapshot(),all=basis.record.entries
  const wanted=ids?all.filter(e=>ids.includes(e.id)):all
  const result:WorkingEntry[]=[]
  for(const original of wanted){const entry=structuredClone(original)
   if(entry.status==='active'&&entry.reviewAt&&Date.parse(entry.reviewAt)<=Date.now()){entry.status='review';entry.reason='MEMORY_CONFIRMATION_REQUIRED'}
   if(entry.status==='active'&&!await this.verifyEntry(entry,all)){entry.status='paused';entry.reason='MEMORY_SOURCE_CHANGED'}
   result.push(entry)
  }
  this.vault.assertSession(context.sessionId)
  const current=this.snapshot().record.entries
  return result.filter(e=>current.some(now=>now.id===e.id&&now.version===e.version))
 }
 private async verifyEntry(entry:WorkingEntry,all:WorkingEntry[],seen=new Set<string>()):Promise<boolean>{
  if(seen.has(entry.id))return false;seen.add(entry.id)
  if(!entry.sources.length)return false
  for(const s of entry.sources){if(!await this.verifySource(s))return false;for(const dep of s.memoryDeps){const parent=all.find(e=>e.id===dep.id&&e.version===dep.version&&e.status==='active');if(!parent||parent.reviewAt&&Date.parse(parent.reviewAt)<=Date.now()||!await this.verifyEntry(parent,all,new Set(seen)))return false}}
  return true
 }
 async view():Promise<MemoryView>{
  const context=this.context(),config=this.config();let configError:string|undefined
  let cfg:import('../shared/memory.ts').PublicMemoryConfig={defaultModelId:null,limits:{seconds:120,calls:2,tools:0},vault:{enabled:false,override:{mode:'inherit'}},effectiveModelId:null,modelStatus:'unavailable'}
  try{if(!config)throw Error('MEMORY_CONFIG_UNAVAILABLE');cfg=config.getMemoryConfig(context.vaultKey)}catch{configError='MEMORY_CONFIG_UNAVAILABLE'}
  let credential:import('./model-config.ts').ModelCredential|null=null;try{credential=cfg.modelStatus==='ready'?config!.memoryCredential(context.vaultKey):null}catch{configError='MEMORY_MODEL_UNAVAILABLE'}
  let basis:WorkingSnapshot,entries:WorkingEntry[]
  try{basis=this.snapshot();entries=await this.entries()}catch(e){return {sessionId:context.sessionId,revision:null,objectVersion:null,config:cfg,recipient:credential?{modelId:credential.modelId,host:new URL(credential.baseURL).host}:null,status:'invalid',reason:e instanceof Error?e.message:'MEMORY_STORAGE_INVALID',entries:[],jobs:[],running:{permits:0,pending:0,active:0}}}
  return {sessionId:context.sessionId,revision:basis.revision,objectVersion:basis.objectVersion,config:cfg,recipient:credential?{modelId:credential.modelId,host:new URL(credential.baseURL).host}:null,status:'ready',...(configError?{reason:configError}:{}),entries:entries.map(e=>({...e,sources:e.sources.map(s=>({relPath:s.relPath,kind:s.kind,taskId:s.taskId,text:s.text,classification:s.classification}))})),jobs:basis.record.jobs.map(j=>({...j,retryable:false})),running:{permits:0,pending:0,active:0}}
 }
 private bind(request:MemoryItemRequest){this.vault.assertSession(request.sessionId);const basis=this.snapshot();if(basis.revision!==request.revision||basis.objectVersion!==request.objectVersion)throw Error('MEMORY_CONFLICT');const entry=basis.record.entries.find(e=>e.id===request.id&&e.version===request.version);if(!entry)throw Error('MEMORY_CHANGED');return {basis,entry}}
 async edit(request:MemoryItemRequest,change:Partial<WorkingInput>&{status?:WorkingEntry['status']}){return this.vault.memoryMutation(store=>{const {basis}=this.bind(request);return store.edit(basis,request.id,request.version,change)})}
 async forget(request:MemoryItemRequest){return this.vault.memoryMutation(store=>{const {basis}=this.bind(request);return store.forget(basis,request.id,request.version)})}
 async sourceForPrompt(relPath:string,taskId:string):Promise<WorkingSource>{
  const note=await this.vault.read(relPath),record=await this.vault.ledgerRecord(relPath,taskId),chapter=(await this.vault.ledgerContexts(relPath)).find(c=>c.taskId===taskId)
  if(record.state!=='saved'||!record.chapter||!chapter||chapter.fields?.status!=='valid'||record.sequence<1)throw Error('MEMORY_MATERIAL_UNVERIFIED')
  const field=chapter.fields.prompt,text=field.text,id=randomUUID()
  const source:WorkingSource={id,version:1,relPath,objectVersion:note.objectVersion,revision:note.revision,permissionTier:'reference',kind:'ledger',taskId,taskMaterialHash:hash(chapter.text),classification:'command',start:field.start,end:field.end,text,hash:hash(text),basisHash:hash(taskId+'/prompt'),materialId:taskId+'/prompt',sequence:record.sequence,sourceDeps:[],memoryDeps:[]}
  if(!await this.verifySource(source))throw Error('MEMORY_SOURCE_CHANGED');return source
 }
}
