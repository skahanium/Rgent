import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,rename,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path'
import {it,expect,vi} from 'vitest'
import {VaultSession} from '../../src/main/vault.ts';import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {serializeStoredVault} from '../../src/main/notes-fs.ts';import {markPrompt,upsertAiAnswer} from '../../src/main/host-source.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}));vi.mock('../../src/main/watch.ts',async importOriginal=>({...await importOriginal<typeof import('../../src/main/watch.ts')>(),watchVault:()=>()=>{}}))
it('keeps an original human command independent of co-occurring task dependencies',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-command-independence-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),markPrompt('/以后本库回答使用中文',{taskId:'independent',range:{start:0,end:11},expectedText:'/以后本库回答使用中文',promptText:'以后本库回答使用中文'}));await writeFile(path.join(root,'b.md'),'外篇资料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const note=await vault.readOpened('a.md'),external=await vault.readOpened('b.md');const {bodyFingerprint}=await import('../../src/main/ledger-provenance.ts')
  await vault.ledgerPrepare('a.md',{taskId:'independent',startedAt:new Date().toISOString(),status:'completed',prompt:'以后本库回答使用中文',answer:'保存回执',provenance:{version:2,model:{provider:'custom',modelId:'m',endpointHost:'example.test'},scope:['a.md','b.md'],sources:[{relPath:'b.md',objectVersion:external.objectVersion,bodyHash:bodyFingerprint(external.content)}],tools:[],memoryDeps:[{id:'unrelated-old',version:1,basisHashes:['a'.repeat(64)],sourceDeps:[{id:'old-source',version:1,hash:'b'.repeat(64),relPath:'b.md',kind:'body',taskId:null}]}]}})
  const written=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'independent',answer:'保存回执'}),note.revision,note);await vault.ledgerComplete('a.md','independent',written.revision)
  const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForPrompt('a.md','independent')
  expect(source.sourceDeps).toEqual([]);expect(source.memoryDeps).toEqual([])
  await writeFile(path.join(root,'.rgent-permissions'),JSON.stringify({'b.md':'forbidden'}));expect(await service.verifySource(source)).toBe(true)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
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
it('persists controlled same-note source bindings for long and recent memory across restart',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-memory-binding-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),markPrompt('/以后用中文',{taskId:'task',range:{start:0,end:6},expectedText:'/以后用中文',promptText:'以后用中文'}))
 let vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  let note=await vault.readOpened('a.md');await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:new Date().toISOString(),status:'completed',prompt:'以后用中文',answer:'好的',provenance:{version:2,model:{provider:'custom',modelId:'fixture',endpointHost:'example.test'},scope:['a.md'],sources:[],tools:[],memoryDeps:[]}})
  const saved=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task',answer:'好的'}),note.revision,note);await vault.ledgerComplete('a.md','task',saved.revision)
  const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForPrompt('a.md','task'),material=await service.savedMaterial('a.md','task')
  const standing=await vault.memoryMutation(store=>store.add(store.read(),{content:'以后用中文',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'人',reviewAt:null}))
  const recent={taskId:'task',noteId:material.noteId!,materialVersion:material.materialVersion,createdAt:new Date().toISOString(),outcome:'completed' as const,sections:{goal:'继续写作',completed:'完成首轮',blocked:'',next:'核对'},assistantDraft:false}
  const result=await vault.memoryMutation(store=>store.apply(store.read(),[],{taskId:'task',materialVersion:material.materialVersion,outcome:'applied',entryIds:[]},{sources:[source],scope:'本库',recent}))
  note=await vault.read('a.md');await vault.write('a.md',note.content+'\n无关旁注',note.revision,note)
  expect(vault.memorySnapshot().record.entries.find(e=>e.id===standing.id)?.version).toBe(1)
  vault.dispose();vault=new VaultSession(base,vi.fn());vault.restore()
  const reopened=new WorkingMemoryService(vault,()=>null),rows=await reopened.entries()
  expect(rows.find(e=>e.id===standing.id)?.status).toBe('active')
  expect(rows.find(e=>e.id===result.recentIds[0])?.status).toBe('active')
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it.each(['append','body-change','dep-change','dep-same','external'] as const)('renews only proven controlled body bindings across restart: %s',async mode=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-body-binding-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'原始材料');await writeFile(path.join(root,'b.md'),'依赖材料')
 let vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  const service=new WorkingMemoryService(vault,()=>null),note=await vault.readOpened('a.md'),external=await vault.readOpened('b.md'),source=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4})
  if(mode==='dep-change'||mode==='dep-same')source.sourceDeps=[{relPath:'b.md',objectVersion:external.objectVersion,bodyHash:bodyFingerprint(external.content),permissionTier:'reference'}]
  const entry=await vault.memoryMutation(store=>store.add(store.read(),{content:'源事实',layer:'demand',scope:'库',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
  if(mode==='external'){
   await writeFile(path.join(root,'replacement.md'),note.content);await rename(path.join(root,'replacement.md'),path.join(root,'a.md'))
   const replaced=await vault.read('a.md');expect(replaced.objectVersion).not.toBe(note.objectVersion)
   await vault.write('a.md',replaced.content+'\n旁注',replaced.revision,replaced)
  }else{
   const rel=mode==='dep-change'||mode==='dep-same'?'b.md':'a.md',current=await vault.read(rel)
   await vault.write(rel,mode==='body-change'?'替换材料':mode==='dep-same'?current.content:current.content+'\n旁注',current.revision,current)
  }
  vault.dispose();vault=new VaultSession(base,vi.fn());vault.restore()
  const checked=await new WorkingMemoryService(vault,()=>null).entries()
  expect(checked.find(e=>e.id===entry.id)?.status).toBe(mode==='append'||mode==='dep-same'?'active':'paused')
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('keeps a committed note when memory binding CAS fails and reports a separate visible diagnosis',async()=>{
 const {memoryErrorText}=await import('../../src/shared/memory-errors.ts')
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-binding-diagnosis-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'原始材料')
 const vault=new VaultSession(base,vi.fn());vault.restore();let restore:(()=>void)|undefined
 try{const service=new WorkingMemoryService(vault,()=>null),note=await vault.readOpened('a.md'),source=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4})
  await vault.memoryMutation(store=>store.add(store.read(),{content:'事实',layer:'demand',scope:'库',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
  await vault.memoryMutation(store=>{const spy=vi.spyOn(store,'rebindCommittedWrite').mockImplementation(()=>{throw Error('synthetic failure')});restore=()=>spy.mockRestore()})
  await vault.write('a.md',note.content+'\n旁注',note.revision,note)
  expect((await vault.read('a.md')).content).toContain('旁注')
  const view=await service.view();expect(view.bindingFailure).toBe('MEMORY_SOURCE_REBIND_FAILED');expect(view.retirementFailure).toBeUndefined();expect(memoryErrorText(view.bindingFailure!)).toContain('笔记已保存')
  restore?.();restore=undefined
  const current=await vault.read('a.md');await vault.write('a.md',current.content+'\n第二条旁注',current.revision,current)
  expect((await service.view()).bindingFailure).toBeUndefined()
 }finally{restore?.();vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('continues a cleared ledger source through a controlled same-note save and restart',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-cleared-binding-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),markPrompt('/以后用中文',{taskId:'task',range:{start:0,end:6},expectedText:'/以后用中文',promptText:'以后用中文'}))
 let vault=new VaultSession(base,vi.fn());vault.restore()
 try{let note=await vault.readOpened('a.md');await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:new Date().toISOString(),status:'completed',prompt:'以后用中文',answer:'好的'});const saved=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task',answer:'好的'}),note.revision,note);await vault.ledgerComplete('a.md','task',saved.revision)
  const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForPrompt('a.md','task'),entry=await vault.memoryMutation(store=>store.add(store.read(),{content:'中文约定',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'人',reviewAt:null}))
  const preview=await vault.ledgerMaintenancePreview('a.md','clear');await vault.ledgerMaintenanceCommit('a.md','clear',preview.records)
  expect((await service.entries()).find(e=>e.id===entry.id)?.status).toBe('active')
  note=await vault.read('a.md');await vault.write('a.md',note.content+'\n无关旁注',note.revision,note)
  vault.dispose();vault=new VaultSession(base,vi.fn());vault.restore()
  expect((await new WorkingMemoryService(vault,()=>null).entries()).find(e=>e.id===entry.id)?.status).toBe('active')
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
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-retirement-view-')),root=path.join(base,'vault'),unknown=JSON.stringify({version:99,entries:[]});await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'材料');if(materialStatus!=='empty'){const seed=new VaultSession(base,vi.fn());seed.restore();try{await seed.readOpened('a.md');await seed.materialUnit('a.md',0,2)}finally{seed.dispose()}}await writeFile(path.join(root,'.rgent-memory'),unknown)
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{await vault.readOpened('a.md');expect(vault.memoryDiagnosis()).toBe('MEMORY_RETIREMENT_FAILED')
  // Existing material diagnostics predate the damaged memory; never allocate from invalid controls.
  if(materialStatus==='invalid')await writeFile(path.join(root,'.rgent','materials.json'),'{bad')
  expect(vault.materialState().status).toBe(materialStatus)
  const view=await new WorkingMemoryService(vault,()=>null).view();expect(view.status).toBe('invalid');expect(view.reason).toBe('MEMORY_STORAGE_INVALID');expect(view.retirementFailure).toBe('MEMORY_RETIREMENT_FAILED');expect(view.materialStatus).toBe(materialStatus);expect(view.learning).toBeUndefined();expect(await readFile(path.join(root,'.rgent-memory'),'utf8')).toBe(unknown)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('restores uniquely verified sources only after explicit copied-library association',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-memory-recovery-')),root=path.join(base,'vault'),copy=path.join(base,'copy');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root))
 const body=markPrompt('/以后用中文',{taskId:'restore-task',range:{start:0,end:6},expectedText:'/以后用中文',promptText:'以后用中文'});await writeFile(path.join(root,'a.md'),body)
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const note=await vault.readOpened('a.md');await vault.ledgerPrepare('a.md',{taskId:'restore-task',startedAt:new Date().toISOString(),status:'completed',prompt:'以后用中文',answer:'好的',provenance:{version:2,model:{provider:'custom',modelId:'fixture',endpointHost:'example.test'},scope:['a.md'],sources:[],tools:[],memoryDeps:[]}})
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
  const note=await vault.readOpened('a.md');await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:'以后用中文',provenance:{version:2,model:{provider:'custom',modelId:'fixture',endpointHost:'example.test'},scope:['a.md'],sources:[],tools:[],memoryDeps:[]},answer:'历史回答保持'})
  const saved=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task',answer:'历史回答保持'}),note.revision,note);await vault.ledgerComplete('a.md','task',saved.revision)
  const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForPrompt('a.md','task'),coverage=service as WorkingMemoryService & {summaryAllowed?:(relPath:string,taskIds:readonly string[])=>Promise<boolean>}
  expect(source.memoryDeps).toEqual([])
  await writeFile(path.join(root,'b.md'),markPrompt('/未遗忘材料',{taskId:'task-other',range:{start:0,end:6},expectedText:'/未遗忘材料',promptText:'未遗忘材料'}))
  const other=await vault.readOpened('b.md');await vault.ledgerPrepare('b.md',{taskId:'task-other',startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:'未遗忘材料',provenance:{version:2,model:{provider:'custom',modelId:'fixture',endpointHost:'example.test'},scope:['a.md'],sources:[],tools:[],memoryDeps:[]},answer:'另一个历史'})
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
  await vault.ledgerPrepare('a.md',{taskId:'task-body',startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:'说明',provenance:{version:2,model:{provider:'custom',modelId:'fixture',endpointHost:'example.test'},scope:['a.md'],sources:[],tools:[],memoryDeps:[]},answer:'依据正文的历史结论',material:{fragments:[fragment],truncated:false}})
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
   await vault.ledgerPrepare('a.md',{taskId,startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:'口令'+taskId,answer:'回答'+taskId,provenance:{version:2,model:{provider:'custom',modelId:'fixture',endpointHost:'example.test'},scope:['a.md'],sources:[],tools:[],memoryDeps:[]},material})
   const saved=await vault.write('a.md',upsertAiAnswer(note.content,{taskId,answer:'回答'+taskId}),note.revision,note);await vault.ledgerComplete('a.md',taskId,saved.revision)
   if(mode.startsWith('adopted')){const current=await vault.read('a.md');await vault.write('a.md',current.content.replace('<!-- rgent:ai:v1 task-id=\"'+taskId+'\" -->',''),current.revision,current)}
  }
  const inherited=async(taskId:string)=>{const note=await vault.read('a.md'),chapters=await vault.ledgerContexts('a.md'),tracker=new TaskMaterialTracker()
   if(kind==='ledger')tracker.context(note.content,[{kind:'ledger',sourceId:taskId}],{...note,relPath:'a.md'},undefined,chapters)
   else{const start=note.content.indexOf('回答'+taskId);if(mode.startsWith('adopted')){const {compile}=await import('../../src/markdown/index.ts');const index=compile(note.content).index.blocks.findIndex(b=>b.range.start<=start&&b.range.end>=start+('回答'+taskId).length);tracker.context(note.content,[{kind:'body',sourceId:'body-'+(index+1)}],{...note,relPath:'a.md'},undefined,chapters)}else tracker.body(note.content,{start,end:start+('回答'+taskId).length},{...note,relPath:'a.md'})}
   tracker.commit();expect(tracker.snapshot().fragments.every(f=>f.taskId===taskId&&f.kind===kind)).toBe(true);expect(tracker.snapshot().fragments.length).toBeGreaterThan(0);return tracker.snapshot()
  }
  await save('T0');const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForPrompt('a.md','T0');const entry=await vault.memoryMutation(s=>s.add(s.read(),{content:'原始口令材料',layer:'core',scope:'本库',sources:[source],semantic:'fact',attribution:'人的口令',reviewAt:null}))
  await save('T1',await inherited('T0'));await save('T2',await inherited('T1'));expect((await vault.ledgerRecord('a.md','T2')).chapter?.provenance?.version).toBe(2)
  expect((await vault.summaryMaterials('a.md',['T2'])).materialIds).toEqual(expect.arrayContaining(['T0/prompt','T1/prompt','T2/prompt']));expect(await service.summaryAllowed('a.md',['T2'])).toBe(true);
  if(mode==='ledger-forget'){const child=await vault.ledgerRecord('a.md','T2'),file=path.join(root,'.rgent','ledgers',child.noteId,'T2.json'),original=await readFile(file,'utf8'),bad=JSON.parse(original);bad.chapter.material.fragments[0].hash='0'.repeat(64);await writeFile(file,JSON.stringify(bad));expect(await service.summaryAllowed('a.md',['T2'])).toBe(false);await writeFile(file,original)
   const ancestor=await vault.ledgerRecord('a.md','T0'),ancestorFile=path.join(root,'.rgent','ledgers',ancestor.noteId,'T0.json'),ancestorRaw=await readFile(ancestorFile,'utf8'),moved=JSON.parse(ancestorRaw);moved.chapter.answer=moved.chapter.prompt;moved.chapter.prompt='无关新口令';await writeFile(ancestorFile,JSON.stringify(moved));expect(await service.summaryAllowed('a.md',['T2'])).toBe(false);expect((await vault.ledgerRecord('a.md','T0')).chapter?.answer).toBe('口令T0');await writeFile(ancestorFile,ancestorRaw);expect(await service.summaryAllowed('a.md',['T2'])).toBe(true)
  }
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

it('body material continuity follows unique unchanged text while substantive edits get a new identity',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-material-identity-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'原始材料\n')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const service=new WorkingMemoryService(vault,()=>null);let note=await vault.readOpened('a.md');const first=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4})
  await vault.write('a.md','开头\n原始材料\n',note.revision,note);note=await vault.read('a.md');const moved=await service.manualSource({...note,relPath:'a.md',kind:'body',start:3,end:7});expect(moved.materialId).toBe(first.materialId)
  await vault.write('a.md','开头\n修改材料\n',note.revision,note);note=await vault.read('a.md');const changed=await service.manualSource({...note,relPath:'a.md',kind:'body',start:3,end:7});expect(changed.materialId).not.toBe(first.materialId);expect(changed.sequence).toBeGreaterThan(first.sequence)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('ledger evidence moved from command to answer pauses memory and cannot recover command classification',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-ledger-classification-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),markPrompt('/长期要求',{taskId:'classified',range:{start:0,end:5},expectedText:'/长期要求',promptText:'长期要求'}))
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const note=await vault.readOpened('a.md');await vault.ledgerPrepare('a.md',{taskId:'classified',startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:'长期要求',answer:'好'});const saved=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'classified',answer:'好'}),note.revision,note);await vault.ledgerComplete('a.md','classified',saved.revision)
  const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForPrompt('a.md','classified');await vault.memoryMutation(s=>s.add(s.read(),{content:'长期要求',layer:'core',scope:'库',sources:[source],semantic:'standing',attribution:'人',reviewAt:null}))
  const record=await vault.ledgerRecord('a.md','classified'),file=path.join(root,'.rgent','ledgers',record.noteId,'classified.json');record.chapter!.prompt='无关';record.chapter!.answer='长期要求';await writeFile(file,JSON.stringify(record))
  expect(await service.verifySource(source)).toBe(false);expect(await service.verifySource(source,{unique:true,record:async()=>record,contexts:async()=>await vault.ledgerContexts('a.md')})).toBe(false);expect((await service.entries())[0]?.status).toBe('paused')
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('review expiration is projected without modifying the authoritative record on read',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-review-state-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'原始材料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const note=await vault.readOpened('a.md'),service=new WorkingMemoryService(vault,()=>null),source=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4});await vault.memoryMutation(s=>s.add(s.read(),{content:'待复核事实',layer:'demand',scope:'库',sources:[source],semantic:'fact',attribution:'人',reviewAt:'2020-01-01T00:00:00Z'}));const before=service.snapshot().raw;expect((await service.entries())[0]?.status).toBe('review');expect(service.snapshot().raw).toBe(before)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

it('watermark merges covered blocks independently of active material references and later collects unreferenced units',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-material-gc-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'共享材料\n无引用材料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const service=new WorkingMemoryService(vault,()=>null),note=await vault.readOpened('a.md'),s=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4}),unreferenced=await vault.materialUnit('a.md',5,10)
  const first=await vault.memoryMutation(store=>store.add(store.read(),{content:'遗忘条目',layer:'demand',scope:'库',sources:[s],semantic:'fact',attribution:'人',reviewAt:null})),retained=await vault.memoryMutation(store=>store.add(store.read(),{content:'有效条目',layer:'demand',scope:'库',sources:[s],semantic:'fact',attribution:'人',reviewAt:null}))
  await vault.memoryMutation(store=>store.forget(store.read(),first.id,1));await service.advance(unreferenced.sequence,service.snapshot());expect(service.snapshot().record.forgotten).toEqual([])
  let units=JSON.parse(await readFile(path.join(root,'.rgent','materials.json'),'utf8')).units;expect(units.map((u:any)=>u.id)).toContain(s.materialId);expect(units.map((u:any)=>u.id)).toContain(unreferenced.id);expect(vault.materialCeiling()).toBe(unreferenced.sequence)
  await vault.memoryMutation(store=>store.forget(store.read(),retained.id,1));await service.advance(unreferenced.sequence,service.snapshot());units=JSON.parse(await readFile(path.join(root,'.rgent','materials.json'),'utf8')).units;expect(units.map((u:any)=>u.id)).toEqual(expect.arrayContaining([s.materialId,unreferenced.id]));expect(vault.materialCeiling()).toBe(unreferenced.sequence)
  const current=await vault.read('a.md');await vault.write('a.md','真正新内容',current.revision,current);await service.advance(unreferenced.sequence,service.snapshot());units=JSON.parse(await readFile(path.join(root,'.rgent','materials.json'),'utf8')).units;expect(units.map((u:any)=>u.id)).not.toContain(s.materialId);expect(units.map((u:any)=>u.id)).not.toContain(unreferenced.id)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it.each(['hash','legacy','moved-excerpt'] as const)('same-position genuinely new body material is allowed while known forgotten ancestry stays blocked (%s)',async mode=>{
 const {TaskMaterialTracker}=await import('../../src/main/host-material.ts')
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-material-summary-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'落点\n');await writeFile(path.join(root,'b.md'),'原始材料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const service=new WorkingMemoryService(vault,()=>null);let b=await vault.readOpened('b.md');const s=await service.manualSource({...b,relPath:'b.md',kind:'body',start:0,end:4});if(mode==='moved-excerpt'){await vault.write('b.md',b.content+'\n其他材料',b.revision,b);b=await vault.read('b.md')}const e=await vault.memoryMutation(store=>store.add(store.read(),{content:'原材料记忆',layer:'demand',scope:'库',sources:[s],semantic:'fact',attribution:'人',reviewAt:null}))
  const save=async(taskId:string)=>{const tracker=new TaskMaterialTracker();tracker.body(b.content,{start:0,end:mode==='moved-excerpt'?b.content.length:4},{...b,relPath:'b.md'});tracker.commit();let note=await vault.readOpened('a.md');const body=markPrompt(note.content+'\n/'+taskId,{taskId,range:{start:note.content.length+1,end:note.content.length+taskId.length+2},expectedText:'/'+taskId,promptText:taskId});await vault.write('a.md',body,note.revision,note);note=await vault.read('a.md');await vault.ledgerPrepare('a.md',{taskId,startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:taskId,answer:'派生回答',provenance:{version:2,model:{provider:'custom',modelId:'fixture',endpointHost:'example.test'},scope:['a.md','b.md'],sources:[],tools:[],memoryDeps:[]},material:tracker.snapshot()});const saved=await vault.write('a.md',upsertAiAnswer(note.content,{taskId,answer:'派生回答'}),note.revision,note);await vault.ledgerComplete('a.md',taskId,saved.revision)}
  await save('old-task');if(mode==='moved-excerpt'){await vault.write('b.md','开头\n'+b.content,b.revision,b);b=await vault.read('b.md')}if(mode==='legacy'){const file=path.join(root,'.rgent','materials.json'),data=JSON.parse(await readFile(file,'utf8'));delete data.units[0].hash;await writeFile(file,JSON.stringify(data))}
  await service.forget({sessionId:service.context().sessionId,revision:service.snapshot().revision,objectVersion:service.snapshot().objectVersion,id:e.id,version:1});if(mode==='legacy')await expect(service.manualSource({...b,relPath:'b.md',kind:'body',start:0,end:4})).rejects.toThrow('MEMORY_MATERIAL_UNVERIFIED');await vault.write('b.md','新证材料',b.revision,b);b=await vault.read('b.md');const newer=await service.manualSource({...b,relPath:'b.md',kind:'body',start:0,end:4});expect(newer.materialId).not.toBe(s.materialId);await save('new-task')
  expect(await service.summaryAllowed('a.md',['old-task'])).toBe(false);expect(await service.summaryAllowed('a.md',['new-task'])).toBe(true)
  await service.advance(s.sequence,service.snapshot());expect(await service.summaryAllowed('a.md',['old-task'])).toBe(false);expect(await service.summaryAllowed('a.md',['new-task'])).toBe(true);expect((await vault.ledgerRecord('a.md','old-task')).chapter?.answer).toBe('派生回答')
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

it.each(['body','ledger'] as const)('measures 1000 %s sources through startup, recall, dispatch and management without full-history source scans',async kind=>{
 const {encodeWorkingMemory}=await import('../../src/main/working-memory-store.ts')
 const {secureFsFor}=await import('../../src/main/secure-fs.ts'),{recallMemory,createMemoryUsePermit}=await import('../../src/main/memory-use.ts')
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-memory-cost-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),markPrompt('/以后用中文',{taskId:'task',range:{start:0,end:6},expectedText:'/以后用中文',promptText:'以后用中文'}))
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{let note=await vault.readOpened('a.md');await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:'2026-01-01T00:00:00Z',status:'completed',prompt:'以后用中文',answer:'好'});const written=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task',answer:'好'}),note.revision,note)
  await vault.ledgerComplete('a.md','task',written.revision);note=await vault.read('a.md');const service=new WorkingMemoryService(vault,()=>null),start=note.content.indexOf('以后用中文'),source=kind==='ledger'?await service.sourceForPrompt('a.md','task'):await service.manualSource({...note,relPath:'a.md',kind:'body',start,end:start+5})
  if(kind==='ledger'){const first=await vault.ledgerRecord('a.md','task');for(let i=1;i<1000;i++){const r=structuredClone(first);r.taskId='task-'+i;r.sequence=i+1;r.chapter!.taskId=r.taskId;await writeFile(path.join(root,'.rgent','ledgers',first.noteId,r.taskId+'.json'),JSON.stringify(r))}
   const file=path.join(root,'.rgent','registry.json'),registry=JSON.parse(await readFile(file,'utf8'));registry.sequence=1000;registry.owners[0].sequenceCeiling=1000;await writeFile(file,JSON.stringify(registry));await writeFile(path.join(root,'.rgent','ledgers',first.noteId,'owner.json'),JSON.stringify(registry.owners[0]))}
  const record:import('../../src/main/working-memory-store.ts').WorkingRecord={version:3,recent:[],identity:'cost',revision:1,nextSequence:kind==='ledger'?1000:source.sequence,watermark:0,forgotten:[],jobs:[],entries:Array.from({length:1000},(_,i)=>({id:'entry-'+i,version:1,category:'long',state:{source:'verified',content:'current',enabled:true,capacity:'ready'},status:'active',reason:null,content:'中文要求第'+i+'项',layer:'demand',scope:'库',semantic:'standing',attribution:'人',reviewAt:null,updatedAt:'2026-01-01T00:00:00Z',updateBasis:{kind:'manual',id:'cost',version:1},sources:[{...source,id:'source-'+i,...(kind==='ledger'?{taskId:i?'task-'+i:'task',materialId:(i?'task-'+i:'task')+'/prompt',sequence:i+1}:{})}]}))};await writeFile(path.join(root,'.rgent-memory'),encodeWorkingMemory(record))
  const codec=await import('../../src/main/ledger-codec.ts'),decode=vi.spyOn(codec,'decodeLedgerBytes'),bodyDecode=vi.spyOn(vault,'read');const fs=secureFsFor(root),read=fs.readSnapshot.bind(fs);let reads=0,bytes=0,ledgerReads=0,bodyReads=0;vi.spyOn(fs,'readSnapshot').mockImplementation(p=>{const r=read(p);reads++;bytes+=r.bytes.length;if(p.startsWith('.rgent/ledgers/')&&!p.endsWith('/owner.json'))ledgerReads++;if(p.endsWith('.md'))bodyReads++;return r});const contexts=vi.spyOn(vault,'ledgerContexts'),measure=async(label:string,op:()=>unknown|Promise<unknown>)=>{reads=0;bytes=0;ledgerReads=0;bodyReads=0;decode.mockClear();bodyDecode.mockClear();const memoryStart=process.memoryUsage(),t=performance.now();await op();const ms=Number((performance.now()-t).toFixed(2)),memoryEnd=process.memoryUsage()
   const decodedBodies=await Promise.all(bodyDecode.mock.results.filter(r=>r.type==='return').map(r=>r.value)),bodyDecodedBytes=decodedBodies.reduce((n,r)=>n+Buffer.byteLength(r.content),0),ledgerDecodedBytes=decode.mock.results.reduce((n,r)=>n+(r.type==='return'?Buffer.byteLength(r.value):0),0)
   console.info('Memory source cost',JSON.stringify({kind,label,ms,reads,bytes,ledgerReads,bodyReads,ledgerDecodes:decode.mock.calls.length,bodyDecodes:bodyDecode.mock.calls.length,ledgerDecodedBytes,bodyDecodedBytes,memoryBytes:{start:{heapUsed:memoryStart.heapUsed,rss:memoryStart.rss},end:{heapUsed:memoryEnd.heapUsed,rss:memoryEnd.rss},delta:{heapUsed:memoryEnd.heapUsed-memoryStart.heapUsed,rss:memoryEnd.rss-memoryStart.rss}}}))}
  await measure('startup',()=>service.snapshot());await measure('recall',async()=>{const all=await service.entries();expect(all.filter(e=>e.status==='active')).toHaveLength(1000);expect(recallMemory(all,'中文要求','').demand.length).toBeGreaterThan(0)})
  const receiver={provider:'custom' as const,modelId:'model',baseURL:'https://example.test/v1',apiKey:'test',contextTokens:32768},permit=await createMemoryUsePermit({context:()=>service.context(),config:()=>({enabled:true,revision:1}),entries:ids=>service.entries(ids)},receiver,'中文要求','');permit.stage(permit.recall.demand.map(e=>e.id));permit.markSent()
  await measure('dispatch-selected',()=>permit.assertCurrent(receiver));await measure('update-candidates-selected',async()=>{const {updateMemoryCandidates}=await import('../../src/main/memory-use.ts');const selected=updateMemoryCandidates(service.snapshot().record.entries,'中文要求','');expect(selected).toHaveLength(16);expect(await service.consolidationCandidates([source],selected.map(e=>e.id))).toHaveLength(16)});await measure('management',()=>service.view());expect(contexts).not.toHaveBeenCalled()
  await writeFile(path.join(root,'.rgent-permissions'),JSON.stringify({'a.md':'forbidden'}));await expect(permit.assertCurrent(receiver)).rejects.toThrow('MEMORY_CHANGED')
 }finally{vi.restoreAllMocks();vault.dispose();await rm(base,{recursive:true,force:true})}
},30000)
it('damaged material control bytes do not block ordinary note saving or become empty controls',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-material-save-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'原始材料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const service=new WorkingMemoryService(vault,()=>null),note=await vault.readOpened('a.md');await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4});const file=path.join(root,'.rgent','materials.json'),bad='{bad material controls';await writeFile(file,bad)
  const saved=await vault.write('a.md','原始材料\n普通正文已保存',note.revision,note);expect((await vault.read('a.md')).revision).toBe(saved.revision);expect((await vault.read('a.md')).content).toContain('普通正文已保存');expect(await readFile(file,'utf8')).toBe(bad);expect(vault.materialState().status).toBe('invalid')
  await expect(vault.materialUnit('a.md',0,4)).rejects.toThrow('LEDGER_REGISTRY_INVALID');await expect(service.advance(1,service.snapshot())).rejects.toThrow('LEDGER_REGISTRY_INVALID');expect(await readFile(file,'utf8')).toBe(bad)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it.each(['queued','running','interrupted'] as const)('watermark keeps material referenced by a %s job and retains its blocking explanation',async outcome=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-material-job-reference-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'原始材料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const unit=await vault.materialUnit('a.md',0,4),service=new WorkingMemoryService(vault,()=>null);await vault.memoryMutation(s=>{const basis=s.read();basis.record.nextSequence=unit.sequence;return s.receipt(basis,{taskId:'protected',materialVersion:'a'.repeat(64),entryIds:[],outcome,...(outcome==='interrupted'?{reason:'MEMORY_INTERRUPTED'}:{})})});await service.advance(unit.sequence,service.snapshot())
  expect(JSON.parse(await readFile(path.join(root,'.rgent','materials.json'),'utf8')).units[0]?.id).toBe(unit.id);expect(service.snapshot().record.jobs[0]?.outcome).toBe(outcome)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

it('larger body fragments inherit known forgotten subunits and their oldest age after watermark merging',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-material-contained-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'原始材料');const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const service=new WorkingMemoryService(vault,()=>null);let note=await vault.readOpened('a.md');const old=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4}),entry=await vault.memoryMutation(s=>s.add(s.read(),{content:'旧约定',layer:'demand',scope:'库',sources:[old],semantic:'fact',attribution:'人',reviewAt:null}));await vault.memoryMutation(s=>s.forget(s.read(),entry.id,1));await vault.write('a.md','原始材料\n真正新内容',note.revision,note);note=await vault.read('a.md')
  const larger=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:10});expect(larger.materialId).not.toBe(old.materialId);expect(larger.basisGroups).toContain(old.materialId);expect(larger.sequence).toBe(old.sequence);expect(vault.memorySnapshot().record.forgotten[0]?.materialIds).toContain(old.materialId);expect(await vault.memoryMutation(s=>s.canLearn(s.read().record,[larger]))).toBe(false)
  await service.advance(old.sequence,service.snapshot());expect(service.snapshot().record.forgotten).toEqual([]);expect(await vault.memoryMutation(s=>s.canLearn(s.read().record,[larger]))).toBe(false);const same=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4});expect(same.materialId).toBe(old.materialId);expect(await vault.memoryMutation(s=>s.canLearn(s.read().record,[same]))).toBe(false)
  const newer=await service.manualSource({...note,relPath:'a.md',kind:'body',start:5,end:10});expect(newer.sequence).toBeGreaterThan(old.sequence);expect(await vault.memoryMutation(s=>s.canLearn(s.read().record,[newer]))).toBe(true)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('legacy controlled owner updates do not prove an unhashed unit birth or permit shifted forgotten text to learn again',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-material-legacy-history-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'原始材料');const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const service=new WorkingMemoryService(vault,()=>null);let note=await vault.readOpened('a.md');const old=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4}),entry=await vault.memoryMutation(s=>s.add(s.read(),{content:'旧约定',layer:'demand',scope:'库',sources:[old],semantic:'fact',attribution:'人',reviewAt:null}));await vault.memoryMutation(s=>s.forget(s.read(),entry.id,1));const file=path.join(root,'.rgent','materials.json'),legacy=JSON.parse(await readFile(file,'utf8'));delete legacy.units[0].hash
  // Reproduce the old implementation: a controlled body save updates owner evidence,
  // while the previous unhashed material registration stays at its birth offsets.
  await vault.write('a.md','开头\n原始材料',note.revision,note);await writeFile(file,JSON.stringify(legacy));note=await vault.read('a.md');await vault.write('a.md',note.content+'\n备注',note.revision,note);note=await vault.read('a.md');expect(JSON.parse(await readFile(file,'utf8')).units.find((u:any)=>u.id===old.materialId).hash).toBeUndefined();await expect(service.manualSource({...note,relPath:'a.md',kind:'body',start:3,end:7})).rejects.toThrow('MEMORY_MATERIAL_UNVERIFIED')
  await vault.write('a.md','真正新内容',note.revision,note);note=await vault.read('a.md');const fresh=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4});expect(fresh.materialId).not.toBe(old.materialId);expect(fresh.sequence).toBeGreaterThan(old.sequence);expect(await vault.memoryMutation(s=>s.canLearn(s.read().record,[fresh]))).toBe(true)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

it.each(['forgotten','watermark','plain','contained','queued'] as const)('late original body identity and inherited age stay bound to the actual controlled snapshot: %s',async mode=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-D-fix-original-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));const text=mode==='contained'?'原始材料\n独立新内容':'原始材料';await writeFile(path.join(root,'a.md'),text);const vault=new VaultSession(base,vi.fn());vault.restore();let release:(()=>void)|undefined
 try{const service=new WorkingMemoryService(vault,()=>null),note=await vault.readOpened('a.md'),old=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4}),entry=await vault.memoryMutation(s=>s.add(s.read(),{content:'原约定',layer:'demand',scope:'库',sources:[old],semantic:'fact',attribution:'人',reviewAt:null}));if(mode!=='plain')await vault.memoryMutation(s=>s.forget(s.read(),entry.id,1));if(mode==='watermark')await service.advance(old.sequence,service.snapshot())
  const fragment={...note,relPath:'a.md',permissionTier:'reference' as const,kind:'body' as const,classification:'human' as const,taskId:null,start:0,end:text.length,text,hash:createHash('sha256').update(text).digest('hex'),sourceDeps:[],memoryDeps:[]};await vault.write('a.md','前缀\n'+text,note.revision,note)
  let late:import('../../src/main/working-memory-store.ts').WorkingSource
  if(mode==='queued'){let entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);const blocking=vault.memoryMutation(async()=>{entered();await gate});await started;const current=await vault.read('a.md'),writing=vault.write('a.md','第二前缀\n'+text,current.revision,current),sourcing=service.sourceForFragment(fragment);release!();await blocking;await writing;late=await sourcing;expect(late.start).toBe(5)}else{late=await service.sourceForFragment(fragment);expect(late.start).toBe(3)}
  if(mode==='contained')expect(late.basisGroups).toContain(old.materialId);else expect(late.materialId).toBe(old.materialId);expect(late.sequence).toBe(old.sequence);expect(await vault.memoryMutation(s=>s.canLearn(s.read().record,[late]))).toBe(mode==='plain');expect(await service.verifySource(late)).toBe(true)
  const current=await vault.read('a.md');await vault.write('a.md',current.content+'\n真正新内容',current.revision,current);const newer=await vault.read('a.md'),start=newer.content.indexOf('真正新内容'),fresh=await service.manualSource({...newer,relPath:'a.md',kind:'body',start,end:start+5});expect(fresh.sequence).toBeGreaterThan(old.sequence);expect(await vault.memoryMutation(s=>s.canLearn(s.read().record,[fresh]))).toBe(true)
 }finally{release?.();vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('terminal revision blocks lifecycle persistence but safely filters this recall without changing valid raw memory',async()=>{
 const {encodeWorkingMemory}=await import('../../src/main/working-memory-store.ts'),{recallMemory}=await import('../../src/main/memory-use.ts');const base=await mkdtemp(path.join(os.tmpdir(),'rgent-D-fix-terminal-review-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'原始材料');const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const service=new WorkingMemoryService(vault,()=>null),note=await vault.readOpened('a.md'),source=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4}),raw=encodeWorkingMemory({version:3,recent:[],identity:'terminal',revision:Number.MAX_SAFE_INTEGER,nextSequence:source.sequence,watermark:0,forgotten:[],jobs:[],entries:[{id:'expired',version:1,category:'long',state:{source:'verified',content:'current',enabled:true,capacity:'ready'},status:'active',reason:null,content:'过期原始材料',layer:'demand',scope:'库',sources:[source],semantic:'fact',attribution:'人',reviewAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',updateBasis:{kind:'manual',id:'expired',version:1}}]});await writeFile(path.join(root,'.rgent-memory'),raw);const checked=await service.entries();expect(checked[0]?.status).toBe('review');expect(recallMemory(checked,'原始材料','').demand).toEqual([]);expect(await readFile(path.join(root,'.rgent-memory'),'utf8')).toBe(raw);expect(service.snapshot().record.entries[0]?.status).toBe('active')
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it.each(['forbidden','hardlink'] as const)('queued fragment registration rechecks current permission or real alias before body read/publication: %s',async mode=>{
 const {secureFsFor}=await import('../../src/main/secure-fs.ts');const base=await mkdtemp(path.join(os.tmpdir(),'rgent-D-fix-unit-permission-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await mkdir(path.join(root,'notes'));await writeFile(path.join(root,'notes','a.md'),'原始材料');const vault=new VaultSession(base,vi.fn());vault.restore();let release!:()=>void
 try{const service=new WorkingMemoryService(vault,()=>null),note=await vault.readOpened('notes/a.md'),fragment={...note,relPath:'notes/a.md',permissionTier:'reference' as const,kind:'body' as const,classification:'human' as const,taskId:null,start:0,end:4,text:'原始材料',hash:createHash('sha256').update('原始材料').digest('hex'),sourceDeps:[],memoryDeps:[]};let entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),blocking=vault.memoryMutation(async()=>{entered();await gate;if(mode==='hardlink'){const {link}=await import('node:fs/promises');await link(path.join(root,'notes','a.md'),path.join(root,'alias.md'));await writeFile(path.join(root,'.rgent-permissions'),JSON.stringify({'alias.md':'forbidden'}))}});await started;const permission=mode==='forbidden'?vault.setPermission('notes','forbidden'):Promise.resolve(),sourcing=service.sourceForFragment(fragment),rejected=expect(sourcing).rejects.toThrow('MEMORY_SOURCE_CHANGED'),fs=secureFsFor(root),original=fs.readSnapshot.bind(fs);let bodyReads=0;vi.spyOn(fs,'readSnapshot').mockImplementation(p=>{if(p==='notes/a.md')bodyReads++;return original(p)});release();await blocking;await Promise.all([permission,rejected]);expect(bodyReads).toBe(0);expect(vault.materialState().status).toBe('empty')
 }finally{release?.();vi.restoreAllMocks();vault.dispose();await rm(base,{recursive:true,force:true})}
})
it.each([false,true])('expires recent by creation time through recursive dependencies and a final read race: %s',async race=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-recent-expiry-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'可核验材料')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  const service=new WorkingMemoryService(vault,()=>null),note=await vault.readOpened('a.md'),source=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:note.content.length})
  const parent=await vault.memoryMutation(store=>store.add(store.read(),{content:'parent',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
  const middle=await vault.memoryMutation(store=>store.add(store.read(),{content:'middle',layer:'demand',scope:'a.md',sources:[{...source,memoryDeps:[{id:parent.id,version:parent.version}]}],semantic:'fact',attribution:'人',reviewAt:null}))
  await vault.memoryMutation(store=>store.add(store.read(),{content:'leaf',layer:'demand',scope:'a.md',sources:[{...source,memoryDeps:[{id:middle.id,version:middle.version}]}],semantic:'fact',attribution:'人',reviewAt:null}))
  const basis=service.snapshot(),created=Date.now()-14*86400000+1000;let now=Date.now()
  const recent={...basis.record.entries[0]!,category:'recent' as const,layer:'demand' as const,semantic:'fact' as const,recent:{taskId:'task',noteId:'note',materialVersion:'a'.repeat(64),createdAt:new Date(created).toISOString(),outcome:'completed' as const,sections:{goal:'',completed:'',blocked:'',next:''},assistantDraft:false}}
  recent.sources=[{...source,kind:'ledger',taskId:'task'}];basis.record.entries.shift();basis.record.recent=[recent]
  vi.spyOn(service,'snapshot').mockImplementation(()=>structuredClone(basis));vi.spyOn(service,'savedMaterial').mockResolvedValue({taskId:'task',context:service.context(),origin:{relPath:'a.md',sessionId:service.context().sessionId,objectVersion:source.objectVersion,revision:source.revision},status:'completed',prompt:source.text,answer:'',ledgerHash:'a'.repeat(64),noteId:'note',materialVersion:'a'.repeat(64),provenanceStatus:'complete',memoryDeps:[],sourceDeps:[],material:{fragments:[],truncated:false}})
  vi.spyOn(Date,'now').mockImplementation(()=>now);let checks=0;vi.spyOn(service,'verifySource').mockImplementation(async()=>{if(race&&++checks===3)now=created+14*86400000;return true})
  if(!race)now=created+14*86400000
  const raw=vault.memorySnapshot().raw,entries=await service.entries()
  expect(entries.find(e=>e.id===recent.id)?.status).toBe('obsolete');expect(entries.find(e=>e.content==='leaf')?.status).toBe('paused')
  for(const e of entries){const {statusFromState}=await import('../../src/main/working-memory-store.ts');expect(statusFromState(e.state)).toBe(e.status)}
  expect(vault.memorySnapshot().raw).toBe(raw)
 }finally{vi.restoreAllMocks();vault.dispose();await rm(base,{recursive:true,force:true})}
})

it('demotes an agreement whose quoted authority text is absent from the cited source',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-agreement-quote-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),markPrompt('/以后本库回答使用中文',{taskId:'quote',range:{start:0,end:11},expectedText:'/以后本库回答使用中文',promptText:'以后本库回答使用中文'}))
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  const note=await vault.readOpened('a.md')
  await vault.ledgerPrepare('a.md',{taskId:'quote',startedAt:new Date().toISOString(),status:'completed',prompt:'以后本库回答使用中文',answer:'保存回执'})
  const written=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'quote',answer:'保存回执'}),note.revision,note)
  await vault.ledgerComplete('a.md','quote',written.revision)
  const service=new WorkingMemoryService(vault,()=>null),source=await service.sourceForPrompt('a.md','quote')
  const added=await vault.memoryMutation(store=>store.add(store.read(),{content:'以后本库回答使用中文',layer:'core',scope:'本库',sources:[source],semantic:'standing',attribution:'人的口令',reviewAt:null,agreement:{authority:[{sourceId:source.id,quote:'这段原话并不存在于来源'}],supporting:[]}}))
  const demoted=await service.entries([added.id])
  expect(demoted[0]?.status).toBe('paused')
  expect(demoted[0]?.reason).toBe('MEMORY_SOURCE_CHANGED')
  // 原话真实存在时不误伤：同一条目改为正确引用后可继续使用。
  await vault.memoryMutation(store=>{const current=store.read(),entry=current.record.entries.find(e=>e.id===added.id)!;return store.edit(current,added.id,entry.version,{content:entry.content,agreement:{authority:[{sourceId:source.id,quote:source.text.slice(0,4)}],supporting:[]}})})
  const usable=await service.entries([added.id])
  expect(usable[0]?.status).toBe('active')
  expect(usable[0]?.reason).toBeNull()
 }finally{vi.restoreAllMocks();vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('reports a stale dependency as MEMORY_DEPENDENCY_CHANGED and repairs a leftover reference',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-stale-dependency-')),root=path.join(base,'vault');await mkdir(root)
 await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'可核验的来源材料')
 const {encodeWorkingMemory,parseWorkingMemory}=await import('../../src/main/working-memory-store.ts')
 let vault=new VaultSession(base,vi.fn());vault.restore()
 let upstreamId=''
 try{
  const note=await vault.readOpened('a.md'),service=new WorkingMemoryService(vault,()=>null)
  const source=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:note.content.length})
  const upstream=await vault.memoryMutation(store=>store.add(store.read(),{content:'上游事实',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'来源笔记',reviewAt:null}))
  upstreamId=upstream.id
  await vault.memoryMutation(store=>store.add(store.read(),{content:'下游事实',layer:'demand',scope:'本库',sources:[{...source,id:'downstream',memoryDeps:[{id:upstream.id,version:upstream.version}]}],semantic:'fact',attribution:'来源笔记',reviewAt:null}))
 }finally{vault.dispose()}
 // 旧文件里可能留下的形态：上游已升版，下游仍指向同 id 的旧版本（该版本已不存在）。
 const legacy=parseWorkingMemory(await readFile(path.join(root,'.rgent-memory'),'utf8'))
 legacy.entries.find(e=>e.id===upstreamId)!.version+=1
 await writeFile(path.join(root,'.rgent-memory'),encodeWorkingMemory(legacy))
 vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  const service=new WorkingMemoryService(vault,()=>null)
  const stale=await service.entries()
  const downstream=stale.find(e=>e.content==='下游事实')!
  expect(downstream.status).toBe('paused')
  expect(downstream.reason).toBe('MEMORY_DEPENDENCY_CHANGED')
  await service.recheckDeferred()
  const record=service.snapshot().record,upstream=record.entries.find(e=>e.id===upstreamId)!
  expect(record.entries.find(e=>e.content==='下游事实')!.sources[0]!.memoryDeps).toEqual([{id:upstreamId,version:upstream.version}])
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

it.each(['empty','dependency','unknown','mismatch','cache','cache-edit','cache-disabled','cache-unrelated','race','overflow'] as const)('reconstructs only proven old recent ancestry without writing on reads (%s)',async mode=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-integrity-recent-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'原始资料')
 let vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  let service=new WorkingMemoryService(vault,()=>null);await service.initialize();let note=await vault.readOpened('a.md')
  const source=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4}),parent=await vault.memoryMutation(store=>store.add(store.read(),{content:'上游事实',layer:'demand',scope:'a.md',sources:[source],semantic:'fact',attribution:'人',reviewAt:null}))
  const dependency={id:parent.id,version:1,basisHashes:[source.basisHash],sourceDeps:[{id:source.id,version:1,hash:source.hash,relPath:'a.md',kind:'body' as const,taskId:null}]}
  const provenance=mode==='unknown'?undefined:{version:2 as const,model:{provider:'custom',modelId:'fixture',endpointHost:'example.test'},scope:['a.md'],sources:[],tools:[],memoryDeps:mode==='empty'?[]:[dependency]}
  await vault.ledgerPrepare('a.md',{taskId:'recent-task',startedAt:new Date().toISOString(),status:'completed',prompt:'继续工作',answer:'受控草稿',provenance})
  note=await vault.read('a.md');const marked=markPrompt('/继续工作',{taskId:'recent-task',range:{start:0,end:5},expectedText:'/继续工作',promptText:'继续工作'});const written=await vault.write('a.md',note.content+'\n'+upsertAiAnswer(marked,{taskId:'recent-task',answer:'受控草稿'}),note.revision,note);await vault.ledgerComplete('a.md','recent-task',written.revision)
  const material=await service.savedMaterial('a.md','recent-task'),anchor=await service.sourceForPrompt('a.md','recent-task')
  if(mode.startsWith('cache')){
   if(mode!=='cache'){
    const entries=service.entries.bind(service);let changed=false
    vi.spyOn(service,'entries').mockImplementation(async ids=>{const proven=await entries(ids);if(!changed){changed=true;const basis=service.snapshot();if(mode==='cache-unrelated')await vault.memoryMutation(store=>store.add(store.read(),{content:'无关事实',layer:'demand',scope:'a.md',sources:[anchor],semantic:'fact',attribution:'人',reviewAt:null}));else await service.edit({sessionId:service.context().sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:parent.id,version:1},mode==='cache-edit'?{content:'已修订的父事实'}:{status:'disabled'})}return proven})
    expect(await service.summaryAllowed('a.md',['recent-task'])).toBe(mode==='cache-unrelated');return
   }
   expect(await service.summaryAllowed('a.md',['recent-task'])).toBe(true)
   const before=service.snapshot();await service.forget({sessionId:service.context().sessionId,revision:before.revision,objectVersion:before.objectVersion,id:parent.id,version:1})
   expect(await service.summaryAllowed('a.md',['recent-task'])).toBe(false);return
  }
  const result=await vault.memoryMutation(store=>store.apply(store.read(),[],{taskId:'recent-task',materialVersion:material.materialVersion,outcome:'applied',entryIds:[]},{sources:[anchor],scope:'a.md',recent:{taskId:'recent-task',noteId:mode==='mismatch'?'wrong-note':material.noteId!,materialVersion:material.materialVersion,createdAt:new Date().toISOString(),outcome:'completed',sections:{goal:'继续上次工作',completed:'',blocked:'',next:''},assistantDraft:false}}))
  const child=await vault.memoryMutation(store=>store.add(store.read(),{content:'近期派生候选',layer:'demand',scope:'a.md',sources:[{...anchor,memoryDeps:[{id:result.recentIds[0]!,version:1}]}],semantic:'fact',attribution:'人',reviewAt:null}))
  if(mode==='dependency'){
   const current=await vault.read('a.md'),marked=markPrompt('/接续下一步',{taskId:'recent-next',range:{start:0,end:6},expectedText:'/接续下一步',promptText:'接续下一步'})
   await vault.ledgerPrepare('a.md',{taskId:'recent-next',startedAt:new Date().toISOString(),status:'completed',prompt:'接续下一步',answer:'下一步草稿',provenance:{...provenance!,memoryDeps:[{...dependency,id:result.recentIds[0]!,basisHashes:[anchor.basisHash],sourceDeps:[{id:anchor.id,version:1,hash:anchor.hash,relPath:'a.md',kind:'ledger',taskId:'recent-task'}]}]}})
   const written=await vault.write('a.md',current.content+'\n'+upsertAiAnswer(marked,{taskId:'recent-next',answer:'下一步草稿'}),current.revision,current);await vault.ledgerComplete('a.md','recent-next',written.revision)
   const nextMaterial=await service.savedMaterial('a.md','recent-next'),nextSource=await service.sourceForPrompt('a.md','recent-next')
   await vault.memoryMutation(store=>store.apply(store.read(),[],{taskId:'recent-next',materialVersion:nextMaterial.materialVersion,outcome:'applied',entryIds:[]},{sources:[nextSource],scope:'a.md',recent:{taskId:'recent-next',noteId:nextMaterial.noteId!,materialVersion:nextMaterial.materialVersion,createdAt:new Date().toISOString(),outcome:'completed',sections:{goal:'下游接续',completed:'',blocked:'',next:''},assistantDraft:false}}))
  }
  vault.dispose();vault=new VaultSession(base,vi.fn());vault.restore();service=new WorkingMemoryService(vault,()=>null)
  const before=service.snapshot()
  if(mode==='overflow'){
   const original=service.savedMaterial.bind(service);vi.spyOn(service,'savedMaterial').mockImplementation(async(...args)=>({...await original(...args),memoryDeps:Array.from({length:17},(_,i)=>({...dependency,id:'extra-'+i}))}))
  }
  if(mode==='race'){
   const verify=service.verifySource.bind(service);let forgotten=false
   vi.spyOn(service,'verifySource').mockImplementation(async s=>{if(!forgotten){forgotten=true;await service.forget({sessionId:service.context().sessionId,revision:before.revision,objectVersion:before.objectVersion,id:parent.id,version:1})}return verify(s)})
   expect(await service.entries([child.id])).toEqual([]);return
  }
  const entries=await service.entries(),recent=entries.find(e=>e.id===result.recentIds[0])!
  expect(service.snapshot().raw).toBe(before.raw);expect(service.snapshot().revision).toBe(before.revision)
  if(mode==='unknown'||mode==='mismatch'||mode==='overflow'){expect(recent.status).toBe('paused');expect(entries.find(e=>e.id===child.id)?.status).toBe('paused')}
  else{expect(recent.status).toBe('active');expect(recent.sources.flatMap(s=>s.memoryDeps)).toEqual(mode==='empty'?[]:[{id:parent.id,version:1}])}
  await service.forget({sessionId:service.context().sessionId,revision:before.revision,objectVersion:before.objectVersion,id:parent.id,version:parent.version})
  const remaining=service.snapshot().record
  if(mode==='dependency'){expect(remaining.recent).toEqual([]);expect(remaining.entries).toEqual([]);expect(await service.summaryAllowed('a.md',['recent-task'])).toBe(false);expect(await service.summaryAllowed('a.md',['recent-next'])).toBe(false);expect(await vault.memoryMutation(store=>store.canLearn(store.read().record,[anchor]))).toBe(false)}
  if(mode==='unknown'||mode==='mismatch'||mode==='overflow'){expect(await service.summaryAllowed('a.md',['recent-task'])).toBe(false);expect(remaining.recent[0]?.status).toBe('paused');expect((await service.entries()).find(e=>e.id===child.id)?.status).toBe('paused')}
 }finally{vi.restoreAllMocks();vault.dispose();await rm(base,{recursive:true,force:true})}
})


it.each(['missing','v1','v2-empty'] as const)('rolled-out recent history cannot prove derived summary independence from absent recent (%s)',async mode=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-rolled-summary-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root))
 const prompt='继续旧工作',marked=markPrompt('/'+prompt,{taskId:'rolled',range:{start:0,end:prompt.length+1},expectedText:'/'+prompt,promptText:prompt});await writeFile(path.join(root,'a.md'),marked)
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  let note=await vault.readOpened('a.md');const original={model:{provider:'custom',modelId:'fixture',endpointHost:'example.test'},scope:['a.md'],sources:[],tools:[]}
  await vault.ledgerPrepare('a.md',{taskId:'rolled',startedAt:new Date(Date.now()-15*86400000).toISOString(),status:'completed',prompt,answer:'原始旧回答仍可读',provenance:mode==='missing'?undefined:mode==='v1'?{version:1,...original}:{version:2,...original,memoryDeps:[]}})
  const written=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'rolled',answer:'原始旧回答仍可读'}),note.revision,note);await vault.ledgerComplete('a.md','rolled',written.revision)
  const service=new WorkingMemoryService(vault,()=>null),material=await service.savedMaterial('a.md','rolled'),anchor=await service.sourceForPrompt('a.md','rolled')
  await vault.memoryMutation(store=>store.apply(store.read(),[],{taskId:'rolled',materialVersion:material.materialVersion,outcome:'applied',entryIds:[]},{sources:[anchor],scope:'a.md',recent:{taskId:'rolled',noteId:material.noteId!,materialVersion:material.materialVersion,createdAt:material.startedAt!,outcome:'completed',sections:{goal:'旧背景',completed:'',blocked:'',next:''},assistantDraft:false}}))
  expect(service.snapshot().record.recent).toEqual([])
  const before=service.snapshot(),historyBefore=await vault.ledgerRecord('a.md','rolled')
  expect(await service.summaryAllowed('a.md',['rolled'])).toBe(mode==='v2-empty')
  expect(await vault.ledgerRecord('a.md','rolled')).toEqual(historyBefore);expect((await vault.ledgerContexts('a.md'))[0]?.text).toContain('原始旧回答仍可读')
  expect(service.snapshot().raw).toBe(before.raw)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

it.each(['edit','forget'] as const)('keeps a committed %s visible when its one maintenance attempt fails',async operation=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-maintenance-result-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'原始事实')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{const service=new WorkingMemoryService(vault,()=>null),note=await vault.readOpened('a.md'),source=await service.manualSource({...note,relPath:'a.md',kind:'body',start:0,end:4})
  const entry=await vault.memoryMutation(store=>store.add(store.read(),{content:'原始事实',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人',reviewAt:null})),basis=service.snapshot(),request={sessionId:service.context().sessionId,revision:basis.revision,objectVersion:basis.objectVersion,id:entry.id,version:entry.version}
  const mutation=vault.memoryMutation.bind(vault);let attempts=0;const spy=vi.spyOn(vault,'memoryMutation').mockImplementation((...args)=>{attempts++;if(attempts===2)return Promise.reject(Error('MEMORY_FILE_LIMIT'));return mutation(...args)})
  const {createMemoryIpc}=await import('../../src/main/memory-ipc.ts');const revoke=vi.fn(async()=>{}),ipc=createMemoryIpc({vault:()=>vault,config:()=>null,service:()=>service,recheck:revoke})
  const result=await ipc.handle('fixture',operation,operation==='edit'?{...request,content:'已更新事实',layer:'demand',scope:'本库'}:request)
  expect(result.ok).toBe(true);if(!result.ok||!('entries' in result.value))throw Error('expected committed view')
  expect(result.value).toMatchObject({status:'ready',maintenanceFailure:'MEMORY_FILE_LIMIT'});expect(attempts).toBe(2);expect(revoke).toHaveBeenCalledOnce()
  if(operation==='edit')expect(service.snapshot().record.entries.find(e=>e.id===entry.id)).toMatchObject({content:'已更新事实',version:2});else expect(service.snapshot().record.entries.some(e=>e.id===entry.id)).toBe(false)
  // Production creates a fresh service for each read: runtime diagnostics must survive that read without retrying.
  expect(await new WorkingMemoryService(vault,()=>null).view()).toMatchObject({maintenanceFailure:'MEMORY_FILE_LIMIT'});expect(attempts).toBe(2)
  spy.mockRestore();await service.recheckDeferred();expect((await service.view()).maintenanceFailure).toBeUndefined()
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
