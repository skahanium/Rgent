// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {start} from '../../src/renderer/src/shell.ts'
import {renderReadOnlyMarkdown} from '../../src/renderer/src/view/read-only.ts'
import {VaultSwitch} from '../../src/main/vault-switch.ts'
const editorHarness=vi.hoisted(()=>({text:'',change:null as ((text:string)=>void)|null,focus:vi.fn()}))
vi.mock('../../src/renderer/src/view/editor.ts',()=>({mountEditor:(_root:HTMLElement,change:(text:string)=>void)=>{editorHarness.change=change;
 const dom=document.createElement('div'),scrollDOM=document.createElement('div');let text=''
 return {view:{dom,contentDOM:dom,scrollDOM,compositionStarted:false},getText:()=>editorHarness.text,setText:(v:string)=>{text=v;editorHarness.text=v},setReadOnly:()=>{},setTheme:()=>{},setActiveTaskIds:()=>{},setNoteHost:()=>{},onStateChange:()=>{},focus:editorHarness.focus,selectionRange:()=>({anchor:0,head:0}),selectionInfo:()=>({line:1,column:1}),headings:()=>[],viewport:()=>({from:0,to:0}),caret:()=>0,markers:()=>[]}
}}))
vi.mock('../../src/renderer/src/view/read-only.ts',()=>({renderReadOnlyMarkdown:vi.fn(),disposeReadOnlyImages:()=>{}}))
let handlers:Record<string,Function>,api:any,root:HTMLElement
beforeEach(()=>{
 handlers={};vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}})
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(){this.setAttribute('open','')}})
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(){this.removeAttribute('open');this.dispatchEvent(new Event('close'))}})
 const fallback=async()=>null
 api=new Proxy({vaultGet:async()=>({status:'ready',sessionId:'old',rootName:'old'}),vaultWorkspaceGet:async()=>null,vaultWorkspaceSave:vi.fn(async()=>true),treeList:async()=>[],backlinks:async()=>[],permissionsGet:async()=>({status:'ready',entries:[]}),lifecycleStatus:async()=>({status:'ready',sessionId:'old'}),modelConfigGet:async()=>({ok:false}),memoryGet:async()=>({ok:false}),flushDone:vi.fn(),lifecycleFlushDone:vi.fn(),vaultTransitionDone:vi.fn(async()=>true),onMenu:(channel:string,fn:Function)=>{handlers[channel]=fn}}, {get:(target,key:string)=>key in target?(target as any)[key]:key.startsWith('on')?(fn:Function)=>{handlers[key]=fn;return()=>{}}:fallback})
 window.rgent=api;root=document.createElement('main');document.body.append(root)
})
afterEach(()=>{document.body.replaceChildren();vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllTimers()})
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

async function diagnosedPositionWithNotes() {
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:'one.md'},{relPath:'two.md'}],active:'one.md',sidebarHidden:true,treeScroll:0,resourceScroll:0})
 api.noteRead=async(relPath:string)=>({content:relPath,revision:'r',objectVersion:relPath,sessionId:'old'})
 api.lifecycleStatus=async()=>{throw Error('lifecycle unavailable')}
 await start(root)
 expect(root.querySelector<HTMLElement>('.workspace-recovery')!.hidden).toBe(false)
 return root.querySelector<HTMLButtonElement>('.workspace-recovery button')!
}
it('manual restore button immediately protects the query, bounds it and retains new same-session editing and reading after timeout',async()=>{
 const button=await diagnosedPositionWithNotes();let resolve!:(value:any)=>void
 api.vaultGet=()=>new Promise(r=>{resolve=r});vi.useFakeTimers();try{
 button.click();expect(root.inert).toBe(true)
 await vi.advanceTimersByTimeAsync(10_001);expect(root.inert).toBe(false)
 const second=[...root.querySelectorAll<HTMLButtonElement>('.tab')].find(b=>b.textContent?.includes('two'))!;second.click()
 editorHarness.text='new same-session draft';editorHarness.change!('new same-session draft')
 resolve({status:'ready',rootName:'old',sessionId:'old',vaultChanged:true});await vi.advanceTimersByTimeAsync(1)
 expect(editorHarness.text).toBe('new same-session draft');expect(root.querySelector('.tab[aria-selected="true"]')?.textContent).toContain('two')
 expect(root.querySelectorAll('.tab')).toHaveLength(2);expect(root.inert).toBe(false)
 }finally{vi.useRealTimers()}
})
it.each(['success','failure'] as const)('late manual restore query %s cannot reset a new vault draft or replace its notice',async outcome=>{
 const button=await diagnosedPositionWithNotes();let resolve!:(value:any)=>void,reject!:(value:any)=>void
 api.vaultGet=()=>new Promise((yes,no)=>{resolve=yes;reject=no});vi.useFakeTimers();try{
 button.click();await vi.advanceTimersByTimeAsync(10_001)
 api.vaultGet=async()=>({status:'ready',rootName:'new',sessionId:'new',vaultChanged:true})
 api.lifecycleStatus=async()=>({status:'ready',sessionId:'new'})
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:'new.md'}],active:'new.md',sidebarHidden:true,treeScroll:0,resourceScroll:0})
 api.noteRead=async(relPath:string)=>({content:'new body',revision:'r',objectVersion:relPath,sessionId:'new'})
 handlers.onVaultTransition(true,'new',{busy:true,session:'new',phase:'restoring',restoreId:'new'})
 await vi.advanceTimersByTimeAsync(1);expect(api.vaultTransitionDone).toHaveBeenCalledWith({id:'new',sessionId:'new',outcome:'ready'})
 handlers.onVaultTransition(false,'new',{busy:false,session:'new',phase:'idle'})
 editorHarness.text='new vault draft';editorHarness.change!('new vault draft')
 const notice=root.querySelector('.status-host-notice')?.textContent,positions=api.vaultWorkspaceSave.mock.calls.length
 if(outcome==='success')resolve({status:'ready',rootName:'old',sessionId:'old',vaultChanged:true});else reject(Error('old query failure'))
 await vi.advanceTimersByTimeAsync(1)
 expect(editorHarness.text).toBe('new vault draft');expect(root.querySelector('.tab')?.textContent).toContain('new')
 expect(root.querySelector('.status-host-notice')?.textContent).toBe(notice);expect(root.inert).toBe(false);expect(api.vaultWorkspaceSave.mock.calls.length).toBe(positions)
 }finally{vi.useRealTimers()}
})
it.each(['success','failure'] as const)('a newer native restore id retires an older still-pending query %s immediately',async outcome=>{
 await start(root);let firstResolve!:(value:any)=>void,firstReject!:(value:any)=>void,secondResolve!:(value:any)=>void
 let reads=0;api.vaultGet=()=>++reads===1?new Promise((yes,no)=>{firstResolve=yes;firstReject=no}):new Promise(yes=>{secondResolve=yes})
 handlers.onVaultTransition(true,'old',{busy:true,session:'old',phase:'restoring',restoreId:'R1'})
 handlers.onVaultTransition(true,'old',{busy:true,session:'old',phase:'restoring',restoreId:'R2'})
 const notice=root.querySelector('.status-host-notice')?.textContent
 const next={status:'ready',rootName:'old',sessionId:'old'}
 if(outcome==='success')firstResolve(next);else firstReject(Error('old native query failure'))
 await Promise.resolve();await Promise.resolve();await Promise.resolve()
 expect(api.vaultTransitionDone).not.toHaveBeenCalled();expect(root.querySelector('.status-host-notice')?.textContent).toBe(notice);expect(root.inert).toBe(true)
 secondResolve(next)
 await vi.waitFor(()=>expect(api.vaultTransitionDone).toHaveBeenCalledWith({id:'R2',sessionId:'old',outcome:'ready'}))
 expect(api.vaultTransitionDone).toHaveBeenCalledTimes(1)
 handlers.onVaultTransition(false,'old',{busy:false,session:'old',phase:'idle'});expect(root.inert).toBe(false)
})
it('a current manual query failure retains drafts and its enabled button can retry successfully',async()=>{
 const button=await diagnosedPositionWithNotes()
 editorHarness.text='protected existing draft';editorHarness.change!('protected existing draft')
 api.vaultGet=async()=>{throw Error('query failed')};button.click()
 await vi.waitFor(()=>expect(root.inert).toBe(false));expect(editorHarness.text).toBe('protected existing draft');expect(root.querySelector<HTMLElement>('.workspace-recovery')!.hidden).toBe(false)
 api.vaultGet=async()=>({status:'ready',rootName:'old',sessionId:'old',vaultChanged:true})
 api.lifecycleStatus=async()=>({status:'ready',sessionId:'old'});button.click();expect(root.inert).toBe(true)
 await vi.waitFor(()=>expect(root.inert).toBe(false))
 expect(editorHarness.text).toBe('protected existing draft');expect(root.querySelectorAll('.tab')).toHaveLength(2);expect(root.querySelector<HTMLElement>('.workspace-recovery')!.hidden).toBe(true)
 expect(api.vaultTransitionDone).not.toHaveBeenCalled()
})
it('a manual query returning another session diagnoses the mismatch without adopting it or resetting existing drafts',async()=>{
 const button=await diagnosedPositionWithNotes();editorHarness.text='old draft';editorHarness.change!('old draft')
 api.vaultGet=async()=>({status:'ready',rootName:'unexpected',sessionId:'other',vaultChanged:true});button.click()
 await vi.waitFor(()=>expect(root.inert).toBe(false))
 expect(editorHarness.text).toBe('old draft');expect(root.querySelectorAll('.tab')).toHaveLength(2);expect(root.querySelector('.tab[aria-selected="true"]')?.textContent).toContain('one')
 expect(root.querySelector<HTMLElement>('.workspace-recovery')!.hidden).toBe(false)
})
it('native query timeout keeps the main transition gate and a new id can recover while late failure stays retired',async()=>{
 await start(root);let reject!:(error:Error)=>void;api.vaultGet=()=>new Promise((_,no)=>{reject=no})
 vi.useFakeTimers();try{
 handlers.onVaultTransition(true,'old',{busy:true,session:'old',phase:'restoring',restoreId:'timeout-query'})
 await vi.advanceTimersByTimeAsync(10_001);expect(root.inert).toBe(true);expect(api.vaultTransitionDone).not.toHaveBeenCalled()
 api.vaultGet=async()=>({status:'ready',rootName:'old',sessionId:'old'})
 handlers.onVaultTransition(true,'old',{busy:true,session:'old',phase:'restoring',restoreId:'retry-query'})
 await vi.advanceTimersByTimeAsync(1);expect(api.vaultTransitionDone).toHaveBeenCalledWith({id:'retry-query',sessionId:'old',outcome:'ready'})
 handlers.onVaultTransition(false,'old',{busy:false,session:'old',phase:'idle'});const notice=root.querySelector('.status-host-notice')?.textContent
 reject(Error('late timeout rejection'));await vi.advanceTimersByTimeAsync(1)
 expect(root.inert).toBe(false);expect(root.querySelector('.status-host-notice')?.textContent).toBe(notice);expect(api.vaultTransitionDone).toHaveBeenCalledTimes(1)
 }finally{vi.useRealTimers()}
})

it.each([false,true])('actual retryRestore handoff then changed preserves the pending query with repeated close %s',async close=>{
 await start(root)
 const next={status:'ready' as const,sessionId:'old',rootName:'old'}
 const events:any[]=[]
 const flow=new VaultSwitch<string,typeof next>({check:()=>{},prepare:async()=>{},flush:async()=>true,commit:async()=>next,
  release:()=>handlers.onVaultTransition(false,'old',{busy:false,session:'old',phase:'idle'}),
  changed:(phase,closePending,operationId)=>{const event={busy:true,session:'old',phase,closePending,operationId};events.push(event);handlers.onVaultTransition(true,'old',event)},
  handoff:(result,id,_owner,retry)=>{if(retry){const event={busy:true,session:'old',phase:'restoring',restoreId:id};events.push(event);handlers.onVaultTransition(true,'old',event)}return{result,sessionId:'old'}}})
 // The initial commit receipt was lost; main is still holding restoration.
 await flow.run('old','frame');events.length=0
 let finish!:(value:typeof next)=>void;api.vaultGet=()=>new Promise(resolve=>{finish=resolve})
 expect(flow.retryRestore()).toBe(true)
 const id=events[0].restoreId
 expect(events.slice(0,2)).toEqual([{busy:true,session:'old',phase:'restoring',restoreId:id},
  {busy:true,session:'old',phase:'restoring',closePending:false,operationId:flow.operationId}])
 if(close){expect(flow.requestClose()).toBe(true);expect(flow.requestClose()).toBe(true);expect(events.at(-1).closePending).toBe(true)}
 expect(root.inert).toBe(true);finish(next)
 await vi.waitFor(()=>expect(api.vaultTransitionDone).toHaveBeenCalledWith({id,sessionId:'old',outcome:'ready'}))
 expect(api.vaultTransitionDone).toHaveBeenCalledTimes(1);expect(root.inert).toBe(true)
 expect(flow.restored('frame',{id,sessionId:'old',outcome:'ready'},'old')).toBe(true);expect(root.inert).toBe(false)
})

it.each(['preparing','operation','session'] as const)('a proven new %s update retires a pending query without releasing its new gate',async change=>{
 await start(root);let finish!:(value:any)=>void;api.vaultGet=()=>new Promise(resolve=>{finish=resolve})
 handlers.onVaultTransition(true,'old',{busy:true,session:'old',phase:'preparing',operationId:'O1'})
 handlers.onVaultTransition(true,'old',{busy:true,session:'old',phase:'restoring',restoreId:'R1'})
 const session=change==='session'?'new':'old'
 handlers.onVaultTransition(true,session,{busy:true,session,phase:change==='preparing'?'preparing':'restoring',operationId:change==='operation'?'O2':'O1'})
 const notice=root.querySelector('.status-host-notice')?.textContent
 finish({status:'ready',rootName:'old',sessionId:'old'})
 await Promise.resolve();await Promise.resolve();await Promise.resolve()
 expect(api.vaultTransitionDone).not.toHaveBeenCalled();expect(root.inert).toBe(true);expect(root.querySelector('.status-host-notice')?.textContent).toBe(notice)
 handlers.onVaultTransition(false,'old',{busy:false,session:'old',phase:'idle'});expect(root.inert).toBe(false)
})

it('resumes automatic draft saving when the latest lifecycle query completes after recovery release',async()=>{
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:'one.md'}],active:'one.md',sidebarHidden:true,treeScroll:0,resourceScroll:0})
 api.noteRead=async()=>({content:'original',revision:'before',objectVersion:'object',sessionId:'old'})
 api.noteInspect=async()=>({status:'ready',snapshot:await api.noteRead()})
 api.noteWrite=vi.fn(async()=>({ok:true,revision:'after',objectVersion:'saved',sessionId:'old'}))
 await start(root);vi.useFakeTimers()
 try{
  editorHarness.text='retained draft';editorHarness.change!('retained draft')
  api.lifecycleStatus=async()=>({status:'pending',sessionId:'old',operation:{kind:'ledger-repair'}})
  handlers.onTreeChanged();await vi.advanceTimersByTimeAsync(0)
  const context={sessionId:'old',operationId:'resume'}
  handlers.onLifecycleFlushRequest('hold',[],'recovery-resume',context);await vi.advanceTimersByTimeAsync(0)
  expect(api.lifecycleFlushDone).toHaveBeenCalledWith('hold',true)
  let releaseStatus!:(v:any)=>void,latestStatus!:(v:any)=>void
  api.lifecycleStatus=vi.fn().mockImplementationOnce(()=>new Promise(r=>{releaseStatus=r})).mockImplementationOnce(()=>new Promise(r=>{latestStatus=r})).mockResolvedValue({status:'ready',sessionId:'old'})
  handlers.onLifecycleFlushRequest('release',[],'recovery-release',context)
  handlers.onTreeChanged()
  releaseStatus({status:'ready',sessionId:'old'});await vi.advanceTimersByTimeAsync(0)
  expect(api.noteWrite).not.toHaveBeenCalled()
  latestStatus({status:'ready',sessionId:'old'});await vi.advanceTimersByTimeAsync(801)
  expect(api.noteWrite).toHaveBeenCalledWith(expect.objectContaining({content:'retained draft',sessionId:'old',objectVersion:'object'}))
  expect(root.querySelector('.tab-dirty')).toBeNull()
 }finally{vi.useRealTimers()}
})


it('ledger review shows persisted generation, reuse, omission and actual model step numbers beside the original history',async()=>{
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:'one.md'}],active:'one.md',sidebarHidden:true,treeScroll:0,resourceScroll:0})
 api.noteRead=async()=>({content:'original',revision:'r',objectVersion:'object',sessionId:'old'})
 const traces=['历史摘要已生成；元数据由程序核验','复用部分历史摘要：model@localhost','省略派生历史；原历史保留']
 const provenance={model:{modelId:'model',endpointHost:'localhost'},sources:[],tools:[{name:'search_memory',outcome:'执行 4 次，失败 0 次'},{name:'search_memory',outcome:'已执行：entry@7；摘要 有界原文 拒绝 MEMORY_SEARCH_LIMIT × 2'},{name:'search_memory',outcome:'拒绝 MEMORY_SEARCH_LIMIT × 2'},{name:'search_library',outcome:'拒绝 MEMORY_SEARCH_LIMIT × 2'}]}
 const records=[...traces.map((trace,i)=>({taskId:'task-'+i,revision:1,chapter:{startedAt:'2026-10-05',status:'completed',prompt:'原口令'+i,answer:'原回答'+i,trace:[trace,'工具 检索记忆「原查询 ：未执行（MEMORY_SEARCH_LIMIT）」：未执行（MEMORY_SEARCH_LIMIT）'],metrics:[{step:i+1}],provenance}})),{taskId:'legacy',revision:1,legacyRaw:'原始旧历史'}],originalAudit=JSON.stringify(records)
 api.ledgerGet=async()=>({ok:true,value:{records,gaps:[],cursor:null}})
 await start(root);root.querySelector<HTMLButtonElement>('.ledger-open')!.click()
 await vi.waitFor(()=>expect(root.querySelectorAll('.ledger-body details')).toHaveLength(4))
 for(const detail of root.querySelectorAll<HTMLDetailsElement>('.ledger-body details')){detail.open=true;detail.dispatchEvent(new Event('toggle'))}
 for(let i=0;i<traces.length;i++){
  const detail=root.querySelectorAll<HTMLDetailsElement>('.ledger-body details')[i]
  expect(detail?.textContent).toContain(traces[i]);expect(detail?.textContent).toContain('第 '+(i+1)+' 步');expect(detail?.textContent).toContain('原口令'+i)
  expect(renderReadOnlyMarkdown).toHaveBeenCalledWith(expect.anything(),'原回答'+i,expect.anything())
 }
 expect(root.querySelector('.ledger-body')!.textContent).toContain('本场四次记忆检索已用完')
 expect(root.querySelector('.ledger-body')!.textContent).toContain('未执行次数：2')
 expect(root.querySelector('.ledger-body')!.textContent).toContain('执行 4 次，失败 0 次')
 expect(root.querySelector('.ledger-body')!.textContent).toContain('entry@7；摘要 有界原文 拒绝 MEMORY_SEARCH_LIMIT × 2')
 expect(root.querySelector('.ledger-body')!.textContent).toContain('原查询 ：未执行（MEMORY_SEARCH_LIMIT）')
 expect(root.querySelector('.ledger-body')!.textContent).not.toContain('检索记忆 拒绝 MEMORY_SEARCH_LIMIT × 2')
 expect(root.querySelector('.ledger-body')!.textContent).not.toContain('」：未执行（MEMORY_SEARCH_LIMIT）')
 expect(root.querySelector('.ledger-body')!.textContent).toContain('search_library 拒绝 MEMORY_SEARCH_LIMIT × 2')
 expect(JSON.stringify(records)).toBe(originalAudit)
 expect(renderReadOnlyMarkdown).toHaveBeenCalledWith(expect.anything(),'原始旧历史')
})

it('unmigrated legacy history is diagnosed without claiming no history or silently migrating',async()=>{
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:'old.md'}],active:'old.md',sidebarHidden:true,treeScroll:0,resourceScroll:0})
 api.noteRead=async()=>({content:'original body',revision:'r',objectVersion:'object',sessionId:'old',ledger:{status:'unmigrated',next:'migrate'}})
 api.ledgerGet=vi.fn(async()=>({ok:true,value:{noteId:'',records:[],gaps:[],cursor:null,ownership:'unregistered'}}))
 api.ledgerMigrate=vi.fn();api.noteWrite=vi.fn()
 await start(root);root.querySelector<HTMLButtonElement>('.ledger-open')!.click()
 await vi.waitFor(()=>expect(api.ledgerGet).toHaveBeenCalled())
 const review=root.querySelector('.ledger-body')!
 expect(review.textContent).toContain('旧历史尚未迁移')
 expect(review.textContent).toContain('迁移库内旧账本')
 expect(review.textContent).toContain('原记录保留')
 expect(review.textContent).not.toContain('目前没有任务记录')
 expect(review.querySelectorAll('details')).toHaveLength(0)
 expect(api.ledgerMigrate).not.toHaveBeenCalled();expect(api.noteWrite).not.toHaveBeenCalled()
 expect(editorHarness.text).toBe('original body')
})

it('root-recovery-protect clears the window save debounce so a slow restore cannot noteWrite',async()=>{
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:'one.md'}],active:'one.md',sidebarHidden:true,treeScroll:0,resourceScroll:0})
 api.noteRead=async()=>({content:'original',revision:'r',objectVersion:'one.md',sessionId:'old'})
 api.noteWrite=vi.fn(async()=>({ok:true,revision:'saved',objectVersion:'one.md',sessionId:'old'}))
 await start(root)
 const cleared=vi.spyOn(window,'clearTimeout')
 editorHarness.text='draft';editorHarness.change!('draft')
 handlers.onVaultTransition(true,'old',{busy:true,session:'old',phase:'preparing',operationId:'root'})
 handlers.onLifecycleFlushRequest('protect',[],'root-recovery-protect',{sessionId:'old',operationId:'root'})
 await vi.waitFor(()=>expect(api.lifecycleFlushDone).toHaveBeenCalledWith('protect',true,[{relPath:'one.md',objectVersion:'one.md'}]))
 expect(cleared).toHaveBeenCalled()
 expect(api.noteWrite).not.toHaveBeenCalled()
})

it('real shell holds two old-session drafts across explicit root attach and ignores new-root same-path and late Host events',async()=>{
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:'one.md'},{relPath:'two.md'}],active:'one.md',sidebarHidden:false,treeScroll:0,resourceScroll:0})
 api.noteRead=vi.fn(async(relPath:string)=>({content:'original '+relPath,revision:'r',objectVersion:relPath,sessionId:'old'}))
 api.noteWrite=vi.fn(async()=>({ok:false,error:'VAULT_CHANGED'}))
 await start(root)
 editorHarness.text='draft one';editorHarness.change!('draft one')
 root.querySelector<HTMLElement>('.tab[data-rel="two.md"]')!.click()
 editorHarness.text='draft two';editorHarness.change!('draft two')
 handlers.onVaultTransition(true,'old',{busy:true,session:'old',phase:'preparing',operationId:'root'})
 handlers.onLifecycleFlushRequest('protect',[],'root-recovery-protect',{sessionId:'old',operationId:'root'})
 await vi.waitFor(()=>expect(api.lifecycleFlushDone).toHaveBeenCalledWith('protect',true,[{relPath:'one.md',objectVersion:'one.md'},{relPath:'two.md',objectVersion:'two.md'}]))
 expect(api.noteWrite).not.toHaveBeenCalled()
 api.vaultGet=async()=>({status:'ready',sessionId:'new',rootName:'new',vaultChanged:true,protectedSessionId:'old'})
 api.lifecycleStatus=async()=>({status:'ready',sessionId:'new'})
 api.noteRead.mockImplementation(async()=>({content:'replacement',revision:'new',objectVersion:'new-object',sessionId:'new'}))
 const reads=api.noteRead.mock.calls.length
 handlers.onVaultTransition(true,'new',{busy:true,session:'new',phase:'restoring',restoreId:'root-attach',operationId:'root'})
 await vi.waitFor(()=>expect(api.vaultTransitionDone).toHaveBeenCalledWith({id:'root-attach',sessionId:'new',outcome:'diagnosed'}))
 handlers.onVaultTransition(false,'new',{busy:false,session:'new',phase:'idle'})
 handlers.onLifecycleFlushRequest('release',[],'recovery-release',{sessionId:'old',operationId:'root'})
 handlers.onNoteExternalChange({relPath:'two.md',sessionId:'new'})
 handlers.onAgentEvent({id:'late',relPath:'two.md',sessionId:'old',status:'completed',answer:'late replacement'})
 await Promise.resolve();expect(api.noteRead.mock.calls.length).toBe(reads)
 expect(root.querySelectorAll('.tab')).toHaveLength(2);expect(editorHarness.text).toBe('draft two')
 expect(root.querySelector('.note-unavailable')?.textContent).toContain('原对象')
 api.vaultWorkspaceSave.mockClear();handlers.onFlushRequest();await vi.waitFor(()=>expect(api.flushDone).toHaveBeenCalledWith({ok:false}));expect(api.noteWrite).not.toHaveBeenCalled();expect(api.vaultWorkspaceSave).not.toHaveBeenCalled()
 ;[...root.querySelectorAll<HTMLElement>('.tab')].find(n=>n.textContent?.includes('one'))!.click();expect(editorHarness.text).toBe('draft one')
 api.noteSaveCopyPreview=vi.fn(async(r:any)=>({ok:true,preview:{...r,id:'copy-proof',pendingTaskIds:[],warning:'只保留正文'}}))
 api.noteSaveCopyCommit=vi.fn(async(r:any)=>({ok:true,relPath:'one-kept.md',snapshot:{content:r.body,sessionId:'new',revision:'copy-r',objectVersion:'copy-object'},taskIds:[]}))
 root.querySelector<HTMLButtonElement>('.note-save-copy')!.click()
 await vi.waitFor(()=>expect(document.querySelector('#new-note-name')).not.toBeNull())
 ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(n=>n.textContent==='查看预览')!.click()
 await vi.waitFor(()=>expect(document.querySelector('.save-copy-confirm')).not.toBeNull())
 document.querySelector<HTMLButtonElement>('.save-copy-confirm')!.click()
 await vi.waitFor(()=>expect(root.querySelectorAll('.tab')).toHaveLength(3))
 expect(api.noteSaveCopyPreview).toHaveBeenCalledWith(expect.objectContaining({sessionId:'new',sourceSessionId:'old',source:'one.md',body:'draft one'}))
 expect(editorHarness.text).toBe('draft one')
 api.noteAbandon=vi.fn(async()=>true);vi.spyOn(window,'confirm').mockReturnValue(true)
 ;[...root.querySelectorAll<HTMLElement>('.tab')].find(n=>n.textContent?.includes('one')&&!n.textContent.includes('kept'))!.click()
 root.querySelector<HTMLButtonElement>('.note-discard')!.click()
 await vi.waitFor(()=>expect(api.noteAbandon).toHaveBeenCalledWith({sessionId:'new',sourceSessionId:'old',relPath:'one.md',objectVersion:'one.md'}))
 await vi.waitFor(()=>expect(root.querySelectorAll('.tab')).toHaveLength(2))
 ;[...root.querySelectorAll<HTMLElement>('.tab')].find(n=>n.textContent?.includes('two'))!.click();root.querySelector<HTMLButtonElement>('.note-discard')!.click()
 await vi.waitFor(()=>expect(root.querySelectorAll('.tab')).toHaveLength(1))
 expect(api.vaultWorkspaceSave.mock.calls.filter(([session]:[string])=>session==='new')).toEqual([])
 expect(root.querySelector<HTMLElement>('.workspace-recovery')!.hidden).toBe(false)
 api.vaultGet=async()=>({status:'ready',sessionId:'new',rootName:'new'})
 root.querySelector<HTMLButtonElement>('.workspace-recovery button')!.click()
 await vi.waitFor(()=>expect(root.querySelectorAll('.tab')).toHaveLength(3))
 expect(root.querySelector<HTMLElement>('.workspace-recovery')!.hidden).toBe(true)

})

it('arrow keys keep tablist focus on the selected tab instead of the editor',async()=>{
 api.vaultWorkspaceGet=async()=>({version:1,tabs:[{relPath:'one.md'},{relPath:'two.md'}],active:'one.md',sidebarHidden:false,treeScroll:0,resourceScroll:0})
 api.noteRead=vi.fn(async(relPath:string)=>({content:'body '+relPath,revision:'r',objectVersion:relPath,sessionId:'old'}))
 await start(root)
 const selected=root.querySelector<HTMLButtonElement>('.tab[aria-selected="true"]')!
 selected.focus()
 editorHarness.focus.mockClear()
 selected.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))
 const next=root.querySelector<HTMLButtonElement>('.tab[aria-selected="true"]')!
 expect(next.dataset.rel).toBe('two.md')
 expect(document.activeElement).toBe(next)
 expect(editorHarness.focus).not.toHaveBeenCalled()
 root.querySelector<HTMLElement>('.tab[data-rel="one.md"]')!.click()
 expect(editorHarness.focus).toHaveBeenCalled()
})
