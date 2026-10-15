import {it,expect,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
vi.mock('../../src/main/watch.ts',async original=>({...await original<object>(),watchVault:(root:string)=>{if(path.basename(root)==='B')throw Error('WATCH_INITIALIZATION_FAILED');return ()=>{}}}))
import {VaultSession} from '../../src/main/vault.ts'
import {vaultRootIdentity} from '../../src/main/watch.ts'
it('watcher initialization failure returns the committed new binding with a persistent diagnosis',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-review-')),a=path.join(base,'A'),b=path.join(base,'B');await mkdir(a);await mkdir(b)
 const vault=new VaultSession(base,()=>{});vault.restoreVerified(a,vaultRootIdentity(a));const old=vault.sessionId()
 try{const state=await vault.openVerified(b,vaultRootIdentity(b));expect(state).toMatchObject({status:'ready',rootName:'B',vaultChanged:true,diagnostic:expect.any(String)});expect(vault.root).toBe(b);expect(vault.sessionId()).not.toBe(old);expect(vault.currentState()).toMatchObject({status:'ready',rootName:'B',diagnostic:expect.any(String)})}
 finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {WorkingMemoryConsolidation} from '../../src/main/working-memory-consolidation.ts'
import {markPrompt,upsertAiAnswer} from '../../src/main/host-source.ts'
it('cancelled consolidation cannot write an old receipt or begin reading in a new mount',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-review-memory-')),a=path.join(base,'A'),b=path.join(base,'New');await mkdir(a);await mkdir(b)
 await writeFile(path.join(a,'a.md'),markPrompt('/以后用中文',{taskId:'task',range:{start:0,end:6},expectedText:'/以后用中文',promptText:'以后用中文'}))
 const vault=new VaultSession(base,()=>{});vault.restoreVerified(a,vaultRootIdentity(a));const service=new WorkingMemoryService(vault,()=>null);await service.initialize()
 let release!:()=>void,queued=false;const gate=new Promise<void>(r=>release=r)
 const engine=new WorkingMemoryConsolidation({service:()=>service,configuration:()=>({enabled:true,signature:'configured',credential:{provider:'custom',modelId:'memory',baseURL:'https://example.test/v1',apiKey:'secret',contextTokens:32768},limits:{seconds:120,calls:2,tools:0}}),stream:async function*(){yield {type:'text',text:'{"recent":null,"proposals":[]}' }},changed:()=>{if(!queued){queued=true;void vault.memoryMutation(async()=>{await gate})}}})
 try{
 engine.capture('task');const note=await vault.readOpened('a.md');await vault.ledgerPrepare('a.md',{taskId:'task',startedAt:new Date().toISOString(),status:'completed',prompt:'以后用中文',answer:'好的'});const result=await vault.write('a.md',upsertAiAnswer(note.content,{taskId:'task',answer:'好的'}),note.revision,note);await vault.ledgerComplete('a.md','task',result.revision)
 await engine.handoff(await service.savedMaterial('a.md','task'))
 engine.cancel(undefined,'MEMORY_SESSION_CLOSED');const opened=vault.openVerified(b,vaultRootIdentity(b));release();await opened;await engine.idle()
 expect(new WorkingMemoryService(vault,()=>null).snapshot().record.jobs).toEqual([])
 }finally{release?.();engine.close();await engine.idle();vault.dispose();await rm(base,{recursive:true,force:true})}
})
