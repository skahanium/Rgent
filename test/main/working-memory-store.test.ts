import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path'
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
