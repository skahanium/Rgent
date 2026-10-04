import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {IPC} from '../../src/shared/ipc.ts'
import {VaultCatalog} from '../../src/main/vault-catalog.ts'
const state=vi.hoisted(()=>({trusted:true,memoryOwnerCheck:undefined as undefined|(()=>void),data:'',handles:new Map<string,Function>(),events:new Map<string,Function>(),appEvents:new Map<string,Function>(),window:null as any,host:null as any,launch:Promise.resolve(),active:false,settled:0,stopped:0,watchFailure:'',open:vi.fn(),save:vi.fn(),confirm:vi.fn(),memoryResult:null as Promise<any>|null,rechecks:[] as string[],tasks:[] as {id:string;root:string;relPath:string}[],cancelled:[] as string[],retried:[] as string[]}))
vi.mock('electron',()=>({
 app:{isPackaged:true,getPath:()=>state.data,requestSingleInstanceLock:()=>true,quit:vi.fn(),whenReady:()=>Promise.resolve(),on:(name:string,fn:Function)=>state.appEvents.set(name,fn)},
 BrowserWindow:class{
  static getAllWindows(){return state.window?[state.window]:[]}
  webContents={id:1,on:vi.fn(),isDestroyed:()=>false,setWindowOpenHandler:vi.fn(),send:(channel:string,id:string)=>{if(channel===IPC.lifecycleFlushRequest)queueMicrotask(()=>state.events.get(IPC.lifecycleFlushDone)?.({sender:this.webContents},{id,ok:true}))}}
  constructor(){state.window=this}on=vi.fn();isDestroyed=()=>false;loadFile=vi.fn();loadURL=vi.fn()
 },
 dialog:{showOpenDialog:state.open,showSaveDialog:state.save,showMessageBox:state.confirm},
 ipcMain:{handle:(channel:string,fn:Function)=>state.handles.set(channel,fn),on:(channel:string,fn:Function)=>state.events.set(channel,fn)},
 protocol:{registerSchemesAsPrivileged:vi.fn(),handle:vi.fn()},Menu:{buildFromTemplate:vi.fn(),setApplicationMenu:vi.fn()},nativeTheme:{on:vi.fn(),off:vi.fn()},safeStorage:{},shell:{}
}))
vi.mock('../../src/main/ipc-sender.ts',()=>({isTrustedIpcSender:()=>state.trusted}))
vi.mock('../../src/main/memory-ipc.ts',async original=>{
 const module=await original<typeof import('../../src/main/memory-ipc.ts')>()
 return {...module,createMemoryIpc:(ports:Parameters<typeof module.createMemoryIpc>[0])=>{const ipc=module.createMemoryIpc(ports);return {...ipc,handle:(...args:Parameters<typeof ipc.handle>)=>{state.memoryOwnerCheck=args[3];return state.memoryResult??ipc.handle(...args)}}}}
})
vi.mock('../../src/main/model-config.ts',async original=>({...await original<object>(),createModelConfigStore:()=>{throw Error('UNAVAILABLE')}}))
vi.mock('../../src/main/watch.ts',async original=>({...await original<object>(),watchVault:(root:string)=>{if(root===state.watchFailure)throw Error('WATCH_INITIALIZATION_FAILED');return ()=>{}}}))
vi.mock('../../src/main/agent-host.ts',()=>({AgentHost:class{
 constructor(){state.host=this}active=()=>state.tasks.length?state.tasks:state.active?[{id:'old'}]:[];hasPending=()=>false
 whenLaunchesSettled=async()=>{state.settled++;await state.launch}
 cancelAll=async()=>{state.stopped++;state.active=false};retryPending=async(root:string)=>{state.retried.push(root)};pendingPaths=()=>['same.md'];cancel=async(id:string)=>{state.cancelled.push(id)};recheckSources=async(root:string)=>{state.rechecks.push(root)}
}}))
let base='',catalog:VaultCatalog,a:string,b:string,c:string
const invoke=(channel:string,...args:unknown[])=>state.handles.get(channel)!({sender:state.window.webContents,senderFrame:{routingId:1}},...args)
beforeEach(async()=>{
 vi.resetModules();state.trusted=true;state.memoryOwnerCheck=undefined;state.handles.clear();state.events.clear();state.appEvents.clear();state.window=null;state.launch=Promise.resolve();state.active=false;state.settled=0;state.stopped=0;state.watchFailure='';state.memoryResult=null;state.rechecks=[];state.tasks=[];state.cancelled=[];state.retried=[];state.open.mockReset();state.save.mockReset();state.confirm.mockReset();state.confirm.mockResolvedValue({response:1})
 base=fs.mkdtempSync(path.join(os.tmpdir(),'rgent-switch-main-'));state.data=path.join(base,'data');fs.mkdirSync(state.data)
 a=path.join(base,'A');b=path.join(base,'B');c=path.join(base,'C');for(const root of [a,b,c])fs.mkdirSync(root)
 catalog=new VaultCatalog(state.data);catalog.committed(catalog.inspect(a));catalog.register(catalog.inspect(b));catalog.register(catalog.inspect(c))
 await import('../../src/main/index.ts');await vi.waitFor(()=>expect(state.window).not.toBeNull())
})
afterEach(()=>{state.appEvents.get('will-quit')?.();fs.rmSync(base,{recursive:true,force:true})})
async function restart(){
 state.appEvents.get('will-quit')?.();vi.resetModules();state.handles.clear();state.events.clear();state.appEvents.clear();state.window=null
 await import('../../src/main/index.ts');await vi.waitFor(()=>expect(state.window).not.toBeNull())
}
it.each(['missing','replaced'] as const)('keeps a %s last-used root in the chooser with its diagnosis',async kind=>{
 fs.renameSync(a,`${a}-old`);if(kind==='replaced')fs.mkdirSync(a)
 await restart()
 expect(await invoke(IPC.vaultGet)).toMatchObject({status:'needs-pick',reason:'missing',diagnostic:expect.any(String)})
 expect((await invoke(IPC.vaultCatalog)).activeId).toBeNull()
})
it('exposes a damaged device catalogue while remaining in the chooser',async()=>{
 fs.writeFileSync(path.join(state.data,'vault-catalog.json'),'damaged')
 await restart()
 expect(await invoke(IPC.vaultGet)).toMatchObject({status:'needs-pick',diagnostic:expect.any(String)})
 expect(fs.readFileSync(path.join(state.data,'vault-catalog.json'),'utf8')).toBe('damaged')
})
it('restores the actual target and its watcher initialization diagnosis at startup',async()=>{
 state.watchFailure=fs.realpathSync(a);await restart()
 expect(await invoke(IPC.vaultGet)).toMatchObject({status:'ready',rootName:'A',vaultId:catalog.inspect(a).id,diagnostic:expect.any(String)})
})
it('waits for an existing launch before asking whether its active task may stop',async()=>{
 let release!:()=>void;state.launch=new Promise<void>(r=>release=r)
 const id=catalog.inspect(b).id!;const switching=invoke(IPC.vaultOpen,id)
 await new Promise(r=>setTimeout(r,10));const hadCommitted=(await invoke(IPC.vaultGet)).rootName!=='A'
 state.active=true;release();await switching
 expect(hadCommitted).toBe(false);expect(state.settled).toBeGreaterThan(0);expect(state.confirm).toHaveBeenCalledTimes(1);expect(state.stopped).toBe(1)
})
it('rejects an old successful memory IPC result before obtaining a new service for postprocessing',async()=>{
 const {WorkingMemoryService}=await import('../../src/main/working-memory-service.ts'),promoted:(string|null)[]=[]
 const spy=vi.spyOn(WorkingMemoryService.prototype,'recheckDeferred').mockImplementation(async function(this:import('../../src/main/working-memory-service.ts').WorkingMemoryService){promoted.push(this.vault.root)})
 let release!:(value:unknown)=>void;state.memoryResult=new Promise(r=>release=r)
 const session=(await invoke(IPC.vaultGet)).sessionId
 const old=invoke(IPC.memoryItemDisable,{session,args:[{sessionId:session}]}).then(()=>null,(e:Error)=>e.message)
 await invoke(IPC.vaultOpen,catalog.inspect(b).id!)
 release({ok:true,value:{}})
 try{expect(await old).toBe('VAULT_CHANGED');expect(promoted).toEqual([]);expect(state.rechecks).toEqual([])}finally{spy.mockRestore()}
})
it('a suspended picker excludes vaultOpen and a second picker without stopping the old task',async()=>{
 state.active=true
 let release!:(value:unknown)=>void;state.open.mockReturnValue(new Promise(r=>release=r))
 const picking=invoke(IPC.vaultPick,false)
 const opening=invoke(IPC.vaultOpen,catalog.inspect(b).id!).then(()=>null,(e:Error)=>e.message)
 const second=invoke(IPC.vaultPick,false).then(()=>null,(e:Error)=>e.message)
 release({canceled:true,filePaths:[]});await picking
 expect(await opening).toBe('VAULT_SWITCH_BUSY');expect(await second).toBe('VAULT_SWITCH_BUSY');expect(state.open).toHaveBeenCalledTimes(1);expect(state.stopped).toBe(0);expect(state.active).toBe(true)
})
it('a suspended relocate picker excludes opening its target as active',async()=>{
 let release!:(value:unknown)=>void;state.open.mockReturnValue(new Promise(r=>release=r));const entry=catalog.inspect(b)
 const relocating=invoke(IPC.vaultCatalogChange,{action:'relocate',id:entry.id,revision:catalog.view().revision})
 const opening=invoke(IPC.vaultOpen,entry.id).then(()=>null,(e:Error)=>e.message)
 release({canceled:true,filePaths:[]});await relocating;expect(await opening).toBe('VAULT_SWITCH_BUSY')
})
it('rejects a nested create before touching the old vault directory',async()=>{
 const child=path.join(a,'Sub');state.save.mockResolvedValue({canceled:false,filePath:child})
 await expect(invoke(IPC.vaultPick,true)).rejects.toThrow('VAULT_NESTED');expect(fs.existsSync(child)).toBe(false);expect((await invoke(IPC.vaultGet)).rootName).toBe('A')
})
it('reports the actual new target after watcher initialization failure',async()=>{
 state.watchFailure=fs.realpathSync(b);const entry=catalog.update(catalog.inspect(b).id!,{label:'新库'},catalog.view().revision).entries.find(e=>e.path===fs.realpathSync(b))!
 const result=await invoke(IPC.vaultOpen,entry.id).catch(()=>invoke(IPC.vaultGet))
 expect(result).toMatchObject({status:'ready',rootName:'新库',vaultId:entry.id,diagnostic:expect.any(String)})
})
it.each(['maintenance','get','reasoning'] as const)('a late ledger %s read cannot call the next operation in the new root',async operation=>{
 const {VaultSession}=await import('../../src/main/vault.ts')
 const session=(await invoke(IPC.vaultGet)).sessionId
 const snapshot={content:'body',revision:'revision',objectVersion:'old-object',sessionId:session}
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 let delayed=false
 vi.spyOn(VaultSession.prototype,'read').mockImplementation(async()=>{if(delayed){entered();await gate}return snapshot})
 vi.spyOn(VaultSession.prototype,'ledgerMaintenancePreview').mockResolvedValue({records:[{taskId:'task',revision:1}]} as any)
 const roots:(string|null)[]=[]
 vi.spyOn(VaultSession.prototype,'ledgerMaintenanceCommit').mockImplementation(async function(this:import('../../src/main/vault.ts').VaultSession){roots.push(this.root);return {failed:[],processed:['task']} as any})
 vi.spyOn(VaultSession.prototype,'ledgerPage').mockImplementation(async function(this:import('../../src/main/vault.ts').VaultSession){roots.push(this.root);return {} as any})
 vi.spyOn(VaultSession.prototype,'ledgerRecord').mockImplementation(async function(this:import('../../src/main/vault.ts').VaultSession){roots.push(this.root);return {state:'cleared'} as any})
 const r={sessionId:session,objectVersion:'old-object',relPath:'same.md',action:'clear'}
 let channel:string=IPC.ledgerGet,request:unknown={sessionId:session,objectVersion:'old-object',relPath:'same.md'}
 if(operation==='maintenance'){
  channel=IPC.ledgerMaintenance;const preview=await invoke(channel,{session,args:[r]});request={...r,previewId:preview.value.id}
 }else if(operation==='reasoning'){channel=IPC.ledgerReasoning;request={sessionId:session,objectVersion:'old-object',relPath:'same.md',taskId:'task'}}
 delayed=true
 const old=invoke(channel,{session,args:[request]}).then(()=>null,(e:Error)=>e.message)
 await started;await invoke(IPC.vaultOpen,catalog.inspect(b).id!);release()
 try{expect(await old).toBe('VAULT_CHANGED');expect(roots).toEqual([])}finally{vi.restoreAllMocks()}
})
it.each(['inspect','abandon'] as const)('late note %s does not stop a same-name task in B',async operation=>{
 const {VaultSession}=await import('../../src/main/vault.ts');const session=(await invoke(IPC.vaultGet)).sessionId
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 const spy=vi.spyOn(VaultSession.prototype,'noteStatus').mockImplementation(async()=>{entered();await gate;return {status:'missing',sessionId:session,relPath:'same.md',objectVersion:'old'}})
 const old=invoke(operation==='inspect'?IPC.noteInspect:IPC.noteAbandon,{session,args:[{sessionId:session,relPath:'same.md',objectVersion:'old'}]}).then(()=>null,(e:Error)=>e.message)
 await started;await invoke(IPC.vaultOpen,catalog.inspect(b).id!);state.tasks=[{id:'B-task',root:fs.realpathSync(b),relPath:'same.md'}];release()
 try{expect(await old).toBe('VAULT_CHANGED');expect(state.cancelled).toEqual([])}finally{spy.mockRestore()}
})
it('late note save receipt does not request retryPending for B',async()=>{
 const {VaultSession}=await import('../../src/main/vault.ts');const session=(await invoke(IPC.vaultGet)).sessionId
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 const spy=vi.spyOn(VaultSession.prototype,'write').mockImplementation(async()=>{entered();await gate;return {sessionId:session,revision:'r',objectVersion:'o'}})
 const old=invoke(IPC.noteWrite,{session,args:[{sessionId:session,relPath:'same.md',objectVersion:'old',content:'body',expectedRevision:'a'.repeat(64)}]}).then(()=>null,(e:Error)=>e.message)
 await started;await invoke(IPC.vaultOpen,catalog.inspect(b).id!);const before=[...state.retried];release()
 try{expect(await old).toBe('VAULT_CHANGED');expect(state.retried).toEqual(before)}finally{spy.mockRestore()}
})
it('authorization preview cannot read B after the previous chapter read is delayed',async()=>{
 const {VaultSession}=await import('../../src/main/vault.ts'),{TaskAuthorizationRegistry}=await import('../../src/main/task-authorization.ts'),session=(await invoke(IPC.vaultGet)).sessionId
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),roots:(string|null)[]=[]
 vi.spyOn(TaskAuthorizationRegistry.prototype,'preview').mockResolvedValue({id:'preview',sources:[{relPath:'same.md'}]} as any)
 vi.spyOn(VaultSession.prototype,'ledgerContexts').mockImplementation(async()=>{entered();await gate;return []})
 vi.spyOn(VaultSession.prototype,'read').mockImplementation(async function(this:import('../../src/main/vault.ts').VaultSession){this.captureSession();roots.push(this.root);return {sessionId:session,content:'body',revision:'r',objectVersion:'o'}})
 const request={sessionId:session,relPath:'same.md',objectVersion:'old',expectedRevision:'a'.repeat(64),modelRecordId:'model',range:{start:0,end:3},expectedText:'/go',promptText:'go',references:[]}
 const old=invoke(IPC.agentAuthorizationPreview,{session,args:[request]}).then(()=>null,(e:Error)=>e.message)
 await started;await invoke(IPC.vaultOpen,catalog.inspect(b).id!);release()
 try{expect(await old).toBe('VAULT_CHANGED');expect(roots).toEqual([])}finally{vi.restoreAllMocks()}
})
it('a new-root watcher notification cannot re-read B for an old image controller before cleanup',async()=>{
 const {VaultSession}=await import('../../src/main/vault.ts'),{RemoteImageService}=await import('../../src/main/remote-image.ts'),source=await import('../../src/main/image-source.ts'),session=(await invoke(IPC.vaultGet)).sessionId
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),roots:(string|null)[]=[]
 vi.spyOn(VaultSession.prototype,'read').mockImplementation(async function(this:import('../../src/main/vault.ts').VaultSession){this.captureSession();roots.push(this.root);return {sessionId:this.captureSession(),content:'![x](https://image.test/x.png)',revision:'r',objectVersion:'o'}})
 vi.spyOn(source,'verifyImageSource').mockReturnValue({ok:true,binding:'verified'} as any)
 vi.spyOn(RemoteImageService.prototype,'load').mockImplementation(async()=>{entered();await gate;return {ok:false,error:'UNAVAILABLE'} as any})
 const open=VaultSession.prototype.openVerified
 vi.spyOn(VaultSession.prototype,'openVerified').mockImplementation(async function(this:import('../../src/main/vault.ts').VaultSession,...args){const result=await open.apply(this,args);(this as any).emit(IPC.treeChanged);return result})
 const old=invoke(IPC.remoteImageGet,{session,args:[{url:'https://image.test/x.png',context:{sessionId:session,noteRelPath:'same.md',objectVersion:'o',revision:'r'},mode:'default'}]}).then(()=>null,(e:Error)=>e.message)
 await started;await invoke(IPC.vaultOpen,catalog.inspect(b).id!);release()
 try{expect(await old).toBe('VAULT_CHANGED');expect(roots).toEqual([fs.realpathSync(a)])}finally{vi.restoreAllMocks()}
})

it('passes a captured production frame check to the existing memory IPC handler',async()=>{
 const session=(await invoke(IPC.vaultGet)).sessionId
 await invoke(IPC.memoryGet,{session,args:[{sessionId:session}]})
 expect(state.memoryOwnerCheck).toBeTypeOf('function');expect(()=>state.memoryOwnerCheck!()).not.toThrow()
 state.trusted=false;expect(()=>state.memoryOwnerCheck!()).toThrow('MEMORY_SESSION_CLOSED')
})
