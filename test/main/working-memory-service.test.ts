import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path'
import {it,expect,vi} from 'vitest'
import {VaultSession} from '../../src/main/vault.ts';import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {serializeStoredVault} from '../../src/main/notes-fs.ts';import {markPrompt,upsertAiAnswer} from '../../src/main/host-source.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}));vi.mock('../../src/main/watch.ts',async importOriginal=>({...await importOriginal<typeof import('../../src/main/watch.ts')>(),watchVault:()=>()=>{}}))
it('keeps local memory diagnosis accessible and refuses reset when material registry is damaged',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-material-diagnosis-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'材料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{await vault.memoryMutation(s=>s.initialize());await mkdir(path.join(root,'.rgent'),{recursive:true});await writeFile(path.join(root,'.rgent','registry.json'),'{bad');const service=new WorkingMemoryService(vault,()=>null),before=vault.memorySnapshot()
  const view=await service.view();expect(view.materialStatus).toBe('invalid');expect(view.learning).toBeUndefined();expect(view.entries).toEqual([]);await expect(service.reset(vault.memoryDiagnostic())).rejects.toThrow('LEDGER_REGISTRY_INVALID');expect(vault.memorySnapshot().raw).toBe(before.raw)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('separates source proof from meaning, tolerates unrelated app edits and preserves local diagnosis without models',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-working-service-')),root=path.join(base,'vault');await mkdir(root)
 await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));const marked=markPrompt('/以后用中文',{taskId:'task',range:{start:0,end:6},expectedText:'/以后用中文',promptText:'以后用中文'})
 await writeFile(path.join(root,'a.md'),marked);const vault=new VaultSession(base,vi.fn());vault.restore()
 try{let note=await vault.readOpened('a.md');await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:new Date().toISOString(),status:'completed',prompt:'以后用中文',answer:'好的'})
  const body=upsertAiAnswer(note.content,{taskId:'task',answer:'好的'});const saved=await vault.write('a.md',body,note.revision,note);await vault.ledgerComplete('a.md','task',saved.revision)
  const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForPrompt('a.md','task')
  await vault.memoryMutation(store=>store.add(store.read(),{content:'以后用中文',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'人的口令',reviewAt:null}))
  note=await vault.read('a.md');await vault.write('a.md',note.content+'\n无关的正文修改',note.revision,note)
  expect((await service.entries())[0]?.status).toBe('active');expect((await service.view()).entries).toHaveLength(1)
  const preview=await vault.ledgerMaintenancePreview('a.md','clear');await vault.ledgerMaintenanceCommit('a.md','clear',preview.records)
  expect((await service.entries())[0]?.status).toBe('active')
  await writeFile(path.join(root,'.rgent-permissions'),JSON.stringify({'a.md':'forbidden'}))
  expect((await service.entries())[0]?.status).toBe('paused')
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('a manually remembered adopted answer retains its original external dependencies',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-adopted-source-')),root=path.join(base,'vault');await mkdir(root)
 await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),markPrompt('/查证',{taskId:'task',range:{start:0,end:3},expectedText:'/查证',promptText:'查证'}));await writeFile(path.join(root,'b.md'),'获准外篇原材料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  const origin=await vault.readOpened('a.md'),external=await vault.readOpened('b.md')
  await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:new Date().toISOString(),status:'completed',prompt:'查证',answer:'依据外篇的公开结论',provenance:{version:1,model:{provider:'custom',modelId:'model',endpointHost:'model.test'},scope:['a.md','b.md'],sources:[{relPath:'b.md',objectVersion:external.objectVersion,bodyHash:bodyFingerprint(external.content)}],tools:[]}})
  const saved=await vault.write('a.md',upsertAiAnswer(origin.content,{taskId:'task',answer:'依据外篇的公开结论'}),origin.revision,origin);await vault.ledgerComplete('a.md','task',saved.revision)
  const note=await vault.read('a.md'),adopted=note.content.replace(/<!-- rgent:ai:v1[^\n]*-->\n/g,'');await vault.write('a.md',adopted,note.revision,note)
  const current=await vault.read('a.md'),service=new WorkingMemoryService(vault,()=>null),start=current.content.indexOf('依据外篇的公开结论')
  const source=await service.manualSource({...current,sessionId:current.sessionId,relPath:'a.md',kind:'body',start,end:start+'依据外篇的公开结论'.length})
  expect(source.classification).toBe('adopted-ai');expect(source.sourceDeps[0]?.relPath).toBe('b.md')
  await vault.write('b.md','外篇依据已改变',external.revision,external)
  expect(await service.verifySource(source)).toBe(false)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
import {bodyFingerprint} from '../../src/main/ledger-provenance.ts'
it.each(['dependency','unrelated','review'] as const)('rechecks the involved memory after asynchronous source proof: %s',async changed=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-memory-read-race-')),root=path.join(base,'vault');await mkdir(root)
 await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'可核验的来源材料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  const note=await vault.readOpened('a.md'),service=new WorkingMemoryService(vault,()=>null)
  const source=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:note.content.length})
  const add=async(content:string,deps:{id:string;version:number}[]=[])=>vault.memoryMutation(store=>store.add(store.read(),{content,layer:'demand',scope:'本库',sources:[{...source,id:content,memoryDeps:deps}],semantic:'fact',attribution:'来源笔记',reviewAt:null}))
  const parent=await add('parent'),middle=await add('middle',[{id:parent.id,version:parent.version}]),leaf=await add('leaf',[{id:middle.id,version:middle.version}]),unrelated=await add('unrelated')
  const started=Date.now();let now=started
  if(changed==='review'){
   await vault.memoryMutation(store=>store.edit(store.read(),leaf.id,leaf.version,{reviewAt:new Date(started+1000).toISOString()}))
   vi.spyOn(Date,'now').mockImplementation(()=>now)
  }
  const verify=service.verifySource.bind(service);let committed=false
  vi.spyOn(service,'verifySource').mockImplementation(async s=>{
   const valid=await verify(s)
   if(s.id==='parent'&&!committed){committed=true
    if(changed==='review')now=started+2000
    else{const target=changed==='dependency'?parent:unrelated
     await vault.memoryMutation(store=>store.edit(store.read(),target.id,target.version,{content:target.content+' changed'}))
    }
   }
   return valid
  })
  const entries=await service.entries([leaf.id]);expect(committed).toBe(true)
  expect(entries[0]?.status).toBe(changed==='dependency'?'paused':changed==='review'?'review':'active')
 }finally{vi.restoreAllMocks();vault.dispose();await rm(base,{recursive:true,force:true})}
})

it.each(['unit','task','malformed'] as const)('keeps local memory and refuses reset and advance against untrusted %s material history',async kind=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-material-controls-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'材料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{await vault.memoryMutation(s=>s.initialize())
  if(kind==='task')await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:new Date().toISOString(),status:'completed',prompt:'问',answer:'答'})
  else await vault.materialUnit('a.md',0,2)
  if(kind==='malformed')await writeFile(path.join(root,'.rgent','materials.json'),'{bad')
  else{const file=path.join(root,'.rgent','registry.json'),registry=JSON.parse(await readFile(file,'utf8'));registry.sequence=0;for(const owner of registry.owners){owner.sequenceCeiling=0;await writeFile(path.join(root,'.rgent','ledgers',owner.noteId,'owner.json'),JSON.stringify(owner))}await writeFile(file,JSON.stringify(registry))}
  const before=vault.memorySnapshot(),service=new WorkingMemoryService(vault,()=>null),view=await service.view()
  expect(view.materialStatus).toBe('invalid');expect(view.learning).toBeUndefined();expect(view.entries).toEqual([])
  await expect(service.reset(vault.memoryDiagnostic())).rejects.toThrow('LEDGER_REGISTRY_INVALID');await expect(service.advance(0,before)).rejects.toThrow('LEDGER_REGISTRY_INVALID');expect(vault.memorySnapshot().raw).toBe(before.raw)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

it.each(['reset','advance'] as const)('rechecks material validity inside the queued %s control operation',async operation=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-material-queue-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'材料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{await vault.memoryMutation(s=>s.initialize());await vault.materialUnit('a.md',0,2);const service=new WorkingMemoryService(vault,()=>null),before=vault.memorySnapshot()
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),blocked=new Promise<void>(resolve=>release=resolve)
  const mutation=vault.memoryMutation(async()=>{entered();await blocked;await writeFile(path.join(root,'.rgent','materials.json'),'{bad')});await started
  const control=operation==='reset'?service.reset(vault.memoryDiagnostic()):service.advance(1,before)
  // Attach the rejection handler before releasing the earlier queue operation.
  const rejected=expect(control).rejects.toThrow('LEDGER_REGISTRY_INVALID');release();await mutation;await rejected;expect(vault.memorySnapshot().raw).toBe(before.raw)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

it.each(['empty','verified','invalid'] as const)('preserves retirement and real %s material diagnosis when an unknown old JSON memory causes an early invalid view',async materialStatus=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-retirement-view-')),root=path.join(base,'vault'),unknown=JSON.stringify({version:99,entries:[]});await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'材料');await writeFile(path.join(root,'.rgent-memory'),unknown)
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{await vault.readOpened('a.md');expect(vault.memoryDiagnosis()).toBe('MEMORY_RETIREMENT_FAILED')
  if(materialStatus!=='empty')await vault.materialUnit('a.md',0,2)
  if(materialStatus==='invalid')await writeFile(path.join(root,'.rgent','materials.json'),'{bad')
  expect(vault.materialState().status).toBe(materialStatus)
  const view=await new WorkingMemoryService(vault,()=>null).view();expect(view.status).toBe('invalid');expect(view.reason).toBe('MEMORY_STORAGE_INVALID');expect(view.retirementFailure).toBe('MEMORY_RETIREMENT_FAILED');expect(view.materialStatus).toBe(materialStatus);expect(view.learning).toBeUndefined();expect(await readFile(path.join(root,'.rgent-memory'),'utf8')).toBe(unknown)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('restores uniquely verified sources only after explicit copied-library association',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-memory-recovery-')),root=path.join(base,'vault'),copy=path.join(base,'copy');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root))
 const body=markPrompt('/以后用中文',{taskId:'restore-task',range:{start:0,end:6},expectedText:'/以后用中文',promptText:'以后用中文'});await writeFile(path.join(root,'a.md'),body)
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const note=await vault.readOpened('a.md');await vault.ledgerPrepare('a.md',{taskId:'restore-task',startedAt:new Date().toISOString(),status:'completed',prompt:'以后用中文',answer:'好的'})
  const saved=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'restore-task',answer:'好的'}),note.revision,note);await vault.ledgerComplete('a.md','restore-task',saved.revision)
  const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForPrompt('a.md','restore-task')
  await vault.memoryMutation(store=>store.add(store.read(),{content:'以后用中文',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'人的口令',reviewAt:null}))
  const invalidBodySource={...source,id:source.id,kind:'body' as const,text:'好的',hash:createHash('sha256').update('好的').digest('hex'),start:(await vault.read('a.md')).content.indexOf('好的'),end:(await vault.read('a.md')).content.indexOf('好的')+2}
  await vault.memoryMutation(store=>store.add(store.read(),{content:'不能恢复的未采纳来源',layer:'core',scope:'本库',sources:[invalidBodySource],semantic:'standing',attribution:'旧来源',reviewAt:null}))
  const {cp}=await import('node:fs/promises');await cp(root,copy,{recursive:true});await writeFile(path.join(base,'vault.json'),serializeStoredVault(copy));vault.restore()
  const recovered=new WorkingMemoryService(vault,()=>null);expect((await recovered.entries())[0].status).toBe('paused')
  const preview=await vault.ledgerRecoveryPreview('restore');expect(preview.rows[0].sources[0].status).toBe('verified');expect(preview.rows[0].sources.filter(s=>s.id===source.id).map(s=>s.status)).toEqual(['verified','paused'])
  let result=await vault.ledgerRecoveryCommit(preview.id);while(result.status==='pending')result=await vault.ledgerRecoveryResume(result.revision!)
  const invalid=(await recovered.entries()).find(e=>e.content==='不能恢复的未采纳来源')!;expect(invalid.status).toBe('paused');expect(invalid.sources[0].objectVersion).not.toBe((await vault.read('a.md')).objectVersion);expect((await recovered.entries())[0].status).toBe('active');expect((await recovered.entries())[0].sources[0].objectVersion).toBe((await vault.read('a.md')).objectVersion)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('blocks derived summary coverage after forgetting a raw task prompt with no memory dependency while retaining original history',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-forgotten-summary-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),markPrompt('/以后用中文',{taskId:'task',range:{start:0,end:6},expectedText:'/以后用中文',promptText:'以后用中文'}))
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  const note=await vault.readOpened('a.md');await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:'以后用中文',answer:'历史回答保持'})
  const saved=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task',answer:'历史回答保持'}),note.revision,note);await vault.ledgerComplete('a.md','task',saved.revision)
  const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForPrompt('a.md','task'),coverage=service as WorkingMemoryService & {summaryAllowed?:(relPath:string,taskIds:readonly string[])=>Promise<boolean>}
  expect(source.memoryDeps).toEqual([])
  await writeFile(path.join(root,'b.md'),markPrompt('/未遗忘材料',{taskId:'task-other',range:{start:0,end:6},expectedText:'/未遗忘材料',promptText:'未遗忘材料'}))
  const other=await vault.readOpened('b.md');await vault.ledgerPrepare('b.md',{taskId:'task-other',startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:'未遗忘材料',answer:'另一个历史'})
  const otherSaved=await vault.write('b.md',upsertAiAnswer(other.content,{taskId:'task-other',answer:'另一个历史'}),other.revision,other);await vault.ledgerComplete('b.md','task-other',otherSaved.revision)
  const otherSource=await service.sourceForPrompt('b.md','task-other'),validEntry=await vault.memoryMutation(s=>s.add(s.read(),{content:'未遗忘有效记忆',layer:'demand',scope:'本库',sources:[otherSource],semantic:'fact',attribution:'人的口令',reviewAt:null}))
  expect(await coverage.summaryAllowed?.('b.md',['task-other'])).toBe(true)
  const entry=await vault.memoryMutation(s=>s.add(s.read(),{content:'以后用中文',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'人的口令',reviewAt:null}))
  expect(await (coverage.summaryAllowed?.('a.md',['task'])??Promise.resolve(true))).toBe(true)
  await vault.memoryMutation(s=>s.forget(s.read(),entry.id,entry.version))
  expect(await (coverage.summaryAllowed?.('a.md',['task'])??Promise.resolve(true))).toBe(false)
  expect((await vault.ledgerRecord('a.md','task')).chapter?.answer).toBe('历史回答保持');expect((await vault.ledgerContexts('a.md'))[0]?.fields).toMatchObject({prompt:{text:'以后用中文'}})
  await vault.memoryMutation(s=>s.advance(s.read(),source.sequence));expect(vault.memorySnapshot().record.forgotten).toEqual([])
  expect(await coverage.summaryAllowed?.('b.md',['task-other'])).toBe(true);expect((await service.entries([validEntry.id]))[0]?.status).toBe('active')
  expect(await (coverage.summaryAllowed?.('a.md',['task'])??Promise.resolve(true))).toBe(false)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('blocks summary copies derived from forgotten body material UUIDs without allocating a new material unit',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-body-summary-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));const raw='正文材料。\n\n/说明';await writeFile(path.join(root,'a.md'),markPrompt(raw,{taskId:'task-body',range:{start:raw.indexOf('/'),end:raw.length},expectedText:'/说明',promptText:'说明'}))
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  const note=await vault.readOpened('a.md'),fragment={...note,relPath:'a.md',permissionTier:'reference' as const,kind:'body' as const,classification:'human' as const,taskId:null,start:0,end:5,text:'正文材料。',hash:createHash('sha256').update('正文材料。').digest('hex'),sourceDeps:[],memoryDeps:[]}
  await vault.ledgerPrepare('a.md',{taskId:'task-body',startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:'说明',answer:'依据正文的历史结论',material:{fragments:[fragment],truncated:false}})
  const saved=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task-body',answer:'依据正文的历史结论'}),note.revision,note);await vault.ledgerComplete('a.md','task-body',saved.revision)
  const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForFragment(fragment);expect(source.materialId).not.toContain('task-body/prompt');expect(source.memoryDeps).toEqual([])
  const entry=await vault.memoryMutation(s=>s.add(s.read(),{content:'正文材料形成的记忆',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'来源笔记',reviewAt:null}))
  expect(await service.summaryAllowed('a.md',['task-body'])).toBe(true);await vault.memoryMutation(s=>s.forget(s.read(),entry.id,entry.version));const before=await readFile(path.join(root,'.rgent/materials.json'),'utf8')
  expect(await service.summaryAllowed('a.md',['task-body'])).toBe(false);expect(await readFile(path.join(root,'.rgent/materials.json'),'utf8')).toBe(before)
  await writeFile(path.join(root,'.rgent/materials.json'),JSON.stringify({version:1,units:[]}));expect(await service.summaryAllowed('a.md',['task-body'])).toBe(false);await writeFile(path.join(root,'.rgent/materials.json'),before)
  expect((await vault.ledgerRecord('a.md','task-body')).chapter?.answer).toBe('依据正文的历史结论');expect((await vault.readOpened('a.md')).content).toContain('正文材料。')
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

it.each(['ledger-forget','body-forget','ledger-watermark','body-watermark','adopted-forget','adopted-watermark'] as const)('blocks a real three-generation %s material chain',async mode=>{
 const kind=mode.startsWith('ledger')?'ledger':'body'
 const {TaskMaterialTracker}=await import('../../src/main/host-material.ts')
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-summary-chain-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'正文\n\n')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  const save=async(taskId:string,material?:import('../../src/main/host-material.ts').SentTaskMaterial)=>{
   let note=await vault.readOpened('a.md'),body=note.content+'/口令'+taskId+'\n\n';const start=note.content.length;body=markPrompt(body,{taskId,range:{start,end:start+('/口令'+taskId).length},expectedText:'/口令'+taskId,promptText:'口令'+taskId});await vault.write('a.md',body,note.revision,note);note=await vault.read('a.md')
   await vault.ledgerPrepare('a.md',{taskId,startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:'口令'+taskId,answer:'回答'+taskId,material})
   const saved=await vault.write('a.md',upsertAiAnswer(note.content,{taskId,answer:'回答'+taskId}),note.revision,note);await vault.ledgerComplete('a.md',taskId,saved.revision)
   if(mode.startsWith('adopted')){const current=await vault.read('a.md');await vault.write('a.md',current.content.replace('<!-- rgent:ai:v1 task-id=\"'+taskId+'\" -->',''),current.revision,current)}
  }
  const inherited=async(taskId:string)=>{const note=await vault.read('a.md'),chapters=await vault.ledgerContexts('a.md'),tracker=new TaskMaterialTracker()
   if(kind==='ledger')tracker.context(note.content,[{kind:'ledger',sourceId:taskId}],{...note,relPath:'a.md'},undefined,chapters)
   else{const start=note.content.indexOf('回答'+taskId);if(mode.startsWith('adopted')){const {compile}=await import('../../src/markdown/index.ts');const index=compile(note.content).index.blocks.findIndex(b=>b.range.start<=start&&b.range.end>=start+('回答'+taskId).length);tracker.context(note.content,[{kind:'body',sourceId:'body-'+(index+1)}],{...note,relPath:'a.md'},undefined,chapters)}else tracker.body(note.content,{start,end:start+('回答'+taskId).length},{...note,relPath:'a.md'})}
   tracker.commit();expect(tracker.snapshot().fragments.every(f=>f.taskId===taskId&&f.kind===kind)).toBe(true);expect(tracker.snapshot().fragments.length).toBeGreaterThan(0);return tracker.snapshot()
  }
  await save('T0');const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForPrompt('a.md','T0');const entry=await vault.memoryMutation(s=>s.add(s.read(),{content:'原始口令材料',layer:'core',scope:'本库',sources:[source],semantic:'fact',attribution:'人的口令',reviewAt:null}))
  await save('T1',await inherited('T0'));await save('T2',await inherited('T1'));expect((await vault.ledgerRecord('a.md','T2')).chapter?.provenance?.version??1).toBe(1)
  expect((await vault.summaryMaterials('a.md',['T2'])).materialIds).toEqual(expect.arrayContaining(['T0/prompt','T1/prompt','T2/prompt']));expect(await service.summaryAllowed('a.md',['T2'])).toBe(true);
  if(mode==='ledger-forget'){const child=await vault.ledgerRecord('a.md','T2'),file=path.join(root,'.rgent','ledgers',child.noteId,'T2.json'),original=await readFile(file,'utf8'),bad=JSON.parse(original);bad.chapter.material.fragments[0].hash='0'.repeat(64);await writeFile(file,JSON.stringify(bad));expect(await service.summaryAllowed('a.md',['T2'])).toBe(false);await writeFile(file,original)}
  await vault.memoryMutation(s=>s.forget(s.read(),entry.id,entry.version));if(mode.endsWith('forget'))expect(await service.summaryAllowed('a.md',['T2'])).toBe(false)
  await vault.memoryMutation(s=>s.advance(s.read(),source.sequence));expect(vault.memorySnapshot().record.forgotten).toEqual([]);expect((await vault.ledgerRecord('a.md','T2')).sequence).toBeGreaterThan(source.sequence);expect(await service.summaryAllowed('a.md',['T2'])).toBe(false)
  expect((await vault.ledgerRecord('a.md','T0')).chapter?.answer).toBe('回答T0');expect((await vault.read('a.md')).content).toContain('回答T2')
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

it('saves a real Vault answer with the complete material JSON boundary',async()=>{
 const {TaskMaterialTracker}=await import('../../src/main/host-material.ts')
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-material-boundary-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));const raw='x'.repeat(262000),marked=markPrompt(raw+'\n\n/说明',{taskId:'edge',range:{start:raw.length+2,end:raw.length+5},expectedText:'/说明',promptText:'说明'});await writeFile(path.join(root,'a.md'),marked)
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  const note=await vault.read('a.md'),binding={relPath:'a.md',sessionId:note.sessionId,objectVersion:note.objectVersion,revision:note.revision},probe=new TaskMaterialTracker(1024*1024);probe.body(note.content,{start:0,end:raw.length},binding);probe.commit();const overhead=Buffer.byteLength(JSON.stringify(probe.snapshot().fragments[0]))-raw.length
  const tracker=new TaskMaterialTracker();tracker.body(note.content,{start:0,end:262142-overhead},binding);tracker.commit()
  await vault.ledgerPrepare('a.md',{taskId:'edge',startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:'说明',answer:'边界完整保稿',material:tracker.snapshot()})
  const saved=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'edge',answer:'边界完整保稿'}),note.revision,note);await vault.ledgerComplete('a.md','edge',saved.revision)
  const record=await vault.ledgerRecord('a.md','edge');expect(record.state).toBe('saved');expect(record.chapter?.answer).toBe('边界完整保稿');expect(record.chapter?.material?.truncated).toBe(true);expect(Buffer.byteLength(JSON.stringify(record.chapter?.material))).toBeLessThanOrEqual(256*1024)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
