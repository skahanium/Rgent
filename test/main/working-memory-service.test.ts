import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path'
import {it,expect,vi} from 'vitest'
import {VaultSession} from '../../src/main/vault.ts';import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {serializeStoredVault} from '../../src/main/notes-fs.ts';import {markPrompt,upsertAiAnswer} from '../../src/main/host-source.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}));vi.mock('../../src/main/watch.ts',async importOriginal=>({...await importOriginal<typeof import('../../src/main/watch.ts')>(),watchVault:()=>()=>{}}))
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
