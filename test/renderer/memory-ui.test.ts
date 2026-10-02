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

import { ledgerRememberRanges, mountLedgerRememberButtons } from '../../src/renderer/src/memory-ui.ts'
import { renderReadOnlyMarkdown } from '../../src/renderer/src/view/read-only.ts'
import { readFileSync } from 'node:fs'
import { appendLedgerChapter } from '../../src/main/host-source.ts'
import type { LedgerProvenance } from '../../src/main/ledger-provenance.ts'
import { partitionSource } from '../../src/markdown/partition.ts'
it('offers interrupted human commands and completed answers with exact chapter offsets',()=>{
  const source=appendLedgerChapter('正文',{taskId:'cancelled-task',startedAt:'now',status:'cancelled',prompt:'长期使用中文',answer:'部分 AI 回答'})
  const ledger=partitionSource(source).ledger!
  const ranges=ledgerRememberRanges(ledger)
  expect(ranges.map(r=>r.label)).toEqual(['口令'])
  const chapter=ledger.slice(ledger.indexOf('<!-- rgent:ledger-task:'))
  expect(chapter.slice(ranges[0]!.start,ranges[0]!.end)).toBe('长期使用中文')
  const completed=partitionSource(appendLedgerChapter('正文',{taskId:'completed-task',startedAt:'now',status:'completed',prompt:'口令',answer:'完整回答'})).ledger!
  expect(ledgerRememberRanges(completed).map(r=>r.label)).toEqual(['口令','回答'])
})

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

it.each([0,1,2].flatMap(version=>['\n','\r\n'].map(newline=>[version,newline] as const)))('places each remember button at its marked task chapter despite legacy and answer h2 headings with sources v%i / %j', (version,newline)=>{
 const basis={model:{provider:'test',modelId:'model',endpointHost:'example.test'},scope:['note.md'],sources:[],tools:[]}
 const provenance:LedgerProvenance|undefined=version===0?undefined:version===1?{...basis,version:1}:{...basis,version:2,memoryDeps:[]}
 const first=appendLedgerChapter('正文',{taskId:'first',startedAt:'one',status:'completed',prompt:'第一口令',answer:'## 分析\n\n第一回答',provenance}),second=appendLedgerChapter(first,{taskId:'second',startedAt:'two',status:'completed',prompt:'第二口令',answer:'第二回答',provenance})
 const ledger=('## 旧手写章节\n\n旧材料\n\n'+partitionSource(second).ledger!).replaceAll('\n',newline),host=document.createElement('div'),remember=vi.fn()
 renderReadOnlyMarkdown(host,ledger);mountLedgerRememberButtons(host,ledger,remember)
 const buttons=[...host.querySelectorAll<HTMLButtonElement>('.memory-ledger-remember')]
 expect(buttons).toHaveLength(4)
 for(const b of buttons){let previous=b.previousElementSibling;while(previous?.tagName==='BUTTON')previous=previous.previousElementSibling;const taskId=b.getAttribute('aria-label')!.includes('first')?'first':'second';expect(previous?.textContent).toBe(taskId==='first'?'one · completed':'two · completed');const marker=ledger.indexOf(`<!-- rgent:ledger-task:v1 id="${taskId}"`),offset=ledger.indexOf(`## ${taskId==='first'?'one':'two'} · completed`,marker);expect((previous as HTMLElement).dataset.sourceStart).toBe(String(offset))}
 expect(host.querySelectorAll('h2')[0]!.nextElementSibling!.tagName).not.toBe('BUTTON')
 buttons.find(b=>b.getAttribute('aria-label')==='记住任务 second 的回答')!.click()
 const choice=ledgerRememberRanges(ledger).find(r=>r.taskId==='second'&&r.label==='回答')!;expect(remember).toHaveBeenCalledWith(choice.start,choice.end,'second');const secondChapter=ledger.slice(ledger.indexOf('<!-- rgent:ledger-task:v1 id="second"'));expect(secondChapter.slice(choice.start,choice.end)).toBe('第二回答')
 const legacy=document.createElement('div');renderReadOnlyMarkdown(legacy,'## old · completed\n\n### 口令\n\n口令\n\n### 回答\n\n回答\n\n### 工具摘要\n');mountLedgerRememberButtons(legacy,legacy.textContent!,remember);expect(legacy.querySelector('button')).toBeNull()
})

it('gives management and manual-preview textareas the existing themed settings padding',async()=>{
 const style=document.createElement('style');style.textContent=readFileSync('src/renderer/src/styles.css','utf8');document.head.append(style)
 const body=document.createElement('div');document.body.append(body)
 const entry:MemoryEntryView={id:'entry',version:1,content:'内容',layer:'core',scope:'库',status:'active',reason:null,updatedAt:'now',sources:[]}
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()}, {get:async()=>({ok:true,value:{...view,entries:[entry]}}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 renderMemoryPreview(body,{id:'preview',sessionId:'session',kind:'manual',content:'source',layer:'demand',scope:'库',sources:[],warning:'核对'}, {commit:vi.fn(),isCurrent:()=>true,onDone:vi.fn(),onCancel:vi.fn()} as never)
 try{for(const textarea of body.querySelectorAll('textarea')){expect(getComputedStyle(textarea).paddingTop).toBe('8px');expect(getComputedStyle(textarea).paddingLeft).toBe('10px')}}finally{dispose();body.remove();style.remove()}
})
