import {createHash,randomUUID} from 'node:crypto'
import type {SecureVaultFs} from './secure-fs.ts'
import type {MemoryEntry,MemorySource,MemoryJobReceipt} from '../shared/memory.ts'
import {conservativeTokens} from './context-budget.ts'
import {RETIRED_MEMORY} from './memory-retirement.ts'
/** sequence is the earliest explicitly proven material age; registry units keep their actual allocation numbers. */
export type WorkingSource=MemorySource&{materialId:string;sequence:number}
export type WorkingEntry=Omit<MemoryEntry,'sources'>&{sources:WorkingSource[];semantic:'standing'|'fact';attribution:string;reviewAt:string|null}
export type Forgotten={materialIds:string[];entryIds:{id:string;version:number}[];through:number}
export type WorkingRecord={version:2;identity:string;revision:number;nextSequence:number;watermark:number;entries:WorkingEntry[];forgotten:Forgotten[];jobs:MemoryJobReceipt[]}
export type WorkingSnapshot={record:WorkingRecord;revision:string|null;objectVersion:string|null;raw:string|null}
export type WorkingInput=Pick<WorkingEntry,'content'|'layer'|'scope'|'sources'|'semantic'|'attribution'|'reviewAt'>
export type WorkingChange = {action:'add';input:WorkingInput} | {action:'correct'|'conflict'|'obsolete';id:string;version:number;input:WorkingInput}
const FILE='.rgent-memory',MAX=2*1024*1024,RESERVE=256*1024
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_/-]{1,256}$/.test(v)&&!v.includes('..')
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&Buffer.byteLength(v)<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)
const integer=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const empty=():WorkingRecord=>({version:2,identity:randomUUID(),revision:0,nextSequence:0,watermark:0,entries:[],forgotten:[],jobs:[]})
function sourceValid(s:unknown):s is WorkingSource{
 if(!object(s)||!identifier(s.id)||!identifier(s.materialId)||!integer(s.sequence)||s.sequence<1||s.version!==1||!text(s.relPath,4096)||!s.relPath.endsWith('.md')||s.relPath.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))||!text(s.objectVersion,512)||!text(s.revision,128)||!['reference','follow'].includes(String(s.permissionTier))||!['body','ledger'].includes(String(s.kind))||!['human','command','adopted-ai'].includes(String(s.classification))||!integer(s.start)||!integer(s.end)||s.end<=s.start||!text(s.text,4096)||typeof s.hash!=='string'||!/^[a-f0-9]{64}$/.test(s.hash)||typeof s.basisHash!=='string'||!/^[a-f0-9]{64}$/.test(s.basisHash)||!Array.isArray(s.sourceDeps)||s.sourceDeps.length>16||!Array.isArray(s.memoryDeps)||s.memoryDeps.length>16||s.basisGroups!==undefined&&(!Array.isArray(s.basisGroups)||s.basisGroups.length>16||!s.basisGroups.every(identifier)||new Set(s.basisGroups).size!==s.basisGroups.length))return false
 return s.sourceDeps.every(d=>object(d)&&text(d.relPath,4096)&&text(d.objectVersion,512)&&typeof d.bodyHash==='string'&&/^[a-f0-9]{64}$/.test(d.bodyHash))&&s.memoryDeps.every(d=>object(d)&&identifier(d.id)&&integer(d.version)&&d.version>0)
}
function inputValid(e:unknown):e is WorkingInput{return object(e)&&text(e.content,4096)&&e.content.trim().length>0&&['core','demand'].includes(String(e.layer))&&text(e.scope,512)&&Array.isArray(e.sources)&&e.sources.length>0&&e.sources.length<=16&&e.sources.every(sourceValid)&&['standing','fact'].includes(String(e.semantic))&&text(e.attribution,512)&&(e.reviewAt===null||typeof e.reviewAt==='string'&&Number.isFinite(Date.parse(e.reviewAt)))}
function entryValid(e:unknown):e is WorkingEntry{return inputValid(e)&&identifier((e as WorkingEntry).id)&&integer((e as WorkingEntry).version)&&(e as WorkingEntry).version>0&&['active','paused','pending','disabled','review','obsolete','disputed','deferred'].includes((e as WorkingEntry).status)&&text((e as WorkingEntry).updatedAt,64)&&Number.isFinite(Date.parse((e as WorkingEntry).updatedAt))&&object((e as WorkingEntry).updateBasis)}
/** Reserve the actual encoded upper bound of independent forgets of every current entry.
 * A closure shares brackets/IDs, so separate constraints are the larger representation. */
function ordinaryFits(record:WorkingRecord):boolean{
 const projected=structuredClone(record)
 projected.revision=Number.MAX_SAFE_INTEGER;projected.nextSequence=Number.MAX_SAFE_INTEGER;projected.watermark=Number.MAX_SAFE_INTEGER
 for(const entry of record.entries)projected.forgotten.push({materialIds:[...new Set(entry.sources.flatMap(s=>[s.materialId,...(s.basisGroups??[])]))],entryIds:[{id:entry.id,version:entry.version}],through:Number.MAX_SAFE_INTEGER})
 const bytes=Buffer.byteLength(encodeWorkingMemory(record)),future=Buffer.byteLength(encodeWorkingMemory(projected))
 return record.revision<=Number.MAX_SAFE_INTEGER-record.entries.length-1024&&bytes+Math.max(RESERVE,future-bytes)+16*1024<=MAX
}
function nextRevision(record:WorkingRecord,reduction=false){
 if(record.revision===Number.MAX_SAFE_INTEGER){if(!reduction)throw Error('MEMORY_FILE_LIMIT')}
 else record.revision++
}
export function encodeWorkingMemory(record:WorkingRecord):string{
 const meta={...record,entries:record.entries.map(({content:_content,...entry})=>entry)}
 const header=`<!-- rgent:memory:v2 data="${Buffer.from(JSON.stringify(meta)).toString('base64url')}" -->\n`
 return header+record.entries.map(e=>`<!-- rgent:item:v2 id="${e.id}" bytes="${Buffer.byteLength(e.content)}" -->\n${e.content}\n<!-- rgent:end:v2 -->\n`).join('')
}
export function parseWorkingMemory(raw:string):WorkingRecord{
 try{if(Buffer.byteLength(raw)>MAX)throw Error();const prefix=/^<!-- rgent:memory:v2 data="([A-Za-z0-9_-]+)" -->\n/.exec(raw);if(!prefix)throw Error();const data=Buffer.from(prefix[1]!,'base64url');if(data.toString('base64url')!==prefix[1])throw Error();const r=JSON.parse(data.toString()) as WorkingRecord
  if(Object.keys(r).sort().join()!=='entries,forgotten,identity,jobs,nextSequence,revision,version,watermark'||r.version!==2||!identifier(r.identity)||!integer(r.revision)||!integer(r.nextSequence)||!integer(r.watermark)||r.watermark>r.nextSequence||!Array.isArray(r.entries)||r.entries.length>1000||!Array.isArray(r.jobs)||r.jobs.length>256||!Array.isArray(r.forgotten))throw Error()
  for(const f of r.forgotten){if(!object(f)||Object.keys(f).sort().join()!=='entryIds,materialIds,through'||!integer(f.through)||f.through>r.nextSequence||!Array.isArray(f.materialIds)||!f.materialIds.every(identifier)||!Array.isArray(f.entryIds)||f.entryIds.some(d=>!object(d)||!identifier(d.id)||!integer(d.version)||d.version<1))throw Error()}
  for(const job of r.jobs)if(!object(job)||!identifier(job.taskId)||typeof job.materialVersion!=='string'||!/^[a-f0-9]{64}$/.test(job.materialVersion)||!['queued','running','applied','rejected','interrupted'].includes(String(job.outcome))||!Array.isArray(job.entryIds)||!job.entryIds.every(identifier)||job.reason!==undefined&&!text(job.reason,256))throw Error()
  let remaining=Buffer.from(raw.slice(prefix[0].length))
  for(const e of r.entries){const marker=/^<!-- rgent:item:v2 id="([A-Za-z0-9_-]+)" bytes="(\d+)" -->\n/.exec(remaining.subarray(0,remaining.indexOf(10)+1).toString());if(!marker||marker[1]!==e.id||Number(marker[2])>4096)throw Error();const start=Buffer.byteLength(marker[0]),end=start+Number(marker[2]),content=remaining.subarray(start,end);if(!Buffer.from(content.toString()).equals(content)||remaining.subarray(end,end+23).toString()!=='\n<!-- rgent:end:v2 -->\n')throw Error();e.content=content.toString();remaining=remaining.subarray(end+23);if(!entryValid(e)||e.sources.some(s=>s.sequence>r.nextSequence))throw Error()}
  if(remaining.length||new Set(r.entries.map(e=>e.id)).size!==r.entries.length)throw Error();return r
 }catch{throw Error('MEMORY_STORAGE_INVALID')}
}
/** All authoritative changes are a single native CAS, called through the vault mutation queue. */
export class WorkingMemoryStore{
 private observed:{raw:string;id:string}|null=null
 constructor(private readonly filesystem:SecureVaultFs|(()=>SecureVaultFs),private readonly check:()=>void){}
 private get fs(){this.check();return typeof this.filesystem==='function'?this.filesystem():this.filesystem}
 read():WorkingSnapshot{
  this.check();let disk
  try{disk=this.fs.readSnapshot(FILE)}catch(e){if(e instanceof Error&&e.message==='ENOENT'){if(this.observed)throw Error('MEMORY_STORAGE_CHANGED');return {record:empty(),revision:null,objectVersion:null,raw:null}}throw e}
  const raw=disk.bytes.toString();if(!Buffer.from(raw).equals(disk.bytes))throw Error('MEMORY_STORAGE_INVALID')
  if(this.observed&&(this.observed.id!==disk.objectVersion||this.observed.raw!==raw))throw Error('MEMORY_STORAGE_CHANGED')
  const record=raw===RETIRED_MEMORY?empty():parseWorkingMemory(raw);this.observed={raw,id:disk.objectVersion};return {record,revision:hash(raw),objectVersion:disk.objectVersion,raw}
 }
 private commit(basis:WorkingSnapshot,record:WorkingRecord,reduction=false,administrative=false){
  this.check();const current=this.read();if(current.revision!==basis.revision||current.objectVersion!==basis.objectVersion)throw Error('MEMORY_CONFLICT')
  record.forgotten=record.forgotten.filter(f=>f.through>record.watermark)
  nextRevision(record,reduction);const raw=encodeWorkingMemory(record)
  const bytes=Buffer.byteLength(raw),beforeBytes=Buffer.byteLength(basis.raw??'')
  const ordinaryBlocked=!reduction&&!administrative&&(!ordinaryFits(record)&&bytes>=beforeBytes||record.revision>Number.MAX_SAFE_INTEGER-record.entries.length-1024)
  const administrativeBlocked=!reduction&&administrative&&record.revision>Number.MAX_SAFE_INTEGER-record.entries.length
  if(bytes>MAX||ordinaryBlocked||administrativeBlocked||record.revision===Number.MAX_SAFE_INTEGER&&reduction&&bytes>beforeBytes)throw Error('MEMORY_FILE_LIMIT')
  parseWorkingMemory(raw)
  const next=this.fs.replace(FILE,basis.raw,raw,basis.objectVersion??undefined);this.check();const disk=this.fs.readSnapshot(FILE);if(disk.objectVersion!==next||disk.bytes.toString()!==raw)throw Error('MEMORY_CONFLICT');this.observed={raw,id:next}
  return {record:structuredClone(record),revision:hash(raw),objectVersion:next,raw}
 }
 initialize(){const basis=this.read();return basis.raw===null||basis.raw===RETIRED_MEMORY?this.commit(basis,basis.record):basis}
 diagnosis(){this.check();try{const d=this.fs.readSnapshot(FILE);return {revision:createHash('sha256').update(d.bytes).digest('hex'),objectVersion:d.objectVersion,bytes:d.bytes.length}}catch(e){if(e instanceof Error&&e.message==='ENOENT')return {revision:null,objectVersion:null,bytes:0};throw e}}
 reset(expected:{revision:string|null;objectVersion:string|null},watermark:number){
  this.check();const current=this.diagnosis();if(current.revision!==expected.revision||current.objectVersion!==expected.objectVersion||!integer(watermark))throw Error('MEMORY_CONFLICT')
  const disk=current.objectVersion?this.fs.readSnapshot(FILE):null,raw=disk?.bytes.toString()??null
  if(disk&&!Buffer.from(raw!).equals(disk.bytes))throw Error('MEMORY_STORAGE_INVALID')
  const record=empty();record.nextSequence=watermark;record.watermark=watermark;const encoded=encodeWorkingMemory(record)
  const next=this.fs.replace(FILE,raw,encoded,current.objectVersion??undefined);this.observed={raw:encoded,id:next};return {record,revision:hash(encoded),objectVersion:next,raw:encoded}
 }
 canLearn(record:WorkingRecord,sources:readonly WorkingSource[],explicit=false){return explicit||sources.every(s=>s.sequence>record.watermark&&!record.forgotten.some(f=>f.materialIds.some(id=>id===s.materialId||s.basisGroups?.includes(id))||s.memoryDeps.some(d=>f.entryIds.some(x=>x.id===d.id&&x.version===d.version))))}
 add(basis:WorkingSnapshot,input:WorkingInput,explicit=false):WorkingEntry{
  const current=this.read();if(current.revision!==basis.revision||current.objectVersion!==basis.objectVersion)throw Error('MEMORY_CONFLICT')
  if(!inputValid(input))throw Error('BAD_MEMORY_EDIT');if(basis.record.entries.length>=1000)throw Error('MEMORY_ENTRY_LIMIT');if(!this.canLearn(basis.record,input.sources,explicit))throw Error('MEMORY_MATERIAL_FORGOTTEN')
  const record=structuredClone(basis.record);record.nextSequence=Math.max(record.nextSequence,...input.sources.map(s=>s.sequence));const now=new Date().toISOString()
  const duplicate=record.entries.find(e=>e.content===input.content&&e.scope===input.scope&&e.semantic===input.semantic&&e.status!=='disabled')
  if(duplicate)return duplicate
  const coreTokens=record.entries.filter(e=>e.layer==='core'&&e.status==='active').reduce((n,e)=>n+conservativeTokens(e.content),0)
  const entry:WorkingEntry={...structuredClone(input),id:randomUUID(),version:1,status:input.layer==='core'&&coreTokens+conservativeTokens(input.content)>2048?'deferred':'active',reason:null,updatedAt:now,updateBasis:{kind:explicit?'manual':'consolidation',id:input.sources[0]!.taskId??input.sources[0]!.materialId,version:1}}
  record.entries.push(entry);this.commit(basis,record);return entry
 }
 edit(basis:WorkingSnapshot,id:string,version:number,change:Partial<WorkingInput>&{status?:WorkingEntry['status']}){
  const record=structuredClone(basis.record),entry=record.entries.find(e=>e.id===id);if(!entry||entry.version!==version)throw Error('MEMORY_CHANGED');Object.assign(entry,structuredClone(change));if(!inputValid(entry))throw Error('BAD_MEMORY_EDIT');entry.version++;entry.updatedAt=new Date().toISOString()
  if(entry.layer==='core'&&entry.status==='active'&&record.entries.filter(e=>e.layer==='core'&&e.status==='active').reduce((n,e)=>n+conservativeTokens(e.content),0)>2048)entry.status='deferred'
  return this.commit(basis,record)
 }
 /** Groups are isolated proposals. Related corrections either commit together or not at all. */
 apply(basis:WorkingSnapshot,groups:readonly (readonly WorkingChange[])[],receipt:MemoryJobReceipt){
  if(groups.length>64||groups.reduce((n,g)=>n+g.length,0)>64)throw Error('MEMORY_OUTPUT_LIMIT')
  let record=structuredClone(basis.record),rejected=0,rejectionReason:string|undefined;const entryIds:string[]=[]
  for(const group of groups){const candidate=structuredClone(record),accepted:string[]=[]
   try{if(!group.length)throw Error('BAD_MEMORY_EDIT')
    for(const change of group){
     if(!inputValid(change.input)||!this.canLearn(candidate,change.input.sources))throw Error('MEMORY_MATERIAL_FORGOTTEN')
     const input=structuredClone(change.input),now=new Date().toISOString()
     candidate.nextSequence=Math.max(candidate.nextSequence,...input.sources.map(s=>s.sequence))
     if(change.action==='add'){
      const duplicate=candidate.entries.find(e=>e.content===input.content&&e.scope===input.scope&&e.semantic===input.semantic&&e.status!=='disabled')
      if(duplicate)continue
      if(candidate.entries.length>=1000)throw Error('MEMORY_ENTRY_LIMIT')
      const e:WorkingEntry={...input,id:randomUUID(),version:1,status:'active',reason:null,updatedAt:now,updateBasis:{kind:'consolidation',id:receipt.taskId,version:1}};candidate.entries.push(e);accepted.push(e.id)
     }else{
      const e=candidate.entries.find(e=>e.id===change.id&&e.version===change.version)
      if(!e)throw Error('MEMORY_CHANGED')
      if(change.action==='conflict'){
       if(candidate.entries.length>=1000)throw Error('MEMORY_ENTRY_LIMIT')
       const pending:WorkingEntry={...input,id:randomUUID(),version:1,status:'disputed',reason:'MEMORY_CONFIRMATION_REQUIRED',updatedAt:now,pendingTarget:{id:e.id,version:e.version},updateBasis:{kind:'consolidation',id:receipt.taskId,version:1}}
       candidate.entries.push(pending);accepted.push(pending.id)
      }else{
       Object.assign(e,input);e.version++;e.updatedAt=now;e.updateBasis={kind:'consolidation',id:receipt.taskId,version:e.version};e.status=change.action==='obsolete'?'obsolete':'active';e.reason=null;accepted.push(e.id)
      }
     }
     // A newly added/corrected agreement may defer itself, never evict an older active one.
     const changed=accepted.at(-1),entry=candidate.entries.find(e=>e.id===changed)
     if(entry?.layer==='core'&&entry.status==='active'&&candidate.entries.filter(e=>e.layer==='core'&&e.status==='active').reduce((n,e)=>n+conservativeTokens(e.content),0)>2048)entry.status='deferred'
    }
    if(!ordinaryFits(candidate))throw Error('MEMORY_FILE_LIMIT')
    record=candidate;entryIds.push(...accepted)
   }catch(error){rejected++;if(error instanceof Error&&error.message==='MEMORY_FILE_LIMIT')rejectionReason='MEMORY_FILE_LIMIT'}
  }
  record.jobs=record.jobs.filter(j=>j.taskId!==receipt.taskId)
  record.jobs.push({...receipt,...(rejected&&!entryIds.length?{outcome:'rejected' as const}:{}),entryIds:[...new Set(entryIds)],...(rejected?{reason:rejectionReason??'MEMORY_OUTPUT_INVALID'}:{})});record.jobs=boundedReceipts(record.jobs)
  const snapshot=this.commit(basis,record,false,!entryIds.length)
  return {snapshot,entryIds:[...new Set(entryIds)],rejected}
 }
 /** Explicit batch undo is version-bound and leaves textless anti-relearning constraints. */
 undo(basis:WorkingSnapshot,before:readonly WorkingEntry[],after:readonly {id:string;version:number}[],taskId:string,materialVersion:string){
  const record=structuredClone(basis.record),removed:WorkingEntry[]=[]
  for(const change of after){const at=record.entries.findIndex(e=>e.id===change.id&&e.version===change.version);if(at<0)throw Error('MEMORY_CHANGED')
   const current=record.entries[at]!,previous=before.find(e=>e.id===current.id)
   if(previous){record.entries[at]={...structuredClone(previous),version:current.version+1,updatedAt:new Date().toISOString(),updateBasis:{kind:'manual',id:taskId,version:current.version+1}}}
   else {removed.push(current);record.entries.splice(at,1)}
  }
  if(removed.length)record.forgotten.push({materialIds:[...new Set(removed.flatMap(e=>e.sources.flatMap(s=>[s.materialId,...(s.basisGroups??[])])))],entryIds:removed.map(e=>({id:e.id,version:e.version})),through:Math.max(...removed.flatMap(e=>e.sources.map(s=>s.sequence)))})
  let cost=record.entries.filter(e=>e.layer==='core'&&e.status==='active'&&!before.some(b=>b.id===e.id)).reduce((n,e)=>n+conservativeTokens(e.content),0)
  for(const e of record.entries.filter(e=>e.layer==='core'&&e.status==='active'&&before.some(b=>b.id===e.id))){const size=conservativeTokens(e.content);if(cost+size>2048)e.status='deferred';else cost+=size}
  const receipt=record.jobs.find(j=>j.taskId===taskId&&j.materialVersion===materialVersion);if(!receipt||receipt.outcome!=='applied')throw Error('MEMORY_CHANGED');receipt.outcome='rejected';receipt.reason='MEMORY_UNDONE';receipt.entryIds=[]
  return this.commit(basis,record)
 }
 forget(basis:WorkingSnapshot,id:string,version:number){
  const record=structuredClone(basis.record),entry=record.entries.find(e=>e.id===id);if(!entry||entry.version!==version)throw Error('MEMORY_CHANGED')
  const removed=new Set([id]);let changed=true;while(changed){changed=false;for(const e of record.entries)if(!removed.has(e.id)&&(e.pendingTarget&&removed.has(e.pendingTarget.id)||e.sources.some(s=>s.memoryDeps.some(d=>removed.has(d.id))))){removed.add(e.id);changed=true}}
  const entries=record.entries.filter(e=>removed.has(e.id)),sources=entries.flatMap(e=>e.sources)
  record.forgotten.push({materialIds:[...new Set(sources.flatMap(s=>[s.materialId,...(s.basisGroups??[])]))],entryIds:entries.map(e=>({id:e.id,version:e.version})),through:Math.max(...sources.map(s=>s.sequence))})
  record.entries=record.entries.filter(e=>!removed.has(e.id));record.jobs=record.jobs.filter(j=>!j.entryIds.some(i=>removed.has(i)));return this.commit(basis,record,true)
 }
 advance(basis:WorkingSnapshot,watermark:number){const record=structuredClone(basis.record);if(!integer(watermark)||watermark<record.watermark||watermark>record.nextSequence)throw Error('BAD_REQUEST');record.watermark=watermark;record.forgotten=record.forgotten.filter(f=>f.through>watermark);return this.commit(basis,record,true)}
 receipt(basis:WorkingSnapshot,job:MemoryJobReceipt){const record=structuredClone(basis.record);record.jobs=record.jobs.filter(j=>j.taskId!==job.taskId);record.jobs.push(job);record.jobs=boundedReceipts(record.jobs);return this.commit(basis,record,false,true)}
 interrupted(basis:WorkingSnapshot){const record=structuredClone(basis.record);let changed=false;for(const j of record.jobs)if(j.outcome==='queued'||j.outcome==='running'){j.outcome='interrupted';j.reason='MEMORY_INTERRUPTED';changed=true}return changed?this.commit(basis,record,false,true):basis}
 reconcile(basis:WorkingSnapshot,states:readonly {id:string;version:number;status:WorkingEntry['status'];reason:string|null}[]){
  const record=structuredClone(basis.record);let changed=false
  for(const state of states){const e=record.entries.find(e=>e.id===state.id&&e.version===state.version);if(e&&e.status==='active'&&state.status!=='active'){e.status=state.status;e.reason=state.reason;changed=true}}
  return changed?this.commit(basis,record,false,true):basis
 }
 confirm(basis:WorkingSnapshot,id:string,version:number){const record=structuredClone(basis.record),entry=record.entries.find(e=>e.id===id&&e.version===version);if(!entry)throw Error('MEMORY_CHANGED')
  let target=entry
  if(entry.pendingTarget){const prior=record.entries.find(e=>e.id===entry.pendingTarget!.id&&e.version===entry.pendingTarget!.version);if(!prior)throw Error('MEMORY_CHANGED');target=prior;Object.assign(target,{content:entry.content,sources:entry.sources,scope:entry.scope,layer:entry.layer,semantic:entry.semantic,attribution:entry.attribution});record.entries=record.entries.filter(e=>e.id!==entry.id)}
  target.status='active';target.reason=null;target.reviewAt=null;target.version++;target.updatedAt=new Date().toISOString();target.updateBasis={kind:'manual',id:target.id,version:target.version}
  if(target.layer==='core'&&record.entries.filter(e=>e.layer==='core'&&e.status==='active').reduce((n,e)=>n+conservativeTokens(e.content),0)>2048)target.status='deferred'
  return this.commit(basis,record)
 }
 relocate(basis:WorkingSnapshot,from:string,to:string,objectVersion:string){const record=structuredClone(basis.record);let changed=false;for(const e of record.entries)for(const s of e.sources)if(s.relPath===from&&s.objectVersion===objectVersion){s.relPath=to;changed=true}return changed?this.commit(basis,record):basis}
}

/** Metadata-only association patches; the lifecycle journal never copies source text. */
export type MemoryRecoveryPatch={id:string;version:number;pause:boolean;sources:{id:string;objectVersion:string;revision:string;deps:{relPath:string;objectVersion:string}[]}[]}
export function applyMemoryRecovery(raw:string,patches:MemoryRecoveryPatch[]):string{
 const record=parseWorkingMemory(raw)
 for(const patch of patches){const entry=record.entries.find(e=>e.id===patch.id&&e.version===patch.version);if(!entry)throw Error('MEMORY_CHANGED')
  for(const update of patch.sources){const source=entry.sources.find(s=>s.id===update.id);if(!source)throw Error('MEMORY_SOURCE_CHANGED');source.objectVersion=update.objectVersion;source.revision=update.revision
   for(const dep of update.deps){const prior=source.sourceDeps.find(d=>d.relPath===dep.relPath);if(!prior)throw Error('MEMORY_SOURCE_CHANGED');prior.objectVersion=dep.objectVersion}
  }
  if(!patch.pause&&entry.status==='paused'&&['MEMORY_SOURCE_CHANGED','MEMORY_DEPENDENCY_CHANGED'].includes(entry.reason??'')){entry.status='active';entry.reason=null}
  if(patch.pause&&entry.status==='active'){entry.status='paused';entry.reason='MEMORY_SOURCE_CHANGED'}
 }
 nextRevision(record);if(!ordinaryFits(record))throw Error('MEMORY_FILE_LIMIT');return encodeWorkingMemory(record)
}

function boundedReceipts(jobs:MemoryJobReceipt[]):MemoryJobReceipt[]{
 const protectedJobs=jobs.filter(j=>['queued','running','interrupted'].includes(j.outcome))
 if(protectedJobs.length>256)throw Error('MEMORY_QUEUE_FULL')
 return [...jobs.filter(j=>!['queued','running','interrupted'].includes(j.outcome)).slice(-Math.min(64,256-protectedJobs.length)),...protectedJobs]
}
