// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { mountMemoryPage } from '../../src/renderer/src/memory-ui.ts'
import type { MemoryEntryView, MemoryView } from '../../src/shared/memory.ts'
const view:MemoryView={sessionId:'session',revision:null,objectVersion:null,config:{defaultModelId:null,limits:{seconds:120,calls:2,tools:0},vault:{enabled:false,override:{mode:'inherit'}},effectiveModelId:null,modelStatus:'missing'},recipient:null,status:'ready',entries:[],jobs:[],running:{permits:0,pending:0,active:0}}
const flush=()=>new Promise(resolve=>setTimeout(resolve,0))
describe('memory page drafts',()=>{
  it('saves default and vault separately; a failed save preserves the draft and current value',async()=>{
    const body=document.createElement('div');document.body.append(body)
    const save=vi.fn(async()=>({ok:false,error:'IO_ERROR'}))
    const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()}, {get:async()=>({ok:true,value:view}),save,models:async()=>({ok:true,config:{models:[{id:'model',modelId:'test',provider:'custom',contextTokens:32000}],providers:[{provider:'custom',configured:true,hasKey:true,modelCount:1,baseURL:'http://localhost:1234'}],defaultModelId:null,limits:{}}})} as never)
    await flush()
    const select=body.querySelector<HTMLSelectElement>('[data-memory="default-model"]')!;select.value='model'
    body.querySelector<HTMLButtonElement>('[data-memory="save-default"]')!.click();await flush()
    expect(save).toHaveBeenCalledWith({target:'default',modelId:'model'})
    expect(select.value).toBe('model')
    expect(body.querySelector('[role="alert"]')?.textContent).toContain('保存')
    expect(body.querySelector('[data-memory="current-default"]')?.textContent).toContain('未选择')
    dispose();body.remove()
  })
  it('ignores a late read after disposal without changing the new vault page',async()=>{
    const body=document.createElement('div');let finish!:(v:unknown)=>void
    const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()}, {get:()=>new Promise(r=>finish=r),models:async()=>({ok:false,error:'IO_ERROR'})} as never)
    dispose();body.textContent='new vault';finish({ok:true,value:view});await flush()
    expect(body.textContent).toBe('new vault')
  })
})

import { ledgerRememberCommand } from '../../src/renderer/src/memory-ui.ts'
import { renderReadOnlyMarkdown } from '../../src/renderer/src/view/read-only.ts'
import { readFileSync } from 'node:fs'
import { appendLedgerChapter } from '../../src/main/host-source.ts'
import type { LedgerProvenance } from '../../src/main/ledger-provenance.ts'
import { partitionSource } from '../../src/markdown/partition.ts'
import { renderMemoryPreview } from '../../src/renderer/src/memory-ui.ts'
it('keeps an empty manual draft local and submits the same unused token only after content is filled',async()=>{
 const host=document.createElement('div'),commit=vi.fn(async()=>({ok:false,error:'MEMORY_SOURCE_CHANGED'}))
 renderMemoryPreview(host,{id:'preview',sessionId:'session',kind:'manual',content:'source',layer:'demand',scope:'库',sources:[],warning:'核对'}, {commit,isCurrent:()=>true,onDone:vi.fn(),onCancel:vi.fn()} as never)
 const content=host.querySelector('textarea')!,confirm=host.querySelector('button')!
 content.value='   ';confirm.click();await flush();expect(commit).not.toHaveBeenCalled();expect(confirm.disabled).toBe(false)
 content.value='edited draft';confirm.click();await flush();expect(commit).toHaveBeenCalledOnce();expect(content.value).toBe('edited draft');expect(confirm.disabled).toBe(true)
 confirm.click();await flush();expect(commit).toHaveBeenCalledOnce()
})
it('preserves an unchanged retry job node and its preview when another job changes, and invalidates changed material',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const job={taskId:'retry-task',materialVersion:'a'.repeat(64),outcome:'rejected' as const,retryable:true}
 let value:MemoryView={...view,jobs:[job]}
 const handlers={get:async()=>({ok:true,value}),models:async()=>({ok:false,error:'IO_ERROR'}),retry:async()=>({ok:true,value:{id:'retry-preview',sessionId:'session',kind:'retry',content:'saved',layer:'demand',scope:'库',sources:[],warning:'核对'}})}
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},handlers as never);await flush()
 const row=body.querySelector('.memory-job')!;row.querySelector<HTMLButtonElement>('button')!.click();await flush()
 const preview=row.querySelector('.memory-preview')!;expect(preview).not.toBeNull()
 value={...value,jobs:[job,{taskId:'other',materialVersion:null,outcome:'unavailable',retryable:false}]}
 window.dispatchEvent(new CustomEvent('rgent:memory',{detail:'session'}));await flush()
 expect(body.querySelector('.memory-job')).toBe(row);expect(row.querySelector('.memory-preview')).toBe(preview)
 value={...value,jobs:[{...job,materialVersion:'b'.repeat(64)}]}
 window.dispatchEvent(new CustomEvent('rgent:memory',{detail:'session'}));await flush()
 expect(body.querySelector('.memory-job')).not.toBe(row);expect(body.querySelector('.memory-preview')).toBeNull();expect(body.textContent).toContain('预览已失效')
 dispose();body.remove()
})

it.each(['paused', 'renamed'] as const)('refreshes same-version %s metadata while retaining the editable draft, focus and source expansion', async change => {
 const body=document.createElement('div');document.body.append(body)
 const entry:MemoryEntryView={id:'entry',version:1,content:'中文优先',layer:'core',scope:'本库',status:'active',reason:null,updatedAt:'old-time',sources:[{relPath:'old.md',kind:'body',taskId:null,text:'原始来源',classification:'human'}]}
 let value:MemoryView={...view,revision:'old-revision',objectVersion:'old-object',entries:[entry]}
 const edit=vi.fn(async()=>({ok:false,error:'MEMORY_CONFLICT'})),restore=vi.fn(async()=>({ok:false,error:'MEMORY_SOURCE_CHANGED'}))
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()}, {get:async()=>({ok:true,value}),models:async()=>({ok:false,error:'IO_ERROR'}),edit,restore} as never)
 await flush()
 const row=body.querySelector<HTMLDetailsElement>('.memory-entry')!;row.open=true
 const source=row.querySelector<HTMLDetailsElement>('.memory-source')!;source.open=true
 const content=row.querySelector('textarea')!,scope=row.querySelector('input')!,layer=row.querySelector('select')!
 content.value='未保存中文草稿';scope.value='未保存范围';layer.value='demand';content.focus();content.setSelectionRange(2,5)
 value={...value,revision:'new-revision',objectVersion:'new-object',entries:[{...entry,updatedAt:'new-time',...(change==='paused'?{status:'paused',reason:'MEMORY_SOURCE_CHANGED'}:{sources:[{...entry.sources[0]!,relPath:'moved.md',text:'迁移后的来源'}]})}]}
 window.dispatchEvent(new CustomEvent('rgent:memory',{detail:'session'}));await flush()
 expect(body.querySelector('.memory-entry')).toBe(row);expect(row.open).toBe(true)
 expect(row.querySelector('textarea')).toBe(content);expect(content.value).toBe('未保存中文草稿');expect(scope.value).toBe('未保存范围');expect(layer.value).toBe('demand')
 expect(document.activeElement).toBe(content);expect([content.selectionStart,content.selectionEnd]).toEqual([2,5])
 expect(row.textContent).toContain('new-time');expect(row.querySelector<HTMLDetailsElement>('.memory-source')).toBe(source);expect(source.open).toBe(true)
 if(change==='paused'){
   expect(row.querySelector('summary')!.textContent).toContain('暂停');expect(row.textContent).toContain('来源片段已改变');expect([...row.querySelectorAll('button')].some(b=>b.textContent==='停用')).toBe(false)
   ;[...row.querySelectorAll('button')].find(b=>b.textContent==='核对来源并恢复')!.click();await flush()
   expect(restore).toHaveBeenCalledWith({revision:'new-revision',objectVersion:'new-object',id:'entry',version:1})
 }else{expect(row.querySelector('.memory-source summary')!.textContent).toContain('moved.md');expect(row.querySelector('.memory-source')!.textContent).toContain('迁移后的来源');expect(row.textContent).not.toContain('old.md')}
 ;[...row.querySelectorAll('button')].find(b=>b.textContent==='保存条目')!.click();await flush()
 expect(edit).toHaveBeenCalledWith({revision:'new-revision',objectVersion:'new-object',id:'entry',version:1,content:'未保存中文草稿',layer:'demand',scope:'未保存范围'})
 dispose();body.remove()
})

it('retains an open draft when the entry version changes and replaces it only after closing and refreshing',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const entry:MemoryEntryView={id:'entry',version:1,content:'原内容',layer:'core',scope:'库',status:'active',reason:null,updatedAt:'old',sources:[]}
 let value:MemoryView={...view,entries:[entry]}
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()}, {get:async()=>({ok:true,value}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 const row=body.querySelector<HTMLDetailsElement>('.memory-entry')!;row.open=true;row.querySelector('textarea')!.value='草稿'
 value={...value,entries:[{...entry,version:2,content:'新版本'}]};window.dispatchEvent(new CustomEvent('rgent:memory',{detail:'session'}));await flush()
 expect(body.querySelector('.memory-entry')).toBe(row);expect(row.querySelector('textarea')!.value).toBe('草稿');expect(row.querySelector('.memory-stale-warning')).not.toBeNull()
 row.open=false;window.dispatchEvent(new CustomEvent('rgent:memory',{detail:'session'}));await flush()
 expect(body.querySelector('.memory-entry')).not.toBe(row);expect(body.querySelector('textarea')!.value).toBe('新版本');dispose();body.remove()
})

it('refreshes a collapsed same-version entry and its recovery action without expanding it',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const entry:MemoryEntryView={id:'entry',version:1,content:'内容',layer:'core',scope:'库',status:'active',reason:null,updatedAt:'old',sources:[]}
 let value:MemoryView={...view,entries:[entry]}
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()}, {get:async()=>({ok:true,value}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 const row=body.querySelector<HTMLDetailsElement>('.memory-entry')!
 value={...value,entries:[{...entry,status:'pending',reason:'MEMORY_SOURCE_CHANGED',updatedAt:'new',pendingTarget:{id:'target',version:3}}]}
 ;[...body.querySelectorAll('button')].find(b=>b.textContent==='刷新状态')!.click();await flush()
 expect(body.querySelector('.memory-entry')).toBe(row);expect(row.open).toBe(false);expect(row.querySelector('summary')!.textContent).toContain('待确认');expect(row.querySelector('.memory-entry-state-action')!.textContent).toBe('核对更正');expect(row.textContent).toContain('new')
 dispose();body.remove()
})


it('gives management and manual-preview textareas the existing themed settings padding',async()=>{
 const style=document.createElement('style');style.textContent=readFileSync('src/renderer/src/styles.css','utf8');document.head.append(style)
 const body=document.createElement('div');document.body.append(body)
 const entry:MemoryEntryView={id:'entry',version:1,content:'内容',layer:'core',scope:'库',status:'active',reason:null,updatedAt:'now',sources:[]}
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()}, {get:async()=>({ok:true,value:{...view,entries:[entry]}}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 renderMemoryPreview(body,{id:'preview',sessionId:'session',kind:'manual',content:'source',layer:'demand',scope:'库',sources:[],warning:'核对'}, {commit:vi.fn(),isCurrent:()=>true,onDone:vi.fn(),onCancel:vi.fn()} as never)
 try{for(const textarea of body.querySelectorAll('textarea')){expect(getComputedStyle(textarea).paddingTop).toBe('8px');expect(getComputedStyle(textarea).paddingLeft).toBe('10px')}}finally{dispose();body.remove();style.remove()}
})
it('exposes corruption and a single-use repair preview without hiding local management behind model configuration',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const value:MemoryView={...view,reason:'MEMORY_CONFIG_UNAVAILABLE',learning:{watermark:3,nextSequence:7},diagnosis:{revision:'a'.repeat(64),objectVersion:'object',bytes:42},configDiagnosis:{revision:'b'.repeat(64),bytes:30}}
 const maintenance=vi.fn(async()=>({ok:true,value:{id:'repair',sessionId:'session',kind:'reset-config',content:'关闭设备记忆许可',layer:'demand',scope:'设备',sources:[],warning:'笔记与密钥不变'}}))
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value}),models:async()=>({ok:false,error:'IO_ERROR'}),maintenance} as never)
 await flush();expect(body.textContent).toContain('记忆配置')
 ;[...body.querySelectorAll('button')].find(b=>b.textContent==='核对并重建记忆设备配置')!.click();await flush()
 expect(maintenance).toHaveBeenCalledWith({action:'reset-config',revision:'b'.repeat(64),objectVersion:null})
 expect(body.querySelector('.memory-preview')!.textContent).toContain('关闭设备记忆许可')
 dispose();body.remove()
})

it.each(['saved','pending-body','cleared','legacy'] as const)('remembers only a verified typed human command when ledger state is %s',state=>{
 const record={version:1,noteId:'note',taskId:'task',revision:2,sequence:3,state,bodyStatus:'present',chapter:{taskId:'task',startedAt:'now',status:'completed',prompt:'长期使用中文',answer:'未采纳回答'}} as import('../../src/main/ledger-store.ts').LedgerRecord
 const choice=ledgerRememberCommand(record)
 if(state!=='saved')expect(choice).toBeNull()
 else {expect(choice?.taskId).toBe('task');expect(('口令：\n'+record.chapter!.prompt+'\n\n历史回答：\n'+record.chapter!.answer).slice(choice!.start,choice!.end)).toBe('长期使用中文')}
})
