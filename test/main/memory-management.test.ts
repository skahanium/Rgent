import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import os from 'node:os';import path from 'node:path'
import {it,expect,vi} from 'vitest'
import {VaultSession} from '../../src/main/vault.ts'
import {WorkingMemoryService} from '../../src/main/working-memory-service.ts'
import {createMemoryIpc} from '../../src/main/memory-ipc.ts'
import {serializeStoredVault} from '../../src/main/notes-fs.ts'
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}))
vi.mock('../../src/main/watch.ts',async original=>({...await original<typeof import('../../src/main/watch.ts')>(),watchVault:()=>()=>{}}))
it('single-use previews bind owner and exact revision; a stale request cannot overwrite a newer memory',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-memory-manage-')),root=path.join(base,'vault');await mkdir(root)
 await writeFile(path.join(base,'vault.json'),serializeStoredVault(root));await writeFile(path.join(root,'a.md'),'项目约定：使用中文。')
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  const note=await vault.readOpened('a.md'),service=new WorkingMemoryService(vault,()=>null);await service.initialize()
  const ipc=createMemoryIpc({vault:()=>vault,service:()=>service,config:()=>null,recheck:async()=>{}})
  const request={sessionId:note.sessionId,relPath:'a.md',objectVersion:note.objectVersion,revision:note.revision,kind:'body',start:0,end:'项目约定：使用中文。'.length}
  const preview=await ipc.handle('owner','manual',request);expect(preview.ok).toBe(true)
  if(!preview.ok||!('id'in preview.value))throw Error('preview missing')
  expect(await ipc.handle('foreign','commit',{sessionId:note.sessionId,id:preview.value.id})).toMatchObject({ok:false,error:'STALE_PREVIEW'})
  expect(await ipc.handle('owner','commit',{sessionId:note.sessionId,id:preview.value.id})).toMatchObject({ok:false,error:'STALE_PREVIEW'})
  const again=await ipc.handle('owner','manual',request);if(!again.ok||!('id'in again.value))throw Error('preview missing')
  expect(await ipc.handle('owner','commit',{sessionId:note.sessionId,id:again.value.id})).toMatchObject({ok:true})
  expect(service.snapshot().record.entries[0]?.content).toBe('项目约定：使用中文。')
  const pending=await ipc.handle('owner','manual',request);if(!pending.ok||!('id'in pending.value))throw Error('preview missing')
  const basis=service.snapshot(),entry=basis.record.entries[0]!
  await vault.memoryMutation(store=>store.edit(basis,entry.id,entry.version,{content:'人改写的新约定'}))
  expect(await ipc.handle('owner','commit',{sessionId:note.sessionId,id:pending.value.id})).toMatchObject({ok:false,error:'MEMORY_CONFLICT'})
  expect(service.snapshot().record.entries[0]?.content).toBe('人改写的新约定')
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})
it('a late enabled initialization cannot change config or cancel the new vault engine',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-config-call-')),a=path.join(base,'A'),b=path.join(base,'New');await mkdir(a);await mkdir(b)
 const {vaultRootIdentity}=await import('../../src/main/watch.ts'),vault=new VaultSession(base,()=>{});vault.restoreVerified(a,vaultRootIdentity(a));const service=new WorkingMemoryService(vault,()=>null);await service.initialize()
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 const initialize=service.initialize.bind(service);vi.spyOn(service,'initialize').mockImplementation(async()=>{const result=await initialize();entered();await gate;return result})
 const setVaultMemory=vi.fn(),cancel=vi.fn(),ipc=createMemoryIpc({vault:()=>vault,service:()=>service,config:()=>({setVaultMemory}) as any,engine:()=>({cancel}) as any,recheck:async()=>{}})
 try{
  const old=ipc.handle('owner','config',{sessionId:vault.captureSession(),target:'vault',vault:{enabled:true,override:{mode:'inherit'}}})
  await started;await vault.openVerified(b,vaultRootIdentity(b));release();expect((await old).ok).toBe(false)
  expect(setVaultMemory).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled()
 }finally{release?.();vault.dispose();await rm(base,{recursive:true,force:true})}
})

it('retirement uses the existing single-use preview and leaves unknown or changed bytes intact',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-retire-manage-')),root=path.join(base,'vault');await mkdir(root)
 const file=path.join(root,'.rgent-memory');await writeFile(file,'unknown bytes');await writeFile(path.join(base,'vault.json'),serializeStoredVault(root))
 const vault=new VaultSession(base,vi.fn());vault.restore()
 try{
  await vault.memoryMutation(()=>{});const service=new WorkingMemoryService(vault,()=>null),ipc=createMemoryIpc({vault:()=>vault,service:()=>service,config:()=>null,recheck:async()=>{}}),sessionId=vault.captureSession()
  expect((await service.view()).retirement).toBeUndefined()
  expect(await ipc.handle('owner','maintenance',{sessionId,action:'retire',revision:'a'.repeat(64),objectVersion:'o'})).toEqual({ok:false,error:'MEMORY_RETIREMENT_UNRECOGNIZED'})
  const legacy=JSON.stringify({version:1,entries:[],forgotten:[],jobs:[],relocations:[]});await writeFile(file,legacy)
  const view=await service.view();expect(view.retirementFailure).toBe('MEMORY_RETIREMENT_FAILED');expect(view.retirement).toBeDefined()
  const request={sessionId,action:'retire',revision:view.retirement!.revision,objectVersion:view.retirement!.objectVersion}
  const preview=await ipc.handle('owner','maintenance',request);if(!preview.ok||!('id'in preview.value))throw Error('preview missing')
  expect(preview.value.kind).toBe('retire');expect(JSON.stringify(preview.value)).not.toContain(root)
  await writeFile(file,legacy+' ');expect(await ipc.handle('owner','commit',{sessionId,id:preview.value.id},()=>{})).toEqual({ok:false,error:'MEMORY_CONFLICT'});expect(await readFile(file,'utf8')).toBe(legacy+' ')
  expect(await ipc.handle('owner','commit',{sessionId,id:preview.value.id},()=>{})).toEqual({ok:false,error:'STALE_PREVIEW'})
  const next=await service.view(),again=await ipc.handle('owner','maintenance',{...request,revision:next.retirement!.revision,objectVersion:next.retirement!.objectVersion});if(!again.ok||!('id'in again.value))throw Error('preview missing')
  expect(await ipc.handle('foreign','commit',{sessionId,id:again.value.id},()=>{})).toEqual({ok:false,error:'STALE_PREVIEW'})
  const fresh=await ipc.handle('owner','maintenance',{...request,revision:next.retirement!.revision,objectVersion:next.retirement!.objectVersion});if(!fresh.ok||!('id'in fresh.value))throw Error('preview missing')
  const result=await ipc.handle('owner','commit',{sessionId,id:fresh.value.id},()=>{});expect(result).toMatchObject({ok:true,value:{status:'ready'}});expect(await readFile(file,'utf8')).toBe('<!-- rgent:memory:retired:v2 -->\n');expect(vault.memoryDiagnosis()).toBeNull()
 }finally{vault.dispose();await rm(base,{recursive:true,force:true})}
})

it('retirement commit rechecks the confirming owner after waiting in the actual vault queue',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'rgent-retire-owner-')),root=path.join(base,'vault');await mkdir(root);await writeFile(path.join(base,'vault.json'),serializeStoredVault(root))
 const vault=new VaultSession(base,vi.fn());vault.restore();await vault.memoryMutation(()=>{});const file=path.join(root,'.rgent-memory'),legacy=JSON.stringify({version:1,entries:[],forgotten:[],jobs:[],relocations:[]});await writeFile(file,legacy)
 let release!:()=>void,entered!:()=>void,current=true,checks=0;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),assertOwner=()=>{checks++;if(!current)throw Error('MEMORY_SESSION_CLOSED')}
 try{
  const service=new WorkingMemoryService(vault,()=>null),ipc=createMemoryIpc({vault:()=>vault,service:()=>service,config:()=>null,recheck:async()=>{}}),target=await vault.memoryRetirementPreview(),sessionId=target.sessionId
  const preview=await ipc.handle('owner','maintenance',{sessionId,action:'retire',revision:target.revision,objectVersion:target.objectVersion});if(!preview.ok||!('id'in preview.value))throw Error('preview missing')
  const blocker=vault.memoryMutation(async()=>{entered();await gate});await started
  const commit=ipc.handle('owner','commit',{sessionId,id:preview.value.id},assertOwner);await Promise.resolve();const sameSession=vault.captureSession();current=false;release();await blocker
  expect(await commit).toEqual({ok:false,error:'MEMORY_SESSION_CLOSED'});expect(checks).toBeGreaterThan(0);expect(vault.captureSession()).toBe(sameSession);expect(await readFile(file,'utf8')).toBe(legacy)
 }finally{release?.();vault.dispose();await rm(base,{recursive:true,force:true})}
})
