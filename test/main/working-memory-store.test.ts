import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path'
import {it,expect,afterEach} from 'vitest'
import {WorkingMemoryStore} from '../../src/main/working-memory-store.ts'
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

import {encodeWorkingMemory,type WorkingRecord} from '../../src/main/working-memory-store.ts'
const entryRecord=(count:number,long=false):WorkingRecord=>({version:2,identity:'fixture',revision:1,nextSequence:count,watermark:0,forgotten:[],jobs:[],entries:Array.from({length:count},(_,i)=>({id:long?'E'.repeat(253)+String(i).padStart(3,'0'):'entry-'+i,version:1,content:'事实'+i,layer:'demand',scope:'库',sources:[{...source(i+1),revision:'',taskMaterialHash:null,materialId:long?'M'.repeat(253)+String(i).padStart(3,'0'):'material-'+i}],semantic:'fact',attribution:'人',reviewAt:null,status:'active',reason:null,updatedAt:'2026-01-01T00:00:00Z',updateBasis:{kind:'manual',id:'manual',version:1}}))})
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
