// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {start} from '../../src/renderer/src/shell.ts'
const editorHarness=vi.hoisted(()=>({text:'',change:null as ((text:string)=>void)|null}))
vi.mock('../../src/renderer/src/view/editor.ts',()=>({mountEditor:(_root:HTMLElement,change:(text:string)=>void)=>{editorHarness.change=change;
 const dom=document.createElement('div'),scrollDOM=document.createElement('div');let text=''
 return {view:{dom,contentDOM:dom,scrollDOM,compositionStarted:false},getText:()=>editorHarness.text,setText:(v:string)=>{text=v;editorHarness.text=v},setReadOnly:()=>{},setTheme:()=>{},setActiveTaskIds:()=>{},setNoteHost:()=>{},onStateChange:()=>{},focus:()=>{},selectionRange:()=>({anchor:0,head:0}),selectionInfo:()=>({line:1,column:1}),headings:()=>[],viewport:()=>({from:0,to:0}),caret:()=>0,markers:()=>[]}
}}))
vi.mock('../../src/renderer/src/view/read-only.ts',()=>({renderReadOnlyMarkdown:()=>{},disposeReadOnlyImages:()=>{}}))
let handlers:Record<string,Function>,api:any,root:HTMLElement
beforeEach(()=>{
 handlers={};vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}})
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(){this.setAttribute('open','')}})
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(){this.removeAttribute('open');this.dispatchEvent(new Event('close'))}})
 const fallback=async()=>null
 api=new Proxy({vaultGet:async()=>({status:'ready',sessionId:'old',rootName:'old'}),vaultWorkspaceGet:async()=>null,vaultWorkspaceSave:vi.fn(async()=>true),treeList:async()=>[],backlinks:async()=>[],permissionsGet:async()=>({status:'ready',entries:[]}),lifecycleStatus:async()=>({status:'ready',sessionId:'old'}),modelConfigGet:async()=>({ok:false}),memoryGet:async()=>({ok:false}),flushDone:vi.fn(),lifecycleFlushDone:vi.fn(),vaultTransitionDone:vi.fn(async()=>true),onMenu:(channel:string,fn:Function)=>{handlers[channel]=fn}}, {get:(target,key:string)=>key in target?(target as any)[key]:key.startsWith('on')?(fn:Function)=>{handlers[key]=fn;return()=>{}}:fallback})
 window.rgent=api;root=document.createElement('main');document.body.append(root)
})
afterEach(()=>{document.body.replaceChildren();vi.unstubAllGlobals()})
it('real shell refuses native close and switch flush when workspace persistence returns false or throws',async()=>{
 await start(root)
 for(const write of [async()=>false,async()=>{throw Error('disk')}]){
  api.vaultWorkspaceSave.mockImplementation(write);handlers.onFlushRequest();await vi.waitFor(()=>expect(api.flushDone).toHaveBeenCalledWith({ok:false}));api.flushDone.mockClear()
  handlers.onLifecycleFlushRequest('switch',[]);await vi.waitFor(()=>expect(api.lifecycleFlushDone).toHaveBeenCalledWith('switch',false));api.lifecycleFlushDone.mockClear()
 }
 expect(root.textContent).toContain('工作区位置未保存')
})
it('real shell restores every tab before acknowledging the new transition',async()=>{
 await start(root);let finish!:(v:any)=>void
 api.vaultGet=async()=>({status:'ready',sessionId:'new',rootName:'new',vaultChanged:true})
 api.lifecycleStatus=async()=>({status:'ready',sessionId:'new'})
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:'one.md'},{relPath:'two.md'}],active:'one.md',sidebarHidden:true,treeScroll:0,resourceScroll:0})
 api.noteRead=vi.fn((path:string)=>path==='one.md'?new Promise(r=>{finish=r}):Promise.resolve({content:'two',revision:'2',objectVersion:'two',sessionId:'new'}))
 handlers.onVaultTransition(true,'new',{busy:true,session:'new',phase:'restoring',restoreId:'transition'})
 await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));expect(api.vaultTransitionDone).not.toHaveBeenCalled();expect(root.inert).toBe(true)
 finish({content:'one',revision:'1',objectVersion:'one',sessionId:'new'})
 await vi.waitFor(()=>expect(api.vaultTransitionDone).toHaveBeenCalledWith({id:'transition',sessionId:'new',outcome:'ready'}))
 expect(api.noteRead).toHaveBeenCalledTimes(2);expect(root.querySelectorAll('.tab')).toHaveLength(2)
 handlers.onVaultTransition(false,'new',{busy:false,session:'new',phase:'idle'});expect(root.inert).toBe(false)
})
it('restore timeout reports diagnosis, preserves saved positions and refuses late tab mutation',async()=>{
 await start(root);vi.useFakeTimers();try{
 let finish!:(v:any)=>void
 api.vaultGet=async()=>({status:'ready',sessionId:'new',rootName:'new',vaultChanged:true})
 api.lifecycleStatus=async()=>({status:'ready',sessionId:'new'})
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:'slow.md'}],active:'slow.md',sidebarHidden:true,treeScroll:0,resourceScroll:0})
 api.noteRead=()=>new Promise(r=>{finish=r})
 handlers.onVaultTransition(true,'new',{busy:true,session:'new',phase:'restoring',restoreId:'slow'})
 await vi.advanceTimersByTimeAsync(10_001)
 expect(api.vaultTransitionDone).toHaveBeenCalledWith({id:'slow',sessionId:'new',outcome:'diagnosed'})
 handlers.onVaultTransition(false,'new',{busy:false,session:'new',phase:'idle'})
 expect(root.textContent).toContain('重试恢复位置');expect(root.inert).toBe(false)
 finish({content:'late',revision:'1',objectVersion:'slow',sessionId:'new'});await vi.advanceTimersByTimeAsync(1)
 expect(root.querySelectorAll('.tab')).toHaveLength(0);handlers.onFlushRequest();await vi.advanceTimersByTimeAsync(1)
 expect(api.flushDone).toHaveBeenCalledWith({ok:false});expect(api.vaultWorkspaceSave).not.toHaveBeenCalled()
 }finally{vi.useRealTimers()}
})
it('late preparation freeze cannot resurrect a released or newer interaction gate',async()=>{
 await start(root)
 handlers.onVaultTransition(true,'old',{busy:true,session:'old',phase:'preparing',operationId:'first'})
 handlers.onVaultTransition(false,'old',{busy:false,session:'old',phase:'idle'})
 handlers.onLifecycleFlushRequest('late',[],'freeze',{sessionId:'old',operationId:'first'})
 expect(root.inert).toBe(false);expect(api.lifecycleFlushDone).toHaveBeenCalledWith('late',false)
 handlers.onVaultTransition(true,'old',{busy:true,session:'old',phase:'preparing',operationId:'second'})
 handlers.onLifecycleFlushRequest('late-again',[],'freeze',{sessionId:'old',operationId:'first'})
 expect(api.lifecycleFlushDone).toHaveBeenCalledWith('late-again',false)
 handlers.onVaultTransition(false,'old',{busy:false,session:'old',phase:'idle'})
})
it('a committed new root diagnosis retains its actual session for the close handoff',async()=>{
 await start(root)
 api.vaultGet=async()=>({status:'needs-pick',reason:'missing',sessionId:'new',diagnostic:'新库根暂不可核验'})
 handlers.onVaultTransition(true,'new',{busy:true,session:'new',phase:'restoring',restoreId:'diagnosis'})
 await vi.waitFor(()=>expect(api.vaultTransitionDone).toHaveBeenCalledWith({id:'diagnosis',sessionId:'new',outcome:'diagnosed'}))
 handlers.onVaultTransition(false,'new',{busy:false,session:'new',phase:'idle'})
 expect(root.inert).toBe(false)
})
it('real draft conflict during switching preserves both bodies and settings fold, name and focus',async()=>{
 let disk='original'
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:'one.md'}],active:'one.md',sidebarHidden:true,treeScroll:0,resourceScroll:0})
 api.noteRead=async()=>({content:disk,revision:disk,objectVersion:'object',sessionId:'old'})
 api.noteInspect=async()=>({status:'ready',snapshot:await api.noteRead()})
 api.noteWrite=vi.fn(async()=>({ok:false,error:'CONFLICT'}))
 api.vaultCatalog=async()=>({revision:'r1',diagnostic:null,lastVaultId:'a',activeId:'a',entries:[{id:'a',label:'本库',path:'/a',rootIdentity:'a',pinned:false,lastUsed:1},{id:'b',label:'其它库',path:'/b',rootIdentity:'b',pinned:false,lastUsed:0}]})
 api.vaultOpen=async()=>{handlers.onLifecycleFlushRequest('body',[]);await vi.waitFor(()=>expect(api.lifecycleFlushDone).toHaveBeenCalledWith('body',false));throw Error('UNSAVED_DRAFT')}
 await start(root);editorHarness.text='window draft';editorHarness.change!('window draft');disk='disk draft'
 handlers['menu:open-vault']();await vi.waitFor(()=>expect(document.querySelector('[data-vault-id="a"]')).not.toBeNull())
 const row=document.querySelector<HTMLElement>('[data-vault-id="a"]')!
 row.querySelector<HTMLButtonElement>('[data-vault-action="edit-name"]')!.click()
 const input=row.querySelector<HTMLInputElement>('input')!,fold=row.querySelector<HTMLDetailsElement>('details')!
 fold.open=true;input.value='name draft';input.dispatchEvent(new Event('input'));input.focus();input.setSelectionRange(1,3)
 document.querySelector<HTMLButtonElement>('[data-vault-open="b"]')!.click()
 await vi.waitFor(()=>expect(document.querySelector('.vault-settings')!.textContent).toContain('窗口稿与磁盘稿发生冲突'))
 expect(editorHarness.text).toBe('window draft');expect(disk).toBe('disk draft');expect(document.querySelectorAll('dialog[open]')).toHaveLength(1)
 expect(input.value).toBe('name draft');expect(fold.open).toBe(true);expect(document.activeElement).toBe(input);expect([input.selectionStart,input.selectionEnd]).toEqual([1,3])
})
it('an old restore completion cannot acknowledge or unlock a newer restoration gate',async()=>{
 await start(root)
 let session='first',first!:(v:any)=>void,second!:(v:any)=>void
 api.vaultGet=async()=>({status:'ready',sessionId:session,rootName:session,vaultChanged:true})
 api.lifecycleStatus=async()=>({status:'ready',sessionId:session})
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:session+'.md'}],active:session+'.md',sidebarHidden:true,treeScroll:0,resourceScroll:0})
 api.noteRead=(relPath:string)=>new Promise(r=>{if(relPath==='first.md')first=r;else second=r})
 handlers.onVaultTransition(true,'first',{busy:true,session:'first',phase:'restoring',restoreId:'first'})
 await vi.waitFor(()=>expect(first).toBeTypeOf('function'));session='second'
 handlers.onVaultTransition(true,'second',{busy:true,session:'second',phase:'restoring',restoreId:'second'})
 await vi.waitFor(()=>expect(second).toBeTypeOf('function'));first({content:'old',revision:'r',objectVersion:'o',sessionId:'first'})
 await Promise.resolve();await Promise.resolve();expect(root.inert).toBe(true);expect(api.vaultTransitionDone).not.toHaveBeenCalled();expect(root.querySelectorAll('.tab')).toHaveLength(0)
 second({content:'new',revision:'r',objectVersion:'o',sessionId:'second'})
 await vi.waitFor(()=>expect(api.vaultTransitionDone).toHaveBeenCalledWith({id:'second',sessionId:'second',outcome:'ready'}))
 expect(api.vaultTransitionDone).toHaveBeenCalledTimes(1);expect(root.querySelector('.tab')?.textContent).toContain('second')
})
