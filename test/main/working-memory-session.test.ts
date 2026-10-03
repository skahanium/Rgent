import {it,expect,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
vi.mock('../../src/main/watch.ts',async original=>({...await original<object>(),watchVault:()=>()=>{}}))
import {VaultSession} from '../../src/main/vault.ts'
import {vaultRootIdentity} from '../../src/main/watch.ts'
import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {markPrompt,upsertAiAnswer} from '../../src/main/host-source.ts'
it('inflight human memory deferred recheck refuses to promote a copied entry in a new mount',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-review-recheck-')),a=path.join(base,'A'),b=path.join(base,'B');await mkdir(a);await mkdir(b)
 await writeFile(path.join(a,'a.md'),markPrompt('/以后用中文',{taskId:'task',range:{start:0,end:6},expectedText:'/以后用中文',promptText:'以后用中文'}))
 const vault=new VaultSession(base,()=>{});vault.restoreVerified(a,vaultRootIdentity(a));const service=new WorkingMemoryService(vault,()=>null);await service.initialize()
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 try{
 const note=await vault.readOpened('a.md');await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:new Date().toISOString(),status:'completed',prompt:'以后用中文',answer:'好的'});const result=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task',answer:'好的'}),note.revision,note);await vault.ledgerComplete('a.md','task',result.revision)
 const source=await service.sourceForPrompt('a.md','task');await vault.memoryMutation(store=>{const r=store.add(store.read(),{content:'延后材料',layer:'demand',scope:'本库',sources:[source],semantic:'fact',attribution:'人确认',reviewAt:null},true);const e=r;store.edit(store.read(),e.id,e.version,{status:'deferred'})})
 await writeFile(path.join(b,'.rgent-memory'),await readFile(path.join(a,'.rgent-memory')))
 const verified=(service as any).verifyEntry.bind(service)
 vi.spyOn(service as any,'verifyEntry').mockImplementation(async(...args:unknown[])=>{const valid=await verified(...args);entered();await gate;return valid})
 const checking=service.recheckDeferred().then(()=>null,(e:Error)=>e.message);await started
 await vault.openVerified(b,vaultRootIdentity(b));release();expect(await checking).toBe('VAULT_CHANGED')
 expect(new WorkingMemoryService(vault,()=>null).snapshot().record.entries[0]?.status).toBe('deferred')
 }finally{release?.();vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('a previously used memory service refuses every late mutation after the mount changes',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-memory-stale-service-')),a=path.join(base,'A'),b=path.join(base,'B');await mkdir(a);await mkdir(b)
 const vault=new VaultSession(base,()=>{});vault.restoreVerified(a,vaultRootIdentity(a));const old=new WorkingMemoryService(vault,()=>null);await old.initialize()
 try{
  await vault.openVerified(b,vaultRootIdentity(b));const current=new WorkingMemoryService(vault,()=>null);await current.initialize();const basis=current.snapshot()
  for(const mutate of [()=>old.initialize(),()=>old.interruptOutstanding(),()=>old.advance(0,basis),()=>old.reset(basis),()=>old.recheckDeferred()])await expect(mutate()).rejects.toThrow('VAULT_CHANGED')
  expect(()=>old.snapshot()).toThrow('VAULT_CHANGED')
  expect(current.snapshot().revision).toBe(basis.revision)
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
