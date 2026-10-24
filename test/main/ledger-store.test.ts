import {mkdtempSync,readFileSync,rmSync,writeFileSync,renameSync,unlinkSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
import {LedgerStore} from '../../src/main/ledger-store.ts'
import {secureFsFor,closeSecureFs} from '../../src/main/secure-fs.ts'
import {appendLedgerChapter} from '../../src/main/host-source.ts'
const roots:string[]=[]
const fixture=()=>{const root=mkdtempSync(path.join(os.tmpdir(),'rgent-ledger-v2-'));roots.push(root);const fs=secureFsFor(root);return {root,fs,store:new LedgerStore(fs,()=>{})}}
afterEach(()=>roots.splice(0).forEach(r=>{closeSecureFs(r);rmSync(r,{recursive:true,force:true})}))
const helloDraft=draftSource('你好')
const markHello=()=>markPrompt(helloDraft.source,{taskId:task.taskId,...helloDraft,expectedText:'你好',promptText:'你好'})
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
it('binds only continuous objects; Finder copy starts new history and replacement starts a new object',()=>{
 const {root,fs,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文')
 const owner=store.owner('a.md');store.prepare('a.md',task)
 writeFileSync(path.join(root,'copy.md'),'正文');expect(store.owner('copy.md').noteId).not.toBe(owner.noteId)
 renameSync(path.join(root,'a.md'),path.join(root,'renamed.md'));expect(store.owner('renamed.md').noteId).toBe(owner.noteId)
 fs.replace('renamed.md','正文','替换正文');const replacement=store.owner('renamed.md');expect(replacement.noteId).not.toBe(owner.noteId);expect(store.historyEntries().some(e=>e.noteId===owner.noteId&&e.state==='orphaned')).toBe(true)
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
import {draftSource} from './draft-fixture.ts'
it('completes only after the matching body receipt and keeps historical answer after a human delete',()=>{
 const {root,fs,store}=fixture(),marked=markHello()
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
 const {root,fs,store}=fixture();const marked=markHello(),answer='较旧完整回答'.repeat(1000)
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
it('reads unregistered history without publishing ownership',()=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文')
 expect(store.page('a.md').records).toEqual([]);expect(store.contexts('a.md')).toEqual([])
 expect(store.registryRevision()).toBeNull()
})
it('does not let a registered query hide a missing descriptor or unknown ledger member',()=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');const owner=store.owner('a.md')
 writeFileSync(path.join(root,'.rgent','ledgers',owner.noteId,'surprise.txt'),'unknown')
 expect(()=>store.page('a.md')).toThrow('LEDGER_REGISTRY_INVALID')
 unlinkSync(path.join(root,'.rgent','ledgers',owner.noteId,'surprise.txt'));unlinkSync(path.join(root,'.rgent','ledgers',owner.noteId,'owner.json'))
 expect(()=>store.page('a.md')).toThrow('LEDGER_REGISTRY_INVALID')
 expect(()=>store.rebuildRegistry()).toThrow('LEDGER_REGISTRY_INVALID')
})
it('recovery preview binds all descriptors and rejects ambiguous task anchors',()=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');store.owner('a.md');store.prepare('a.md',task)
 writeFileSync(path.join(root,'b.md'),'另一篇');store.owner('b.md');store.prepare('b.md',task)
 expect(()=>store.recoveryOwners()).toThrow('LEDGER_RECOVERY_AMBIGUOUS')
})
it('rebuild preserves registered history if a descriptor is missing',()=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');const owner=store.owner('a.md');const before=store.registryRevision()
 unlinkSync(path.join(root,'.rgent','ledgers',owner.noteId,'owner.json'))
 expect(()=>store.rebuildRegistry()).toThrow('LEDGER_REGISTRY_INVALID');expect(store.registryRevision()).toBe(before)
})
it('hashes raw attachment bytes and detects distinct invalid UTF-8 content',()=>{
 const {root,fs,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');fs.createDirectory('a');writeFileSync(path.join(root,'a','binary.bin'),Buffer.from([0x80]))
 const before=store.attachmentEvidence('a.md');writeFileSync(path.join(root,'a','binary.bin'),Buffer.from([0x81]))
 expect(store.attachmentEvidence('a.md')).not.toEqual(before)
})
it('keeps a durable publication intent if owner succeeds and registry fails',()=>{
 const {root,fs,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文')
 const replace=fs.replace.bind(fs);let fail=true
 fs.replace=(p,b,a,id)=>{if(p==='.rgent/registry.json'&&fail){fail=false;throw Error('fixture interruption')}return replace(p,b,a,id)}
 expect(()=>store.owner('a.md')).toThrow('fixture interruption')
 const journal=JSON.parse(readFileSync(path.join(root,'.rgent-lifecycle'),'utf8'));expect(journal.active.kind).toBe('ledger-publication')
 expect(()=>store.page('a.md')).toThrow('LEDGER_REGISTRY_INVALID')
 store.resumePublication(awaitHash(readFileSync(path.join(root,'.rgent-lifecycle'),'utf8')))
 expect(store.page('a.md').ownership).toBe('verified');expect(JSON.parse(readFileSync(path.join(root,'.rgent-lifecycle'),'utf8')).active).toBeNull()
})
it('refuses contradictory registered owner evidence without selecting the latest descriptor',()=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');const owner=store.owner('a.md');const file=path.join(root,'.rgent','ledgers',owner.noteId,'owner.json')
 writeFileSync(file,JSON.stringify({...owner,sequenceCeiling:owner.sequenceCeiling+1}))
 expect(()=>store.recoveryOwners()).toThrow('LEDGER_REGISTRY_INVALID')
 expect(()=>store.owner('a.md')).toThrow('LEDGER_REGISTRY_INVALID')
})
it('keeps finite owner anchors readable beyond 256 task markers without limiting the body',()=>{
 const {root,store}=fixture();const body=Array.from({length:257},(_,n)=>`<!-- rgent:prompt:v1 task-id="task-${n}" -->\n/任务${n}\n\n`).join('')
 writeFileSync(path.join(root,'a.md'),body);expect(()=>store.owner('a.md')).not.toThrow();const owner=store.lookupOwner('a.md')!
 expect(owner.anchors.length).toBeLessThanOrEqual(256);expect(owner.anchorsTruncated).toBe(true);expect(readFileSync(path.join(root,'a.md'),'utf8')).toBe(body)
})
it.each(['registry-receipt','permission-change','owner-missing','registry-conflict'] as const)('verifies actual publication state at %s',stage=>{
 const {root,fs,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');const owner=store.owner('a.md'),old=fs.readSnapshot('a.md'),next=fs.replace('a.md','正文','新正文',old.objectVersion)
 const replace=fs.replace.bind(fs);let fail=true
 fs.replace=(p,b,a,id)=>{if(p==='.rgent-lifecycle'&&fail){const active=JSON.parse(a).active;if(active?.kind==='ledger-publication'&&active.writes[1].receipt){fail=false;throw Error('receipt interruption')}}return replace(p,b,a,id)}
 expect(()=>store.onWrite('a.md',old.objectVersion,next,'新正文')).toThrow('receipt interruption')
 if(stage==='permission-change')writeFileSync(path.join(root,'.rgent-permissions'),JSON.stringify({'a.md':'forbidden'}))
 if(stage==='owner-missing')unlinkSync(path.join(root,'.rgent','ledgers',owner.noteId,'owner.json'))
 if(stage==='registry-conflict')writeFileSync(path.join(root,'.rgent','registry.json'),JSON.stringify({version:1,sequence:0,owners:[]}))
 const revision=awaitHash(readFileSync(path.join(root,'.rgent-lifecycle'),'utf8'))
 if(stage==='registry-receipt'){store.resumePublication(revision);expect(store.lookupOwner('a.md')?.objectVersion).toBe(next)}
 else{expect(()=>store.resumePublication(revision)).toThrow('STALE_RECOVERY');expect(JSON.parse(readFileSync(path.join(root,'.rgent-lifecycle'),'utf8')).active).not.toBeNull()}
})
it('rejects a reconstructed registry with orphan material units',()=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');store.materialUnit('a.md',0,2)
 const file=path.join(root,'.rgent','materials.json'),value=JSON.parse(readFileSync(file,'utf8'));value.units[0].noteId='missing-owner';writeFileSync(file,JSON.stringify(value))
 expect(()=>store.recoveryOwners()).toThrow('LEDGER_REGISTRY_INVALID')
})
it('treats an orphan descriptor as unregistered for the current object',()=>{
 const {root,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');store.owner('a.md');writeFileSync(path.join(root,'.rgent','registry.json'),JSON.stringify({version:1,owners:[],sequence:0}))
 expect(store.page('a.md').ownership).toBe('unregistered');expect(store.owner('a.md').noteId).toBeTruthy()
})
it('decodes unchanged historical records once across pages and invalidates an external change',()=>{
 const {root,fs,store}=fixture();writeFileSync(root+'/a.md','正文');const owner=store.owner('a.md')
 for(let n=1;n<=42;n++)writeFileSync(root+`/.rgent/ledgers/${owner.noteId}/t${n}.json`,JSON.stringify({version:1,noteId:owner.noteId,taskId:'t'+n,revision:1,state:'legacy',bodyStatus:'unable-to-verify',sequence:0,chapter:{...task,taskId:'t'+n}}))
 const original=JSON.parse;let decodes=0
 JSON.parse=((raw,...args)=>{if(typeof raw==='string'&&raw.startsWith('{"version":1,"noteId":'))decodes++;return original(raw,...args)}) as typeof JSON.parse
 try{const first=store.page('a.md');expect(decodes).toBe(84);decodes=0;store.page('a.md',first.cursor);expect(decodes).toBe(0)
 const file=root+`/.rgent/ledgers/${owner.noteId}/t9.json`,changed=original(readFileSync(file,'utf8'));changed.chapter.answer='外部改变';writeFileSync(file,JSON.stringify(changed));expect(store.page('a.md').records.find(r=>r.taskId==='t9')?.chapter?.answer).toBe('外部改变');expect(decodes).toBe(2)
 let reads=0;const read=fs.readSnapshot.bind(fs);fs.readSnapshot=p=>{if(/\/t\d+\.json$/.test(p))reads++;return read(p)};expect(store.contexts('a.md')).toHaveLength(42);expect(reads).toBe(42)
 }finally{JSON.parse=original}
})
it('reports an unverifiable saved body as a read-only gap without changing the record',()=>{
 const {root,store}=fixture();writeFileSync(root+'/a.md','正文');const r=store.prepare('a.md',task),file=root+`/.rgent/ledgers/${r.noteId}/${r.taskId}.json`
 const saved={...r,state:'saved',bodyStatus:'present'};writeFileSync(file,JSON.stringify(saved));const before=readFileSync(file,'utf8')
 const page=store.page('a.md');expect(page.records[0]?.bodyStatus).toBe('unable-to-verify');expect(page.gaps).toContain(task.taskId);expect(readFileSync(file,'utf8')).toBe(before);expect(readFileSync(root+'/a.md','utf8')).toBe('正文')
})
it('preserves sent summary copies through gzip and blocks them after forgetting without rewriting old answers',async()=>{
 const {historicalContextPolicy}=await import('../../src/main/ledger-provenance.ts'),{summaryHash}=await import('../../src/main/summary-cache.ts')
 const {root,store}=fixture();writeFileSync(root+'/a.md','正文')
 const dependency={id:'memory',version:1,basisHashes:['a'.repeat(64)],sourceDeps:[{id:'source',version:1,hash:'b'.repeat(64),relPath:'a.md',kind:'body' as const,taskId:null}]},provenance={...task.provenance,version:2 as const,memoryDeps:[dependency]}
 const sentSummaries=[{step:1,text:'仅审计保留的旧摘要副本',sourceChapterIds:['old'],generators:[{modelId:'old-model',host:'old.test',connection:'old',time:task.startedAt,format:1 as const}],dependencies:[{sourceId:'old',hash:summaryHash('原文'),provenance}]}]
 const r=store.prepare('a.md',{...task,startedAt:'2026-01-01T00:00:00Z',provenance,sentSummaries}),file=root+`/.rgent/ledgers/${r.noteId}/${r.taskId}.json`;writeFileSync(file,JSON.stringify({...r,state:'saved'}))
 const preview=store.maintenancePreview('a.md','compress');expect(store.maintain('a.md','compress',preview.records).success).toEqual([task.taskId]);expect(readFileSync(file,'utf8')).toContain('"codec":"gzip"');expect(store.getRecord('a.md',task.taskId).chapter?.sentSummaries).toEqual(sentSummaries)
 const chapters=store.contexts('a.md');expect(chapters[0]!.text).not.toContain(sentSummaries[0]!.text)
 expect((await historicalContextPolicy('正文',async()=>true,undefined,chapters,async()=>true)).allowedLedgerChapterIds).toEqual([task.taskId])
 expect((await historicalContextPolicy('正文',async()=>true,undefined,chapters,async()=>false)).allowedLedgerChapterIds).toEqual([]);expect(store.getRecord('a.md',task.taskId).chapter?.answer).toBe(task.answer)
 const clear=store.maintenancePreview('a.md','clear');store.maintain('a.md','clear',clear.records);expect(store.getRecord('a.md',task.taskId).chapter).toBeNull()
})

it.each(['valid','wrong-hash','wrong-field','wrong-object','missing-ancestor','cleared-ancestor','cycle'] as const)('verifies complete ledger fragment ancestry and keeps raw history readable: %s',kind=>{
 const verifiedTask={...task,provenance:{...task.provenance,version:2 as const,memoryDeps:[]}}
 const {root,fs,store}=fixture();writeFileSync(root+'/a.md','正文');const original=store.prepare('a.md',{...verifiedTask,taskId:'origin'}),originPath=root+`/.rgent/ledgers/${original.noteId}/origin.json`;writeFileSync(originPath,JSON.stringify({...original,state:'saved'}))
 const chapter=store.contexts('a.md')[0]!;if(chapter.fields?.status!=='valid')throw Error('invalid fixture');const field=chapter.fields.prompt,note=fs.readSnapshot('a.md'),fragment={relPath:'a.md',sessionId:'s',objectVersion:note.objectVersion,revision:awaitHash('正文'),permissionTier:'reference' as const,kind:'ledger' as const,classification:'command' as const,taskId:'origin',start:field.start,end:field.end,text:field.text,hash:awaitHash(field.text),sourceDeps:[],memoryDeps:[]}
 const next=store.prepare('a.md',{...verifiedTask,taskId:'derived',material:{fragments:[fragment],truncated:false}}),nextPath=root+`/.rgent/ledgers/${next.noteId}/derived.json`;writeFileSync(nextPath,JSON.stringify({...next,state:'saved'}))
 const edited=structuredClone(next)
 if(kind==='wrong-hash')edited.chapter!.material!.fragments[0]!.hash='0'.repeat(64)
 if(kind==='wrong-field'){const f=edited.chapter!.material!.fragments[0]!;f.text='伪造';f.hash=awaitHash(f.text)}
 if(kind==='wrong-object')edited.chapter!.material!.fragments[0]!.objectVersion='wrong'
 if(kind==='missing-ancestor')edited.chapter!.material!.fragments[0]!.taskId='absent'
 if(kind==='cycle')edited.chapter!.material!.fragments[0]!.taskId='derived'
 if(kind==='cleared-ancestor')writeFileSync(originPath,JSON.stringify({...original,state:'cleared',chapter:null}))
 if(kind!=='valid'&&kind!=='cleared-ancestor')writeFileSync(nextPath,JSON.stringify({...edited,state:'saved'}))
 if(kind==='valid')expect(store.summaryMaterials('a.md',['derived']).materialIds).toEqual(expect.arrayContaining(['derived/prompt','origin/prompt']))
 else expect(()=>store.summaryMaterials('a.md',['derived'])).toThrow('MEMORY_MATERIAL_UNVERIFIED')
 expect(store.getRecord('a.md','derived').chapter?.answer).toBe(task.answer);expect(store.contexts('a.md').find(c=>c.taskId==='derived')?.summaryDerived).toBe(true);expect(store.page('a.md').records.some(r=>r.taskId==='derived')).toBe(true)
})

it.each(['valid','ambiguous','wrong-text'] as const)('proves the original task of a body adopted copy: %s',kind=>{
 const verifiedTask={...task,provenance:{...task.provenance,version:2 as const,memoryDeps:[]}}
 const {root,fs,store}=fixture(),answer='唯一旧结论';writeFileSync(root+'/a.md',answer+'\n');const original=store.prepare('a.md',{...verifiedTask,taskId:'original',answer}),file=root+`/.rgent/ledgers/${original.noteId}/original.json`;writeFileSync(file,JSON.stringify({...original,state:'saved'}))
 if(kind==='ambiguous'){const duplicate=store.prepare('a.md',{...verifiedTask,taskId:'duplicate',answer});writeFileSync(root+`/.rgent/ledgers/${duplicate.noteId}/duplicate.json`,JSON.stringify({...duplicate,state:'saved'}))}
 const note=fs.readSnapshot('a.md'),text=kind==='wrong-text'?'假的结论':answer,fragment={relPath:'a.md',sessionId:'s',objectVersion:note.objectVersion,revision:awaitHash(answer+'\n'),permissionTier:'reference' as const,kind:'body' as const,classification:'ai' as const,taskId:'original',start:0,end:text.length,text,hash:awaitHash(text),sourceDeps:[],memoryDeps:[]},derived=store.prepare('a.md',{...verifiedTask,taskId:'derived',answer:'新派生回答',material:{fragments:[fragment],truncated:false}});writeFileSync(root+`/.rgent/ledgers/${derived.noteId}/derived.json`,JSON.stringify({...derived,state:'saved'}))
 if(kind==='valid')expect(store.summaryMaterials('a.md',['derived']).materialIds).toContain('original/prompt');else expect(()=>store.summaryMaterials('a.md',['derived'])).toThrow('MEMORY_MATERIAL_UNVERIFIED')
 expect(store.getRecord('a.md','derived').chapter?.answer).toBe('新派生回答')
})

it.each(['prepare','complete','clear'] as const)('preserves a legal terminal task revision when %s needs another version',action=>{
 const {root,fs,store}=fixture(),marked=markHello(),body=upsertAiAnswer(marked,{taskId:task.taskId,answer:task.answer})
 writeFileSync(path.join(root,'a.md'),body);const original=store.prepare('a.md',task),file=`.rgent/ledgers/${original.noteId}/${task.taskId}.json`,disk=fs.readSnapshot(file)
 const terminal={...original,...(action==='clear'?{state:'legacy' as const}:{}),revision:Number.MAX_SAFE_INTEGER};fs.replace(file,disk.bytes.toString(),JSON.stringify(terminal),disk.objectVersion)
 const before=fs.readSnapshot(file)
 expect(store.getRecord('a.md',task.taskId).revision).toBe(Number.MAX_SAFE_INTEGER)
 if(action==='prepare')expect(()=>store.prepare('a.md',{...task,answer:'修改回答'},Number.MAX_SAFE_INTEGER)).toThrow('LEDGER_RECORD_LIMIT')
 else if(action==='complete')expect(()=>store.complete('a.md',task.taskId,awaitHash(body))).toThrow('LEDGER_RECORD_LIMIT')
 else{const preview=store.maintenancePreview('a.md','clear'),result=store.maintain('a.md','clear',preview.records);expect(result.success).toEqual([]);expect(result.failed).toEqual([task.taskId])}
 const after=fs.readSnapshot(file);expect(after.bytes).toEqual(before.bytes);expect(after.objectVersion).toBe(before.objectVersion);expect(store.getRecord('a.md',task.taskId).revision).toBe(Number.MAX_SAFE_INTEGER)


})

it('resolves an active owner without scanning the ledger/history directories',()=>{
 const {root,fs,store}=fixture();writeFileSync(path.join(root,'a.md'),'正文');const owner=store.owner('a.md')
 const list=vi.spyOn(fs,'list')
 try {
  expect(store.lookupOwner('a.md')?.noteId).toBe(owner.noteId)
  expect(list).not.toHaveBeenCalled()
 } finally { list.mockRestore() }
})
