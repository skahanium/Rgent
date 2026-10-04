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
