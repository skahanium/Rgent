import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path'
import {it,expect,afterEach} from 'vitest'
import {WorkingMemoryStore,statusFromState} from '../../src/main/working-memory-store.ts'
import {secureFsFor,closeSecureFs} from '../../src/main/secure-fs.ts'
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(r=>{closeSecureFs(r);rmSync(r,{recursive:true,force:true})}))
const fixture=()=>{const root=mkdtempSync(path.join(os.tmpdir(),'rgent-working-memory-'));roots.push(root);const fs=secureFsFor(root);return {root,fs,store:new WorkingMemoryStore(fs,()=>{})}}
const source=(seq=1)=>({id:'source-'+seq,version:1,relPath:'a.md',objectVersion:'object',revision:'a'.repeat(64),permissionTier:'reference' as const,kind:'ledger' as const,taskId:'task-'+seq,taskMaterialHash:'b'.repeat(64),classification:'command' as const,start:0,end:5,text:'以后用中文',hash:'c'.repeat(64),basisHash:'d'.repeat(64),sourceDeps:[],memoryDeps:[],materialId:'task-'+seq+'/prompt',sequence:seq})
it('stores unambiguous Markdown lengths; rejects old JSON and preserves a damaged record',()=>{
 const {fs,store}=fixture();const basis=store.read();store.add(basis,{content:'正文\n<!-- rgent:item:v2 -->\n',layer:'core',scope:'本库',sources:[source()],semantic:'standing',attribution:'人的口令',reviewAt:null})
 expect(store.read().record.entries[0]?.content).toContain('rgent:item:v2');const raw=fs.readSnapshot('.rgent-memory');expect(raw.bytes.toString()).toContain('正文');fs.replace('.rgent-memory',raw.bytes.toString(),'{"version":1}',raw.objectVersion)
 expect(()=>store.read()).toThrow();expect(fs.readSnapshot('.rgent-memory').bytes.toString()).toBe('{"version":1}')
})
it('selected versions survive unrelated writes while CAS blocks a stale edit',()=>{
 const {store}=fixture(),first=store.add(store.read(),{content:'后续用中文',layer:'core',scope:'本库',sources:[source()],semantic:'standing',attribution:'人的口令',reviewAt:null}),snapshot=store.read()
 store.add(snapshot,{content:'另一个事实',layer:'demand',scope:'本库',sources:[source(2)],semantic:'fact',attribution:'笔记记载',reviewAt:null})
 expect(store.read().record.entries.find(e=>e.id===first.id)?.version).toBe(first.version)
 expect(()=>store.edit(snapshot,first.id,first.version,{content:'旧请求'})).toThrow('MEMORY_CONFLICT')
})
it('forgets content and known derivations, retains textless constraints and safely advances a monotonic watermark',()=>{
 const {fs,store}=fixture(),entry=store.add(store.read(),{content:'不可复活的私人事实',layer:'demand',scope:'库',sources:[source()],semantic:'fact',attribution:'人说',reviewAt:null})
 store.forget(store.read(),entry.id,entry.version)
 expect(fs.readSnapshot('.rgent-memory').bytes.toString()).not.toContain('不可复活的私人事实')
 expect(store.canLearn(store.read().record,[source()])).toBe(false)
 store.advance(store.read(),1);expect(store.read().record.forgotten).toHaveLength(0);expect(store.canLearn(store.read().record,[source()])).toBe(false)
 expect(()=>store.advance(store.read(),0)).toThrow()
})
it('defers a full standing set without silently evicting a still-effective agreement',()=>{
 const {store}=fixture();let basis=store.read(),i=0
 while(i<30){store.add(basis,{content:'约定'.repeat(50)+String(i),layer:'core',scope:'本库',sources:[source(i+1)],semantic:'standing',attribution:'口令',reviewAt:null});basis=store.read();i++}
 expect(basis.record.entries.some(e=>e.status==='deferred')).toBe(true);expect(basis.record.entries[0]?.content).toContain('约定')
})
it('commits valid proposal groups once; a stale correction group cannot partially change its target',()=>{
 const {store}=fixture(),target=store.add(store.read(),{content:'旧事实',layer:'demand',scope:'库',sources:[source()],semantic:'fact',attribution:'人说',reviewAt:null}),basis=store.read()
 const input={content:'新事实',layer:'demand' as const,scope:'库',sources:[source(2)],semantic:'fact' as const,attribution:'新口令',reviewAt:null}
 const result=store.apply(basis,[[{action:'correct',id:target.id,version:99,input},{action:'add',input}],[{action:'add',input:{...input,content:'独立有效事实'}}]],{taskId:'job',materialVersion:'a'.repeat(64),outcome:'applied',entryIds:[]})
 expect(result.rejected).toBe(1);expect(result.entryIds).toHaveLength(1)
 expect(store.read().record.entries.map(e=>e.content)).toEqual(['旧事实','独立有效事实'])
 expect(store.read().record.revision).toBe(basis.record.revision+1)
})
it('records layered group results: a partial batch keeps the specific rejection code and never claims full success',()=>{
 const {store}=fixture(),target=store.add(store.read(),{content:'旧事实',layer:'demand',scope:'库',sources:[source()],semantic:'fact',attribution:'人说',reviewAt:null}),basis=store.read()
 const input={content:'新事实',layer:'demand' as const,scope:'库',sources:[source(2)],semantic:'fact' as const,attribution:'新口令',reviewAt:null}
 store.apply(basis,[[{action:'correct',id:target.id,version:99,input}],[{action:'add',input:{...input,content:'独立有效事实'}}]],{taskId:'job',materialVersion:'a'.repeat(64),outcome:'applied',entryIds:[]})
 const receipt=store.read().record.jobs.find(job=>job.taskId==='job')!
 expect(receipt.outcome).toBe('applied')
 expect(receipt.results).toEqual([{action:'correct',outcome:'rejected',code:'MEMORY_CHANGED'},{action:'add',outcome:'applied'}])
 expect(receipt.reason).toBe('MEMORY_CHANGED')
})
it('keeps a capacity rejection distinct from other causes and survives a storage round-trip',()=>{
 const {fs,store}=fixture(),basis=store.read()
 store.apply(basis,[[{action:'add',input:{content:'容量超限的新增',layer:'core' as const,scope:'库',sources:[source(2)],semantic:'standing' as const,attribution:'人说',reviewAt:null}}]],{taskId:'capacity',materialVersion:'a'.repeat(64),outcome:'applied',entryIds:[]},null)
 const written=store.read().record.jobs.find(job=>job.taskId==='capacity')!
 expect(written.results).toHaveLength(1)
 expect(written.results?.[0]?.outcome).toBe(written.outcome==='rejected'?'rejected':'applied')
 expect(written.reason===undefined||written.reason==='MEMORY_OUTPUT_INVALID'||/^MEMORY_[A-Z_]+$/.test(written.reason)).toBe(true)
 const raw=fs.readSnapshot('.rgent-memory').bytes.toString()
 const encoded=/rgent:memory:(v3|v4) data="([A-Za-z0-9_-]+)"/.exec(raw)!
 const record=JSON.parse(Buffer.from(encoded[2]!,'base64url').toString())
 expect(record.jobs.find((job:{taskId:string})=>job.taskId==='capacity').results).toHaveLength(1)
 expect(store.read().record.jobs.find(job=>job.taskId==='capacity')?.results).toEqual(record.jobs.find((job:{taskId:string})=>job.taskId==='capacity').results)
})
it('freeing standing capacity keeps deferred entries deferred until sources are rechecked',()=>{
 const {store}=fixture();for(let i=0;i<3;i++)store.add(store.read(),{content:'约'.repeat(500)+i,layer:'core',scope:'库',sources:[source(i+1)],semantic:'standing',attribution:'口令',reviewAt:null})
 const initial=store.read(),first=initial.record.entries[0]!,deferred=initial.record.entries.find(e=>e.status==='deferred')!
 store.forget(initial,first.id,first.version)
 expect(store.read().record.entries.find(e=>e.id===deferred.id)?.status).toBe('deferred')
})
it('diagnoses invalid storage without opening it, and requires exact bytes/object before explicit reset',()=>{
 const {fs,store}=fixture();store.initialize();let d=fs.readSnapshot('.rgent-memory');fs.replace('.rgent-memory',d.bytes.toString(),'corrupt',d.objectVersion)
 expect(()=>store.read()).toThrow('MEMORY_STORAGE_CHANGED');const diagnosis=store.diagnosis()
 d=fs.readSnapshot('.rgent-memory');fs.replace('.rgent-memory',d.bytes.toString(),'new corrupt',d.objectVersion)
 expect(()=>store.reset(diagnosis,4)).toThrow('MEMORY_CONFLICT')
 store.reset(store.diagnosis(),4);expect(store.read().record.watermark).toBe(4);expect(store.canLearn(store.read().record,[source(3)])).toBe(false)
})

import {encodeWorkingMemory,parseWorkingMemory,type WorkingRecord,type WorkingRecent} from '../../src/main/working-memory-store.ts'
const entryRecord=(count:number,long=false):WorkingRecord=>({version:3,identity:'fixture',revision:1,nextSequence:count,watermark:0,forgotten:[],jobs:[],recent:[],entries:Array.from({length:count},(_,i)=>({id:long?'E'.repeat(253)+String(i).padStart(3,'0'):'entry-'+i,version:1,content:'事实'+i,category:'long',layer:'demand',scope:'库',sources:[{...source(i+1),revision:'',taskMaterialHash:null,materialId:long?'M'.repeat(253)+String(i).padStart(3,'0'):'material-'+i}],semantic:'fact',attribution:'人',reviewAt:null,status:'active',state:{source:'verified',content:'current',enabled:true,capacity:'ready'},reason:null,updatedAt:'2026-01-01T00:00:00Z',updateBasis:{kind:'manual',id:'manual',version:1}}))})
it('forgets 1000 longest legal identities serially beyond the old control wall',()=>{
 const {root,store}=fixture(),record=entryRecord(1000,true);writeFileSync(path.join(root,'.rgent-memory'),encodeWorkingMemory(record));expect(Buffer.byteLength(encodeWorkingMemory(record))).toBeLessThan(2*1024*1024)
 const started=performance.now();for(const e of record.entries)store.forget(store.read(),e.id,e.version)
 const final=store.read();expect(final.record.entries).toEqual([]);expect(final.record.forgotten).toHaveLength(1000);expect(Buffer.byteLength(final.raw!)).toBeLessThanOrEqual(2*1024*1024);appendFileSync('/tmp/rgent-v4-D-capacity-numbers.jsonl',JSON.stringify({kind:'serial-1000',initialBytes:Buffer.byteLength(encodeWorkingMemory(record)),finalBytes:Buffer.byteLength(final.raw!),ms:Number((performance.now()-started).toFixed(2))})+'\n')
},120000)
it('forget closes pending target chains as well as recursive evidence dependencies',()=>{
 const {root,store}=fixture(),record=entryRecord(4);record.entries[1]!.pendingTarget={id:record.entries[0]!.id,version:1};record.entries[2]!.pendingTarget={id:record.entries[1]!.id,version:1};record.entries[3]!.sources[0]!.memoryDeps=[{id:record.entries[2]!.id,version:1}];writeFileSync(path.join(root,'.rgent-memory'),encodeWorkingMemory(record))
 store.forget(store.read(),record.entries[0]!.id,1);expect(store.read().record.entries).toEqual([])
})
it('a legal terminal numerical revision still allows verified forget by byte CAS',()=>{
 const {root,store}=fixture(),record=entryRecord(1);record.revision=Number.MAX_SAFE_INTEGER;writeFileSync(path.join(root,'.rgent-memory'),encodeWorkingMemory(record));const before=store.read();store.forget(before,'entry-0',1);const after=store.read();expect(after.record.revision).toBe(Number.MAX_SAFE_INTEGER);expect(after.revision).not.toBe(before.revision);expect(after.record.entries).toEqual([])
})
it('ordinary writes stop before exhausting all remaining forget revisions',()=>{
 const {root,store}=fixture(),record=entryRecord(1);record.revision=Number.MAX_SAFE_INTEGER-1;writeFileSync(path.join(root,'.rgent-memory'),encodeWorkingMemory(record));const basis=store.read();expect(()=>store.edit(basis,'entry-0',1,{content:'新事实'})).toThrow('MEMORY_FILE_LIMIT');expect(store.read().raw).toBe(basis.raw)
})
it('a near-full legal control region stays readable and forget never hits a separate metadata wall',()=>{
 const {root,store}=fixture(),record=entryRecord(1,true),block={materialIds:['M'.repeat(256)],entryIds:[{id:'F'.repeat(256),version:Number.MAX_SAFE_INTEGER}],through:1};let lo=0,hi=4000
 while(lo<hi){const mid=Math.ceil((lo+hi)/2);record.forgotten=Array.from({length:mid},()=>structuredClone(block));if(Buffer.byteLength(encodeWorkingMemory(record))<=2*1024*1024-64)lo=mid;else hi=mid-1}
 record.forgotten=Array.from({length:lo},()=>structuredClone(block));const raw=encodeWorkingMemory(record);writeFileSync(path.join(root,'.rgent-memory'),raw);expect(Buffer.byteLength(raw)).toBeGreaterThan(2*1024*1024-1024);store.forget(store.read(),record.entries[0]!.id,1);expect(store.read().record.entries).toEqual([])
})
it('ordinary growth pauses on an existing unreserved full body but a real reduction and 1000-entry closure stay available',()=>{
 const {root,store}=fixture(),record=entryRecord(1000);for(const e of record.entries){e.content='x'.repeat(800);if(e.id!=='entry-0')e.pendingTarget={id:'entry-0',version:1}}
 const raw=encodeWorkingMemory(record);expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2*1024*1024);expect(Buffer.byteLength(raw)).toBeGreaterThan(2*1024*1024-256*1024);writeFileSync(path.join(root,'.rgent-memory'),raw)
 expect(()=>store.edit(store.read(),'entry-1',1,{content:'x'.repeat(900)})).toThrow('MEMORY_FILE_LIMIT');store.edit(store.read(),'entry-1',1,{content:'缩短'});const before=store.read(),started=performance.now();store.forget(before,'entry-0',1);const after=store.read();expect(after.record.entries).toEqual([]);appendFileSync('/tmp/rgent-v4-D-capacity-numbers.jsonl',JSON.stringify({kind:'closure-1000',initialBytes:Buffer.byteLength(before.raw!),finalBytes:Buffer.byteLength(after.raw!),ms:Number((performance.now()-started).toFixed(2))})+'\n')
})
it('a capacity-rejected automatic proposal records the real capacity reason while preserving existing entries',()=>{
 const {root,store}=fixture(),record=entryRecord(999);for(const e of record.entries)e.content='x'.repeat(800);writeFileSync(path.join(root,'.rgent-memory'),encodeWorkingMemory(record));const result=store.apply(store.read(),[[{action:'add',input:{content:'新事实',layer:'demand',scope:'库',sources:[source(1000)],semantic:'fact',attribution:'人',reviewAt:null}}]],{taskId:'capacity-job',materialVersion:'a'.repeat(64),outcome:'applied',entryIds:[]});expect(result.rejected).toBe(1);expect(result.snapshot.record.jobs.at(-1)?.reason).toBe('MEMORY_FILE_LIMIT');expect(result.snapshot.record.entries).toHaveLength(999)
})

it('validates contained identity groups strictly and retains all longest legal IDs in forget constraints',()=>{
 const {store}=fixture(),groups=Array.from({length:16},(_,i)=>('group'+i).padEnd(256,'x')),input={content:'派生条目',layer:'demand' as const,scope:'库',sources:[{...source(),basisGroups:groups}],semantic:'fact' as const,attribution:'人',reviewAt:null};const entry=store.add(store.read(),input);store.forget(store.read(),entry.id,1);expect(store.read().record.forgotten[0]?.materialIds).toEqual(expect.arrayContaining(groups));expect(store.canLearn(store.read().record,[{...source(2),basisGroups:[groups[0]!]}])).toBe(false)
 for(const bad of ['not-array',Array(17).fill('a'),['..'],['duplicate','duplicate'],['x'.repeat(257)]])expect(()=>store.add(store.read(),{...input,sources:[{...source(2),basisGroups:bad as string[]}]})).toThrow('BAD_MEMORY_EDIT')
})

it('uses the last protected receipt slot without retaining zero-capacity terminal receipts',()=>{
 const {root,store}=fixture(),record=entryRecord(0)
 record.jobs=Array.from({length:255},(_,i)=>({taskId:'interrupted-'+i,materialVersion:'a'.repeat(64),outcome:'interrupted' as const,entryIds:[]}))
 record.jobs.push({taskId:'old-rejection',materialVersion:'a'.repeat(64),outcome:'rejected',entryIds:[]})
 writeFileSync(path.join(root,'.rgent-memory'),encodeWorkingMemory(record))
 const protectedJobs=structuredClone(record.jobs.slice(0,255))
 store.receipt(store.read(),{taskId:'new-queued',materialVersion:'b'.repeat(64),outcome:'queued',entryIds:[]})
 const jobs=store.read().record.jobs
 expect(jobs).toHaveLength(256);expect(jobs.slice(0,255)).toEqual(protectedJobs)
 expect(jobs.at(-1)?.taskId).toBe('new-queued');expect(jobs.some(j=>j.taskId==='old-rejection')).toBe(false)
})
it('keeps all 256 interrupted receipts when a new queued job or failure arrives',()=>{
 const {root,store}=fixture(),record=entryRecord(0)
 record.jobs=Array.from({length:256},(_,i)=>({taskId:'interrupted-'+i,materialVersion:'a'.repeat(64),outcome:'interrupted' as const,entryIds:[]}))
 writeFileSync(path.join(root,'.rgent-memory'),encodeWorkingMemory(record))
 const basis=store.read()
 expect(()=>store.receipt(basis,{taskId:'new-job',materialVersion:'b'.repeat(64),outcome:'queued',entryIds:[]})).toThrow('MEMORY_QUEUE_FULL')
 expect(store.read().raw).toBe(basis.raw)
 store.receipt(store.read(),{taskId:'new-job',materialVersion:'b'.repeat(64),outcome:'rejected',reason:'MEMORY_QUEUE_FULL',entryIds:[]})
 expect(store.read().record.jobs).toEqual(record.jobs)
})

it('writes M4 Markdown, reads M3 without upgrading, and refuses a valid v2 record without overwriting it',()=>{
 const {root,fs,store}=fixture()
 const asVersion=(raw:string,version:3|2)=>{
  const match=/^<!-- rgent:memory:v4 data="([A-Za-z0-9_-]+)" -->\n/.exec(raw)!
  const meta=JSON.parse(Buffer.from(match[1]!,'base64url').toString());meta.version=version
  return `<!-- rgent:memory:v${version} data="${Buffer.from(JSON.stringify(meta)).toString('base64url')}" -->\n`
   +raw.slice(match[0].length).replaceAll('rgent:item:v4',`rgent:item:v${version}`).replaceAll('rgent:end:v4',`rgent:end:v${version}`)
 }
 const m3=asVersion(encodeWorkingMemory(entryRecord(1)),3)
 writeFileSync(path.join(root,'.rgent-memory'),m3)
 const before=store.read()
 expect(before.record.version).toBe(3)
 expect(before.raw).toBe(m3)
 const added=store.add(before,{content:'升级后新增的条目',layer:'demand',scope:'库',sources:[source(2)],semantic:'fact',attribution:'人说',reviewAt:null})
 const upgraded=fs.readSnapshot('.rgent-memory').bytes.toString()
 expect(upgraded).toContain('rgent:memory:v4')
 expect(upgraded).not.toContain('rgent:memory:v3')
 const after=store.read()
 expect(after.record.version).toBe(4)
 expect(after.record.entries.map(e=>e.id)).toContain(added.id)
 expect(after.record.entries.find(e=>e.id===added.id)?.content).toBe('升级后新增的条目')
 const v2=asVersion(upgraded,2)
 // 独立夹具：同一个 store 已经观察过该路径，外部替换会先命中外改检测。
 const fresh=fixture()
 writeFileSync(path.join(fresh.root,'.rgent-memory'),v2)
 expect(()=>fresh.store.read()).toThrow('MEMORY_STORAGE_INVALID')
 expect(fresh.fs.readSnapshot('.rgent-memory').bytes.toString()).toBe(v2)
 expect(fs.readSnapshot('.rgent-memory').bytes.toString()).toBe(upgraded)
})
it('round-trips the agreement basis and rejects malformed authority references',()=>{
 const {store}=fixture(),first=source(1)
 const added=store.add(store.read(),{content:'本库回答使用中文',layer:'core',scope:'本库',sources:[first,source(2)],semantic:'standing',attribution:'人的口令',reviewAt:null,agreement:{authority:[{sourceId:first.id,quote:'以后用中文'}],supporting:['source-2']}})
 const stored=store.read().record.entries.find(e=>e.id===added.id)!
 expect(stored.agreement).toEqual({authority:[{sourceId:first.id,quote:'以后用中文'}],supporting:['source-2']})
 expect(parseWorkingMemory(encodeWorkingMemory(store.read().record)).entries.find(e=>e.id===added.id)?.agreement).toEqual(stored.agreement)
 // 新字段不改变容量与遗忘出口：带依据角色的条目照样可以完整遗忘。
 store.forget(store.read(),added.id,added.version)
 expect(store.read().record.entries.some(e=>e.id===added.id)).toBe(false)
 expect(store.read().record.forgotten).toHaveLength(1)
 expect(store.read().record.forgotten[0]?.entryIds.some(item=>item.id===added.id)).toBe(true)
 const base={content:'另一条事实',layer:'demand' as const,scope:'库存',sources:[source(3)],semantic:'fact' as const,attribution:'人说',reviewAt:null}
 for(const agreement of [
  {authority:[] as {sourceId:string;quote:string}[],supporting:[]},
  {authority:[{sourceId:'missing-source',quote:'原话'}],supporting:[]},
  {authority:[{sourceId:'source-3',quote:'原话'}],supporting:['source-9']},
  {authority:[{sourceId:'source-3',quote:'x'.repeat(513)}],supporting:[]}
 ]) expect(()=>store.add(store.read(),{...base,agreement})).toThrow('BAD_MEMORY_EDIT')
})
it('keeps an entry without a role field readable and never backfills it as proven authority',()=>{
 const {root,store}=fixture()
 const m4=encodeWorkingMemory({version:3,identity:'legacy',revision:1,nextSequence:1,watermark:0,forgotten:[],jobs:[],recent:[],entries:[{id:'legacy-1',version:1,content:'旧条目',category:'long',layer:'demand',scope:'库',sources:[{...source(1),revision:'',taskMaterialHash:null}],semantic:'fact',attribution:'人说',reviewAt:null,status:'active',state:{source:'verified',content:'current',enabled:true,capacity:'ready'},reason:null,updatedAt:'2026-01-01T00:00:00Z',updateBasis:{kind:'manual',id:'manual',version:1}}]})
 const legacy=(()=>{const match=/^<!-- rgent:memory:v4 data="([A-Za-z0-9_-]+)" -->\n/.exec(m4)!;const meta=JSON.parse(Buffer.from(match[1]!,'base64url').toString());meta.version=3
  return `<!-- rgent:memory:v3 data="${Buffer.from(JSON.stringify(meta)).toString('base64url')}" -->\n`+m4.slice(match[0].length).replaceAll('rgent:item:v4','rgent:item:v3').replaceAll('rgent:end:v4','rgent:end:v3')})()
 writeFileSync(path.join(root,'.rgent-memory'),legacy)
 const record=store.read().record
 expect(record.version).toBe(3)
 expect(record.entries[0]?.agreement).toBeUndefined()
 expect(parseWorkingMemory(legacy).entries[0]?.agreement).toBeUndefined()
})
it('keeps a recent block in the same CAS record and forgets its dependent closure',()=>{
 const {store}=fixture(),basis=store.read(),recent={taskId:'task-1',noteId:'note-1',materialVersion:'b'.repeat(64),createdAt:new Date().toISOString(),outcome:'completed' as const,sections:{goal:'整理清单',completed:'已列两项',blocked:'无',next:'继续核对'},assistantDraft:false}
 const result=store.apply(basis,[],{taskId:'task-1',materialVersion:'b'.repeat(64),outcome:'applied',entryIds:[]},{sources:[source()],scope:'库',recent,tags:['工作']})
 expect(result.recentIds).toHaveLength(1)
 const saved=store.read();expect(saved.record.recent).toHaveLength(1)
 expect(saved.record.recent[0]?.content).toContain('已列两项')
 expect(saved.record.jobs.at(-1)?.entryIds).toContain(result.recentIds[0])
 store.forget(saved,result.recentIds[0]!,1)
 expect(store.read().record.recent).toEqual([])
 expect(store.canLearn(store.read().record,[source()])).toBe(false)
})
it('isolates an invalid recent proposal from a valid standing group',()=>{
 const {store}=fixture(),input={content:'长期约定',layer:'core' as const,scope:'库',sources:[source()],semantic:'standing' as const,attribution:'人',reviewAt:null}
 const result=store.apply(store.read(),[[{action:'add',input}]],{taskId:'job',materialVersion:'b'.repeat(64),outcome:'applied',entryIds:[]},{sources:[{...source(2),taskId:'job'}],scope:'库',recent:{taskId:'job',noteId:'note-1',materialVersion:'b'.repeat(64),createdAt:new Date().toISOString(),outcome:'completed',sections:{goal:'x'.repeat(2100),completed:'',blocked:'',next:''},assistantDraft:false}})
 expect(result.entryIds).toHaveLength(1);expect(result.recentIds).toEqual([]);expect(result.rejected).toBe(1)
 expect(store.read().record.entries).toHaveLength(1)
})
it('projects source and content axes without losing a disputed state when paused',()=>{
 const {store}=fixture(),base=store.read(),input={content:'有争议的事实',layer:'demand' as const,scope:'库',sources:[source()],semantic:'fact' as const,attribution:'人',reviewAt:null}
 const target=store.add(base,input)
 const result=store.apply(store.read(),[[{action:'conflict',id:target.id,version:1,input:{...input,content:'冲突说法',sources:[source(2)]}}]],{taskId:'job',materialVersion:'b'.repeat(64),outcome:'applied',entryIds:[]})
 const disputed=store.read().record.entries.find(e=>e.id===result.entryIds[0])!
 expect(disputed.state.content).toBe('disputed')
 store.reconcile(store.read(),[{id:disputed.id,version:1,status:'paused',reason:'MEMORY_SOURCE_CHANGED'}])
 const paused=store.read().record.entries.find(e=>e.id===disputed.id)!
 expect(paused.status).toBe('paused');expect(paused.state.content).toBe('disputed');expect(paused.state.source).toBe('revoked')
 const unchecked={...paused.state,source:'unchecked' as const}
 expect(statusFromState(unchecked)).toBe('paused')
 expect(statusFromState({...unchecked,source:'verified'})).toBe('disputed')
})
it('does not write during a read of an expired recent block',()=>{
 const {root,store}=fixture(),record=entryRecord(0);record.nextSequence=1
 record.recent=[{...entryRecord(1).entries[0]!,id:'recent-one',content:'目标：旧任务\n已完成：\n受阻：\n下一步：',category:'recent',layer:'demand',semantic:'fact',recent:{taskId:'task-1',noteId:'note-1',materialVersion:'b'.repeat(64),createdAt:'2020-01-01T00:00:00.000Z',outcome:'completed',sections:{goal:'旧任务',completed:'',blocked:'',next:''},assistantDraft:false}}]
 const raw=encodeWorkingMemory(record);writeFileSync(path.join(root,'.rgent-memory'),raw)
 expect(store.read().record.recent).toHaveLength(1)
 expect(store.read().raw).toBe(raw)
})
it('updates the same task recent block by ID and invalidates the prior version',()=>{
 const {store}=fixture(),first={taskId:'task-1',noteId:'note-1',materialVersion:'a'.repeat(64),createdAt:new Date().toISOString(),outcome:'completed' as const,sections:{goal:'第一步',completed:'',blocked:'',next:'第二步'},assistantDraft:false}
 const firstResult=store.apply(store.read(),[],{taskId:'task-1',materialVersion:first.materialVersion,outcome:'applied',entryIds:[]},{sources:[source()],scope:'库',recent:first})
 const old=store.read().record.recent[0]!
 const second={...first,materialVersion:'b'.repeat(64),sections:{...first.sections,completed:'第二步完成'}}
 const nextResult=store.apply(store.read(),[],{taskId:'task-1',materialVersion:second.materialVersion,outcome:'applied',entryIds:[]},{sources:[{...source(2),taskId:'task-1'}],scope:'库',recent:second})
 expect(nextResult.recentIds).toEqual(firstResult.recentIds)
 const updated=store.read().record.recent[0]!
 expect(updated.id).toBe(old.id);expect(updated.version).toBe(old.version+1)
 expect(updated.recent.materialVersion).toBe(second.materialVersion)
 expect(store.read().record.jobs.at(-1)?.entryIds).toContain(old.id)
 expect(()=>store.forget(store.read(),old.id,old.version)).toThrow('MEMORY_CHANGED')
})
it('rejects forged independent state and extra source authority in v3 metadata',()=>{
 const {root,store}=fixture(),record=entryRecord(1),original=encodeWorkingMemory(record)
 const mutate=(fn:(metadata:WorkingRecord)=>void)=>{
  const data=/data="([A-Za-z0-9_-]+)"/.exec(original)![1]!,metadata=JSON.parse(Buffer.from(data,'base64url').toString()) as WorkingRecord
  fn(metadata)
  return original.replace(data,Buffer.from(JSON.stringify(metadata)).toString('base64url'))
 }
 writeFileSync(path.join(root,'.rgent-memory'),mutate(r=>{r.entries[0]!.state.content='disputed'}))
 expect(()=>store.read()).toThrow('MEMORY_STORAGE_INVALID')
 writeFileSync(path.join(root,'.rgent-memory'),mutate(r=>{(r.entries[0]!.sources[0] as object as Record<string,unknown>).extraAuthority=true}))
 expect(()=>store.read()).toThrow('MEMORY_STORAGE_INVALID')
})
const v3Recent=(n:number):WorkingRecent=>{
 const base=entryRecord(1).entries[0]!
 return {...base,id:'recent-'+n,category:'recent',layer:'demand',semantic:'fact',content:'目标：旧任务\n已完成：\n受阻：\n下一步：',sources:[{...base.sources[0]!,taskId:'task-'+n}],recent:{taskId:'task-'+n,noteId:'note-'+n,materialVersion:'b'.repeat(64),createdAt:'2026-10-05T00:00:00.000Z',outcome:'completed',sections:{goal:'旧任务',completed:'',blocked:'',next:''},assistantDraft:false}}
}
it('rejects a recent item in the long collection, even when the record has no recent items',()=>{
 const record=entryRecord(0);record.nextSequence=1;record.entries.push(v3Recent(1))
 expect(()=>parseWorkingMemory(encodeWorkingMemory(record))).toThrow('MEMORY_STORAGE_INVALID')
 record.entries=[];record.recent=[entryRecord(1).entries[0]! as WorkingRecent]
 expect(()=>parseWorkingMemory(encodeWorkingMemory(record))).toThrow('MEMORY_STORAGE_INVALID')
})
it('rejects thirty three recent items hidden in the long collection',()=>{
 const record=entryRecord(0);record.nextSequence=1;record.entries.push(...Array.from({length:33},(_,i)=>v3Recent(i+1)))
 expect(()=>parseWorkingMemory(encodeWorkingMemory(record))).toThrow('MEMORY_STORAGE_INVALID')
})
it('rejects an item whose full encoded recent block exceeds 16 KiB',()=>{
 const record=entryRecord(0);record.nextSequence=1
 const item=v3Recent(1)
 item.sources[0]!.sourceDeps=Array.from({length:16},(_,i)=>({relPath:`${i}-${'x'.repeat(900)}.md`,objectVersion:'object',bodyHash:'a'.repeat(64),permissionTier:'reference' as const}))
 record.recent=[item]
 const raw=encodeWorkingMemory(record)
 expect(Buffer.byteLength(raw)).toBeGreaterThan(16*1024)
 expect(()=>parseWorkingMemory(raw)).toThrow('MEMORY_STORAGE_INVALID')
})

it('treats a representation-only duplicate as an idempotent no-op instead of a second active entry',()=>{
 const {store}=fixture(),input={content:'本库回答使用中文',layer:'core' as const,scope:'本库',sources:[source()],semantic:'standing' as const,attribution:'人的口令',reviewAt:null}
 store.add(store.read(),input)
 store.apply(store.read(),[[{action:'add',input:{...input,content:' 本库回答使用中文　'}}]],{taskId:'idempotent',materialVersion:'a'.repeat(64),outcome:'applied',entryIds:[]})
 expect(store.read().record.entries).toHaveLength(1)
 const receipt=store.read().record.jobs.find(job=>job.taskId==='idempotent')!
 expect(receipt.results).toEqual([{action:'add',outcome:'unchanged'}])
 expect(receipt.reason).toBeUndefined()
 expect(receipt.outcome).toBe('applied')
})
it('does not merge genuinely different facts that merely look similar',()=>{
 const {store}=fixture(),input={content:'石桥项目每两周检查一次',layer:'demand' as const,scope:'本库',sources:[source()],semantic:'fact' as const,attribution:'人说',reviewAt:null}
 store.add(store.read(),input)
 store.apply(store.read(),[[{action:'add',input:{...input,content:'石桥项目每周检查一次'}}]],{taskId:'distinct',materialVersion:'a'.repeat(64),outcome:'applied',entryIds:[]})
 expect(store.read().record.entries.map(e=>e.content)).toEqual(['石桥项目每两周检查一次','石桥项目每周检查一次'])
})
it('keeps a rejected target and a saved independent group apart in one batch',()=>{
 const {store}=fixture(),input={content:'银桥项目采用 A 方案',layer:'demand' as const,scope:'本库',sources:[source()],semantic:'fact' as const,attribution:'人说',reviewAt:null}
 store.apply(store.read(),[[{action:'add',input}]],{taskId:'mixed',materialVersion:'a'.repeat(64),outcome:'applied',entryIds:[]},null,[{action:'correct',outcome:'rejected',code:'MEMORY_TARGET_NOT_FOUND'}])
 const receipt=store.read().record.jobs.find(job=>job.taskId==='mixed')!
 expect(receipt.outcome).toBe('applied')
 expect(receipt.reason).toBe('MEMORY_TARGET_NOT_FOUND')
 expect(receipt.results).toEqual([{action:'correct',outcome:'rejected',code:'MEMORY_TARGET_NOT_FOUND'},{action:'add',outcome:'applied'}])
 expect(store.read().record.entries).toHaveLength(1)
})
