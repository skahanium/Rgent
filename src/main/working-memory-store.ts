import {createHash,randomUUID} from 'node:crypto'
import type {SecureVaultFs} from './secure-fs.ts'
import type {MemoryEntry,MemorySource,MemoryJobReceipt} from '../shared/memory.ts'
import {conservativeTokens} from './context-budget.ts'
import {RETIRED_MEMORY} from './memory-retirement.ts'
export type WorkingSource=MemorySource&{materialId:string;sequence:number}
export type WorkingEntry=Omit<MemoryEntry,'sources'>&{sources:WorkingSource[];semantic:'standing'|'fact';attribution:string;reviewAt:string|null}
export type Forgotten={materialIds:string[];entryIds:{id:string;version:number}[];through:number}
export type WorkingRecord={version:2;identity:string;revision:number;nextSequence:number;watermark:number;entries:WorkingEntry[];forgotten:Forgotten[];jobs:MemoryJobReceipt[]}
export type WorkingSnapshot={record:WorkingRecord;revision:string|null;objectVersion:string|null;raw:string|null}
export type WorkingInput=Pick<WorkingEntry,'content'|'layer'|'scope'|'sources'|'semantic'|'attribution'|'reviewAt'>
const FILE='.rgent-memory',MAX=2*1024*1024,RESERVE=256*1024
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_/-]{1,256}$/.test(v)&&!v.includes('..')
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&Buffer.byteLength(v)<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)
const integer=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const empty=():WorkingRecord=>({version:2,identity:randomUUID(),revision:0,nextSequence:0,watermark:0,entries:[],forgotten:[],jobs:[]})
function sourceValid(s:unknown):s is WorkingSource{
 if(!object(s)||!identifier(s.id)||!identifier(s.materialId)||!integer(s.sequence)||s.sequence<1||s.version!==1||!text(s.relPath,4096)||!s.relPath.endsWith('.md')||s.relPath.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))||!text(s.objectVersion,512)||!text(s.revision,128)||!['reference','follow'].includes(String(s.permissionTier))||!['body','ledger'].includes(String(s.kind))||!['human','command','adopted-ai'].includes(String(s.classification))||!integer(s.start)||!integer(s.end)||s.end<=s.start||!text(s.text,4096)||typeof s.hash!=='string'||!/^[a-f0-9]{64}$/.test(s.hash)||typeof s.basisHash!=='string'||!/^[a-f0-9]{64}$/.test(s.basisHash)||!Array.isArray(s.sourceDeps)||s.sourceDeps.length>16||!Array.isArray(s.memoryDeps)||s.memoryDeps.length>16)return false
 return s.sourceDeps.every(d=>object(d)&&text(d.relPath,4096)&&text(d.objectVersion,512)&&typeof d.bodyHash==='string'&&/^[a-f0-9]{64}$/.test(d.bodyHash))&&s.memoryDeps.every(d=>object(d)&&identifier(d.id)&&integer(d.version)&&d.version>0)
}
function inputValid(e:unknown):e is WorkingInput{return object(e)&&text(e.content,4096)&&e.content.trim().length>0&&['core','demand'].includes(String(e.layer))&&text(e.scope,512)&&Array.isArray(e.sources)&&e.sources.length>0&&e.sources.length<=16&&e.sources.every(sourceValid)&&['standing','fact'].includes(String(e.semantic))&&text(e.attribution,512)&&(e.reviewAt===null||typeof e.reviewAt==='string'&&Number.isFinite(Date.parse(e.reviewAt)))}
function entryValid(e:unknown):e is WorkingEntry{return inputValid(e)&&identifier((e as WorkingEntry).id)&&integer((e as WorkingEntry).version)&&(e as WorkingEntry).version>0&&['active','paused','pending','disabled','review','obsolete','disputed','deferred'].includes((e as WorkingEntry).status)&&text((e as WorkingEntry).updatedAt,64)&&Number.isFinite(Date.parse((e as WorkingEntry).updatedAt))&&object((e as WorkingEntry).updateBasis)}
function controls(record:WorkingRecord){const {entries:_entries,...meta}=record;return meta}
export function encodeWorkingMemory(record:WorkingRecord):string{
 const meta={...record,entries:record.entries.map(({content:_content,...entry})=>entry)}
 const header=`<!-- rgent:memory:v2 data="${Buffer.from(JSON.stringify(meta)).toString('base64url')}" -->\n`
 return header+record.entries.map(e=>`<!-- rgent:item:v2 id="${e.id}" bytes="${Buffer.byteLength(e.content)}" -->\n${e.content}\n<!-- rgent:end:v2 -->\n`).join('')
}
export function parseWorkingMemory(raw:string):WorkingRecord{
 try{if(Buffer.byteLength(raw)>MAX)throw Error();const prefix=/^<!-- rgent:memory:v2 data="([A-Za-z0-9_-]+)" -->\n/.exec(raw);if(!prefix)throw Error();const data=Buffer.from(prefix[1]!,'base64url');if(data.toString('base64url')!==prefix[1])throw Error();const r=JSON.parse(data.toString()) as WorkingRecord
  if(Object.keys(r).sort().join()!=='entries,forgotten,identity,jobs,nextSequence,revision,version,watermark'||r.version!==2||!identifier(r.identity)||!integer(r.revision)||!integer(r.nextSequence)||!integer(r.watermark)||r.watermark>r.nextSequence||!Array.isArray(r.entries)||r.entries.length>1000||!Array.isArray(r.jobs)||r.jobs.length>256||!Array.isArray(r.forgotten)||Buffer.byteLength(JSON.stringify(controls(r)))>RESERVE)throw Error()
  for(const f of r.forgotten){if(!object(f)||Object.keys(f).sort().join()!=='entryIds,materialIds,through'||!integer(f.through)||f.through>r.nextSequence||!Array.isArray(f.materialIds)||!f.materialIds.every(identifier)||!Array.isArray(f.entryIds)||f.entryIds.some(d=>!object(d)||!identifier(d.id)||!integer(d.version)||d.version<1))throw Error()}
  for(const job of r.jobs)if(!object(job)||!identifier(job.taskId)||typeof job.materialVersion!=='string'||!/^[a-f0-9]{64}$/.test(job.materialVersion)||!['queued','running','applied','rejected','interrupted'].includes(String(job.outcome))||!Array.isArray(job.entryIds)||!job.entryIds.every(identifier)||job.reason!==undefined&&!text(job.reason,256))throw Error()
  let remaining=Buffer.from(raw.slice(prefix[0].length))
  for(const e of r.entries){const marker=/^<!-- rgent:item:v2 id="([A-Za-z0-9_-]+)" bytes="(\d+)" -->\n/.exec(remaining.toString());if(!marker||marker[1]!==e.id||Number(marker[2])>4096)throw Error();const start=Buffer.byteLength(marker[0]),end=start+Number(marker[2]),content=remaining.subarray(start,end);if(!Buffer.from(content.toString()).equals(content)||remaining.subarray(end,end+23).toString()!=='\n<!-- rgent:end:v2 -->\n')throw Error();e.content=content.toString();remaining=remaining.subarray(end+23);if(!entryValid(e)||e.sources.some(s=>s.sequence>r.nextSequence))throw Error()}
  if(remaining.length||new Set(r.entries.map(e=>e.id)).size!==r.entries.length)throw Error();return r
 }catch{throw Error('MEMORY_STORAGE_INVALID')}
}
/** All authoritative changes are a single native CAS, called through the vault mutation queue. */
export class WorkingMemoryStore{
 private observed:{raw:string;id:string}|null=null
 constructor(private readonly fs:SecureVaultFs,private readonly check:()=>void){}
 read():WorkingSnapshot{
  this.check();let disk
  try{disk=this.fs.readSnapshot(FILE)}catch(e){if(e instanceof Error&&e.message==='ENOENT'){if(this.observed)throw Error('MEMORY_STORAGE_CHANGED');return {record:empty(),revision:null,objectVersion:null,raw:null}}throw e}
  const raw=disk.bytes.toString();if(!Buffer.from(raw).equals(disk.bytes))throw Error('MEMORY_STORAGE_INVALID')
  if(this.observed&&(this.observed.id!==disk.objectVersion||this.observed.raw!==raw))throw Error('MEMORY_STORAGE_CHANGED')
  const record=raw===RETIRED_MEMORY?empty():parseWorkingMemory(raw);this.observed={raw,id:disk.objectVersion};return {record,revision:hash(raw),objectVersion:disk.objectVersion,raw}
 }
 private commit(basis:WorkingSnapshot,record:WorkingRecord){
  this.check();const current=this.read();if(current.revision!==basis.revision||current.objectVersion!==basis.objectVersion)throw Error('MEMORY_CONFLICT')
  record.revision++;const raw=encodeWorkingMemory(record)
  if(Buffer.byteLength(JSON.stringify(controls(record)))>RESERVE||Buffer.byteLength(raw)>MAX||Buffer.byteLength(raw)-Buffer.byteLength(JSON.stringify(controls(record)))>MAX-RESERVE)throw Error('MEMORY_FILE_LIMIT')
  parseWorkingMemory(raw)
  const next=this.fs.replace(FILE,basis.raw,raw,basis.objectVersion??undefined);this.check();const disk=this.fs.readSnapshot(FILE);if(disk.objectVersion!==next||disk.bytes.toString()!==raw)throw Error('MEMORY_CONFLICT');this.observed={raw,id:next}
  return {record:structuredClone(record),revision:hash(raw),objectVersion:next,raw}
 }
 initialize(){const basis=this.read();return basis.raw===null||basis.raw===RETIRED_MEMORY?this.commit(basis,basis.record):basis}
 canLearn(record:WorkingRecord,sources:readonly WorkingSource[],explicit=false){return explicit||sources.every(s=>s.sequence>record.watermark&&!record.forgotten.some(f=>f.materialIds.includes(s.materialId)||s.memoryDeps.some(d=>f.entryIds.some(x=>x.id===d.id&&x.version===d.version))))}
 add(basis:WorkingSnapshot,input:WorkingInput,explicit=false):WorkingEntry{
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
  this.promote(record);return this.commit(basis,record)
 }
 private promote(record:WorkingRecord){let size=record.entries.filter(e=>e.layer==='core'&&e.status==='active').reduce((n,e)=>n+conservativeTokens(e.content),0);for(const e of record.entries.filter(e=>e.status==='deferred')){const cost=conservativeTokens(e.content);if(e.layer==='demand'||size+cost<=2048){e.status='review';e.reason='MEMORY_CONFIRMATION_REQUIRED'}}}
 forget(basis:WorkingSnapshot,id:string,version:number){
  const record=structuredClone(basis.record),entry=record.entries.find(e=>e.id===id);if(!entry||entry.version!==version)throw Error('MEMORY_CHANGED')
  const removed=new Set([id]);let changed=true;while(changed){changed=false;for(const e of record.entries)if(!removed.has(e.id)&&e.sources.some(s=>s.memoryDeps.some(d=>removed.has(d.id)))){removed.add(e.id);changed=true}}
  const entries=record.entries.filter(e=>removed.has(e.id)),sources=entries.flatMap(e=>e.sources)
  record.forgotten.push({materialIds:[...new Set(sources.map(s=>s.materialId))],entryIds:entries.map(e=>({id:e.id,version:e.version})),through:Math.max(...sources.map(s=>s.sequence))})
  record.entries=record.entries.filter(e=>!removed.has(e.id));record.jobs=record.jobs.filter(j=>!j.entryIds.some(i=>removed.has(i)));this.promote(record);return this.commit(basis,record)
 }
 advance(basis:WorkingSnapshot,watermark:number){const record=structuredClone(basis.record);if(!integer(watermark)||watermark<record.watermark||watermark>record.nextSequence)throw Error('BAD_REQUEST');record.watermark=watermark;record.forgotten=record.forgotten.filter(f=>f.through>watermark);return this.commit(basis,record)}
 receipt(basis:WorkingSnapshot,job:MemoryJobReceipt){const record=structuredClone(basis.record);record.jobs=record.jobs.filter(j=>j.taskId!==job.taskId);record.jobs.push(job);record.jobs=record.jobs.slice(-256);return this.commit(basis,record)}
 relocate(basis:WorkingSnapshot,from:string,to:string,objectVersion:string){const record=structuredClone(basis.record);let changed=false;for(const e of record.entries)for(const s of e.sources)if(s.relPath===from&&s.objectVersion===objectVersion){s.relPath=to;changed=true}return changed?this.commit(basis,record):basis}
}
