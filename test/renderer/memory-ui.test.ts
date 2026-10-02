// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { mountMemoryPage } from '../../src/renderer/src/memory-ui.ts'
import type { MemoryView } from '../../src/shared/memory.ts'
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

import { ledgerRememberRanges } from '../../src/renderer/src/memory-ui.ts'
import { appendLedgerChapter } from '../../src/main/host-source.ts'
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
