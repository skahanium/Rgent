import type {WorkingRecord,WorkingSnapshot} from './working-memory-store.ts'
import {validSummaryGenerator} from './summary-cache.ts'
import {validTaskMaterial} from './host-material.ts'
import {summaryAuditFits} from './context-budget.ts'
import {decodeLedgerBytes,compressLedgerBytes} from './ledger-codec.ts'
import {createHash,randomUUID} from 'node:crypto'
import type {SecureVaultFs} from './secure-fs.ts'
import {partitionSource,compile,parseMarker} from '../markdown/index.ts'
import {ledgerChapters,ledgerTaskFields,historicalBodyTasks,type ContextChapter} from './host-context.ts'
import {ledgerProvenance,encodeLedgerProvenance,type LedgerProvenance} from './ledger-provenance.ts'
import {upsertAiAnswer,type LedgerChapterWrite} from './host-source.ts'
const digest=(s:string)=>createHash('sha256').update(s).digest('hex')
function nextRecordRevision(revision:number):number{if(revision>=Number.MAX_SAFE_INTEGER)throw Error('LEDGER_RECORD_LIMIT');return revision+1}
const fixed='.rgent/registry.json'
const historyFixed='.rgent/ledger-history/index.json'
const historyRoot='.rgent/ledger-history'
const id=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s)
const rel=(s:unknown):s is string=>typeof s==='string'&&s.length<=4096&&/\.md$/i.test(s)&&!s.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.'))&&!/[:\\\x00-\x1f]/.test(s)
const obj=(s:unknown):s is Record<string,unknown>=>!!s&&typeof s==='object'&&!Array.isArray(s)
const exact=(s:Record<string,unknown>,keys:string[])=>Object.keys(s).sort().join()===keys.sort().join()
/** `.rgent-lifecycle` 有两个写入者：生命周期 journal（vault-lifecycle）与账本发布（本模块）。
 *  谁都不能整篇覆盖别人的键——写入前按当前字节读回，保留本模块不认识的顶层键（至少 `missing`
 *  外部消失记录），只替换 `active`。整篇写 `{version:1,active}` 会把别人的记录一起抹掉。 */
function lifecycleRaw(expected:string|null,active:unknown):string{
 let current:Record<string,unknown>={}
 if(expected!==null){
  let parsed:unknown
  try{parsed=JSON.parse(expected)}catch{throw Error('LIFECYCLE_RECOVERY_REQUIRED')}
  if(!obj(parsed))throw Error('LIFECYCLE_RECOVERY_REQUIRED')
  current=parsed
 }
 return JSON.stringify({...current,version:1,active})
}
export type LedgerOwner={noteId:string;relPath:string;objectVersion:string;bodyRevision:string;anchors:string[];anchorsTruncated?:true;sequenceCeiling:number;recoveryEvidence?:{rootIdentity:string;attachments:{relPath:string;kind:'file'|'dir';hash?:string}[]}}
type Registry={version:1;owners:LedgerOwner[];sequence:number}
export type LedgerHistoryState='trashed'|'retired'|'orphaned'|'archived'
export type LedgerHistoryEntry={noteId:string;relPath:string;objectVersion:string;state:LedgerHistoryState;trashId?:string;archivedAt:string}
type LedgerHistory={version:1;entries:LedgerHistoryEntry[]}
type MaterialUnit={id:string;noteId:string;start:number;end:number;sequence:number;hash?:string}
export type LedgerRecord={version:1;noteId:string;taskId:string;revision:number;state:'pending-body'|'saved'|'legacy'|'cleared';bodyStatus:'present'|'unable-to-verify';chapter:Omit<LedgerChapterWrite,'reasoning'>|null;legacyRaw?:string;legacyReasoning?:string;sequence:number}
export type LedgerPage={noteId:string;records:LedgerRecord[];cursor:string|null;ownership:'verified'|'unregistered';gaps:string[]}
export function validOwner(v:unknown):v is LedgerOwner{return obj(v)&&exact(v,['noteId','relPath','objectVersion','bodyRevision','anchors','sequenceCeiling',...('recoveryEvidence'in v?['recoveryEvidence']:[]),...('anchorsTruncated'in v?['anchorsTruncated']:[])])&&id(v.noteId)&&rel(v.relPath)&&typeof v.objectVersion==='string'&&v.objectVersion.length>0&&v.objectVersion.length<512&&typeof v.bodyRevision==='string'&&/^[a-f0-9]{64}$/.test(v.bodyRevision)&&Array.isArray(v.anchors)&&v.anchors.length<=256&&v.anchors.every(id)&&(v.anchorsTruncated===undefined||v.anchorsTruncated===true)&&Number.isSafeInteger(v.sequenceCeiling)&&Number(v.sequenceCeiling)>=0&&(v.recoveryEvidence===undefined||obj(v.recoveryEvidence)&&exact(v.recoveryEvidence,['rootIdentity','attachments'])&&typeof v.recoveryEvidence.rootIdentity==='string'&&/^\d+:\d+$/.test(v.recoveryEvidence.rootIdentity)&&Array.isArray(v.recoveryEvidence.attachments)&&v.recoveryEvidence.attachments.every(a=>obj(a)&&typeof a.relPath==='string'&&!a.relPath.split('/').some(p=>!p||p==='.'||p==='..')&&(a.kind==='dir'&&a.hash===undefined||a.kind==='file'&&typeof a.hash==='string'&&/^[a-f0-9]{64}$/.test(a.hash))))}
export function validSentSummary(value:unknown):value is import('./host-source.ts').SentSummary{
 if(!obj(value)||!exact(value,['step','text','sourceChapterIds','generators','dependencies'])||!Number.isSafeInteger(value.step)||Number(value.step)<1||typeof value.text!=='string'||!Array.isArray(value.sourceChapterIds)||!value.sourceChapterIds.length||!value.sourceChapterIds.every(id)||new Set(value.sourceChapterIds).size!==value.sourceChapterIds.length||!Array.isArray(value.generators)||value.generators.length>64||!Array.isArray(value.dependencies)||value.dependencies.length!==value.sourceChapterIds.length)return false
 const covered=value.sourceChapterIds
 if(!value.generators.every(validSummaryGenerator))return false
 try{if(value.dependencies.some(d=>!obj(d)||!exact(d,['sourceId','hash',...('provenance'in d?['provenance']:[])])||!(covered as unknown[]).includes(d.sourceId)||typeof d.hash!=='string'||!/^[a-f0-9]{64}$/.test(d.hash)||d.provenance!==undefined&&ledgerProvenance(encodeLedgerProvenance(d.provenance as LedgerProvenance)).status!=='valid'))return false}catch{return false}
 return new Set(value.dependencies.map(d=>(d as {sourceId:string}).sourceId)).size===value.dependencies.length
}
/** 账本 `network[]` 的一条外发记录：≤50 条／场，字段类型固定，不含正文。
 *  抓页记 path；搜索 path 为空并另记截断 120 字的 query（只有 search 允许 query），
 *  成功时另记结果条数 count（1–10，只有 search 允许）。
 *  MCP 的 path 为空、不带 query／count，另记服务器名与工具名（都 ≤128 字）；
 *  fetch／search 不得带 server／tool。 */
function validNetworkEntry(v:unknown):boolean{
 if(!obj(v))return false
 if(Object.keys(v).some(k=>!['at','action','host','path','query','count','bytes','truncated','outcome','server','tool'].includes(k)))return false
 if(v.action!=='fetch'&&v.action!=='search'&&v.action!=='mcp')return false
 if(typeof v.at!=='string'||!Number.isFinite(Date.parse(v.at)))return false
 if(typeof v.host!=='string'||!v.host||v.host.length>255)return false
 if(typeof v.path!=='string'||v.path.length>120)return false
 if(typeof v.outcome!=='string'||!v.outcome||v.outcome.length>128)return false
 if(v.action==='mcp'){
  if(v.path!=='')return false
  if(typeof v.server!=='string'||!v.server||v.server.length>128)return false
  if(typeof v.tool!=='string'||!v.tool||v.tool.length>128)return false
 }else if(v.server!==undefined||v.tool!==undefined)return false
 if(v.query!==undefined){
  if(v.action!=='search')return false
  if(typeof v.query!=='string'||!v.query||v.query.length>120)return false
 }
 if(v.count!==undefined&&(v.action!=='search'||!Number.isSafeInteger(v.count)||Number(v.count)<1||Number(v.count)>10))return false
 if(v.bytes!==undefined&&(!Number.isSafeInteger(v.bytes)||Number(v.bytes)<0))return false
 if(v.truncated!==undefined&&typeof v.truncated!=='boolean')return false
 return true
}
function validChapter(v:unknown):v is LedgerRecord['chapter']{
 if(v===null)return true
 if(!obj(v)||!id(v.taskId)||typeof v.startedAt!=='string'||!Number.isFinite(Date.parse(v.startedAt))||!['completed','cancelled','failed','limit'].includes(String(v.status))||typeof v.prompt!=='string'||typeof v.answer!=='string')return false
 if(Object.keys(v).some(k=>!['taskId','startedAt','status','prompt','answer','reason','provenance','trace','assistant','metrics','summaryGenerators','sentSummaries','material','network'].includes(k)))return false
 if(v.reason!==undefined&&typeof v.reason!=='string'||v.assistant!==undefined&&typeof v.assistant!=='string'||v.trace!==undefined&&(!Array.isArray(v.trace)||v.trace.some(t=>typeof t!=='string')))return false
 if(v.network!==undefined&&(!Array.isArray(v.network)||v.network.length>50||!v.network.every(validNetworkEntry)))return false
 if(v.material!==undefined&&!validTaskMaterial(v.material))return false
 if(v.metrics!==undefined&&(!Array.isArray(v.metrics)||v.metrics.length>1000||v.metrics.some(m=>!obj(m)||!Number.isSafeInteger(m.step)||!Number.isFinite(m.estimatedInput)||m.actualInput!==null&&!Number.isFinite(m.actualInput)||m.actualOutput!==null&&!Number.isFinite(m.actualOutput))))return false
 if(v.sentSummaries!==undefined&&(!Array.isArray(v.sentSummaries)||!v.sentSummaries.every(validSentSummary)||!summaryAuditFits(v.sentSummaries)))return false
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
 constructor(private readonly filesystem:SecureVaultFs|(()=>SecureVaultFs),private readonly check:()=>void,private readonly saved?:(relPath:string,before:string,after:string,body:string)=>void,private readonly rootIdentity?:()=>string,private readonly sessionId:()=>string=()=> 'ledger-service'){}
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
 private publish(registry:Registry,owner:LedgerOwner){
  const ownerPath=`.rgent/ledgers/${owner.noteId}/owner.json`,beforeOwner=this.read(ownerPath)
  const journal=this.read('.rgent-lifecycle');let active:unknown=null
  if(journal){try{const parsed=JSON.parse(journal.raw);if(parsed.version!==1||!('active'in parsed))throw Error();active=parsed.active}catch{throw Error('LIFECYCLE_RECOVERY_REQUIRED')}}
  const note=this.fs.readSnapshot(owner.relPath)
  owner.bodyRevision=digest(note.bytes.toString());owner.anchors=this.anchors(note.bytes.toString());if(this.anchors(note.bytes.toString(),Infinity).length>256)owner.anchorsTruncated=true;else delete owner.anchorsTruncated;if(owner.recoveryEvidence)owner.recoveryEvidence.attachments=this.attachmentEvidence(owner.relPath)
  if(Buffer.byteLength(JSON.stringify(registry))>8*1024*1024||registry.owners.length>100000)throw Error('LEDGER_RECORD_LIMIT')
  this.dirs(['.rgent','ledgers',owner.noteId])
  if(active){
    // A move's existing intent and native receipts already guard relocation callbacks.
    if(!obj(active)||active.kind!=='move')throw Error('LIFECYCLE_RECOVERY_REQUIRED')
    this.replace(ownerPath,JSON.stringify(owner));this.replace(fixed,JSON.stringify(registry));return
  }
  const permission=this.read('.rgent-permissions'),beforeRegistry=this.bases.get(fixed)??this.read(fixed)
  const plan:LedgerPublication={kind:'ledger-publication',rootIdentity:this.rootIdentity?.()??this.fs.rootIdentity,sessionId:this.sessionId(),relPath:owner.relPath,objectVersion:note.objectVersion,bodyRevision:digest(note.bytes.toString()),permissionRaw:permission?.raw??null,permissionId:permission?.id??null,ownerPath,
    writes:[{path:ownerPath,before:beforeOwner?.raw??null,beforeId:beforeOwner?.id??null,after:JSON.stringify(owner)},{path:fixed,before:beforeRegistry?.raw??null,beforeId:beforeRegistry?.id??null,after:JSON.stringify(registry)}]}
  if(!validLedgerPublication(plan))throw Error('LEDGER_REGISTRY_INVALID')
  this.replace('.rgent-lifecycle',lifecycleRaw(journal?.raw??null,plan))
  recoverLedgerPublication(this.fs,plan,()=>this.check())
  this.read(fixed);this.read(ownerPath)
 }
 resumePublication(revision:string){const journal=this.read('.rgent-lifecycle');if(!journal||digest(journal.raw)!==revision)throw Error('STALE_RECOVERY');let parsed:unknown;try{parsed=JSON.parse(journal.raw)}catch{throw Error('LIFECYCLE_RECOVERY_REQUIRED')};if(!obj(parsed)||parsed.version!==1||!validLedgerPublication(parsed.active))throw Error('LIFECYCLE_RECOVERY_REQUIRED');recoverLedgerPublication(this.fs,parsed.active,()=>this.check());this.read(fixed);return {status:'complete' as const,revision:null,processed:2,total:2}}
 /** Read-only inspection. Opening a note never grants publication or migration. */
 inspectOwner(relPath:string):import('../shared/ipc.ts').NoteSnapshot['ledger']{
  try{const note=this.fs.readSnapshot(relPath),owner=this.lookupOwner(relPath)
   if(!this.read(fixed))this.assertNoMaterialHistory()
   if(owner){const descriptor=this.read(`.rgent/ledgers/${owner.noteId}/owner.json`);if(!descriptor||descriptor.raw!==JSON.stringify(owner))throw Error('LEDGER_REGISTRY_INVALID')}
   if(partitionSource(note.bytes.toString()).ledger!==null)return {status:'unmigrated',next:'migrate'}
   return {status:owner?'verified':'unregistered',next:'none'}
  }catch(e){return {status:'invalid',reason:e instanceof Error?e.message:'LEDGER_STORAGE_INVALID',next:'repair'}}
 }
 private assertNoMaterialHistory(){
  try{if(this.fs.list('.rgent/ledgers').some(f=>f.name!=='.DS_Store'))throw Error('LEDGER_REGISTRY_INVALID')}catch(e){if(!(e instanceof Error&&e.message==='ENOENT'))throw e}
  if(this.read('.rgent/materials.json'))throw Error('LEDGER_REGISTRY_INVALID')
 }
 /** Queries never publish owner evidence or move a logical association. */
 lookupOwner(relPath:string):LedgerOwner|null{
  if(!rel(relPath))throw Error('BAD_PATH')
  const registry=this.registry();if(!this.read(fixed))this.assertNoMaterialHistory()
  const note=this.fs.readSnapshot(relPath),owner=registry.owners.find(o=>o.relPath===relPath)
  if(!owner){
   let dirs:ReturnType<SecureVaultFs['list']>=[];try{dirs=this.fs.list('.rgent/ledgers')}catch(e){if(!(e instanceof Error&&e.message==='ENOENT'))throw e}
   for(const dir of dirs){if(dir.name==='.DS_Store'&&dir.kind==='file')continue;if(dir.kind!=='dir'||!id(dir.name))throw Error('LEDGER_REGISTRY_INVALID');const descriptor=this.read(`.rgent/ledgers/${dir.name}/owner.json`);let evidence:unknown;try{evidence=JSON.parse(descriptor?.raw??'')}catch{throw Error('LEDGER_REGISTRY_INVALID')};if(!validOwner(evidence))throw Error('LEDGER_REGISTRY_INVALID');if(evidence.relPath===relPath&&evidence.objectVersion!==note.objectVersion)return null}
   return null
  }
  const raw=this.read(`.rgent/ledgers/${owner.noteId}/owner.json`)
  if(!raw||raw.raw!==JSON.stringify(owner))throw Error('LEDGER_REGISTRY_INVALID')
  // A different object at the same address is a new note, not a corrupt owner.
  if(owner.objectVersion!==note.objectVersion)return null
  return structuredClone(owner)
 }
 private requiredOwner(relPath:string){const owner=this.lookupOwner(relPath);if(!owner)throw Error('LEDGER_RECORD_INVALID');return owner}
 owner(relPath:string):LedgerOwner{
  if(!rel(relPath))throw Error('BAD_PATH');this.check();const note=this.fs.readSnapshot(relPath),registry=this.registry()
  const same=registry.owners.filter(o=>o.objectVersion===note.objectVersion)
  const atPath=registry.owners.find(o=>o.relPath===relPath)
  if(same.length>1)throw Error('LEDGER_OWNERSHIP_UNVERIFIED')
  // A different object at the address is a new note; retire the old owner to history.
  if(atPath&&atPath.objectVersion!==note.objectVersion)this.archiveOwner(atPath,'orphaned')
  if(same.length===1){const owner=same[0]!;const descriptor=this.read(`.rgent/ledgers/${owner.noteId}/owner.json`);if(!descriptor||descriptor.raw!==JSON.stringify(owner))throw Error('LEDGER_REGISTRY_INVALID');if(owner.relPath!==relPath){owner.relPath=relPath;this.publish(registry,owner)}return structuredClone(owner)}
  // A missing registry is not proof that the existing ledger tree has no history.
  if(!this.read(fixed)){try{if(this.fs.list('.rgent/ledgers').length)throw Error('LEDGER_REGISTRY_INVALID')}catch(e){if(!(e instanceof Error&&e.message==='ENOENT'))throw e}}
  const currentRegistry=this.registry()
  const body=note.bytes.toString('utf8'),parsed=compile(body)
  const anchors=[...new Set(parsed.index.markers.flatMap(b=>{const k=parseMarker(body.slice(b.range.start,b.range.end))?.attrs['task-id'];return k?[k]:[]}))].slice(0,256)
  const owner:LedgerOwner={noteId:randomUUID(),relPath,objectVersion:note.objectVersion,bodyRevision:digest(body),anchors,sequenceCeiling:currentRegistry.sequence,...(this.rootIdentity?{recoveryEvidence:{rootIdentity:this.rootIdentity(),attachments:this.attachmentEvidence(relPath)}}:{})};currentRegistry.owners.push(owner);this.publish(currentRegistry,owner);return structuredClone(owner)
 }
 /** Active owners are the only hot-path records. Historical owners live in a separate index/dir. */
 private history():LedgerHistory{
  const disk=this.read(historyFixed);if(!disk)return {version:1,entries:[]}
  try{const v:unknown=JSON.parse(disk.raw);if(!obj(v)||!exact(v,['version','entries'])||v.version!==1||!Array.isArray(v.entries)||v.entries.length>100000||!v.entries.every(e=>obj(e)&&exact(e,['noteId','relPath','objectVersion','state','archivedAt',...('trashId'in e?['trashId']:[])] )&&typeof e.noteId==='string'&&typeof e.relPath==='string'&&typeof e.objectVersion==='string'&&['trashed','retired','orphaned','archived'].includes(String(e.state))&&typeof e.archivedAt==='string'&&(e.trashId===undefined||typeof e.trashId==='string')))throw Error('LEDGER_REGISTRY_INVALID');return v as LedgerHistory}catch{throw Error('LEDGER_REGISTRY_INVALID')}
 }
 private archiveOwner(owner:LedgerOwner,state:LedgerHistoryState,trashId?:string):LedgerHistoryEntry{
  const source=`.rgent/ledgers/${owner.noteId}`,target=`${historyRoot}/${owner.noteId}`
  const sourceId=this.fs.resolve(source).at(-1)?.id
  if(!sourceId)throw Error('LEDGER_STORAGE_INVALID')
  this.dirs(['.rgent','ledger-history'])
  if(this.read(target))throw Error('LEDGER_STORAGE_INVALID')
  const entry:LedgerHistoryEntry={noteId:owner.noteId,relPath:owner.relPath,objectVersion:owner.objectVersion,state,archivedAt:new Date().toISOString(),...(trashId?{trashId}:{})}
  const history=this.history();if(history.entries.some(e=>e.noteId===owner.noteId))throw Error('LEDGER_CONFLICT')
  // Archived owners must not leave active material units behind: the source index is live, not history.
  const units=this.materialUnits(),kept=units.filter(u=>u.noteId!==owner.noteId)
  if(kept.length!==units.length)this.replace('.rgent/materials.json',JSON.stringify({version:1,units:kept}))
  this.fs.move(source,target,sourceId)
  try{
   this.replace(historyFixed,JSON.stringify({version:1,entries:[...history.entries,entry]}))
   const registry=this.registry(),next={...registry,owners:registry.owners.filter(o=>o.noteId!==owner.noteId)}
   this.replace(fixed,JSON.stringify(next))
   this.bases.delete(source)
   return entry
  }catch(e){
   try{this.fs.move(target,source,this.fs.resolve(target).at(-1)!.id)}catch{/* leave diagnostics for the caller */}
   try{const current=this.history();this.replace(historyFixed,JSON.stringify({version:1,entries:current.entries.filter(x=>x.noteId!==owner.noteId)}))}catch{/* best effort */}
   throw e
  }
 }
 /** Called by VaultSession when a trusted in-vault delete succeeds. */
 archiveTrashed(objectVersion:string,trashId:string):LedgerHistoryEntry|null{
  const registry=this.registry(),owner=registry.owners.find(o=>o.objectVersion===objectVersion)
  return owner?this.archiveOwner(owner,'trashed',trashId):null
 }
 /** Called when a note is restored from in-vault trash: active again at the restored address. */
 restoreArchived(trashId:string,relPath:string,objectVersion:string):LedgerOwner|null{
  const history=this.history(),entry=history.entries.find(e=>e.trashId===trashId)
  if(!entry)return null
  const source=`${historyRoot}/${entry.noteId}`,target=`.rgent/ledgers/${entry.noteId}`
  const sourceId=this.fs.resolve(source).at(-1)?.id
  if(!sourceId)throw Error('LEDGER_STORAGE_INVALID')
  const raw=this.read(`${source}/owner.json`);if(!raw)throw Error('LEDGER_REGISTRY_INVALID')
  let owner:unknown;try{owner=JSON.parse(raw.raw)}catch{throw Error('LEDGER_REGISTRY_INVALID')}
  if(!validOwner(owner))throw Error('LEDGER_REGISTRY_INVALID')
  const nextOwner={...owner,relPath,objectVersion}
  this.fs.replace(`${source}/owner.json`,raw.raw,JSON.stringify(nextOwner),raw.id)
  this.fs.move(source,target,sourceId)
  try{
   const registry=this.registry()
   const next={...registry,owners:[...registry.owners.filter(o=>o.noteId!==entry.noteId),nextOwner]}
   this.replace(fixed,JSON.stringify(next))
   this.replace(historyFixed,JSON.stringify({version:1,entries:history.entries.filter(e=>e.noteId!==entry.noteId)}))
   this.bases.delete(`${source}/owner.json`)
   return structuredClone(nextOwner)
  }catch(e){
   try{this.fs.move(target,source,this.fs.resolve(target).at(-1)!.id)}catch{/* leave diagnostics */}
   throw e
  }
 }
 historyEntryForTrash(trashId:string):LedgerHistoryEntry|null{
  return this.history().entries.find(e=>e.trashId===trashId)??null
 }
 historyOwnerForTrash(trashId:string):{entry:LedgerHistoryEntry;owner:LedgerOwner}|null{
  const entry=this.historyEntryForTrash(trashId);if(!entry)return null
  const raw=this.read(`${historyRoot}/${entry.noteId}/owner.json`);if(!raw)return null
  let owner:unknown;try{owner=JSON.parse(raw.raw)}catch{return null}
  return validOwner(owner)?{entry,owner}:null
 }
 /** Explicit purge preserves the ledger archive, but records that it is no longer a trash entry. */
 archivePurged(trashId:string):void{
  const history=this.history(),entry=history.entries.find(e=>e.trashId===trashId)
  if(!entry)return
  this.replace(historyFixed,JSON.stringify({version:1,entries:history.entries.map(e=>e.noteId===entry.noteId?{...e,state:'archived'}:e)}))
 }
 historyEntries():LedgerHistoryEntry[]{return structuredClone(this.history().entries)}
 onWrite(relPath:string,before:string,after:string,body:string,previousBody?:string,basis?:WorkingSnapshot){const record=basis?.record,registry=this.registry(),owner=registry.owners.find(o=>o.relPath===relPath&&o.objectVersion===before);if(!owner)return
  const units=this.materialUnits();let changed=false
  const keep=new Set((record?[...record.entries,...record.recent]:[]).flatMap(e=>e.sources.flatMap(s=>[s.materialId,...(s.basisGroups??[])]))??[]),pending=record?.jobs.some(j=>['queued','running','interrupted'].includes(j.outcome)),removed=new Set<string>(),added:MaterialUnit[]=[]
  if(previousBody!==undefined&&owner.bodyRevision===digest(previousBody))for(const unit of units.filter(u=>u.noteId===owner.noteId)){
   // A current owner hash proves this save's before image, never an old unit's birth.
   // Only an explicitly registered source can supply a missing birth hash.
   const evidence=(record?[...record.entries,...record.recent]:[]).flatMap(e=>e.sources).find(s=>s.kind==='body'&&s.taskId===null&&s.relPath===relPath&&s.materialId===unit.id&&s.sequence===unit.sequence&&s.text.length===unit.end-unit.start&&digest(s.text)===s.hash)
   const text=unit.hash?previousBody.slice(unit.start,unit.end):evidence?.text,start=text?body.indexOf(text):-1
   if(text&&(!unit.hash||digest(text)===unit.hash)&&previousBody.indexOf(text)>=0&&previousBody.indexOf(text,previousBody.indexOf(text)+1)<0){
    if(!unit.hash){unit.hash=digest(text);changed=true}
    if(start>=0&&body.indexOf(text,start+1)<0){if(unit.start!==start){unit.start=start;unit.end=start+text.length;changed=true}}
    else if(start<0&&record&&unit.sequence<=record.watermark&&!keep.has(unit.id)&&!pending&&this.read('.rgent-permissions')===null){removed.add(unit.id);changed=true}
   }
   if(!unit.hash){
    const old=previousBody.slice(unit.start,unit.end),fresh=body.slice(unit.start,unit.end)
    if(old&&fresh&&old!==fresh&&!body.includes(old)&&!previousBody.includes(fresh)&&body.indexOf(fresh)===unit.start&&body.indexOf(fresh,unit.start+1)<0)added.push({id:randomUUID(),noteId:owner.noteId,start:unit.start,end:unit.start+fresh.length,sequence:0,hash:digest(fresh)})
   }
  }
  // For an unproven legacy range, an actual inserted/replaced current region may
  // establish a new identity. Unchanged text shifted by the save never does.
  if(previousBody!==undefined&&units.some(u=>u.noteId===owner.noteId&&!u.hash)&&body!==previousBody){
   let start=0,end=body.length,oldEnd=previousBody.length;while(start<Math.min(end,oldEnd)&&body[start]===previousBody[start])start++;while(end>start&&oldEnd>start&&body[end-1]===previousBody[oldEnd-1]){end--;oldEnd--}
   const fresh=body.slice(start,end);if(fresh&&!previousBody.includes(fresh)&&body.indexOf(fresh)===start&&body.indexOf(fresh,start+1)<0)added.push({id:randomUUID(),noteId:owner.noteId,start,end,sequence:0,hash:digest(fresh)})
  }
  for(const unit of added){if(units.some(u=>u.noteId===unit.noteId&&u.start===unit.start&&u.end===unit.end&&u.hash===unit.hash))continue;if(units.length>=100000)throw Error('MEMORY_SOURCE_LIMIT');if(!Number.isSafeInteger(++registry.sequence))throw Error('LEDGER_RECORD_LIMIT');unit.sequence=registry.sequence;owner.sequenceCeiling=registry.sequence;units.push(unit);changed=true}
  if(removed.size&&!this.memoryBasisCurrent(basis!))removed.clear()
  if(changed)this.replace('.rgent/materials.json',JSON.stringify({version:1,units:units.filter(u=>!removed.has(u.id))}))
  owner.objectVersion=after;owner.bodyRevision=digest(body);owner.anchors=this.anchors(body);this.publish(registry,owner)
 }
 relocate(from:string,to:string,objectVersion:string){const registry=this.registry(),owner=registry.owners.find(o=>o.relPath===from&&o.objectVersion===objectVersion);if(!owner)return;const current=this.fs.readSnapshot(to);if(current.objectVersion!==objectVersion)throw Error('LEDGER_OWNERSHIP_UNVERIFIED');owner.relPath=to;this.publish(registry,owner)}
 materialUnit(relPath:string,start:number,end:number,controls:{watermark:number;forgotten:readonly string[]}={watermark:0,forgotten:[]},proof?:Pick<import('./host-material.ts').SentFragment,'text'|'hash'|'objectVersion'|'classification'>,acceptsObject:(path:string,before:string,after:string)=>boolean=(_p,b,a)=>b===a,beforeUse:()=>void=()=>{}){
  beforeUse();if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start)throw Error('BAD_REQUEST')
  this.materialCeiling()
  beforeUse();const note=this.fs.readSnapshot(relPath),body=note.bytes.toString()
  if(proof){
   if(!proof.text||proof.text.length!==end-start||digest(proof.text)!==proof.hash||proof.classification==='ai'||!acceptsObject(relPath,proof.objectVersion,note.objectVersion))throw Error('MEMORY_SOURCE_CHANGED')
   const parsed=compile(body);if(parsed.stale)throw Error('MEMORY_SOURCE_CHANGED');const raw=parsed.partition.body
   if(raw.slice(start,end)!==proof.text){start=raw.indexOf(proof.text);if(start<0||raw.indexOf(proof.text,start+1)>=0)throw Error('MEMORY_SOURCE_CHANGED');end=start+proof.text.length}
   const block=parsed.index.blocks.find(b=>b.range.start<=start&&b.range.end>=end);if(!block||block.identity==='ai'||proof.classification==='command'&&block.identity!=='command')throw Error('MEMORY_SOURCE_CHANGED')
  }
  beforeUse();const owner=this.owner(relPath),file='.rgent/materials.json',units=this.materialUnits(),text=body.slice(start,end);if(end>body.length||!text)throw Error('BAD_REQUEST');const hash=digest(text)
  const current=()=>{beforeUse();const next=this.fs.readSnapshot(relPath);if(next.objectVersion!==note.objectVersion||!next.bytes.equals(note.bytes))throw Error('MEMORY_SOURCE_CHANGED')}
  current()
  const parents=units.filter(u=>u.noteId===owner.noteId&&u.hash&&u.start>=start&&u.end<=end&&digest(body.slice(u.start,u.end))===u.hash&&body.indexOf(body.slice(u.start,u.end))===u.start&&body.indexOf(body.slice(u.start,u.end),u.start+1)<0)
  const inherited=(unit:MaterialUnit)=>{const basisGroups=[...new Set(parents.filter(u=>u.id!==unit.id).map(u=>u.id))];if(basisGroups.length>16)throw Error('MEMORY_SOURCE_LIMIT');return {...unit,basisGroups,age:Math.min(unit.sequence,...parents.map(u=>u.sequence))}}
  const known=units.find(u=>u.noteId===owner.noteId&&u.start===start&&u.end===end&&u.hash===hash);if(known){current();return inherited(known)}if(parents.length>16)throw Error('MEMORY_SOURCE_LIMIT')
  // Birth offsets of an unhashed old unit may be stale. Unknown is not empty.
  // A registered new region established by a controlled real edit is an exit.
  const newRegion=units.some(u=>u.noteId===owner.noteId&&u.hash&&u.start<=start&&u.end>=end&&digest(body.slice(u.start,u.end))===u.hash&&units.filter(p=>p.noteId===owner.noteId&&!p.hash).every(p=>u.sequence>p.sequence))
  if(!newRegion&&units.some(u=>u.noteId===owner.noteId&&!u.hash&&(u.sequence<=controls.watermark||controls.forgotten.includes(u.id))))throw Error('MEMORY_MATERIAL_UNVERIFIED')
  if(units.length>=100000)throw Error('MEMORY_SOURCE_LIMIT')
  const registry=this.registry();registry.sequence++;if(!Number.isSafeInteger(registry.sequence))throw Error('LEDGER_RECORD_LIMIT');const row=registry.owners.find(o=>o.noteId===owner.noteId)!;row.sequenceCeiling=registry.sequence;current();this.publish(registry,row)
  const unit={id:randomUUID(),noteId:owner.noteId,start,end,sequence:registry.sequence,hash};units.push(unit);current();this.replace(file,JSON.stringify({version:1,units}));return inherited(unit)
 }
 private memoryBasisCurrent(basis:WorkingSnapshot){try{const disk=this.fs.readSnapshot('.rgent-memory');return disk.objectVersion===basis.objectVersion&&disk.bytes.toString()===basis.raw}catch{return false}}
 collectMaterials(basis:WorkingSnapshot,allowed:(relPath:string)=>boolean=()=>false,permissionRaw:string|null=null){
  const record=basis.record;this.materialCeiling()
  if(record.jobs.some(j=>['queued','running','interrupted'].includes(j.outcome)))return
  const keep=new Set([...record.entries,...record.recent].flatMap(e=>e.sources.flatMap(s=>[s.materialId,...(s.basisGroups??[])]))),units=this.materialUnits(),registry=this.registry(),removed=new Set<string>()
  let evidence:Map<string,string>|undefined
  const originals=()=>{if(evidence)return evidence;evidence=new Map<string,string>();for(const owner of registry.owners)for(const {record:task} of this.orderedRecords(owner,registry.sequence))for(const f of task.chapter?.material?.fragments??[]){if(f.kind!=='body'||f.taskId!==null||digest(f.text)!==f.hash)continue;const target=registry.owners.find(o=>o.relPath===f.relPath);if(!target)continue;for(const unit of units.filter(u=>u.noteId===target.noteId&&u.hash)){
    const text=unit.hash===f.hash?f.text:unit.start>=f.start&&unit.end<=f.end?f.text.slice(unit.start-f.start,unit.end-f.start):'';if(text&&digest(text)===unit.hash)evidence.set(unit.id,text)
   }}return evidence}
  for(const owner of registry.owners){const candidates=units.filter(u=>u.noteId===owner.noteId&&u.hash&&u.sequence<=record.watermark&&!keep.has(u.id));if(!candidates.length||!allowed(owner.relPath))continue
   try{const current=this.lookupOwner(owner.relPath),note=this.fs.readSnapshot(owner.relPath),body=note.bytes.toString();if(!current||digest(body)!==current.bodyRevision)continue
    for(const unit of candidates){if(digest(body.slice(unit.start,unit.end))===unit.hash)continue;const text=originals().get(unit.id);if(text&&!body.includes(text))removed.add(unit.id)}
   }catch{/* An unverifiable object or original is retained, never treated as absent. */}
  }
  if(removed.size&&this.memoryBasisCurrent(basis)){if((this.read('.rgent-permissions')?.raw??null)!==permissionRaw)throw Error('PERMISSIONS_CHANGED');this.replace('.rgent/materials.json',JSON.stringify({version:1,units:units.filter(u=>!removed.has(u.id))}))}
 }
 maintenancePreview(relPath:string,action:'compress'|'clear'){
  const owner=this.requiredOwner(relPath);let cursor:string|null=null,totalBytes=0;const records:{taskId:string;revision:number;bytes:number}[]=[],legacyIds:string[]=[]
  do{const page=this.page(relPath,cursor);for(const r of page.records){const d=this.read(this.path(owner,r.taskId))!;totalBytes+=Buffer.byteLength(d.raw);if(records.length<20&&r.state!=='pending-body'&&r.state!=='cleared'&&(action==='clear'||r.state==='saved'&&Date.parse(r.chapter!.startedAt)<Date.now()-7*86400000&&!d.raw.includes('"codec":"gzip"')))records.push({taskId:r.taskId,revision:r.revision,bytes:Buffer.byteLength(d.raw)})}cursor=page.cursor}while(cursor)
  if(action==='clear'){let c:string|null=null;do{const p=this.page(relPath,c);legacyIds.push(...p.records.filter(r=>r.legacyRaw!==undefined&&r.state!=='cleared').map(r=>r.taskId));c=p.cursor}while(c)}
  const disk=this.read(`.rgent/ledgers/${owner.noteId}/legacy.json`);if(disk)totalBytes+=Buffer.byteLength(disk.raw)
  const archive=action==='clear'&&disk&&legacyIds.length&&legacyIds.every(id=>records.some(r=>r.taskId===id))?{revision:digest(disk.raw),bytes:Buffer.byteLength(disk.raw)}:undefined
  return {records,totalBytes,...(archive?{archive}:{}),warning:action==='clear'?'只清理列出的已完成历史，不修改正文或自动遗忘已学记忆。原始材料清理后不能重建对应摘要。'+(archive?'本次同时清除全部关联任务共享的旧归档，包括未解析内容。':disk?'共享旧归档仍保留历史内容；本次不清除共享归档。':''):'核验无损往返与净节省后替换同一记录；不保留双表示。'}
 }
 maintain(relPath:string,action:'compress'|'clear',items:readonly {taskId:string;revision:number}[],archive?:{revision:string;bytes:number}){
  if(items.length>20||new Set(items.map(i=>i.taskId)).size!==items.length)throw Error('BAD_REQUEST')
  const owner=this.requiredOwner(relPath),success:string[]=[],failed:string[]=[];let savedBytes=0,archiveCleared=false
  const archivePath=`.rgent/ledgers/${owner.noteId}/legacy.json`,originalArchive=archive?this.read(archivePath):null
  if(archive&&(action!=='clear'||!originalArchive||digest(originalArchive.raw)!==archive.revision||Buffer.byteLength(originalArchive.raw)!==archive.bytes))throw Error('LEDGER_CONFLICT')
  for(const item of items){try{const r=this.record(owner,item.taskId),disk=this.bases.get(this.path(owner,item.taskId));if(!r||r.revision!==item.revision||r.state==='pending-body'||!disk)throw Error('LEDGER_CONFLICT')
    if(action==='compress'){if(r.state!=='saved'||Date.parse(r.chapter!.startedAt)>=Date.now()-7*86400000)throw Error('BAD_REQUEST');const zipped=compressLedgerBytes(decodeLedgerBytes(disk.raw));if(zipped){this.replace(this.path(owner,r.taskId),zipped.raw);savedBytes+=Buffer.byteLength(disk.raw)-Buffer.byteLength(zipped.raw)}}
    else {const cleared:LedgerRecord={version:1,noteId:owner.noteId,taskId:r.taskId,revision:nextRecordRevision(r.revision),state:'cleared',bodyStatus:'unable-to-verify',chapter:null,sequence:r.sequence};this.replace(this.path(owner,r.taskId),JSON.stringify(cleared));savedBytes+=Buffer.byteLength(disk.raw)-Buffer.byteLength(JSON.stringify(cleared))}
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
   if(!obj(v)||!exact(v,['version','units'])||v.version!==1||!Array.isArray(v.units)||v.units.length>100000||v.units.some(u=>!obj(u)||!exact(u,['id','noteId','start','end','sequence',...('hash'in u?['hash']:[])])||u.hash!==undefined&&(typeof u.hash!=='string'||!/^[a-f0-9]{64}$/.test(u.hash))||!id(u.id)||!id(u.noteId)||!Number.isSafeInteger(u.start)||!Number.isSafeInteger(u.end)||Number(u.start)<0||Number(u.end)<=Number(u.start)||!Number.isSafeInteger(u.sequence)||Number(u.sequence)<1))throw Error()
   return v.units as MaterialUnit[]
  }catch{throw Error('LEDGER_REGISTRY_INVALID')}
 }
 materialState():{status:'verified'|'empty';sequence:number}|{status:'invalid';reason:string}{
  try{const registry=this.registry();if(!this.read(fixed)){this.assertNoMaterialHistory();return {status:'empty',sequence:0}}
   const owners=new Map(registry.owners.map(owner=>[owner.noteId,owner])),sequences=new Set<number>(),unitIds=new Set<string>(),unitRanges=new Set<string>()
   const verifySequence=(noteId:string,sequence:number)=>{const owner=owners.get(noteId);if(!owner||sequence>owner.sequenceCeiling||sequence>registry.sequence||sequence>0&&sequences.has(sequence))throw Error('LEDGER_REGISTRY_INVALID');if(sequence>0)sequences.add(sequence)}
   for(const owner of owners.values())if(owner.sequenceCeiling>registry.sequence)throw Error('LEDGER_REGISTRY_INVALID')
   for(const unit of this.materialUnits()){
    const range=JSON.stringify([unit.noteId,unit.start,unit.end,unit.hash??null]);if(unitIds.has(unit.id)||unitRanges.has(range))throw Error('LEDGER_REGISTRY_INVALID');unitIds.add(unit.id);unitRanges.add(range);verifySequence(unit.noteId,unit.sequence)
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
 attachmentEvidence(relPath:string):NonNullable<LedgerOwner['recoveryEvidence']>['attachments']{
  const walk=(p:string):NonNullable<LedgerOwner['recoveryEvidence']>['attachments']=>{const leaf=this.fs.resolve(p).at(-1)!;if(leaf.kind==='file')return [{relPath:p,kind:'file',hash:createHash('sha256').update(this.fs.readSnapshot(p).bytes).digest('hex')}];return [{relPath:p,kind:'dir'},...this.fs.list(p).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(c=>{if(c.kind!=='file'&&c.kind!=='dir')throw Error('LEDGER_STORAGE_INVALID');return walk(p+'/'+c.name)})]}
  try{return walk(relPath.slice(0,-3))}catch(e){if(e instanceof Error&&e.message==='ENOENT')return [];throw e}
 }
 anchors(body:string,limit=256){return [...new Set(compile(body).index.markers.flatMap(b=>{const k=parseMarker(body.slice(b.range.start,b.range.end))?.attrs['task-id'];return k?[k]:[]}))].sort().slice(0,limit)}
 /** Finite reconstruction evidence, never an object-continuity grant. */
 recoveryOwners():{owners:LedgerOwner[];sequence:number}{
  this.check();const owners:LedgerOwner[]=[],tasks=new Set<string>(),sequences=new Set<number>();let count=0
  for(const dir of this.fs.list('.rgent/ledgers')){
   if(dir.name==='.DS_Store'&&dir.kind==='file')continue
   if(dir.kind!=='dir'||!id(dir.name))throw Error('LEDGER_REGISTRY_INVALID')
   const raw=this.read(`.rgent/ledgers/${dir.name}/owner.json`);if(!raw)throw Error('LEDGER_REGISTRY_INVALID')
   let owner:unknown;try{owner=JSON.parse(raw.raw)}catch{throw Error('LEDGER_REGISTRY_INVALID')}
   if(!validOwner(owner)||owner.noteId!==dir.name)throw Error('LEDGER_REGISTRY_INVALID');owners.push(owner)
   for(const file of this.fs.list(`.rgent/ledgers/${dir.name}`)){
    if(file.kind!=='file')throw Error('LEDGER_REGISTRY_INVALID')
    if(['owner.json','legacy.json','recovery.json','.DS_Store'].includes(file.name))continue
    if(!file.name.endsWith('.json')||!id(file.name.slice(0,-5))||++count>100000)throw Error('LEDGER_REGISTRY_INVALID')
    const record=parseRecord(this.read(`.rgent/ledgers/${dir.name}/${file.name}`)!.raw)
    if(record.noteId!==owner.noteId||file.name!==record.taskId+'.json'||record.sequence>owner.sequenceCeiling)throw Error('LEDGER_REGISTRY_INVALID')
    if(tasks.has(record.taskId))throw Error('LEDGER_RECOVERY_AMBIGUOUS');tasks.add(record.taskId)
    if(record.sequence>0){if(sequences.has(record.sequence))throw Error('LEDGER_REGISTRY_INVALID');sequences.add(record.sequence)}
   }
  }
  if(new Set(owners.map(o=>o.noteId)).size!==owners.length||new Set(owners.map(o=>o.relPath)).size!==owners.length||new Set(owners.map(o=>o.objectVersion)).size!==owners.length)throw Error('LEDGER_RECOVERY_AMBIGUOUS')
  const unitIds=new Set<string>(),ranges=new Set<string>();for(const unit of this.materialUnits()){const owner=owners.find(o=>o.noteId===unit.noteId),range=JSON.stringify([unit.noteId,unit.start,unit.end,unit.hash??null]);if(!owner||unit.sequence>owner.sequenceCeiling||sequences.has(unit.sequence)||unitIds.has(unit.id)||ranges.has(range))throw Error('LEDGER_REGISTRY_INVALID');sequences.add(unit.sequence);unitIds.add(unit.id);ranges.add(range)}
  let registered:Registry|null=null;try{registered=this.registry()}catch{/* Explicit reconstruction can repair malformed registry bytes. */}
  if(registered){for(const old of registered.owners){const evidence=owners.find(o=>o.noteId===old.noteId);if(!evidence||JSON.stringify(evidence)!==JSON.stringify(old))throw Error('LEDGER_REGISTRY_INVALID')}}
  return {owners,sequence:Math.max(registered?.sequence??0,...owners.map(o=>o.sequenceCeiling))}
 }
 rebuildRegistry(){const next=this.recoveryOwners();this.replace(fixed,JSON.stringify({version:1,...next}))}
 recoveryRecord(owner:LedgerOwner,taskId:string){return this.record(owner,taskId)}
 private path(owner:LedgerOwner,taskId:string){if(!id(taskId))throw Error('BAD_REQUEST');return `.rgent/ledgers/${owner.noteId}/${taskId}.json`}
 getRecord(relPath:string,taskId:string){const owner=this.requiredOwner(relPath),record=this.record(owner,taskId);if(!record)throw Error('LEDGER_RECORD_INVALID');return record}
 private record(owner:LedgerOwner,taskId:string){const raw=this.read(this.path(owner,taskId));if(!raw)return null;const record=parseRecord(raw.raw);if(record.noteId!==owner.noteId||record.taskId!==taskId)throw Error('LEDGER_RECORD_INVALID');return record}
 prepare(relPath:string,chapter:LedgerChapterWrite,expectedVersion?:number):LedgerRecord{
  this.materialCeiling()
  const owner=this.owner(relPath),{reasoning:_reasoning,...visible}=chapter
  if(!validChapter(visible))throw Error('LEDGER_RECORD_INVALID')
  const previous=this.record(owner,chapter.taskId)
  if(previous){
   if(JSON.stringify(previous.chapter)===JSON.stringify(visible))return previous
   if(expectedVersion!==previous.revision||previous.state!=='pending-body'||previous.chapter?.prompt!==chapter.prompt||previous.chapter.startedAt!==chapter.startedAt||JSON.stringify(previous.chapter.provenance?.model)!==JSON.stringify(chapter.provenance?.model))throw Error('LEDGER_TASK_CONFLICT')
   previous.chapter=visible;previous.revision=nextRecordRevision(previous.revision);const raw=JSON.stringify(previous);if(Buffer.byteLength(raw)>2*1024*1024)throw Error('LEDGER_RECORD_LIMIT');this.replace(this.path(owner,chapter.taskId),raw);return previous
  }
  const registry=this.registry(),row=registry.owners.find(o=>o.noteId===owner.noteId)!;registry.sequence++;if(!Number.isSafeInteger(registry.sequence))throw Error('LEDGER_RECORD_LIMIT');row.sequenceCeiling=registry.sequence;this.publish(registry,row)
  const record:LedgerRecord={version:1,noteId:owner.noteId,taskId:chapter.taskId,revision:1,state:'pending-body',bodyStatus:'unable-to-verify',chapter:visible,sequence:registry.sequence}
  const raw=JSON.stringify(record);if(Buffer.byteLength(raw)>2*1024*1024)throw Error('LEDGER_RECORD_LIMIT');this.replace(this.path(owner,chapter.taskId),raw);return record
 }
 /** 人确认删除后记一笔：笔记已进废纸篓，不能再读正文，所以不走 owner()/publish()。 */
 recordHumanTrash(relPath:string,landing:string,attachmentLanding:string|null,orphan:boolean,attribution?:{taskId?:string;prompt?:string}):void{
  if(!rel(relPath))throw Error('BAD_PATH')
  const registry=this.registry(),owner=registry.owners.find(o=>o.relPath===relPath)
  if(!owner)return
  const taskId=attribution?.taskId||'humantrash'
  const prompt=attribution?.prompt||'移入系统废纸篓'
  const answer=orphan
   ?`${landing?`笔记落点：${landing}`:'笔记已移入系统废纸篓'}；同名附件夹未能送入废纸篓`
   :attachmentLanding
    ?`笔记落点：${landing||'（无收据）'}；附件夹落点：${attachmentLanding}`
    :`笔记落点：${landing||'（无收据）'}`
  const chapter={taskId,startedAt:new Date().toISOString(),status:'completed' as const,prompt,answer}
  if(!validChapter(chapter))throw Error('LEDGER_RECORD_INVALID')
  const previous=this.record(owner,taskId)
  const record:LedgerRecord={version:1,noteId:owner.noteId,taskId,revision:previous?nextRecordRevision(previous.revision):1,state:'saved',bodyStatus:'unable-to-verify',chapter,sequence:0}
  const raw=JSON.stringify(record);if(Buffer.byteLength(raw)>2*1024*1024)throw Error('LEDGER_RECORD_LIMIT')
  this.replace(this.path(owner,taskId),raw)
 }
 /** 人放弃恢复：只清库内生命周期记录、释放路径；不碰系统废纸篓里的文件。
  *  与 `recordHumanTrash` 不同，任务键用带时间戳的 `humanabandon-<ISO>`，不覆盖任何历史章节。 */
 recordRecoveryAbandon(relPath:string):void{
  if(!rel(relPath))throw Error('BAD_PATH')
  const registry=this.registry(),owner=registry.owners.find(o=>o.relPath===relPath)
  if(!owner)return
  const startedAt=new Date().toISOString()
  // 时间戳去掉冒号／连字符／点，再带一小段随机后缀：既是人能读的来源，也不会同名覆盖。
  const taskId=`humanabandon-${startedAt.replace(/[-:.]/g,'')}-${randomUUID().slice(0,8)}`
  const chapter={taskId,startedAt,status:'completed' as const,prompt:'人放弃恢复',answer:'人放弃恢复，路径释放；只清除 Rgent 库内的生命周期记录，未改动系统废纸篓里的文件。'}
  if(!validChapter(chapter))throw Error('LEDGER_RECORD_INVALID')
  const record:LedgerRecord={version:1,noteId:owner.noteId,taskId,revision:1,state:'saved',bodyStatus:'unable-to-verify',chapter,sequence:0}
  const raw=JSON.stringify(record);if(Buffer.byteLength(raw)>2*1024*1024)throw Error('LEDGER_RECORD_LIMIT')
  this.replace(this.path(owner,taskId),raw)
 }
 complete(relPath:string,taskId:string,bodyRevision:string):LedgerRecord{
  const owner=this.owner(relPath),note=this.fs.readSnapshot(relPath),record=this.record(owner,taskId);if(!record||!record.chapter)throw Error('LEDGER_RECORD_INVALID');if(digest(note.bytes.toString())!==bodyRevision)throw Error('LEDGER_BODY_CHANGED')
  const body=note.bytes.toString(),blocks=compile(body).index.markers.filter(b=>b.identity==='ai'&&parseMarker(body.slice(b.range.start,b.range.end))?.attrs['task-id']===taskId)
  // The Host write receipt is necessary; identity markers are an additional local check.
  if(record.chapter.answer.trim()){if(blocks.length<1)throw Error('LEDGER_BODY_CHANGED');try{if(upsertAiAnswer(body,{taskId,answer:record.chapter.answer,expectedPreviousAnswer:record.chapter.answer})!==body)throw Error()}catch{throw Error('LEDGER_BODY_CHANGED')}}
  if(record.state==='saved'&&record.bodyStatus==='present')return record
  record.state='saved';record.bodyStatus='present';record.revision=nextRecordRevision(record.revision);this.replace(this.path(owner,taskId),JSON.stringify(record));return record
 }
 private displayed(relPath:string,record:LedgerRecord){
  record=structuredClone(record)
  if(record.state==='saved'&&record.chapter?.answer){try{const body=this.fs.readSnapshot(relPath).bytes.toString();if(upsertAiAnswer(body,{taskId:record.taskId,answer:record.chapter.answer,expectedPreviousAnswer:record.chapter.answer})!==body)record.bodyStatus='unable-to-verify'}catch{record.bodyStatus='unable-to-verify'}}
  return record
 }
 private decoded=new Map<string,{raw:string;record:LedgerRecord;bytes:number}>()
 private decodedBytes=0
 private decode(path:string,raw:string):LedgerRecord{
  const old=this.decoded.get(path);if(old?.raw===raw)return old.record
  const record=parseRecord(raw),bytes=Buffer.byteLength(raw)+Buffer.byteLength(JSON.stringify(record))
  if(old){this.decoded.delete(path);this.decodedBytes-=old.bytes}
  if(bytes<=16*1024*1024){while(this.decodedBytes+bytes>16*1024*1024){const [key,value]=this.decoded.entries().next().value!;this.decoded.delete(key);this.decodedBytes-=value.bytes}this.decoded.set(path,{raw,record,bytes});this.decodedBytes+=bytes}
  return record
 }
 private orderedRecordsIn(owner:LedgerOwner,dir:string,ceiling:number){
  const members=this.fs.list(dir);if(members.some(f=>f.kind!=='file'||!['owner.json','legacy.json','recovery.json','.DS_Store'].includes(f.name)&&(!f.name.endsWith('.json')||!id(f.name.slice(0,-5)))))throw Error('LEDGER_REGISTRY_INVALID')
  return members.filter(f=>f.kind==='file'&&!['owner.json','legacy.json','recovery.json'].includes(f.name)&&f.name.endsWith('.json')).map(file=>{
   const p=`${dir}/${file.name}`,disk=this.read(p);if(!disk)throw Error('LEDGER_RECORD_INVALID');const record=this.decode(p,disk.raw);if(record.noteId!==owner.noteId||file.name!==record.taskId+'.json')throw Error('LEDGER_RECORD_INVALID');return {record,bytes:Buffer.byteLength(disk.raw)}
  }).filter(({record})=>record.sequence<=ceiling).sort((a,b)=>this.compare(a.record,b.record))
 }
 private orderedRecords(owner:LedgerOwner,ceiling:number){return this.orderedRecordsIn(owner,`.rgent/ledgers/${owner.noteId}`,ceiling)}
 private compare(a:LedgerRecord,b:LedgerRecord){return b.sequence-a.sequence||(b.chapter?.startedAt??'').localeCompare(a.chapter?.startedAt??'')||b.taskId.localeCompare(a.taskId)}
 page(relPath:string,cursor:string|null=null,maxBytes=128*1024):LedgerPage{
  const owner=this.lookupOwner(relPath),registry=this.registry()
  if(!owner){if(cursor!==null)throw Error('BAD_REQUEST');return {noteId:'',records:[],cursor:null,ownership:'unregistered',gaps:[]}}
  type Boundary=[number,number,string,string]
  let boundary:Boundary|null=null,ceiling=registry.sequence
  if(cursor!==null){try{const value:unknown=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!Array.isArray(value)||value.length!==4||!Number.isSafeInteger(value[0])||!Number.isSafeInteger(value[1])||value[0]<0||value[1]<0||typeof value[2]!=='string'||!id(value[3]))throw Error();boundary=value as Boundary;ceiling=boundary[0]}catch{throw Error('BAD_REQUEST')}}
  const ordered=this.orderedRecords(owner,ceiling)
  const compare=(a:LedgerRecord,b:LedgerRecord)=>this.compare(a,b)
  const eligible=boundary?ordered.filter(({record})=>compare(record,{sequence:boundary![1],chapter:{startedAt:boundary![2]},taskId:boundary![3]} as LedgerRecord)>0):ordered
  const records:LedgerRecord[]=[];let bytes=0
  for(const entry of eligible){if(records.length&&(records.length>=20||bytes+entry.bytes>maxBytes))break;records.push(this.displayed(relPath,entry.record));bytes+=entry.bytes}
  const last=records.at(-1),next=last&&records.length<eligible.length?Buffer.from(JSON.stringify([ceiling,last.sequence,last.chapter?.startedAt??'',last.taskId])).toString('base64url'):null
  return {noteId:owner.noteId,records,cursor:next,ownership:'verified',gaps:records.filter(r=>r.state==='cleared'||r.bodyStatus==='unable-to-verify').map(r=>r.taskId)}
 }
 historyPage(trashId:string,cursor:string|null=null,maxBytes=128*1024):LedgerPage{
  const found=this.historyOwnerForTrash(trashId)
  if(!found){if(cursor!==null)throw Error('BAD_REQUEST');return {noteId:'',records:[],cursor:null,ownership:'unregistered',gaps:[]}}
  const {owner}=found
  const ceiling=owner.sequenceCeiling
  const ordered=this.orderedRecordsIn(owner,`${historyRoot}/${owner.noteId}`,ceiling)
  type Boundary=[number,number,string,string]
  let boundary:Boundary|null=null
  if(cursor!==null){try{const value:unknown=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!Array.isArray(value)||value.length!==4||!Number.isSafeInteger(value[0])||!Number.isSafeInteger(value[1])||value[0]<0||value[1]<0||typeof value[2]!=='string'||!id(value[3]))throw Error();boundary=value as Boundary}catch{throw Error('BAD_REQUEST')}}
  const compare=(a:LedgerRecord,b:LedgerRecord)=>this.compare(a,b)
  const eligible=boundary?ordered.filter(({record})=>compare(record,{sequence:boundary![1],chapter:{startedAt:boundary![2]},taskId:boundary![3]} as LedgerRecord)>0):ordered
  const records:LedgerRecord[]=[];let bytes=0
  for(const entry of eligible){if(records.length&&(records.length>=20||bytes+entry.bytes>maxBytes))break;records.push(structuredClone(entry.record));bytes+=entry.bytes}
  const last=records.at(-1),next=last&&records.length<eligible.length?Buffer.from(JSON.stringify([ceiling,last.sequence,last.chapter?.startedAt??'',last.taskId])).toString('base64url'):null
  return {noteId:owner.noteId,records,cursor:next,ownership:'verified',gaps:records.filter(r=>r.state==='cleared'||r.bodyStatus==='unable-to-verify').map(r=>r.taskId)}
 }
 wirePage(relPath:string,cursor:string|null):import('../shared/ledger.ts').LedgerView{
  let taskId:string|null=null,offset=0,expected:string|null=null,nextPage:string|null=null
  if(cursor?.startsWith('raw:')){const parts=cursor.split(':');if(parts.length!==5||!id(parts[1])||!/^\d+$/.test(parts[2]!)||!/^[a-f0-9]{64}$/.test(parts[3]!)||!/^[A-Za-z0-9_-]+$/.test(parts[4]!))throw Error('BAD_REQUEST');taskId=parts[1]!;offset=Number(parts[2]);expected=parts[3]!;nextPage=parts[4]==='-1'?null:parts[4]!}
  const page=taskId?{noteId:this.requiredOwner(relPath).noteId,records:[] as LedgerRecord[],cursor:nextPage,ownership:'verified' as const,gaps:[] as string[]}:this.page(relPath,cursor,116*1024)
  const record=taskId?this.displayed(relPath,this.getRecord(relPath,taskId)):page.records[0]
  if(!record)return page
  const raw=JSON.stringify(record),bytes=Buffer.from(raw),hash=digest(raw)
  if(taskId||bytes.length>116*1024){if(expected&&hash!==expected||offset>=bytes.length)throw Error('LEDGER_CONFLICT');const data=bytes.subarray(offset,offset+88*1024),end=offset+data.length
   const next=taskId?nextPage:page.cursor??'-1'
   return {noteId:page.noteId,records:[],ownership:'verified',gaps:page.gaps,chunk:{taskId:record.taskId,data:data.toString('base64'),offset,total:bytes.length,hash},cursor:end<bytes.length?`raw:${record.taskId}:${end}:${hash}:${next??'-1'}`:next==='-1'?null:next}
  }
  return page
 }
 legacyRaw(relPath:string){const owner=this.lookupOwner(relPath);if(!owner)return null;const d=this.read(`.rgent/ledgers/${owner.noteId}/legacy.json`);if(!d)return null;try{const v=JSON.parse(d.raw);if(v.version!==1||typeof v.raw!=='string'||digest(v.raw)!==v.hash)throw Error();return v.raw as string}catch{throw Error('LEDGER_RECORD_INVALID')}}
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
 migrate(relPath:string,expected?:{objectVersion:string;revision:string},beforeCommit?:()=>void):{body:string;objectVersion:string;revision:string;migrated:boolean}{
  const note=this.fs.readSnapshot(relPath),raw=note.bytes.toString('utf8');if(!Buffer.from(raw).equals(note.bytes))throw Error('LEDGER_RECORD_INVALID')
  if(expected&&(note.objectVersion!==expected.objectVersion||digest(raw)!==expected.revision))throw Error('CONFLICT')
  this.owner(relPath);const part=partitionSource(raw)
  if(part.ledger===null)return {body:raw,objectVersion:note.objectVersion,revision:digest(raw),migrated:false}
  this.importLegacy(relPath,part.ledger)
  this.check();beforeCommit?.();const after=this.fs.replace(relPath,raw,part.body,note.objectVersion);this.saved?.(relPath,note.objectVersion,after,part.body);this.onWrite(relPath,note.objectVersion,after,part.body,raw)
  return {body:part.body,objectVersion:after,revision:digest(part.body),migrated:true}
 }
 /** Read existing control identities and known dispatched body ranges; never allocate a unit. */
 summaryMaterials(relPath:string,taskIds:readonly string[],requiredBodyIds:readonly string[]=[],watermark=0,acceptsObject:(path:string,before:string,after:string)=>boolean=(_p,b,a)=>b===a){
  const registry=this.registry(),units=this.materialUnits(),pending:{relPath:string;taskId:string}[]=[],queued=new Set<string>(),seen=new Set<string>(),bodyContexts=new Map<string,ContextChapter[]>(),materialIds=new Set<string>(),sequences:number[]=[],memoryDeps=new Map<string,{id:string;version:number}>()
  const queue=(path:string,taskId:string)=>{const key=path+'\0'+taskId;if(queued.has(key))return;if(queued.size>=100000)throw Error('MEMORY_SOURCE_LIMIT');queued.add(key);pending.push({relPath:path,taskId})};for(const taskId of taskIds)queue(relPath,taskId)
  const unitIds=new Set(units.map(u=>u.id));if(unitIds.size!==units.length||requiredBodyIds.some(id=>!unitIds.has(id))||units.some(u=>{const o=registry.owners.find(o=>o.noteId===u.noteId);return !o||u.sequence>o.sequenceCeiling||u.sequence>registry.sequence}))throw Error('MEMORY_MATERIAL_UNVERIFIED')
  const read=(path:string,taskId:string)=>{const owner=this.requiredOwner(path),record=this.record(owner,taskId);if(!record||!record.chapter||record.state==='cleared'||record.state==='pending-body'||record.sequence>owner.sequenceCeiling||record.sequence>registry.sequence||record.chapter.material?.truncated)throw Error('MEMORY_MATERIAL_UNVERIFIED');return record}
  while(pending.length){const at=pending.pop()!,key=at.relPath+'\0'+at.taskId;if(seen.has(key))continue;if(seen.size>=100000)throw Error('MEMORY_SOURCE_LIMIT');seen.add(key)
   const record=read(at.relPath,at.taskId)
   sequences.push(record.sequence);materialIds.add(at.taskId+'/prompt')
   const provenance=record.chapter!.provenance
   // 摘要是派生发送用途；近期已滚出集合也不能把旧章节的未知关系当独立。原始账本阅读不经此门。
   if(provenance?.version!==2)throw Error('MEMORY_MATERIAL_UNVERIFIED')
   for(const dep of [...provenance.memoryDeps,...(record.chapter!.material?.fragments??[]).flatMap(f=>f.memoryDeps)])memoryDeps.set(dep.id+'@'+dep.version,{id:dep.id,version:dep.version})
   for(const f of record.chapter!.material?.fragments??[]){
    if(digest(f.text)!==f.hash)throw Error('MEMORY_MATERIAL_UNVERIFIED')
    const sourceOwner=this.requiredOwner(f.relPath);if(!acceptsObject(f.relPath,f.objectVersion,sourceOwner.objectVersion))throw Error('MEMORY_MATERIAL_UNVERIFIED')
    let matchedBody=false,provenBodyBeforeTask=false;const matchedUnits=new Set<string>()
    if(f.kind==='body')for(const unit of units)if(unit.noteId===sourceOwner.noteId&&(unit.start<f.end&&unit.end>f.start||unit.hash===f.hash&&unit.end-unit.start===f.text.length)){
     if(unit.hash&&unit.hash!==f.hash){if(unit.start>=f.start&&unit.end<=f.end){if(digest(f.text.slice(unit.start-f.start,unit.end-f.start))!==unit.hash)continue}else continue}
     if(!unit.hash&&(requiredBodyIds.includes(unit.id)||unit.sequence<=watermark)){
      // A later hash-proven unit may prove genuinely new material, never an old task.
      const replacement=units.find(u=>u.noteId===unit.noteId&&u.hash&&u.sequence>unit.sequence&&u.sequence<=record.sequence&&u.hash===f.hash&&u.end-u.start===f.text.length)
      if(replacement)continue
     }
     materialIds.add(unit.id);sequences.push(unit.sequence);matchedBody=true;matchedUnits.add(unit.id);if(unit.sequence<=record.sequence)provenBodyBeforeTask=true
    }
    if(f.kind==='body'&&f.taskId===null){
     for(const prior of units.filter(u=>u.noteId===sourceOwner.noteId&&requiredBodyIds.includes(u.id)&&!matchedUnits.has(u.id))){
      const replacement=units.some(u=>u.noteId===prior.noteId&&u.hash===f.hash&&u.end-u.start===f.text.length&&u.sequence>prior.sequence&&u.sequence<=record.sequence)
      if(!replacement)throw Error('MEMORY_MATERIAL_UNVERIFIED')
     }
     if(watermark>0&&(!matchedBody||!provenBodyBeforeTask))throw Error('MEMORY_MATERIAL_UNVERIFIED')
    }
    if(f.kind==='ledger'||f.taskId!==null){
     if(!f.taskId||!Number.isSafeInteger(f.start)||!Number.isSafeInteger(f.end)||f.start<0||f.end<=f.start||digest(f.text)!==f.hash)throw Error('MEMORY_MATERIAL_UNVERIFIED')
     const ownPrompt=f.kind==='body'&&f.relPath===at.relPath&&f.taskId===at.taskId&&f.classification==='command',ancestor=ownPrompt?record:read(f.relPath,f.taskId),chapter=this.contextForRecord(ancestor)[0],fields=chapter?.fields,field=fields?.status==='valid'?(f.classification==='command'?fields.prompt:f.classification==='ai'?fields.answer:undefined):undefined
     if(!field||!ownPrompt&&ancestor.sequence>=record.sequence)throw Error('MEMORY_MATERIAL_UNVERIFIED')
     if(f.kind==='ledger'){if(f.start<field.start||f.end>field.end||chapter!.text.slice(f.start,f.end)!==f.text)throw Error('MEMORY_MATERIAL_UNVERIFIED')}
     else{const body=this.fs.readSnapshot(f.relPath).bytes.toString(),parsed=compile(body),block=parsed.index.blocks.find(b=>b.range.start<=f.start&&b.range.end>=f.end)
      if(parsed.stale||!block||body.slice(f.start,f.end)!==f.text||!field.text.includes(f.text))throw Error('MEMORY_MATERIAL_UNVERIFIED')
      if(block.identity==='ai'||block.identity==='command'){const marker=parsed.index.markers.filter(m=>m.range.end<=block.range.start).at(-1),taskId=marker&&parseMarker(body.slice(marker.range.start,marker.range.end))?.attrs['task-id'];if(taskId!==f.taskId||(block.identity==='command')!==(f.classification==='command'))throw Error('MEMORY_MATERIAL_UNVERIFIED')}
      else{let chapters=bodyContexts.get(f.relPath);if(!chapters){chapters=this.contexts(f.relPath);bodyContexts.set(f.relPath,chapters)}const tasks=historicalBodyTasks(parsed,chapters).get(block.range.start);if(f.classification!=='ai'||tasks?.length!==1||tasks[0]!==f.taskId)throw Error('MEMORY_MATERIAL_UNVERIFIED')}
     }
     if(!ownPrompt)queue(f.relPath,f.taskId)
    }
   }
   for(const sent of record.chapter!.sentSummaries??[])for(const d of sent.dependencies){const dependency=read(at.relPath,d.sourceId),chapter=this.contextForRecord(dependency)[0];if(dependency.sequence>=record.sequence||!chapter||digest(chapter.text)!==d.hash)throw Error('MEMORY_MATERIAL_UNVERIFIED');queue(at.relPath,d.sourceId)}
  }
  return {materialIds:[...materialIds],sequences,ceiling:registry.sequence,memoryDeps:[...memoryDeps.values()]}
 }
 contexts(relPath:string):ContextChapter[]{const owner=this.lookupOwner(relPath);if(!owner)return []
  return this.orderedRecords(owner,this.registry().sequence).reverse().flatMap(({record})=>this.contextForRecord(record))
 }
 contextForRecord(r:LedgerRecord):ContextChapter[]{
   if(r.state==='cleared'||r.state==='pending-body')return []
   const c=r.chapter
   if(!c)return [{sourceId:r.taskId,taskId:r.taskId,text:'不可核验的历史记录',fields:{status:'ambiguous' as const},eligible:false}]
   const prefix='口令：\n',separator='\n\n历史回答：\n',text=prefix+c.prompt+separator+c.answer,answerStart=prefix.length+c.prompt.length+separator.length
   return [{sourceId:r.taskId,taskId:r.taskId,text,fields:{status:'valid' as const,prompt:{start:prefix.length,end:prefix.length+c.prompt.length,text:c.prompt},answer:{start:answerStart,end:text.length,text:c.answer}},provenance:c.provenance,summaryDerived:!!c.sentSummaries?.length||!!c.material?.fragments.some(f=>f.kind==='ledger'||f.taskId!==null&&f.taskId!==r.taskId),eligible:r.state==='legacy'?!!c.provenance&&!(c.provenance.version===2&&c.provenance.memoryDeps.length>0):true}]
 }
}


export type LedgerPublication={kind:'ledger-publication';rootIdentity:string;sessionId:string;relPath:string;objectVersion:string;bodyRevision:string;permissionRaw:string|null;permissionId:string|null;ownerPath:string;writes:{path:string;before:string|null;beforeId:string|null;after:string;receipt?:string}[]}
export function validLedgerPublication(value:unknown):value is LedgerPublication{
 try{
  if(!obj(value)||!exact(value,['kind','rootIdentity','sessionId','relPath','objectVersion','bodyRevision','permissionRaw','permissionId','ownerPath','writes'])||value.kind!=='ledger-publication'||typeof value.rootIdentity!=='string'||!/^\d+:\d+$/.test(value.rootIdentity)||typeof value.sessionId!=='string'||!rel(value.relPath)||typeof value.objectVersion!=='string'||typeof value.bodyRevision!=='string'||!/^[a-f0-9]{64}$/.test(value.bodyRevision)||!(value.permissionRaw===null&&value.permissionId===null||typeof value.permissionRaw==='string'&&typeof value.permissionId==='string')||!Array.isArray(value.writes)||value.writes.length!==2)return false
  const writes=value.writes;if(!writes.every(w=>obj(w)&&exact(w,['path','before','beforeId','after',...('receipt'in w?['receipt']:[])])&&(w.before===null&&w.beforeId===null||typeof w.before==='string'&&typeof w.beforeId==='string')&&typeof w.after==='string'&&(w.receipt===undefined||typeof w.receipt==='string')))return false
  const next=JSON.parse(writes[1].after),owner=JSON.parse(writes[0].after),prior=writes[1].before===null?{version:1,owners:[],sequence:0}:JSON.parse(writes[1].before)
  if(!validOwner(owner)||owner.relPath!==value.relPath||owner.objectVersion!==value.objectVersion||owner.bodyRevision!==value.bodyRevision||value.ownerPath!==`.rgent/ledgers/${owner.noteId}/owner.json`||writes[0].path!==value.ownerPath||writes[1].path!==fixed||next.version!==1||prior.version!==1||!Array.isArray(next.owners)||!next.owners.every(validOwner)||!Array.isArray(prior.owners)||!prior.owners.every(validOwner)||!Number.isSafeInteger(next.sequence)||next.sequence<prior.sequence)return false
  if(new Set(next.owners.map((o:LedgerOwner)=>o.noteId)).size!==next.owners.length||new Set(next.owners.map((o:LedgerOwner)=>o.relPath)).size!==next.owners.length)return false
  const old=prior.owners.find((o:LedgerOwner)=>o.noteId===owner.noteId)
  return JSON.stringify(next.owners.find((o:LedgerOwner)=>o.noteId===owner.noteId))===JSON.stringify(owner)&&JSON.stringify(prior.owners.filter((o:LedgerOwner)=>o.noteId!==owner.noteId))===JSON.stringify(next.owners.filter((o:LedgerOwner)=>o.noteId!==owner.noteId))&&(old?writes[0].before===JSON.stringify(old):writes[0].before===null)
 }catch{return false}
}
export function inspectLedgerPublication(fs:SecureVaultFs,plan:LedgerPublication,check:()=>void){
 check();if(fs.rootIdentity!==plan.rootIdentity)throw Error('STALE_RECOVERY')
 const note=fs.readSnapshot(plan.relPath);if(note.objectVersion!==plan.objectVersion||digest(note.bytes.toString())!==plan.bodyRevision)throw Error('STALE_RECOVERY')
 const read=(p:string)=>{try{const d=fs.readSnapshot(p);return {raw:d.bytes.toString(),id:d.objectVersion}}catch(e){if(e instanceof Error&&e.message==='ENOENT')return null;throw e}}
 const permission=read('.rgent-permissions');if((permission?.raw??null)!==plan.permissionRaw||(permission?.id??null)!==plan.permissionId)throw Error('STALE_RECOVERY')
 for(const w of plan.writes){const disk=read(w.path);if(!(disk?.raw===w.after&&(!w.receipt||disk.id===w.receipt)||!w.receipt&&(disk?.raw??null)===w.before&&(disk?.id??null)===w.beforeId))throw Error('STALE_RECOVERY')}
 check()
}
export function recoverLedgerPublication(fs:SecureVaultFs,plan:LedgerPublication,check:()=>void){
 if(!validLedgerPublication(plan))throw Error('LIFECYCLE_RECOVERY_REQUIRED')
 let journal=fs.readSnapshot('.rgent-lifecycle')
 if(JSON.stringify(JSON.parse(journal.bytes.toString()).active)!==JSON.stringify(plan))throw Error('STALE_RECOVERY')
 for(const write of plan.writes){
  inspectLedgerPublication(fs,plan,check)
  if(write.receipt)continue
  let current:string|null=null;try{current=fs.readText(write.path)}catch(e){if(!(e instanceof Error&&e.message==='ENOENT'))throw e}
  if(current!==write.after)fs.replace(write.path,write.before,write.after,write.beforeId??undefined)
  check();const saved=fs.readSnapshot(write.path);if(saved.bytes.toString()!==write.after)throw Error('STALE_RECOVERY')
  write.receipt=saved.objectVersion
  const next=lifecycleRaw(journal.bytes.toString(),plan);fs.replace('.rgent-lifecycle',journal.bytes.toString(),next,journal.objectVersion);journal=fs.readSnapshot('.rgent-lifecycle')
 }
 inspectLedgerPublication(fs,plan,check);fs.replace('.rgent-lifecycle',journal.bytes.toString(),lifecycleRaw(journal.bytes.toString(),null),journal.objectVersion)
}
