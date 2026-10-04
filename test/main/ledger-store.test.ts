import {mkdtempSync,readFileSync,rmSync,writeFileSync,renameSync,unlinkSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {LedgerStore} from '../../src/main/ledger-store.ts'
import {secureFsFor,closeSecureFs} from '../../src/main/secure-fs.ts'
import {appendLedgerChapter} from '../../src/main/host-source.ts'
const roots:string[]=[]
const fixture=()=>{const root=mkdtempSync(path.join(os.tmpdir(),'rgent-ledger-v2-'));roots.push(root);const fs=secureFsFor(root);return {root,fs,store:new LedgerStore(fs,()=>{})}}
afterEach(()=>roots.splice(0).forEach(r=>{closeSecureFs(r);rmSync(r,{recursive:true,force:true})}))
const task={taskId:'task-1',startedAt:'2026-10-03T00:00:00.000Z',status:'completed' as const,prompt:'你好',answer:'回答',provenance:{version:1 as const,model:{provider:'custom',modelId:'fixture',endpointHost:'localhost'},scope:['a.md'],sources:[],tools:[]}}
it('does not treat missing material registry as sequence zero when history exists',()=>{
 const {root,fs,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');store.prepare('a.md',task)
 unlinkSync(path.join(root,'.rgent','registry.json'))
 expect(()=>store.materialCeiling()).toThrow('LEDGER_REGISTRY_INVALID')
})
it('clears one legacy record without replacing a shared original archive',()=>{
 const {root,store}=fixture();const source=appendLedgerChapter(appendLedgerChapter('正文\n',task),{...task,taskId:'task-2',answer:'另一个回答'})
 writeFileSync(path.join(root,'a.md'),source);store.migrate('a.md');const archive=store.legacyRaw('a.md'),preview=store.maintenancePreview('a.md','clear'),record=preview.records.find(r=>r.taskId===task.taskId)!
 expect(preview.warning).toContain('共享');store.maintain('a.md','clear',[record]);expect(store.legacyRaw('a.md')).toBe(archive);expect(store.getRecord('a.md','task-2').chapter?.answer).toBe('另一个回答')
})
it('clears a shared archive only with the whole preview and matching archive revision',()=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),appendLedgerChapter(appendLedgerChapter('正文\n',task),{...task,taskId:'task-2'}));store.migrate('a.md');const preview=store.maintenancePreview('a.md','clear')
 expect(preview.archive).toBeDefined();expect(preview.warning).toContain('全部');const result=store.maintain('a.md','clear',preview.records,preview.archive);expect(result.archiveCleared).toBe(true);expect(store.legacyRaw('a.md')).toBe('<!-- rgent:ledger:v1 -->\n')
})
it('binds only continuous objects; Finder copy starts new history and replacement is unknown',()=>{
 const {root,fs,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文')
 const owner=store.owner('a.md');store.prepare('a.md',task)
 writeFileSync(path.join(root,'copy.md'),'正文');expect(store.owner('copy.md').noteId).not.toBe(owner.noteId)
 renameSync(path.join(root,'a.md'),path.join(root,'renamed.md'));expect(store.owner('renamed.md').noteId).toBe(owner.noteId)
 fs.replace('renamed.md','正文','替换正文');expect(()=>store.owner('renamed.md')).toThrow('LEDGER_OWNERSHIP_UNVERIFIED')
})
it('copies and verifies legacy exact bytes before stripping tail; opaque chapters remain opaque',()=>{
 const {root,fs,store}=fixture();const source='\ufeff正文\r\n\n<!-- rgent:prompt:v1 task-id="keep" -->\r'+appendLedgerChapter('',task).replaceAll('\n','\r\n')
 writeFileSync(path.join(root,'a.md'),source);const before=fs.readSnapshot('a.md');const migrated=store.migrate('a.md')
 expect(migrated.body).toBe(source.slice(0,source.indexOf('<!-- rgent:ledger:v1 -->')))
 expect(fs.readSnapshot('a.md').bytes.toString()).toBe(migrated.body)
 expect(store.legacyRaw('a.md')).toBe(source.slice(source.indexOf('<!-- rgent:ledger:v1 -->')))
 expect(store.page('a.md').records[0]?.chapter?.answer).toBe('回答')
 expect(store.migrate('a.md').body).toBe(migrated.body);expect(before.objectVersion).not.toBe(fs.readSnapshot('a.md').objectVersion)
})
it('keeps a durable checkpoint if body save fails, without refilling later human edits',()=>{
 const {root,fs,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文')
 const checkpoint=store.prepare('a.md',task);expect(checkpoint.state).toBe('pending-body')
 expect(store.prepare('a.md',task).taskId).toBe(task.taskId)
 expect(readFileSync(path.join(root,'a.md'),'utf8')).toBe('正文')
 const old=fs.readSnapshot('a.md'),id=fs.replace('a.md','正文','人改正文',old.objectVersion);store.onWrite('a.md',old.objectVersion,id,'人改正文')
 expect(store.page('a.md').records[0]?.state).toBe('pending-body')
 expect(readFileSync(path.join(root,'a.md'),'utf8')).toBe('人改正文')
 expect(()=>store.prepare('a.md',{...task,answer:'different'})).toThrow('LEDGER_TASK_CONFLICT')
})
it('bad registry stays diagnostic rather than empty and can rebuild descriptors without guessing ownership',()=>{
 const {root,fs,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');const id=store.owner('a.md').noteId
 const disk=fs.readSnapshot('.rgent/registry.json');fs.replace('.rgent/registry.json',disk.bytes.toString(),'{bad',disk.objectVersion)
 expect(()=>store.owner('a.md')).toThrow('LEDGER_REGISTRY_INVALID')
 store.rebuildRegistry();expect(store.owner('a.md').noteId).toBe(id)
})
import {markPrompt,upsertAiAnswer} from '../../src/main/host-source.ts'
it('completes only after the matching body receipt and keeps historical answer after a human delete',()=>{
 const {root,fs,store}=fixture(),marked=markPrompt('/你好',{taskId:task.taskId,range:{start:0,end:3},expectedText:'/你好',promptText:'你好'})
 writeFileSync(path.join(root,'a.md'),marked);store.prepare('a.md',task)
 const before=fs.readSnapshot('a.md'),body=upsertAiAnswer(marked,{taskId:task.taskId,answer:task.answer}),after=fs.replace('a.md',marked,body,before.objectVersion);store.onWrite('a.md',before.objectVersion,after,body)
 const revision=(awaitHash(body));expect(store.complete('a.md',task.taskId,revision).state).toBe('saved')
 const next=fs.replace('a.md',body,'人删除了回答',after);store.onWrite('a.md',after,next,'人删除了回答');expect(store.page('a.md').records[0]?.chapter?.answer).toBe('回答');expect(readFileSync(path.join(root,'a.md'),'utf8')).toBe('人删除了回答')
})
import {createHash} from 'node:crypto'
const awaitHash=(s:string)=>createHash('sha256').update(s).digest('hex')
it('paginates a fixed history horizon while new tasks arrive and continues long records within the wire cap',()=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文')
 for(let n=0;n<22;n++)store.prepare('a.md',{...task,taskId:`task-${String(n).padStart(3,'0')}`})
 const first=store.page('a.md');expect(first.records.map(r=>r.taskId)).toEqual(Array.from({length:20},(_,n)=>`task-${String(21-n).padStart(3,'0')}`))
 store.prepare('a.md',{...task,taskId:'task-new'})
 const last=store.page('a.md',first.cursor);expect(last.records.map(r=>r.taskId)).toEqual(['task-001','task-000'])
 store.prepare('a.md',{...task,taskId:'task-long',answer:'长'.repeat(120000)})
 let cursor:string|null=null,parts:Buffer[]=[]
 do{const page=store.wirePage('a.md',cursor);expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128*1024);if(page.chunk)parts.push(Buffer.from(page.chunk.data,'base64'));cursor=page.cursor;if(!cursor?.startsWith('raw:'))break}while(cursor)
 expect(JSON.parse(Buffer.concat(parts).toString()).chapter.answer).toBe('长'.repeat(120000))
})
it('compresses in place only after roundtrip and net-saving checks, and clears without touching the body',()=>{
 const {root,fs,store}=fixture();const marked=markPrompt('/你好',{taskId:task.taskId,range:{start:0,end:3},expectedText:'/你好',promptText:'你好'}),answer='较旧完整回答'.repeat(1000)
 writeFileSync(path.join(root,'a.md'),marked);store.prepare('a.md',{...task,startedAt:'2020-01-01T00:00:00Z',answer})
 const body=upsertAiAnswer(marked,{taskId:task.taskId,answer}),old=fs.readSnapshot('a.md'),next=fs.replace('a.md',marked,body,old.objectVersion);store.onWrite('a.md',old.objectVersion,next,body);store.complete('a.md',task.taskId,awaitHash(body))
 const preview=store.maintenancePreview('a.md','compress');expect(preview.records).toHaveLength(1)
 const result=store.maintain('a.md','compress',preview.records);expect(result.success).toEqual([task.taskId]);expect(result.savedBytes).toBeGreaterThan(0)
 expect(store.getRecord('a.md',task.taskId).chapter?.answer).toBe(answer)
 const clear=store.maintenancePreview('a.md','clear');store.maintain('a.md','clear',clear.records)
 expect(store.getRecord('a.md',task.taskId).chapter).toBeNull();expect(fs.readSnapshot('a.md').bytes.toString()).toBe(body)
})

it.each(['malformed','null','sequence','owner','duplicate'] as const)('refuses an untrusted material registry: %s',change=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');store.materialUnit('a.md',0,2)
 const file=path.join(root,'.rgent','materials.json'),materials=JSON.parse(readFileSync(file,'utf8'))
 if(change==='sequence')materials.units[0].sequence=2
 if(change==='owner')materials.units[0].noteId='unknown'
 if(change==='duplicate')materials.units.push({...materials.units[0]})
 writeFileSync(file,change==='malformed'?'{bad':change==='null'?'null':JSON.stringify(materials))
 expect(store.materialState()).toEqual({status:'invalid',reason:'LEDGER_REGISTRY_INVALID'});expect(()=>store.materialCeiling()).toThrow('LEDGER_REGISTRY_INVALID')
})
it.each(['unit','task'] as const)('checks independent %s sequences even when registry and descriptors claim zero',kind=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');if(kind==='unit')store.materialUnit('a.md',0,2);else store.prepare('a.md',task)
 const file=path.join(root,'.rgent','registry.json'),registry=JSON.parse(readFileSync(file,'utf8'));registry.sequence=0
 for(const owner of registry.owners){owner.sequenceCeiling=0;writeFileSync(path.join(root,'.rgent','ledgers',owner.noteId,'owner.json'),JSON.stringify(owner))}writeFileSync(file,JSON.stringify(registry))
 expect(store.materialState()).toEqual({status:'invalid',reason:'LEDGER_REGISTRY_INVALID'});expect(()=>store.materialCeiling()).toThrow('LEDGER_REGISTRY_INVALID')
})
it('verifies positive independent task sequences and legacy zero without changing any bytes',()=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');store.prepare('a.md',task);store.materialUnit('a.md',0,2);const before=readFileSync(path.join(root,'.rgent','registry.json'),'utf8')
 expect(store.materialState()).toEqual({status:'verified',sequence:2});expect(readFileSync(path.join(root,'.rgent','registry.json'),'utf8')).toBe(before)
})

it.each(['unit','task'] as const)('refuses new %s allocation rather than reusing a sequence after the registry ceiling is lowered',kind=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');store.prepare('a.md',task)
 const file=path.join(root,'.rgent','registry.json'),registry=JSON.parse(readFileSync(file,'utf8'));registry.sequence=0
 for(const owner of registry.owners){owner.sequenceCeiling=0;writeFileSync(path.join(root,'.rgent','ledgers',owner.noteId,'owner.json'),JSON.stringify(owner))}const corrupt=JSON.stringify(registry);writeFileSync(file,corrupt)
 expect(()=>kind==='unit'?store.materialUnit('a.md',0,2):store.prepare('a.md',{...task,taskId:'new-task'})).toThrow('LEDGER_REGISTRY_INVALID');expect(readFileSync(file,'utf8')).toBe(corrupt)
})

it('keeps a large exact legacy archive eligible for sequence verification without the new-task size cap',()=>{
 const {root,store}=fixture(),tail='<!-- rgent:ledger:v1 -->\n'+ '旧'.repeat(800000);writeFileSync(path.join(root,'a.md'),'正文\n'+tail);store.migrate('a.md')
 expect(store.legacyRaw('a.md')).toBe(tail);expect(store.materialState()).toEqual({status:'verified',sequence:0});expect(store.materialUnit('a.md',0,2).sequence).toBe(1)
})

it('refuses a new saved task with zero sequence instead of accepting it as legacy history',()=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');const record=store.prepare('a.md',task),file=path.join(root,'.rgent','ledgers',record.noteId,record.taskId+'.json');record.sequence=0;writeFileSync(file,JSON.stringify(record))
 expect(store.materialState()).toEqual({status:'invalid',reason:'LEDGER_REGISTRY_INVALID'})
})
it('refuses a directory hidden behind a reserved legacy record filename',()=>{
 const {root,fs,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');const owner=store.owner('a.md');fs.createDirectory('.rgent/ledgers/'+owner.noteId+'/legacy.json')
 expect(store.materialState()).toEqual({status:'invalid',reason:'LEDGER_REGISTRY_INVALID'})
})
