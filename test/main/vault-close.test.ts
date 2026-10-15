import {afterEach,beforeEach,it,expect,vi} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {VaultCatalog} from '../../src/main/vault-catalog.ts'
import {IPC} from '../../src/shared/ipc.ts'
const state=vi.hoisted(()=>({data:'',handles:new Map<string,Function>(),listeners:new Map<string,Function>(),win:null as any,app:null as any,send:null as ((channel:string,args:any[])=>void)|null}))
vi.mock('electron',async()=>{
 const {EventEmitter}=await import('node:events')
 const app=Object.assign(new EventEmitter(),{isPackaged:true,getPath:()=>state.data,requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),quit:vi.fn()});state.app=app
 class BrowserWindow extends EventEmitter{
  destroyed=false
  webContents=Object.assign(new EventEmitter(),{id:1,mainFrame:{routingId:10,url:'',detached:false,isDestroyed:()=>false},isDestroyed:()=>false,getURL:()=>this.webContents.mainFrame.url,send:vi.fn((channel:string,...args:any[])=>state.send?.(channel,args)),setWindowOpenHandler:()=>{}})
  constructor(_options:any){super();state.win=this}
  static getAllWindows(){return state.win&&!state.win.destroyed?[state.win]:[]}
  isDestroyed(){return this.destroyed}
  loadFile(file:string){this.webContents.mainFrame.url=new URL('file://'+file).href;return Promise.resolve()}
  loadURL(url:string){this.webContents.mainFrame.url=url;return Promise.resolve()}
  close(){const event={preventDefault:vi.fn()};this.emit('close',event);if(!event.preventDefault.mock.calls.length){this.destroyed=true;this.emit('closed')}}
 }
 return {app,BrowserWindow,ipcMain:{handle:(name:string,fn:Function)=>state.handles.set(name,fn),on:(name:string,fn:Function)=>state.listeners.set(name,fn)},Menu:{buildFromTemplate:(v:any)=>v,setApplicationMenu:()=>{}},nativeTheme:Object.assign(new EventEmitter(),{shouldUseDarkColors:false}),protocol:{registerSchemesAsPrivileged:()=>{},handle:()=>{}},safeStorage:{isEncryptionAvailable:()=>false},shell:{openExternal:vi.fn()},dialog:{showMessageBox:vi.fn(async()=>({response:1})),showOpenDialog:vi.fn()}}
})
let root:string,bId:string
const event=()=>({sender:state.win.webContents,senderFrame:state.win.webContents.mainFrame})
const invoke=(name:string,...args:any[])=>state.handles.get(name)!(event(),...args)
beforeEach(async()=>{
 vi.resetModules();state.handles.clear();state.listeners.clear();state.send=null
 root=fs.mkdtempSync(path.join(os.tmpdir(),'rgent-e-close-'));state.data=path.join(root,'device');fs.mkdirSync(state.data)
 const a=path.join(root,'a'),b=path.join(root,'b');fs.mkdirSync(a);fs.mkdirSync(b)
 const catalog=new VaultCatalog(state.data);catalog.committed(catalog.inspect(a));bId=catalog.register(catalog.inspect(b)).id
 await import('../../src/main/index.ts');await vi.waitFor(()=>expect(state.win).toBeTruthy())
 state.send=(channel,args)=>{
  if(channel===IPC.lifecycleFlushRequest)state.listeners.get(IPC.lifecycleFlushDone)!(event(),{id:args[0],ok:true})
 }
})
afterEach(()=>{state.app.emit('will-quit');state.win?.emit('closed');state.win=null;fs.rmSync(root,{recursive:true,force:true});vi.useRealTimers()})
it('actual main native close hook defers repeated close until a trusted restoration receipt',async()=>{
 const result=await invoke(IPC.vaultOpen,bId);expect(result.restoreId).toBeTypeOf('string')
 state.win.webContents.send.mockClear();state.win.close();state.win.close()
 expect(state.win.isDestroyed()).toBe(false);expect(state.win.webContents.send.mock.calls.filter((v:any[])=>v[0]===IPC.flushRequest)).toHaveLength(0)
 expect(await invoke(IPC.vaultTransition,{id:result.restoreId,sessionId:'wrong',outcome:'ready'})).toBe(false)
 expect(await invoke(IPC.vaultTransition,{id:result.restoreId,sessionId:result.sessionId,outcome:'ready'})).toBe(true)
 await vi.waitFor(()=>expect(state.win.webContents.send.mock.calls.filter((v:any[])=>v[0]===IPC.flushRequest)).toHaveLength(1))
 state.listeners.get(IPC.flushDone)!(event(),{ok:true});expect(state.win.isDestroyed()).toBe(true)
})
it('actual main preparation close cancels switching without starting a concurrent flush',async()=>{
 let pending:any[]|null=null
 state.send=(channel,args)=>{if(channel===IPC.lifecycleFlushRequest)pending=args}
 const old=await invoke(IPC.vaultGet),work=invoke(IPC.vaultOpen,bId).catch((e:Error)=>e)
 await vi.waitFor(()=>expect(pending).not.toBeNull());state.win.webContents.send.mockClear();state.win.close();state.win.close()
 const concurrent=state.win.webContents.send.mock.calls.filter((v:any[])=>v[0]===IPC.flushRequest).length
 state.send=(channel,args)=>{if(channel===IPC.lifecycleFlushRequest)state.listeners.get(IPC.lifecycleFlushDone)!(event(),{id:args[0],ok:true})}
 state.listeners.get(IPC.lifecycleFlushDone)!(event(),{id:pending![0],ok:true});const result=await work
 expect(concurrent).toBe(0);expect(result).toBeInstanceOf(Error);expect(result.message).toContain('VAULT_SWITCH_CANCELLED')
 expect((await invoke(IPC.vaultGet)).sessionId).toBe(old.sessionId)
 await vi.waitFor(()=>expect(state.win.webContents.send.mock.calls.filter((v:any[])=>v[0]===IPC.flushRequest)).toHaveLength(1))
 state.listeners.get(IPC.flushDone)!(event(),{ok:true})
})
it('actual main restoration timeout offers retry, cancels close and rejects the retired receipt',async()=>{
 vi.useFakeTimers();const result=await invoke(IPC.vaultOpen,bId);state.win.close()
 const electron=await import('electron');await vi.advanceTimersByTimeAsync(30_001)
 expect(electron.dialog.showMessageBox).toHaveBeenCalled()
 const retry=state.win.webContents.send.mock.calls.findLast((v:any[])=>v[0]===IPC.vaultTransition&&v[1]?.restoreId)?.[1]
 expect(retry.restoreId).not.toBe(result.restoreId)
 expect(await invoke(IPC.vaultTransition,{id:result.restoreId,sessionId:result.sessionId,outcome:'ready'})).toBe(false)
 expect(await invoke(IPC.vaultTransition,{id:retry.restoreId,sessionId:result.sessionId,outcome:'diagnosed'})).toBe(true)
 expect(state.win.webContents.send.mock.calls.filter((v:any[])=>v[0]===IPC.flushRequest)).toHaveLength(0)
 state.win.close();await vi.waitFor(()=>expect(state.win.webContents.send.mock.calls.filter((v:any[])=>v[0]===IPC.flushRequest)).toHaveLength(1))
 state.listeners.get(IPC.flushDone)!(event(),{ok:true})
})
it('restoration receipt remains bound to the original frame object even if routing id is reused',async()=>{
 const result=await invoke(IPC.vaultOpen,bId),original=state.win.webContents.mainFrame
 state.win.webContents.mainFrame={...original}
 expect(await invoke(IPC.vaultTransition,{id:result.restoreId,sessionId:result.sessionId,outcome:'ready'})).toBe(false)
 state.win.webContents.mainFrame=original
 expect(await invoke(IPC.vaultTransition,{id:result.restoreId,sessionId:result.sessionId,outcome:'ready'})).toBe(true)
})
