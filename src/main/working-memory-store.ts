import {createHash,randomUUID} from 'node:crypto'
import type {SecureVaultFs} from './secure-fs.ts'
import type {MemoryEntry,MemoryEntryState,MemorySource,MemoryJobReceipt,MemoryJobGroupResult} from '../shared/memory.ts'
import {conservativeTokens} from './context-budget.ts'
import {RETIRED_MEMORY} from './memory-retirement.ts'
/** sequence is the earliest explicitly proven material age; registry units keep their actual allocation numbers. */
export type WorkingSource=MemorySource&{materialId:string;sequence:number}
export type WorkingEntry=Omit<MemoryEntry,'sources'>&{sources:WorkingSource[];semantic:'standing'|'fact';attribution:string;reviewAt:string|null;state:MemoryEntryState;category:'long'|'recent'}
export type WorkingRecent=WorkingEntry&{category:'recent';layer:'demand';semantic:'fact';recent:{taskId:string;noteId:string;materialVersion:string;createdAt:string;outcome:'completed'|'cancelled'|'failed'|'limit';sections:{goal:string;completed:string;blocked:string;next:string};assistantDraft:boolean}}
export type WorkingRecentInput=Pick<WorkingRecent,'sources'|'scope'|'recent'|'tags'>
export type WorkingBindingPatch={id:string;version:number;sources:{id:string;oldObjectVersion:string;objectVersion:string;revision:string;start:number;end:number;deps:{relPath:string;oldObjectVersion:string;objectVersion:string}[]}[]}
export type Forgotten={materialIds:string[];entryIds:{id:string;version:number}[];through:number}
export type WorkingRecord={version:3|4;identity:string;revision:number;nextSequence:number;watermark:number;entries:WorkingEntry[];recent:WorkingRecent[];forgotten:Forgotten[];jobs:MemoryJobReceipt[]}
export type WorkingSnapshot={record:WorkingRecord;revision:string|null;objectVersion:string|null;raw:string|null}
export type WorkingInput=Pick<WorkingEntry,'content'|'layer'|'scope'|'sources'|'semantic'|'attribution'|'reviewAt'|'tags'|'agreement'>
export type WorkingChange = {action:'add';input:WorkingInput} | {action:'correct'|'conflict'|'obsolete';id:string;version:number;input:WorkingInput}
const FILE='.rgent-memory',MAX=2*1024*1024,RESERVE=256*1024
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_/-]{1,256}$/.test(v)&&!v.includes('..')
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&Buffer.byteLength(v)<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)
const integer=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const empty=():WorkingRecord=>({version:4,identity:randomUUID(),revision:0,nextSequence:0,watermark:0,entries:[],recent:[],forgotten:[],jobs:[]})
export function statusFromState(state:MemoryEntryState):WorkingEntry['status']{
 if(!state.enabled)return 'disabled'
 if(state.source!=='verified')return 'paused'
 if(state.content==='disputed')return 'disputed'
 if(state.content==='obsolete')return 'obsolete'
 if(state.content==='review')return 'review'
 return state.capacity==='deferred'?'deferred':'active'
}
export function stateFromStatus(status:WorkingEntry['status'],previous?:MemoryEntryState):MemoryEntryState{
 const state:MemoryEntryState=previous?{...previous}:{source:'verified',content:'current',enabled:true,capacity:'ready'}
 switch(status){case 'active':state.source='verified';state.content='current';state.enabled=true;state.capacity='ready';break
 case 'paused':state.source='revoked';break
 case 'pending':case 'review':state.content='review';break
 case 'disputed':state.content='disputed';break
 case 'obsolete':state.content='obsolete';break
 case 'disabled':state.enabled=false;break
 case 'deferred':state.capacity='deferred';break}
 return state
}
const tagsValid=(v:unknown)=>v===undefined||Array.isArray(v)&&v.length<=6&&v.every(t=>text(t,64)&&t.length>0)&&new Set(v).size===v.length
const stateValid=(v:unknown):v is MemoryEntryState=>object(v)&&Object.keys(v).sort().join()==='capacity,content,enabled,source'&&['verified','unchecked','revoked'].includes(String(v.source))&&['current','review','disputed','obsolete'].includes(String(v.content))&&typeof v.enabled==='boolean'&&['ready','deferred'].includes(String(v.capacity))
function sourceValid(s:unknown):s is WorkingSource{
 if(!object(s)||Object.keys(s).sort().join()!==(s.basisGroups===undefined?'basisHash,classification,end,hash,id,kind,materialId,memoryDeps,objectVersion,permissionTier,relPath,revision,sequence,sourceDeps,start,taskId,taskMaterialHash,text,version':'basisGroups,basisHash,classification,end,hash,id,kind,materialId,memoryDeps,objectVersion,permissionTier,relPath,revision,sequence,sourceDeps,start,taskId,taskMaterialHash,text,version')||!identifier(s.id)||!identifier(s.materialId)||!integer(s.sequence)||s.sequence<1||s.version!==1||!text(s.relPath,4096)||!s.relPath.endsWith('.md')||s.relPath.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))||!text(s.objectVersion,512)||!text(s.revision,128)||!['reference','follow'].includes(String(s.permissionTier))||!['body','ledger'].includes(String(s.kind))||!['human','command','adopted-ai'].includes(String(s.classification))||!(s.taskId===null||identifier(s.taskId))||!(s.taskMaterialHash===null||typeof s.taskMaterialHash==='string'&&/^[a-f0-9]{64}$/.test(s.taskMaterialHash))||!integer(s.start)||!integer(s.end)||s.end<=s.start||!text(s.text,4096)||typeof s.hash!=='string'||!/^[a-f0-9]{64}$/.test(s.hash)||typeof s.basisHash!=='string'||!/^[a-f0-9]{64}$/.test(s.basisHash)||!Array.isArray(s.sourceDeps)||s.sourceDeps.length>16||!Array.isArray(s.memoryDeps)||s.memoryDeps.length>16||s.basisGroups!==undefined&&(!Array.isArray(s.basisGroups)||s.basisGroups.length>16||!s.basisGroups.every(identifier)||new Set(s.basisGroups).size!==s.basisGroups.length))return false
 return s.sourceDeps.every(d=>object(d)&&Object.keys(d).sort().join()==='bodyHash,objectVersion,permissionTier,relPath'&&text(d.relPath,4096)&&text(d.objectVersion,512)&&typeof d.bodyHash==='string'&&/^[a-f0-9]{64}$/.test(d.bodyHash)&&['reference','follow'].includes(String(d.permissionTier)))&&s.memoryDeps.every(d=>object(d)&&Object.keys(d).sort().join()==='id,version'&&identifier(d.id)&&integer(d.version)&&d.version>0)
}
function inputValid(e:unknown):e is WorkingInput{return object(e)&&text(e.content,4096)&&e.content.trim().length>0&&['core','demand'].includes(String(e.layer))&&text(e.scope,512)&&Array.isArray(e.sources)&&e.sources.length>0&&e.sources.length<=16&&e.sources.every(sourceValid)&&['standing','fact'].includes(String(e.semantic))&&text(e.attribution,512)&&tagsValid(e.tags)&&agreementValid(e.agreement,e.sources)&&(e.reviewAt===null||typeof e.reviewAt==='string'&&Number.isFinite(Date.parse(e.reviewAt)))}
function entryValid(e:unknown):e is WorkingEntry{
 if(!inputValid(e))return false
 const x=e as WorkingEntry,allowed=new Set(['id','version','content','layer','scope','sources','semantic','attribution','reviewAt','agreement','status','state','category','tags','recent','reason','updatedAt','updateBasis','pendingTarget'])
 return Object.keys(x).every(k=>allowed.has(k))&&identifier(x.id)&&integer(x.version)&&x.version>0&&['active','paused','pending','disabled','review','obsolete','disputed','deferred'].includes(x.status)&&stateValid(x.state)&&statusFromState(x.state)===x.status&&tagsValid(x.tags)&&agreementValid(x.agreement,x.sources)&&['long','recent'].includes(String(x.category))&&(x.category==='recent'||x.recent===undefined)&&text(x.updatedAt,64)&&Number.isFinite(Date.parse(x.updatedAt))&&(x.reason===null||text(x.reason,256))&&object(x.updateBasis)&&Object.keys(x.updateBasis).sort().join()==='id,kind,version'&&['manual','consolidation'].includes(String(x.updateBasis.kind))&&identifier(x.updateBasis.id)&&integer(x.updateBasis.version)&&x.updateBasis.version>0&&(x.pendingTarget===undefined||object(x.pendingTarget)&&Object.keys(x.pendingTarget).sort().join()==='id,version'&&identifier(x.pendingTarget.id)&&integer(x.pendingTarget.version)&&x.pendingTarget.version>0)
}
/** 依据角色只作结构校验：引用是否真实支撑内容仍由质量验收判断。 */
function agreementValid(agreement:unknown,sources:readonly {id:string}[]):boolean{
 if(agreement===undefined)return true
 if(!object(agreement)||Object.keys(agreement).sort().join()!=='authority,supporting')return false
 if(!Array.isArray(agreement.authority)||!agreement.authority.length||agreement.authority.length>4)return false
 if(!Array.isArray(agreement.supporting)||agreement.supporting.length>8||new Set(agreement.supporting).size!==agreement.supporting.length)return false
 const ids=new Set(sources.map(s=>s.id))
 if(!agreement.supporting.every(id=>identifier(id)&&ids.has(id)))return false
 const seen=new Set<string>()
 return agreement.authority.every(item=>{if(!object(item)||Object.keys(item).sort().join()!=='quote,sourceId'||!identifier(item.sourceId)||!ids.has(item.sourceId)||seen.has(item.sourceId)||!text(item.quote,512)||!item.quote.length)return false;seen.add(item.sourceId);return true})
}
function recentValid(e:unknown):e is WorkingRecent{
 if(!entryValid(e)||e.category!=='recent'||e.layer!=='demand'||e.semantic!=='fact'||!object((e as WorkingRecent).recent))return false
 const r=(e as WorkingRecent).recent
 if(Object.keys(r).sort().join()!=='assistantDraft,createdAt,materialVersion,noteId,outcome,sections,taskId'||!identifier(r.taskId)||!identifier(r.noteId)||!/^[a-f0-9]{64}$/.test(r.materialVersion)||!text(r.createdAt,64)||!Number.isFinite(Date.parse(r.createdAt))||!['completed','cancelled','failed','limit'].includes(r.outcome)||typeof r.assistantDraft!=='boolean'||!object(r.sections)||Object.keys(r.sections).sort().join()!=='blocked,completed,goal,next')return false
 return Object.values(r.sections).every(v=>text(v,2048))&&Buffer.byteLength(Object.values(r.sections).join(''))<=2048&&e.sources.some(s=>s.taskId===r.taskId&&s.kind==='ledger'&&s.classification==='command')
}
function recentInputValid(input:unknown):input is WorkingRecentInput{
 if(!object(input)||!text(input.scope,512)||!tagsValid(input.tags)||!Array.isArray(input.sources)||input.sources.length<1||input.sources.length>16||!input.sources.every(sourceValid))return false
 const fake={...input,id:'recent-check',version:1,content:'recent',layer:'demand',semantic:'fact',category:'recent',attribution:'工作记录',reviewAt:null,status:'active',state:stateFromStatus('active'),reason:null,updatedAt:new Date().toISOString(),updateBasis:{kind:'consolidation',id:'check',version:1}}
 return recentValid(fake)
}
function recentContent(r:WorkingRecent['recent']):string{return `目标：${r.sections.goal}\n已完成：${r.sections.completed}\n受阻：${r.sections.blocked}\n下一步：${r.sections.next}`}
const allEntries=(record:WorkingRecord):WorkingEntry[]=>[...record.entries,...record.recent]
const recentEncodedBytes=(record:WorkingRecord)=>Buffer.byteLength(encodeWorkingMemory(record))-Buffer.byteLength(encodeWorkingMemory({...record,recent:[]}))
/** Reserve the actual encoded upper bound of independent forgets of every current entry.
 * A closure shares brackets/IDs, so separate constraints are the larger representation. */
function ordinaryFits(record:WorkingRecord):boolean{
 const projected=structuredClone(record)
 projected.revision=Number.MAX_SAFE_INTEGER;projected.nextSequence=Number.MAX_SAFE_INTEGER;projected.watermark=Number.MAX_SAFE_INTEGER
 for(const entry of allEntries(record))projected.forgotten.push({materialIds:[...new Set(entry.sources.flatMap(s=>[s.materialId,...(s.basisGroups??[])]))],entryIds:[{id:entry.id,version:entry.version}],through:Number.MAX_SAFE_INTEGER})
 const bytes=Buffer.byteLength(encodeWorkingMemory(record)),future=Buffer.byteLength(encodeWorkingMemory(projected))
 return record.revision<=Number.MAX_SAFE_INTEGER-allEntries(record).length-1024&&bytes+Math.max(RESERVE,future-bytes)+16*1024<=MAX
}
function nextRevision(record:WorkingRecord,reduction=false){
 if(record.revision===Number.MAX_SAFE_INTEGER){if(!reduction)throw Error('MEMORY_FILE_LIMIT')}
 else record.revision++
}
export function encodeWorkingMemory(record:WorkingRecord):string{
 // 任何一次真实写入都是 M4 编码：读到 M3 后在同一个 CAS 内升级，不另留旧格式副本。
 const canonical:WorkingRecord={...record,version:4}
 const meta={...canonical,entries:canonical.entries.map(({content:_content,...entry})=>entry),recent:canonical.recent.map(({content:_content,...entry})=>entry)}
 const header=`<!-- rgent:memory:v4 data="${Buffer.from(JSON.stringify(meta)).toString('base64url')}" -->\n`
 return header+allEntries(canonical).map(e=>`<!-- rgent:item:v4 id="${e.id}" bytes="${Buffer.byteLength(e.content)}" -->\n${e.content}\n<!-- rgent:end:v4 -->\n`).join('')
}
/** 读 M3 与 M4；读取不升级，下一次经授权的真实写入在同一 CAS 内转换。M2 及更早仍按不兼容处理。 */
export function parseWorkingMemory(raw:string):WorkingRecord{
 // 失败时用 cause 记录出错步骤，公开码保持不变（调用方与界面仍按 MEMORY_STORAGE_INVALID 判定）。
 let step='prefix'
 try{if(Buffer.byteLength(raw)>MAX)throw Error();const prefix=/^<!-- rgent:memory:(v3|v4) data="([A-Za-z0-9_-]+)" -->\n/.exec(raw);if(!prefix)throw Error();const data=Buffer.from(prefix[2]!,'base64url');if(data.toString('base64url')!==prefix[2])throw Error();const r=JSON.parse(data.toString()) as WorkingRecord
  step='meta'
  if(Object.keys(r).sort().join()!=='entries,forgotten,identity,jobs,nextSequence,recent,revision,version,watermark'||![3,4].includes(Number(r.version))||(r.version===3&&prefix[1]!=='v3')||(r.version===4&&prefix[1]!=='v4')||!identifier(r.identity)||!integer(r.revision)||!integer(r.nextSequence)||!integer(r.watermark)||r.watermark>r.nextSequence||!Array.isArray(r.entries)||r.entries.length>1000||!r.entries.every(e=>object(e)&&e.category==='long')||!Array.isArray(r.recent)||r.recent.length>32||!r.recent.every(e=>object(e)&&e.category==='recent')||!Array.isArray(r.jobs)||r.jobs.length>256||!Array.isArray(r.forgotten))throw Error()
  step='forgotten'
  for(const f of r.forgotten){if(!object(f)||Object.keys(f).sort().join()!=='entryIds,materialIds,through'||!integer(f.through)||f.through>r.nextSequence||!Array.isArray(f.materialIds)||!f.materialIds.every(identifier)||!Array.isArray(f.entryIds)||f.entryIds.some(d=>!object(d)||!identifier(d.id)||!integer(d.version)||d.version<1))throw Error()}
  for(const job of r.jobs){
   step='job-object';if(!object(job))throw Error()
   step='job-taskId';if(!identifier(job.taskId))throw Error()
   step='job-materialVersion';if(typeof job.materialVersion!=='string'||!/^[a-f0-9]{64}$/.test(job.materialVersion))throw Error()
   step='job-outcome';if(!['queued','running','applied','rejected','interrupted'].includes(String(job.outcome)))throw Error()
   step='job-entryIds';if(!Array.isArray(job.entryIds)||!job.entryIds.every(identifier))throw Error()
   step='job-reason';if(job.reason!==undefined&&!text(job.reason,256))throw Error()
   step='job-results';if(job.results!==undefined&&!jobResultsValid(job.results))throw Error()
  }
  let remaining=Buffer.from(raw.slice(prefix[0].length))
  for(const e of allEntries(r)){step='entry-marker';const marker=/^<!-- rgent:item:(v3|v4) id="([A-Za-z0-9_-]+)" bytes="(\d+)" -->\n/.exec(remaining.subarray(0,remaining.indexOf(10)+1).toString());if(!marker||marker[1]!==prefix[1]||marker[2]!==e.id||Number(marker[3])>4096)throw Error();const start=Buffer.byteLength(marker[0]),end=start+Number(marker[3]),content=remaining.subarray(start,end);const suffix=`\n<!-- rgent:end:${prefix[1]} -->\n`;if(!Buffer.from(content.toString()).equals(content)||remaining.subarray(end,end+Buffer.byteLength(suffix)).toString()!==suffix)throw Error();e.content=content.toString();remaining=remaining.subarray(end+Buffer.byteLength(suffix));step='entry';if(!entryValid(e)||e.sources.some(s=>s.sequence>r.nextSequence))throw Error();if(e.category==='recent'){if(!recentValid(e)||e.content!==recentContent(e.recent))throw Error()}else if(e.category!=='long')throw Error()}
  step='tail'
  if(r.recent.some(e=>recentEncodedBytes({...r,recent:[e]})>16*1024)||recentEncodedBytes(r)>128*1024||remaining.length||new Set(allEntries(r).map(e=>e.id)).size!==allEntries(r).length)throw Error();return r
 }catch(error){const detail=error instanceof Error&&/^[A-Za-z0-9_.:\-]{1,80}$/.test(error.message)?`${step}:${error.message}`:step;throw new Error('MEMORY_STORAGE_INVALID',{cause:Error(detail)})}
}
/** All authoritative changes are a single native CAS, called through the vault mutation queue. */
/** 只做确定性表示归一：大小写、全半角与空白差异不算新事实；不做同义词或语义合并。 */
function sameStatement(entry:{content:string;scope:string;semantic:string},input:{content:string;scope:string;semantic:string}):boolean{
 return entry.scope===input.scope&&entry.semantic===input.semantic&&normalizedStatement(entry.content)===normalizedStatement(input.content)
}
function normalizedStatement(text:string):string{return text.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()}
function boundedJobResults(results:readonly MemoryJobGroupResult[]):MemoryJobGroupResult[]{
 // 拒绝原因优先保留：界面要能说明哪些没保存、为什么。
 const ordered=[...results.filter(r=>r.outcome==='rejected'),...results.filter(r=>r.outcome!=='rejected')],out:MemoryJobGroupResult[]=[]
 for(const result of ordered){if(out.length>=8)break;if(Buffer.byteLength(JSON.stringify([...out,result]))>256)break;out.push(result)}
 return out
}
function jobResultsValid(value:unknown):value is MemoryJobGroupResult[]{
 if(!Array.isArray(value)||value.length>8||Buffer.byteLength(JSON.stringify(value))>256)return false
 return value.every(item=>object(item)&&Object.keys(item).every(key=>['action','outcome','code'].includes(key))&&['add','correct','conflict','obsolete','recent'].includes(String(item.action))&&['applied','rejected','unchanged'].includes(String(item.outcome))&&(item.code===undefined||typeof item.code==='string'&&/^[A-Z][A-Z_]{0,63}$/.test(item.code)))
}

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
  const ordinaryBlocked=!reduction&&!administrative&&(!ordinaryFits(record)&&bytes>=beforeBytes||record.revision>Number.MAX_SAFE_INTEGER-allEntries(record).length-1024)
  const administrativeBlocked=!reduction&&administrative&&record.revision>Number.MAX_SAFE_INTEGER-allEntries(record).length
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
  const status=input.layer==='core'&&coreTokens+conservativeTokens(input.content)>2048?'deferred':'active'
  const entry:WorkingEntry={...structuredClone(input),id:randomUUID(),version:1,category:'long',status,state:stateFromStatus(status),reason:null,updatedAt:now,updateBasis:{kind:explicit?'manual':'consolidation',id:input.sources[0]!.taskId??input.sources[0]!.materialId,version:1}}
  record.entries.push(entry);this.commit(basis,record);return entry
 }
 edit(basis:WorkingSnapshot,id:string,version:number,change:Partial<WorkingInput>&{status?:WorkingEntry['status']}){
  const record=structuredClone(basis.record),entry=record.entries.find(e=>e.id===id);if(!entry||entry.version!==version)throw Error('MEMORY_CHANGED');Object.assign(entry,structuredClone(change));if(!inputValid(entry))throw Error('BAD_MEMORY_EDIT');const priorVersion=entry.version;entry.version++;entry.updatedAt=new Date().toISOString();advanceVersion(record,entry.id,priorVersion,entry.version)
  if(entry.layer==='core'&&entry.status==='active'&&record.entries.filter(e=>e.layer==='core'&&e.status==='active').reduce((n,e)=>n+conservativeTokens(e.content),0)>2048)entry.status='deferred'
  entry.state=stateFromStatus(entry.status,entry.state)
  return this.commit(basis,record)
 }
 /** Groups are isolated proposals. Related corrections either commit together or not at all. */
 apply(basis:WorkingSnapshot,groups:readonly (readonly WorkingChange[])[],receipt:MemoryJobReceipt,recentInput:WorkingRecentInput|null=null,priorResults:readonly MemoryJobGroupResult[]=[]){
  if(groups.length>64||groups.reduce((n,g)=>n+g.length,0)>64)throw Error('MEMORY_OUTPUT_LIMIT')
  let record=structuredClone(basis.record),rejected=0,rejectionReason:string|undefined;const entryIds:string[]=[]
  const results:MemoryJobGroupResult[]=[...priorResults]
  for(const group of groups){const candidate=structuredClone(record),accepted:string[]=[];let duplicates=0
   try{if(!group.length)throw Error('BAD_MEMORY_EDIT')
    for(const change of group){
     if(!inputValid(change.input)||!this.canLearn(candidate,change.input.sources))throw Error('MEMORY_MATERIAL_FORGOTTEN')
     const input=structuredClone(change.input),now=new Date().toISOString()
     candidate.nextSequence=Math.max(candidate.nextSequence,...input.sources.map(s=>s.sequence))
     if(change.action==='add'){
      const duplicate=candidate.entries.find(e=>e.status!=='disabled'&&sameStatement(e,input))
      if(duplicate){duplicates++;continue}
      if(candidate.entries.length>=1000)throw Error('MEMORY_ENTRY_LIMIT')
      const e:WorkingEntry={...input,id:randomUUID(),version:1,category:'long',status:'active',state:stateFromStatus('active'),reason:null,updatedAt:now,updateBasis:{kind:'consolidation',id:receipt.taskId,version:1}};candidate.entries.push(e);accepted.push(e.id)
     }else{
      const e=candidate.entries.find(e=>e.id===change.id&&e.version===change.version)
      if(!e)throw Error('MEMORY_CHANGED')
      // 替换的前提不能包含本次替换自己作废的反向依赖闭包，否则更正条目会被自己的下游拖成不可核验。
      assertReplacementIndependent(candidate,change.id,input)
      if(change.action==='conflict'){
       if(candidate.entries.length>=1000)throw Error('MEMORY_ENTRY_LIMIT')
       const pending:WorkingEntry={...input,id:randomUUID(),version:1,category:'long',status:'disputed',state:stateFromStatus('disputed'),reason:'MEMORY_CONFIRMATION_REQUIRED',updatedAt:now,pendingTarget:{id:e.id,version:e.version},updateBasis:{kind:'consolidation',id:receipt.taskId,version:1}}
       candidate.entries.push(pending);accepted.push(pending.id)
      }else{
       Object.assign(e,input);const priorVersion=e.version;e.version++;e.updatedAt=now;e.updateBasis={kind:'consolidation',id:receipt.taskId,version:e.version};e.status=change.action==='obsolete'?'obsolete':'active';e.state=stateFromStatus(e.status,e.state);e.reason=null;advanceVersion(candidate,e.id,priorVersion,e.version);accepted.push(e.id)
      }
     }
     // A newly added/corrected agreement may defer itself, never evict an older active one.
     const changed=accepted.at(-1),entry=candidate.entries.find(e=>e.id===changed)
     if(entry?.layer==='core'&&entry.status==='active'&&candidate.entries.filter(e=>e.layer==='core'&&e.status==='active').reduce((n,e)=>n+conservativeTokens(e.content),0)>2048){entry.status='deferred';entry.state=stateFromStatus('deferred',entry.state)}
    }
    if(!ordinaryFits(candidate))throw Error('MEMORY_FILE_LIMIT')
    record=candidate;entryIds.push(...accepted)
    // 同一议题只有允许的表示差异时返回明确幂等结果：不冒充新增，也不当作失败。
    results.push(accepted.length?{action:group[0]!.action,outcome:'applied'}:duplicates?{action:group[0]!.action,outcome:'unchanged'}:{action:group[0]!.action,outcome:'applied'})
   }catch(error){
    rejected++
    // 具体原因逐组保留：容量、版本、来源与遗忘分别可辨，不再一律折成格式错误。
    const code=error instanceof Error&&/^[A-Z][A-Z_]{0,63}$/.test(error.message)?error.message:'MEMORY_OUTPUT_INVALID'
    rejectionReason=rejectionReason??code
    results.push({action:group[0]?.action??'add',outcome:'rejected',code})
   }
  }
  const recentIds:string[]=[]
  if(recentInput){
   try{
    if(!recentInputValid(recentInput)||recentInput.recent.taskId!==receipt.taskId||recentInput.recent.materialVersion!==receipt.materialVersion)throw Error('BAD_MEMORY_EDIT')
    if(!this.canLearn(record,recentInput.sources))throw Error('MEMORY_MATERIAL_FORGOTTEN')
    const candidate=structuredClone(record),old=candidate.recent.find(e=>e.recent.taskId===receipt.taskId&&e.recent.materialVersion===receipt.materialVersion)
    if(old){recentIds.push(old.id)}else{
     const prior=candidate.recent.find(e=>e.recent.taskId===receipt.taskId)
     const now=new Date().toISOString(),entry:WorkingRecent={id:randomUUID(),version:1,content:recentContent(recentInput.recent),layer:'demand',semantic:'fact',category:'recent',scope:recentInput.scope,sources:structuredClone(recentInput.sources),tags:recentInput.tags,attribution:'工作记录',reviewAt:null,status:'active',state:stateFromStatus('active'),reason:null,updatedAt:now,updateBasis:{kind:'consolidation',id:receipt.taskId,version:1},recent:structuredClone(recentInput.recent)}
     if(prior){entry.id=prior.id;entry.version=prior.version+1;entry.updateBasis.version=entry.version}
     candidate.nextSequence=Math.max(candidate.nextSequence,...entry.sources.map(s=>s.sequence))
     candidate.recent=candidate.recent.filter(e=>e.recent.taskId!==receipt.taskId)
     candidate.recent.push(entry)
     const cutoff=Date.now()-14*24*3600*1000;candidate.recent=candidate.recent.filter(e=>Date.parse(e.recent.createdAt)>=cutoff).sort((a,b)=>Date.parse(a.recent.createdAt)-Date.parse(b.recent.createdAt))
     while(candidate.recent.length>32||recentEncodedBytes(candidate)>128*1024)candidate.recent.shift()
     if(!candidate.recent.some(e=>e.id===entry.id)||recentEncodedBytes({...candidate,recent:[entry]})>16*1024||!ordinaryFits(candidate))throw Error('MEMORY_FILE_LIMIT')
     record=candidate;recentIds.push(entry.id)
    }
    results.push({action:'recent',outcome:'applied'})
   }catch(error){
    rejected++
    const code=error instanceof Error&&/^[A-Z][A-Z_]{0,63}$/.test(error.message)?error.message:'MEMORY_OUTPUT_INVALID'
    rejectionReason=rejectionReason??code
    results.push({action:'recent',outcome:'rejected',code})
   }
  }
  record.jobs=record.jobs.filter(j=>j.taskId!==receipt.taskId)
  const bounded=boundedJobResults(results),priorRejection=priorResults.find(result=>result.outcome==='rejected')?.code
  const dominantReason=receipt.reason??rejectionReason??priorRejection
  record.jobs.push({...receipt,...(dominantReason?{reason:dominantReason}:{}),...(bounded.length?{results:bounded}:{}),...((rejected||priorRejection)&&!entryIds.length&&!recentIds.length?{outcome:'rejected' as const}:{}),entryIds:[...new Set([...entryIds,...recentIds])]});record.jobs=boundedReceipts(record.jobs)
  const snapshot=this.commit(basis,record,false,!entryIds.length&&!recentIds.length)
  return {snapshot,entryIds:[...new Set([...entryIds,...recentIds])],recentIds,rejected}
 }
 /** Explicit batch undo is version-bound and leaves textless anti-relearning constraints. */
 undo(basis:WorkingSnapshot,before:readonly WorkingEntry[],after:readonly {id:string;version:number}[],taskId:string,materialVersion:string){
  const record=structuredClone(basis.record),removed:WorkingEntry[]=[]
  for(const change of after){const collection=record.entries.some(e=>e.id===change.id)?record.entries:record.recent,at=collection.findIndex(e=>e.id===change.id&&e.version===change.version);if(at<0)throw Error('MEMORY_CHANGED')
   const current=collection[at]!,previous=before.find(e=>e.id===current.id)
   if(previous){const restored={...structuredClone(previous),version:current.version+1,updatedAt:new Date().toISOString(),updateBasis:{kind:'manual',id:taskId,version:current.version+1}} as WorkingRecent;collection[at]=restored;advanceVersion(record,restored.id,current.version,restored.version)}
   else {removed.push(current);collection.splice(at,1)}
  }
  if(removed.length)record.forgotten.push({materialIds:[...new Set(removed.flatMap(e=>e.sources.flatMap(s=>[s.materialId,...(s.basisGroups??[])])))],entryIds:removed.map(e=>({id:e.id,version:e.version})),through:Math.max(...removed.flatMap(e=>e.sources.map(s=>s.sequence)))})
  let cost=record.entries.filter(e=>e.layer==='core'&&e.status==='active'&&!before.some(b=>b.id===e.id)).reduce((n,e)=>n+conservativeTokens(e.content),0)
  for(const e of record.entries.filter(e=>e.layer==='core'&&e.status==='active'&&before.some(b=>b.id===e.id))){const size=conservativeTokens(e.content);if(cost+size>2048){e.status='deferred';e.state=stateFromStatus('deferred',e.state)}else cost+=size}
  const receipt=record.jobs.find(j=>j.taskId===taskId&&j.materialVersion===materialVersion);if(!receipt||receipt.outcome!=='applied')throw Error('MEMORY_CHANGED');receipt.outcome='rejected';receipt.reason='MEMORY_UNDONE';receipt.entryIds=[]
  return this.commit(basis,record)
 }
 forget(basis:WorkingSnapshot,id:string,version:number){
  const record=structuredClone(basis.record),entry=allEntries(record).find(e=>e.id===id);if(!entry||entry.version!==version)throw Error('MEMORY_CHANGED')
  const removed=new Set([id]);let changed=true;while(changed){changed=false;for(const e of allEntries(record))if(!removed.has(e.id)&&(e.pendingTarget&&removed.has(e.pendingTarget.id)||e.sources.some(s=>s.memoryDeps.some(d=>removed.has(d.id))))){removed.add(e.id);changed=true}}
  const entries=allEntries(record).filter(e=>removed.has(e.id)),sources=entries.flatMap(e=>e.sources)
  record.forgotten.push({materialIds:[...new Set(sources.flatMap(s=>[s.materialId,...(s.basisGroups??[])]))],entryIds:entries.map(e=>({id:e.id,version:e.version})),through:Math.max(...sources.map(s=>s.sequence))})
  record.entries=record.entries.filter(e=>!removed.has(e.id));record.recent=record.recent.filter(e=>!removed.has(e.id));record.jobs=record.jobs.filter(j=>!j.entryIds.some(i=>removed.has(i)));return this.commit(basis,record,true)
 }
 advance(basis:WorkingSnapshot,watermark:number){const record=structuredClone(basis.record);if(!integer(watermark)||watermark<record.watermark||watermark>record.nextSequence)throw Error('BAD_REQUEST');record.watermark=watermark;record.forgotten=record.forgotten.filter(f=>f.through>watermark);return this.commit(basis,record,true)}
 receipt(basis:WorkingSnapshot,job:MemoryJobReceipt){const record=structuredClone(basis.record);record.jobs=record.jobs.filter(j=>j.taskId!==job.taskId);record.jobs.push(job);record.jobs=boundedReceipts(record.jobs);return this.commit(basis,record,false,true)}
 interrupted(basis:WorkingSnapshot){const record=structuredClone(basis.record);let changed=false;for(const j of record.jobs)if(j.outcome==='queued'||j.outcome==='running'){j.outcome='interrupted';j.reason='MEMORY_INTERRUPTED';changed=true}return changed?this.commit(basis,record,false,true):basis}
 reconcile(basis:WorkingSnapshot,states:readonly {id:string;version:number;status:WorkingEntry['status'];reason:string|null}[]){
  const record=structuredClone(basis.record);let changed=false
  for(const state of states){const e=allEntries(record).find(e=>e.id===state.id&&e.version===state.version);if(e&&e.status!==state.status){e.status=state.status;e.state=stateFromStatus(state.status,e.state);e.reason=state.reason;changed=true}}
  return changed?this.commit(basis,record,false,true):basis
 }
 /** 惰性修复旧文件里的悬空依赖：依赖 id 仍在、但被引用的版本不存在且已有更新版本时改写引用。
  *  幂等、同一次 CAS；被改写方按"依赖已变"暂停。id 已遗忘的引用保持原样，交由核验如实报依赖变更。 */
 repairStaleDependencies(basis:WorkingSnapshot){
  const record=structuredClone(basis.record),current=new Map(allEntries(record).map(e=>[e.id,e.version]))
  let changed=false
  for(const dep of allEntries(record).flatMap(e=>e.sources.flatMap(s=>s.memoryDeps))){const latest=current.get(dep.id);if(latest===undefined||latest===dep.version)continue
   if(advanceVersion(record,dep.id,dep.version,latest).length)changed=true}
  return changed?this.commit(basis,record,false,true):basis
 }
 confirm(basis:WorkingSnapshot,id:string,version:number){const record=structuredClone(basis.record),entry=record.entries.find(e=>e.id===id&&e.version===version);if(!entry)throw Error('MEMORY_CHANGED')
  let target=entry
  if(entry.pendingTarget){const prior=record.entries.find(e=>e.id===entry.pendingTarget!.id&&e.version===entry.pendingTarget!.version);if(!prior)throw Error('MEMORY_CHANGED');target=prior;Object.assign(target,{content:entry.content,sources:entry.sources,scope:entry.scope,layer:entry.layer,semantic:entry.semantic,attribution:entry.attribution});record.entries=record.entries.filter(e=>e.id!==entry.id)}
  target.status='active';target.state=stateFromStatus('active',target.state);target.reason=null;target.reviewAt=null;const priorVersion=target.version;target.version++;target.updatedAt=new Date().toISOString();target.updateBasis={kind:'manual',id:target.id,version:target.version};advanceVersion(record,target.id,priorVersion,target.version)
  if(target.layer==='core'&&record.entries.filter(e=>e.layer==='core'&&e.status==='active').reduce((n,e)=>n+conservativeTokens(e.content),0)>2048){target.status='deferred';target.state=stateFromStatus('deferred',target.state)}
  return this.commit(basis,record)
 }
 relocate(basis:WorkingSnapshot,from:string,to:string,objectVersion:string){const record=structuredClone(basis.record);let changed=false;for(const e of allEntries(record))for(const s of e.sources)if(s.relPath===from&&s.objectVersion===objectVersion){s.relPath=to;changed=true}return changed?this.commit(basis,record):basis}
 /** Persist only bindings proven by this vault's committed write receipt. No semantic version changes. */
 rebindCommittedWrite(basis:WorkingSnapshot,patches:readonly WorkingBindingPatch[]){
  if(!patches.length)return basis
  const record=structuredClone(basis.record)
  for(const patch of patches){const entry=allEntries(record).find(e=>e.id===patch.id&&e.version===patch.version);if(!entry)throw Error('MEMORY_CHANGED')
   for(const update of patch.sources){const source=entry.sources.find(s=>s.id===update.id&&s.objectVersion===update.oldObjectVersion);if(!source)throw Error('MEMORY_SOURCE_CHANGED')
    source.objectVersion=update.objectVersion;source.revision=update.revision;source.start=update.start;source.end=update.end
    for(const dep of update.deps){const existing=source.sourceDeps.find(d=>d.relPath===dep.relPath&&d.objectVersion===dep.oldObjectVersion);if(!existing)throw Error('MEMORY_SOURCE_CHANGED');existing.objectVersion=dep.objectVersion}
   }
  }
  return this.commit(basis,record,false,true)
 }
}

/** Metadata-only association patches; the lifecycle journal never copies source text. */
export type MemoryRecoveryPatch={id:string;version:number;pause:boolean;sources:{id:string;objectVersion:string;revision:string;deps:{relPath:string;objectVersion:string}[]}[]}
export function applyMemoryRecovery(raw:string,patches:MemoryRecoveryPatch[]):string{
 const record=parseWorkingMemory(raw)
 for(const patch of patches){const entry=allEntries(record).find(e=>e.id===patch.id&&e.version===patch.version);if(!entry)throw Error('MEMORY_CHANGED')
  for(const update of patch.sources){const source=entry.sources.find(s=>s.id===update.id);if(!source)throw Error('MEMORY_SOURCE_CHANGED');source.objectVersion=update.objectVersion;source.revision=update.revision
   for(const dep of update.deps){const prior=source.sourceDeps.find(d=>d.relPath===dep.relPath);if(!prior)throw Error('MEMORY_SOURCE_CHANGED');prior.objectVersion=dep.objectVersion}
  }
  if(!patch.pause&&entry.status==='paused'&&['MEMORY_SOURCE_CHANGED','MEMORY_DEPENDENCY_CHANGED'].includes(entry.reason??'')){entry.state.source='verified';entry.status=statusFromState(entry.state);entry.reason=null}
  if(patch.pause&&entry.status!=='disabled'){entry.state.source='revoked';entry.status=statusFromState(entry.state);entry.reason='MEMORY_SOURCE_CHANGED'}
 }
 nextRevision(record);if(!ordinaryFits(record))throw Error('MEMORY_FILE_LIMIT');return encodeWorkingMemory(record)
}

function boundedReceipts(jobs:MemoryJobReceipt[]):MemoryJobReceipt[]{
 const protectedJobs=jobs.filter(j=>['queued','running','interrupted'].includes(j.outcome))
 if(protectedJobs.length>256)throw Error('MEMORY_QUEUE_FULL')
 const terminalCapacity=Math.min(64,256-protectedJobs.length)
 const terminalJobs=terminalCapacity>0?jobs.filter(j=>!['queued','running','interrupted'].includes(j.outcome)).slice(-terminalCapacity):[]
 return [...terminalJobs,...protectedJobs]
}

/** 就地升版（更正、手工编辑、确认提升、撤销）后，把其他条目指向旧版本的依赖引用改写到新版本。
 *  不改写会留下同 id 旧版本的悬空引用，依赖方永久不可核验（r8 冻结链式 α4 已证实）；
 *  被改写的依赖方按"依赖已变"暂停并可复核恢复，不是来源变更。 */
function advanceVersion(record:WorkingRecord,id:string,from:number,to:number):string[]{
 if(from===to)return []
 const rebound:string[]=[]
 for(const entry of allEntries(record)){
  if(entry.id===id&&entry.version===to)continue
  let changed=false
  for(const source of entry.sources)for(const dep of source.memoryDeps)if(dep.id===id&&dep.version===from){dep.version=to;changed=true}
  if(!changed)continue
  rebound.push(entry.id)
  if(entry.status==='active'){entry.status='paused';entry.reason='MEMORY_DEPENDENCY_CHANGED';entry.state=stateFromStatus('paused',entry.state)}
 }
 return rebound
}

/** 实际来源引用自身或下游时无法证明独立更正，整组拒绝，禁止删边伪造独立依据。 */
function assertReplacementIndependent(record:WorkingRecord,replacedId:string,input:WorkingInput):void{
 const reverse=new Set<string>([replacedId]);let grew=true
 while(grew){grew=false
  for(const entry of allEntries(record))if(!reverse.has(entry.id)&&entry.sources.some(source=>source.memoryDeps.some(dep=>reverse.has(dep.id)))){reverse.add(entry.id);grew=true}
 }
 if(input.sources.some(source=>source.memoryDeps.some(dep=>reverse.has(dep.id))))throw Error('MEMORY_DEPENDENCY_CHANGED')
}
