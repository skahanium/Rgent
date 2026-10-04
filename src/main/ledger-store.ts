import {decodeLedgerBytes,compressLedgerBytes} from './ledger-codec.ts'
import {createHash,randomUUID} from 'node:crypto'
import type {SecureVaultFs} from './secure-fs.ts'
import {partitionSource,compile,parseMarker} from '../markdown/index.ts'
import {ledgerChapters,ledgerTaskFields,type ContextChapter} from './host-context.ts'
import {ledgerProvenance,encodeLedgerProvenance,type LedgerProvenance} from './ledger-provenance.ts'
import {upsertAiAnswer,type LedgerChapterWrite} from './host-source.ts'
const digest=(s:string)=>createHash('sha256').update(s).digest('hex')
const fixed='.rgent/registry.json'
const id=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s)
const rel=(s:unknown):s is string=>typeof s==='string'&&s.length<=4096&&/\.md$/i.test(s)&&!s.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.'))&&!/[:\\\x00-\x1f]/.test(s)
const obj=(s:unknown):s is Record<string,unknown>=>!!s&&typeof s==='object'&&!Array.isArray(s)
const exact=(s:Record<string,unknown>,keys:string[])=>Object.keys(s).sort().join()===keys.sort().join()
export type LedgerOwner={noteId:string;relPath:string;objectVersion:string;bodyRevision:string;anchors:string[];sequenceCeiling:number}
type Registry={version:1;owners:LedgerOwner[];sequence:number}
type MaterialUnit={id:string;noteId:string;start:number;end:number;sequence:number}
export type LedgerRecord={version:1;noteId:string;taskId:string;revision:number;state:'pending-body'|'saved'|'legacy'|'cleared';bodyStatus:'present'|'unable-to-verify';chapter:Omit<LedgerChapterWrite,'reasoning'>|null;legacyRaw?:string;legacyReasoning?:string;sequence:number}
export type LedgerPage={noteId:string;records:LedgerRecord[];cursor:string|null;ownership:'verified';gaps:string[]}
function validOwner(v:unknown):v is LedgerOwner{return obj(v)&&exact(v,['noteId','relPath','objectVersion','bodyRevision','anchors','sequenceCeiling'])&&id(v.noteId)&&rel(v.relPath)&&typeof v.objectVersion==='string'&&v.objectVersion.length>0&&v.objectVersion.length<512&&typeof v.bodyRevision==='string'&&/^[a-f0-9]{64}$/.test(v.bodyRevision)&&Array.isArray(v.anchors)&&v.anchors.length<=256&&v.anchors.every(id)&&Number.isSafeInteger(v.sequenceCeiling)&&Number(v.sequenceCeiling)>=0}
function validChapter(v:unknown):v is LedgerRecord['chapter']{
 if(v===null)return true
 if(!obj(v)||!id(v.taskId)||typeof v.startedAt!=='string'||!Number.isFinite(Date.parse(v.startedAt))||!['completed','cancelled','failed','limit'].includes(String(v.status))||typeof v.prompt!=='string'||typeof v.answer!=='string')return false
 if(Object.keys(v).some(k=>!['taskId','startedAt','status','prompt','answer','reason','provenance','trace','assistant','metrics','summaryGenerators','material'].includes(k)))return false
 if(v.reason!==undefined&&typeof v.reason!=='string'||v.assistant!==undefined&&typeof v.assistant!=='string'||v.trace!==undefined&&(!Array.isArray(v.trace)||v.trace.some(t=>typeof t!=='string')))return false
 if(v.material!==undefined&&(!obj(v.material)||!Array.isArray(v.material.fragments)||v.material.fragments.length>512||typeof v.material.truncated!=='boolean'||Buffer.byteLength(JSON.stringify(v.material))>256*1024))return false
 if(v.metrics!==undefined&&(!Array.isArray(v.metrics)||v.metrics.length>256||v.metrics.some(m=>!obj(m)||!Number.isSafeInteger(m.step)||!Number.isFinite(m.estimatedInput)||m.actualInput!==null&&!Number.isFinite(m.actualInput)||m.actualOutput!==null&&!Number.isFinite(m.actualOutput))))return false
 if(v.summaryGenerators!==undefined&&(!Array.isArray(v.summaryGenerators)||v.summaryGenerators.length>64||v.summaryGenerators.some(g=>!obj(g)||typeof g.modelId!=='string'||typeof g.host!=='string'||g.format!==1)))return false
 if(v.provenance!==undefined){try{const read=ledgerProvenance(encodeLedgerProvenance(v.provenance as LedgerProvenance));if(read.status!=='valid')return false}catch{return false}}
 return true
}
function parseRecord(raw:string):LedgerRecord{
 try{const v:unknown=JSON.parse(decodeLedgerBytes(raw));if(!obj(v)||!exact(v,['version','noteId','taskId','revision','state','bodyStatus','chapter','sequence',...('legacyRaw'in v?['legacyRaw']:[]),...('legacyReasoning'in v?['legacyReasoning']:[])])||v.version!==1||!id(v.noteId)||!id(v.taskId)||!Number.isSafeInteger(v.revision)||Number(v.revision)<1||!Number.isSafeInteger(v.sequence)||Number(v.sequence)<0||!['pending-body','saved','legacy','cleared'].includes(String(v.state))||!['present','unable-to-verify'].includes(String(v.bodyStatus))||!validChapter(v.chapter)||v.legacyRaw!==undefined&&typeof v.legacyRaw!=='string'||v.legacyReasoning!==undefined&&typeof v.legacyReasoning!=='string'||v.chapter&&v.chapter.taskId!==v.taskId)throw Error()
 return v as LedgerRecord}catch{throw Error('LEDGER_RECORD_INVALID')}
}
/** Fixed app-owned records. Caller serializes all mutations with the vault queue. */
export class LedgerStore{
 constructor(private readonly filesystem:SecureVaultFs|(()=>SecureVaultFs),private readonly check:()=>void,private readonly saved?:(relPath:string,before:string,after:string,body:string)=>void){}
 private get fs(){this.check();return typeof this.filesystem==='function'?this.filesystem():this.filesystem}
 private bases=new Map<string,{raw:string;id:string}|null>()
 private read(path:string){this.check();try{const d=this.fs.readSnapshot(path),raw=d.bytes.toString('utf8');if(!Buffer.from(raw).equals(d.bytes))throw Error('LEDGER_RECORD_INVALID');const value={raw,id:d.objectVersion};this.bases.set(path,value);return value}catch(e){if(e instanceof Error&&e.message==='ENOENT'){this.bases.set(path,null);return null}throw e}}
 private replace(path:string,raw:string){this.check();const old=this.bases.has(path)?this.bases.get(path)!:this.read(path);this.fs.replace(path,old?.raw??null,raw,old?.id);this.check();if(this.read(path)?.raw!==raw)throw Error('LEDGER_CONFLICT')}
 private dirs(parts:string[]){for(let i=1;i<=parts.length;i++){const p=parts.slice(0,i).join('/');try{if(this.fs.resolve(p).at(-1)?.kind!=='dir')throw Error('LEDGER_STORAGE_INVALID')}catch(e){if(e instanceof Error&&e.message==='ENOENT')this.fs.createDirectory(p);else throw e}}}
 private registry():Registry{
  const disk=this.read(fixed);if(!disk)return {version:1,owners:[],sequence:0}
  if(Buffer.byteLength(disk.raw)>8*1024*1024)throw Error('LEDGER_REGISTRY_INVALID')
  try{const v:unknown=JSON.parse(disk.raw);if(!obj(v)||!exact(v,['version','owners','sequence'])||v.version!==1||!Number.isSafeInteger(v.sequence)||Number(v.sequence)<0||!Array.isArray(v.owners)||v.owners.length>100000||!v.owners.every(validOwner)||new Set(v.owners.map(o=>o.noteId)).size!==v.owners.length||new Set(v.owners.map(o=>o.relPath)).size!==v.owners.length||new Set(v.owners.map(o=>o.objectVersion)).size!==v.owners.length)throw Error();return v as Registry}catch{throw Error('LEDGER_REGISTRY_INVALID')}
 }
 private publish(registry:Registry,owner:LedgerOwner){this.read(`.rgent/ledgers/${owner.noteId}/owner.json`);this.dirs(['.rgent','ledgers',owner.noteId]);this.replace(`.rgent/ledgers/${owner.noteId}/owner.json`,JSON.stringify(owner));this.replace(fixed,JSON.stringify(registry))}
 /** Read-only inspection. Opening a note never grants publication or migration. */
 inspectOwner(relPath:string):import('../shared/ipc.ts').NoteSnapshot['ledger']{
  try{const note=this.fs.readSnapshot(relPath),registry=this.registry(),owner=registry.owners.find(o=>o.relPath===relPath)
   if(!this.read(fixed))this.assertNoMaterialHistory()
   if(owner&&owner.objectVersion!==note.objectVersion)throw Error('LEDGER_OWNERSHIP_UNVERIFIED')
   if(owner){const descriptor=this.read(`.rgent/ledgers/${owner.noteId}/owner.json`);if(!descriptor||descriptor.raw!==JSON.stringify(owner))throw Error('LEDGER_REGISTRY_INVALID')}
   if(partitionSource(note.bytes.toString()).ledger!==null)return {status:'unmigrated',next:'migrate'}
   return {status:owner?'verified':'unregistered',next:'none'}
  }catch(e){return {status:'invalid',reason:e instanceof Error?e.message:'LEDGER_STORAGE_INVALID',next:'repair'}}
 }
 private assertNoMaterialHistory(){
  try{if(this.fs.list('.rgent/ledgers').some(f=>f.name!=='.DS_Store'))throw Error('LEDGER_REGISTRY_INVALID')}catch(e){if(!(e instanceof Error&&e.message==='ENOENT'))throw e}
  if(this.read('.rgent/materials.json'))throw Error('LEDGER_REGISTRY_INVALID')
 }
 owner(relPath:string):LedgerOwner{
  if(!rel(relPath))throw Error('BAD_PATH');this.check();const note=this.fs.readSnapshot(relPath),registry=this.registry()
  const same=registry.owners.filter(o=>o.objectVersion===note.objectVersion)
  const atPath=registry.owners.find(o=>o.relPath===relPath)
  if(atPath&&atPath.objectVersion!==note.objectVersion)throw Error('LEDGER_OWNERSHIP_UNVERIFIED')
  if(same.length>1)throw Error('LEDGER_OWNERSHIP_UNVERIFIED')
  if(same.length===1){const owner=same[0]!;if(owner.relPath!==relPath){owner.relPath=relPath;this.publish(registry,owner)}return structuredClone(owner)}
  // A missing registry is not proof that the existing ledger tree has no history.
  if(!this.read(fixed)){try{if(this.fs.list('.rgent/ledgers').length)throw Error('LEDGER_REGISTRY_INVALID')}catch(e){if(!(e instanceof Error&&e.message==='ENOENT'))throw e}}
  const body=note.bytes.toString('utf8'),parsed=compile(body)
  const anchors=[...new Set(parsed.index.markers.flatMap(b=>{const k=parseMarker(body.slice(b.range.start,b.range.end))?.attrs['task-id'];return k?[k]:[]}))].slice(0,256)
  const owner:LedgerOwner={noteId:randomUUID(),relPath,objectVersion:note.objectVersion,bodyRevision:digest(body),anchors,sequenceCeiling:registry.sequence};registry.owners.push(owner);this.publish(registry,owner);return structuredClone(owner)
 }
 onWrite(relPath:string,before:string,after:string,body:string){const registry=this.registry(),owner=registry.owners.find(o=>o.relPath===relPath&&o.objectVersion===before);if(!owner)return;owner.objectVersion=after;owner.bodyRevision=digest(body);this.publish(registry,owner)}
 relocate(from:string,to:string,objectVersion:string){const registry=this.registry(),owner=registry.owners.find(o=>o.relPath===from&&o.objectVersion===objectVersion);if(!owner)return;const current=this.fs.readSnapshot(to);if(current.objectVersion!==objectVersion)throw Error('LEDGER_OWNERSHIP_UNVERIFIED');owner.relPath=to;this.publish(registry,owner)}
 materialUnit(relPath:string,start:number,end:number){
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start)throw Error('BAD_REQUEST')
  this.materialCeiling()
  const owner=this.owner(relPath),file='.rgent/materials.json',units=this.materialUnits()
  const known=units.find(u=>u.noteId===owner.noteId&&u.start===start&&u.end===end);if(known)return known
  if(units.length>=100000)throw Error('MEMORY_SOURCE_LIMIT')
  const registry=this.registry();registry.sequence++;if(!Number.isSafeInteger(registry.sequence))throw Error('LEDGER_RECORD_LIMIT');const row=registry.owners.find(o=>o.noteId===owner.noteId)!;row.sequenceCeiling=registry.sequence;this.publish(registry,row)
  const unit={id:randomUUID(),noteId:owner.noteId,start,end,sequence:registry.sequence};units.push(unit);this.replace(file,JSON.stringify({version:1,units}));return unit
 }
 maintenancePreview(relPath:string,action:'compress'|'clear'){
  const owner=this.owner(relPath);let cursor:string|null=null,totalBytes=0;const records:{taskId:string;revision:number;bytes:number}[]=[],legacyIds:string[]=[]
  do{const page=this.page(relPath,cursor);for(const r of page.records){const d=this.read(this.path(owner,r.taskId))!;totalBytes+=Buffer.byteLength(d.raw);if(records.length<20&&r.state!=='pending-body'&&r.state!=='cleared'&&(action==='clear'||r.state==='saved'&&Date.parse(r.chapter!.startedAt)<Date.now()-7*86400000&&!d.raw.includes('"codec":"gzip"')))records.push({taskId:r.taskId,revision:r.revision,bytes:Buffer.byteLength(d.raw)})}cursor=page.cursor}while(cursor)
  if(action==='clear'){let c:string|null=null;do{const p=this.page(relPath,c);legacyIds.push(...p.records.filter(r=>r.legacyRaw!==undefined&&r.state!=='cleared').map(r=>r.taskId));c=p.cursor}while(c)}
  const disk=this.read(`.rgent/ledgers/${owner.noteId}/legacy.json`);if(disk)totalBytes+=Buffer.byteLength(disk.raw)
  const archive=action==='clear'&&disk&&legacyIds.length&&legacyIds.every(id=>records.some(r=>r.taskId===id))?{revision:digest(disk.raw),bytes:Buffer.byteLength(disk.raw)}:undefined
  return {records,totalBytes,...(archive?{archive}:{}),warning:action==='clear'?'只清理列出的已完成历史，不修改正文或自动遗忘已学记忆。原始材料清理后不能重建对应摘要。'+(archive?'本次同时清除全部关联任务共享的旧归档，包括未解析内容。':disk?'共享旧归档仍保留历史内容；本次不清除共享归档。':''):'核验无损往返与净节省后替换同一记录；不保留双表示。'}
 }
 maintain(relPath:string,action:'compress'|'clear',items:readonly {taskId:string;revision:number}[],archive?:{revision:string;bytes:number}){
  if(items.length>20||new Set(items.map(i=>i.taskId)).size!==items.length)throw Error('BAD_REQUEST')
  const owner=this.owner(relPath),success:string[]=[],failed:string[]=[];let savedBytes=0,archiveCleared=false
  const archivePath=`.rgent/ledgers/${owner.noteId}/legacy.json`,originalArchive=archive?this.read(archivePath):null
  if(archive&&(action!=='clear'||!originalArchive||digest(originalArchive.raw)!==archive.revision||Buffer.byteLength(originalArchive.raw)!==archive.bytes))throw Error('LEDGER_CONFLICT')
  for(const item of items){try{const r=this.record(owner,item.taskId),disk=this.bases.get(this.path(owner,item.taskId));if(!r||r.revision!==item.revision||r.state==='pending-body'||!disk)throw Error('LEDGER_CONFLICT')
    if(action==='compress'){if(r.state!=='saved'||Date.parse(r.chapter!.startedAt)>=Date.now()-7*86400000)throw Error('BAD_REQUEST');const zipped=compressLedgerBytes(decodeLedgerBytes(disk.raw));if(zipped){this.replace(this.path(owner,r.taskId),zipped.raw);savedBytes+=Buffer.byteLength(disk.raw)-Buffer.byteLength(zipped.raw)}}
    else {const cleared:LedgerRecord={version:1,noteId:owner.noteId,taskId:r.taskId,revision:r.revision+1,state:'cleared',bodyStatus:'unable-to-verify',chapter:null,sequence:r.sequence};this.replace(this.path(owner,r.taskId),JSON.stringify(cleared));savedBytes+=Buffer.byteLength(disk.raw)-Buffer.byteLength(JSON.stringify(cleared))}
    success.push(item.taskId)
   }catch{failed.push(item.taskId)}}
  if(archive&&originalArchive&&!failed.length){let cursor:string|null=null,referenced=false;do{const page=this.page(relPath,cursor);referenced ||= page.records.some(r=>r.legacyRaw!==undefined&&r.state!=='cleared');cursor=page.cursor}while(cursor)
   if(!referenced){const raw='<!-- rgent:ledger:v1 -->\n',stub=JSON.stringify({version:1,raw,hash:digest(raw)});try{this.replace(archivePath,stub);archiveCleared=true;savedBytes+=Buffer.byteLength(originalArchive.raw)-Buffer.byteLength(stub)}catch{failed.push('legacy-archive')}}
  }
  return {success,failed,savedBytes,archiveCleared}
 }
 registryRevision(){return this.read(fixed)?.raw?digest(this.bases.get(fixed)!.raw):null}
 private materialUnits():MaterialUnit[]{
  const disk=this.read('.rgent/materials.json');if(!disk)return []
  try{if(Buffer.byteLength(disk.raw)>8*1024*1024)throw Error();const v:unknown=JSON.parse(disk.raw)
   if(!obj(v)||!exact(v,['version','units'])||v.version!==1||!Array.isArray(v.units)||v.units.length>100000||v.units.some(u=>!obj(u)||!exact(u,['id','noteId','start','end','sequence'])||!id(u.id)||!id(u.noteId)||!Number.isSafeInteger(u.start)||!Number.isSafeInteger(u.end)||Number(u.start)<0||Number(u.end)<=Number(u.start)||!Number.isSafeInteger(u.sequence)||Number(u.sequence)<1))throw Error()
   return v.units as MaterialUnit[]
  }catch{throw Error('LEDGER_REGISTRY_INVALID')}
 }
 materialState():{status:'verified'|'empty';sequence:number}|{status:'invalid';reason:string}{
  try{const registry=this.registry();if(!this.read(fixed)){this.assertNoMaterialHistory();return {status:'empty',sequence:0}}
   const owners=new Map(registry.owners.map(owner=>[owner.noteId,owner])),sequences=new Set<number>(),unitIds=new Set<string>(),unitRanges=new Set<string>()
   const verifySequence=(noteId:string,sequence:number)=>{const owner=owners.get(noteId);if(!owner||sequence>owner.sequenceCeiling||sequence>registry.sequence||sequence>0&&sequences.has(sequence))throw Error('LEDGER_REGISTRY_INVALID');if(sequence>0)sequences.add(sequence)}
   for(const owner of owners.values())if(owner.sequenceCeiling>registry.sequence)throw Error('LEDGER_REGISTRY_INVALID')
   for(const unit of this.materialUnits()){
    const range=JSON.stringify([unit.noteId,unit.start,unit.end]);if(unitIds.has(unit.id)||unitRanges.has(range))throw Error('LEDGER_REGISTRY_INVALID');unitIds.add(unit.id);unitRanges.add(range);verifySequence(unit.noteId,unit.sequence)
   }
   let count=0;const dirs=this.fs.list('.rgent/ledgers');if(dirs.length>100000)throw Error('LEDGER_REGISTRY_INVALID')
   const found=new Set<string>()
   for(const dir of dirs){if(dir.name==='.DS_Store'&&dir.kind==='file')continue
    const owner=owners.get(dir.name);if(dir.kind!=='dir'||!owner)throw Error('LEDGER_REGISTRY_INVALID');found.add(dir.name)
    const descriptor=this.read(`.rgent/ledgers/${dir.name}/owner.json`);if(!descriptor||descriptor.raw!==JSON.stringify(owner))throw Error('LEDGER_REGISTRY_INVALID')
    for(const file of this.fs.list(`.rgent/ledgers/${dir.name}`)){
     if(['owner.json','legacy.json','recovery.json','.DS_Store'].includes(file.name)){if(file.kind!=='file')throw Error('LEDGER_REGISTRY_INVALID');continue}
     if(++count>100000||file.kind!=='file'||!file.name.endsWith('.json'))throw Error('LEDGER_REGISTRY_INVALID')
     // Read-only verification must not retain every historical task in the CAS
     // basis cache. The queue serializes control operations; writes reread bases.
     const bytes=this.fs.readSnapshot(`.rgent/ledgers/${dir.name}/${file.name}`).bytes,raw=bytes.toString('utf8')
     if(!Buffer.from(raw).equals(bytes))throw Error('LEDGER_REGISTRY_INVALID')
     const record=parseRecord(raw)
     if(record.sequence===0&&['pending-body','saved'].includes(record.state))throw Error('LEDGER_REGISTRY_INVALID')
     // The 2 MiB cap belongs to newly produced tasks. Exact historical tails
     // remain lossless, including old records larger than the new-task limit.
     if(record.legacyRaw===undefined&&Buffer.byteLength(decodeLedgerBytes(raw))>2*1024*1024||record.noteId!==owner.noteId||file.name!==record.taskId+'.json')throw Error('LEDGER_REGISTRY_INVALID');verifySequence(record.noteId,record.sequence)
    }
   }
   if(found.size!==owners.size)throw Error('LEDGER_REGISTRY_INVALID')
   return {status:'verified',sequence:registry.sequence}
  }catch{return {status:'invalid',reason:'LEDGER_REGISTRY_INVALID'}}
 }
 materialCeiling(){const state=this.materialState();if(state.status==='invalid')throw Error(state.reason);return state.sequence}
 taskPath(taskId:string){if(!id(taskId))throw Error('BAD_REQUEST');const matches=this.registry().owners.filter(o=>this.read(this.path(o,taskId))!==null);if(matches.length!==1)throw Error('MEMORY_JOB_UNAVAILABLE');return matches[0]!.relPath}
 repairRegistry(expected:string|null){if(this.registryRevision()!==expected)throw Error('LEDGER_CONFLICT');this.rebuildRegistry()}
 rebuildRegistry(){this.check();const owners:LedgerOwner[]=[];for(const dir of this.fs.list('.rgent/ledgers')){if(dir.kind!=='dir'||!id(dir.name))throw Error('LEDGER_REGISTRY_INVALID');const raw=this.read(`.rgent/ledgers/${dir.name}/owner.json`);if(!raw)throw Error('LEDGER_REGISTRY_INVALID');let owner:unknown;try{owner=JSON.parse(raw.raw)}catch{throw Error('LEDGER_REGISTRY_INVALID')};if(!validOwner(owner)||owner.noteId!==dir.name)throw Error('LEDGER_REGISTRY_INVALID');owners.push(owner)}
 if(new Set(owners.map(o=>o.noteId)).size!==owners.length||new Set(owners.map(o=>o.relPath)).size!==owners.length||new Set(owners.map(o=>o.objectVersion)).size!==owners.length)throw Error('LEDGER_REGISTRY_INVALID');this.replace(fixed,JSON.stringify({version:1,owners,sequence:Math.max(0,...owners.map(o=>o.sequenceCeiling))}))
 }
 private path(owner:LedgerOwner,taskId:string){if(!id(taskId))throw Error('BAD_REQUEST');return `.rgent/ledgers/${owner.noteId}/${taskId}.json`}
 getRecord(relPath:string,taskId:string){const owner=this.owner(relPath),record=this.record(owner,taskId);if(!record)throw Error('LEDGER_RECORD_INVALID');return record}
 private record(owner:LedgerOwner,taskId:string){const raw=this.read(this.path(owner,taskId));if(!raw)return null;const record=parseRecord(raw.raw);if(record.noteId!==owner.noteId||record.taskId!==taskId)throw Error('LEDGER_RECORD_INVALID');return record}
 prepare(relPath:string,chapter:LedgerChapterWrite,expectedVersion?:number):LedgerRecord{
  this.materialCeiling()
  const owner=this.owner(relPath),{reasoning:_reasoning,...visible}=chapter
  if(!validChapter(visible))throw Error('LEDGER_RECORD_INVALID')
  const previous=this.record(owner,chapter.taskId)
  if(previous){
   if(JSON.stringify(previous.chapter)===JSON.stringify(visible))return previous
   if(expectedVersion!==previous.revision||previous.state!=='pending-body'||previous.chapter?.prompt!==chapter.prompt||previous.chapter.startedAt!==chapter.startedAt||JSON.stringify(previous.chapter.provenance?.model)!==JSON.stringify(chapter.provenance?.model))throw Error('LEDGER_TASK_CONFLICT')
   previous.chapter=visible;previous.revision++;const raw=JSON.stringify(previous);if(Buffer.byteLength(raw)>2*1024*1024)throw Error('LEDGER_RECORD_LIMIT');this.replace(this.path(owner,chapter.taskId),raw);return previous
  }
  const registry=this.registry(),row=registry.owners.find(o=>o.noteId===owner.noteId)!;registry.sequence++;if(!Number.isSafeInteger(registry.sequence))throw Error('LEDGER_RECORD_LIMIT');row.sequenceCeiling=registry.sequence;this.publish(registry,row)
  const record:LedgerRecord={version:1,noteId:owner.noteId,taskId:chapter.taskId,revision:1,state:'pending-body',bodyStatus:'unable-to-verify',chapter:visible,sequence:registry.sequence}
  const raw=JSON.stringify(record);if(Buffer.byteLength(raw)>2*1024*1024)throw Error('LEDGER_RECORD_LIMIT');this.replace(this.path(owner,chapter.taskId),raw);return record
 }
 complete(relPath:string,taskId:string,bodyRevision:string):LedgerRecord{
  const owner=this.owner(relPath),note=this.fs.readSnapshot(relPath),record=this.record(owner,taskId);if(!record||!record.chapter)throw Error('LEDGER_RECORD_INVALID');if(digest(note.bytes.toString())!==bodyRevision)throw Error('LEDGER_BODY_CHANGED')
  const body=note.bytes.toString(),blocks=compile(body).index.markers.filter(b=>b.identity==='ai'&&parseMarker(body.slice(b.range.start,b.range.end))?.attrs['task-id']===taskId)
  // The Host write receipt is necessary; identity markers are an additional local check.
  if(record.chapter.answer.trim()){if(blocks.length<1)throw Error('LEDGER_BODY_CHANGED');try{if(upsertAiAnswer(body,{taskId,answer:record.chapter.answer,expectedPreviousAnswer:record.chapter.answer})!==body)throw Error()}catch{throw Error('LEDGER_BODY_CHANGED')}}
  if(record.state==='saved'&&record.bodyStatus==='present')return record
  record.state='saved';record.bodyStatus='present';record.revision++;this.replace(this.path(owner,taskId),JSON.stringify(record));return record
 }
 private displayed(relPath:string,record:LedgerRecord){
  if(record.state==='saved'&&record.chapter?.answer){try{const body=this.fs.readSnapshot(relPath).bytes.toString();if(upsertAiAnswer(body,{taskId:record.taskId,answer:record.chapter.answer,expectedPreviousAnswer:record.chapter.answer})!==body)record.bodyStatus='unable-to-verify'}catch{record.bodyStatus='unable-to-verify'}}
  return record
 }
 page(relPath:string,cursor:string|null=null,maxBytes=128*1024):LedgerPage{
  const owner=this.owner(relPath),registry=this.registry()
  type Boundary=[number,number,string,string]
  let boundary:Boundary|null=null,ceiling=registry.sequence
  if(cursor!==null){try{const value:unknown=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!Array.isArray(value)||value.length!==4||!Number.isSafeInteger(value[0])||!Number.isSafeInteger(value[1])||value[0]<0||value[1]<0||typeof value[2]!=='string'||!id(value[3]))throw Error();boundary=value as Boundary;ceiling=boundary[0]}catch{throw Error('BAD_REQUEST')}}
  const ordered=this.fs.list(`.rgent/ledgers/${owner.noteId}`).filter(f=>f.kind==='file'&&!['owner.json','legacy.json','recovery.json'].includes(f.name)&&f.name.endsWith('.json')).map(file=>{
   const disk=this.read(`.rgent/ledgers/${owner.noteId}/${file.name}`);if(!disk)throw Error('LEDGER_RECORD_INVALID');const record=parseRecord(disk.raw);if(record.noteId!==owner.noteId||file.name!==record.taskId+'.json')throw Error('LEDGER_RECORD_INVALID');return {record,bytes:Buffer.byteLength(disk.raw)}
  }).filter(({record})=>record.sequence<=ceiling)
  const compare=(a:LedgerRecord,b:LedgerRecord)=>b.sequence-a.sequence||(b.chapter?.startedAt??'').localeCompare(a.chapter?.startedAt??'')||b.taskId.localeCompare(a.taskId)
  ordered.sort((a,b)=>compare(a.record,b.record))
  const eligible=boundary?ordered.filter(({record})=>compare(record,{sequence:boundary![1],chapter:{startedAt:boundary![2]},taskId:boundary![3]} as LedgerRecord)>0):ordered
  const records:LedgerRecord[]=[];let bytes=0
  for(const entry of eligible){if(records.length&&(records.length>=20||bytes+entry.bytes>maxBytes))break;records.push(this.displayed(relPath,entry.record));bytes+=entry.bytes}
  const last=records.at(-1),next=last&&records.length<eligible.length?Buffer.from(JSON.stringify([ceiling,last.sequence,last.chapter?.startedAt??'',last.taskId])).toString('base64url'):null
  return {noteId:owner.noteId,records,cursor:next,ownership:'verified',gaps:records.filter(r=>r.state==='cleared').map(r=>r.taskId)}
 }
 wirePage(relPath:string,cursor:string|null):import('../shared/ledger.ts').LedgerView{
  let taskId:string|null=null,offset=0,expected:string|null=null,nextPage:string|null=null
  if(cursor?.startsWith('raw:')){const parts=cursor.split(':');if(parts.length!==5||!id(parts[1])||!/^\d+$/.test(parts[2]!)||!/^[a-f0-9]{64}$/.test(parts[3]!)||!/^[A-Za-z0-9_-]+$/.test(parts[4]!))throw Error('BAD_REQUEST');taskId=parts[1]!;offset=Number(parts[2]);expected=parts[3]!;nextPage=parts[4]==='-1'?null:parts[4]!}
  const page=taskId?{noteId:this.owner(relPath).noteId,records:[] as LedgerRecord[],cursor:nextPage,ownership:'verified' as const,gaps:[] as string[]}:this.page(relPath,cursor,116*1024)
  const record=taskId?this.displayed(relPath,this.getRecord(relPath,taskId)):page.records[0]
  if(!record)return page
  const raw=JSON.stringify(record),bytes=Buffer.from(raw),hash=digest(raw)
  if(taskId||bytes.length>116*1024){if(expected&&hash!==expected||offset>=bytes.length)throw Error('LEDGER_CONFLICT');const data=bytes.subarray(offset,offset+88*1024),end=offset+data.length
   const next=taskId?nextPage:page.cursor??'-1'
   return {noteId:page.noteId,records:[],ownership:'verified',gaps:page.gaps,chunk:{taskId:record.taskId,data:data.toString('base64'),offset,total:bytes.length,hash},cursor:end<bytes.length?`raw:${record.taskId}:${end}:${hash}:${next??'-1'}`:next==='-1'?null:next}
  }
  return page
 }
 legacyRaw(relPath:string){const owner=this.owner(relPath),d=this.read(`.rgent/ledgers/${owner.noteId}/legacy.json`);if(!d)return null;try{const v=JSON.parse(d.raw);if(v.version!==1||typeof v.raw!=='string'||digest(v.raw)!==v.hash)throw Error();return v.raw as string}catch{throw Error('LEDGER_RECORD_INVALID')}}
 importLegacy(relPath:string,raw:string){
  const owner=this.owner(relPath)
  if(partitionSource(raw).ledger!==raw)throw Error('LEDGER_RECORD_INVALID')
  const legacyPath=`.rgent/ledgers/${owner.noteId}/legacy.json`,existing=this.read(legacyPath)
  if(existing){let prior:unknown;try{prior=JSON.parse(existing.raw)}catch{throw Error('LEDGER_RECORD_INVALID')};if(!obj(prior)||prior.raw!==raw||prior.hash!==digest(raw))throw Error('LEDGER_TASK_CONFLICT')}
  else this.replace(legacyPath,JSON.stringify({version:1,raw:raw,hash:digest(raw)}))
  // Re-read persisted exact tail before any destructive body replacement.
  if(this.legacyRaw(relPath)!==raw)throw Error('LEDGER_CONFLICT')
  let chapters:ContextChapter[]=[];try{chapters=ledgerChapters(raw)}catch{/* entire tail stays an opaque history artifact */}
  if(!chapters.length){const taskId='legacy-'+digest(raw).slice(0,32);if(!this.record(owner,taskId))this.replace(this.path(owner,taskId),JSON.stringify({version:1,noteId:owner.noteId,taskId,revision:1,state:'legacy',bodyStatus:'unable-to-verify',chapter:null,legacyRaw:raw,sequence:0}))}
  for(const c of chapters){const fields=c.fields??ledgerTaskFields(c.text),prov=ledgerProvenance(c.text),taskId=c.taskId??'legacy-'+digest(c.text).slice(0,32)
   const previous=this.record(owner,taskId);if(previous){if(previous.legacyRaw!==c.text)throw Error('LEDGER_TASK_CONFLICT');continue}
   const headers=[...c.text.matchAll(/^## ([^\r\n]+) · (completed|cancelled|failed|limit)\r?$/gm)]
   const h=headers.length===1?headers[0]:null
   const chapter=fields.status==='valid'&&h&&Number.isFinite(Date.parse(h[1]!))?{taskId,startedAt:h[1]!,status:h[2] as LedgerChapterWrite['status'],prompt:fields.prompt.text,answer:fields.answer.text,...(prov.status==='valid'?{provenance:prov.record}:{})}:null
   const record:LedgerRecord={version:1,noteId:owner.noteId,taskId,revision:1,state:'legacy',bodyStatus:'unable-to-verify',chapter,legacyRaw:c.text,sequence:0};this.replace(this.path(owner,taskId),JSON.stringify(record))
  }
 }
 recoveryCopy(source:string,target:string,sourceObject:string,legacy:string|null,chapters:readonly LedgerChapterWrite[]){
  const registry=this.registry(),original=registry.owners.find(o=>o.relPath===source&&o.objectVersion===sourceObject),next=this.owner(target)
  const relationship={version:1,fromNoteId:original?.noteId??null,source,sourceObjectVersion:sourceObject,noteId:next.noteId,taskIds:chapters.map(c=>c.taskId)}
  this.replace(`.rgent/ledgers/${next.noteId}/recovery.json`,JSON.stringify(relationship))
  if(legacy)this.importLegacy(target,legacy)
  for(const chapter of chapters){const record=this.prepare(target,chapter);try{this.complete(target,record.taskId,digest(this.fs.readSnapshot(target).bytes.toString()))}catch{/* copied recovery checkpoint remains pending; never rewrite the body */}}
 }
 migrate(relPath:string,expected?:{objectVersion:string;revision:string}):{body:string;objectVersion:string;revision:string;migrated:boolean}{
  const note=this.fs.readSnapshot(relPath),raw=note.bytes.toString('utf8');if(!Buffer.from(raw).equals(note.bytes))throw Error('LEDGER_RECORD_INVALID')
  if(expected&&(note.objectVersion!==expected.objectVersion||digest(raw)!==expected.revision))throw Error('CONFLICT')
  this.owner(relPath);const part=partitionSource(raw)
  if(part.ledger===null)return {body:raw,objectVersion:note.objectVersion,revision:digest(raw),migrated:false}
  this.importLegacy(relPath,part.ledger)
  this.check();const after=this.fs.replace(relPath,raw,part.body,note.objectVersion);this.saved?.(relPath,note.objectVersion,after,part.body);this.onWrite(relPath,note.objectVersion,after,part.body)
  return {body:part.body,objectVersion:after,revision:digest(part.body),migrated:true}
 }
 contexts(relPath:string):ContextChapter[]{const records:LedgerRecord[]=[];let cursor:string|null=null;do{const p=this.page(relPath,cursor);records.push(...p.records);cursor=p.cursor}while(cursor!==null)
  return records.reverse().flatMap<ContextChapter>(r=>{
   if(r.state==='cleared'||r.state==='pending-body')return []
   const c=r.chapter
   if(!c)return [{sourceId:r.taskId,taskId:r.taskId,text:'不可核验的历史记录',fields:{status:'ambiguous' as const},eligible:false}]
   const prefix='口令：\n',separator='\n\n历史回答：\n',text=prefix+c.prompt+separator+c.answer,answerStart=prefix.length+c.prompt.length+separator.length
   return [{sourceId:r.taskId,taskId:r.taskId,text,fields:{status:'valid' as const,prompt:{start:prefix.length,end:prefix.length+c.prompt.length,text:c.prompt},answer:{start:answerStart,end:text.length,text:c.answer}},provenance:c.provenance,eligible:r.state==='legacy'?!!c.provenance&&!(c.provenance.version===2&&c.provenance.memoryDeps.length>0):true}]
  })
 }
}
