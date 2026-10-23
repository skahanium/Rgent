import {afterEach,beforeEach,it,expect,vi} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {VaultCatalog} from '../../src/main/vault-catalog.ts'
import {IPC} from '../../src/shared/ipc.ts'
import { draftRequest, draftSource } from './draft-fixture.ts'
const state=vi.hoisted(()=>({
  data:'',handles:new Map<string,Function>(),listeners:new Map<string,Function>(),
  win:null as any,app:null as any,send:null as ((channel:string,args:any[])=>void)|null,
  launch:Promise.resolve(),settled:0,stopped:0,started:0,cancels:[] as string[],
  tasks:[] as {id:string;root:string;relPath:string}[],pending:[] as any[]
}))
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
vi.mock('../../src/main/agent-host.ts',()=>({AgentHost:class{
 constructor(){}
 active=()=>state.tasks
 hasPending=()=>state.pending.length>0
 whenLaunchesSettled=async()=>{state.settled++;await state.launch}
 cancelAll=async(reason:string)=>{state.cancels.push(reason);state.stopped++;state.tasks=[]}
 start=async()=>{state.started++;return {id:'new',done:Promise.resolve({status:'completed'})}}
 cancel=async()=>null
 retryPending=async()=>{}
 discardPending=()=>{state.pending=[]}
 recheckSources=async()=>{}
 pendingChapters=()=>state.pending
 pendingPaths=()=>[]
 acknowledgeCopied=()=>{}
}}))
let root:string
const event=()=>({sender:state.win.webContents,senderFrame:state.win.webContents.mainFrame})
const invoke=(name:string,...args:any[])=>state.handles.get(name)!(event(),...args)
// R3 之前 index.ts 仍按旧 level 校验；本轮带上 scope，两边都指向同一请求。
const startRequest={previewId:'preview',scope:'vault' as const,level:'write' as const,relPath:'a.md',...draftRequest(draftSource('问').source,'问'),modelRecordId:'m1',sessionId:'s',objectVersion:'o',expectedRevision:'r'}
beforeEach(async()=>{
 vi.resetModules();state.handles.clear();state.listeners.clear();state.send=null
 state.launch=Promise.resolve();state.settled=0;state.stopped=0;state.started=0;state.cancels=[];state.tasks=[];state.pending=[]
 root=fs.mkdtempSync(path.join(os.tmpdir(),'rgent-host-close-'));state.data=path.join(root,'device');fs.mkdirSync(state.data)
 const a=path.join(root,'a');fs.mkdirSync(a)
 new VaultCatalog(state.data).committed(new VaultCatalog(state.data).inspect(a))
 await import('../../src/main/index.ts');await vi.waitFor(()=>expect(state.win).toBeTruthy())
 state.send=(channel,args)=>{
  if(channel===IPC.lifecycleFlushRequest)state.listeners.get(IPC.lifecycleFlushDone)!(event(),{id:args[0],ok:true})
 }
})
afterEach(()=>{state.app.emit('will-quit');state.win?.emit('closed');state.win=null;fs.rmSync(root,{recursive:true,force:true})})

it('waits for launching, then cancelAll(close), and rejects agentStart while closing',async()=>{
 let release!:()=>void
 state.launch=new Promise<void>(resolve=>{release=resolve})
 state.win.close()
 await vi.waitFor(()=>expect(state.settled).toBe(1))
 expect(state.stopped).toBe(0)
 expect(state.cancels).toEqual([])
 const session=(await invoke(IPC.vaultGet)).sessionId
 expect(await invoke(IPC.agentStart,{session,args:[startRequest]})).toEqual({ok:false,error:'NOTE_BUSY'})
 expect(state.started).toBe(0)
 release()
 await vi.waitFor(()=>expect(state.stopped).toBe(1))
 expect(state.cancels).toEqual(['close'])
 expect(state.settled).toBeGreaterThanOrEqual(2)
 await vi.waitFor(()=>expect(state.win.webContents.send.mock.calls.filter((v:any[])=>v[0]===IPC.flushRequest)).toHaveLength(1))
})
