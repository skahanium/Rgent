// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { mountMemoryPage } from '../../src/renderer/src/memory-ui.ts'
import type { MemoryEntryView, MemoryView } from '../../src/shared/memory.ts'
const view:MemoryView={sessionId:'session',revision:null,objectVersion:null,config:{defaultModelId:null,limits:{seconds:120,calls:2,tools:0},vault:{enabled:false,override:{mode:'inherit'}},effectiveModelId:null,modelStatus:'missing'},recipient:null,status:'ready',entries:[],jobs:[],running:{permits:0,pending:0,active:0}}
const flush=()=>new Promise(resolve=>setTimeout(resolve,0))
const recentEntry:MemoryEntryView={id:'recent-1',version:1,content:'推进导入流程',layer:'demand',scope:'本库',category:'recent',status:'active',reason:null,updatedAt:'2026-10-05',sources:[{relPath:'notes/plan.md',kind:'body',taskId:'task-1',text:'原始目标',classification:'human'}],recent:{taskId:'task-1',noteId:'note-1',materialVersion:'material-1',createdAt:'2026-10-05',outcome:'completed',sections:{goal:'完成导入',completed:'入口已接线',blocked:'等待窗口验收',next:'核对来源'},assistantDraft:false}}
it.each(['empty','recent','long'] as const)('keeps separate empty states for %s content',async kind=>{
 const body=document.createElement('div');document.body.append(body)
 const long:MemoryEntryView={id:'long-1',version:1,content:'固定规则',layer:'core',scope:'本库',status:'active',reason:null,updatedAt:'today',sources:[]}
 const entries=kind==='empty'?[]:kind==='recent'?[recentEntry]:[long]
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:{...view,entries}}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 const recent=body.querySelector<HTMLElement>('[data-memory-section="recent"]')!,longSection=body.querySelector<HTMLElement>('[data-memory-section="entries"]')!
 expect((recent.querySelector<HTMLElement>('.memory-empty')!.hidden)).toBe(kind==='recent')
 expect((longSection.querySelector<HTMLElement>('.memory-empty')!.hidden)).toBe(kind==='long')
 if(kind!=='recent')expect(recent.querySelector('.memory-empty')!.textContent).toContain('还没有近期工作背景')
 if(kind!=='long')expect(longSection.querySelector('.memory-empty')!.textContent).toContain('还没有长期内容')
 expect(body.textContent).toContain('自动学习质量尚未通过验证')
 dispose();body.remove()
})
it('separates recent background from long content, shows four sections and only offers forget for recent',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const entry:MemoryEntryView={id:'long-1',version:1,content:'用户偏好中文',layer:'core',scope:'本库',status:'active',reason:null,updatedAt:'today',sources:[]}
 const handlers={get:async()=>({ok:true,value:{...view,entries:[recentEntry,entry]}}),models:async()=>({ok:false,error:'IO_ERROR'}),edit:vi.fn(),disable:vi.fn(),restore:vi.fn(),forget:vi.fn()}
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},handlers as never);await flush()
 const recent=body.querySelector<HTMLDetailsElement>('[data-memory-section="recent"] .memory-entry')!
 expect(recent.textContent).toContain('完成导入');expect(recent.textContent).toContain('入口已接线');expect(recent.textContent).toContain('等待窗口验收');expect(recent.textContent).toContain('核对来源')
 expect(recent.textContent).toContain('notes/plan.md');expect(recent.textContent).toContain('14 天')
 expect(recent.querySelector('.memory-editor')).toBeNull();expect(recent.querySelector('.memory-entry-state-action')).toBeNull()
 expect([...recent.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['删除并遗忘','取消遗忘'])
 expect(body.querySelector('[data-memory-section="entries"]')?.textContent).toContain('用户偏好中文')
 expect(body.querySelector('.memory-status-line')?.textContent).toContain('长期 1 条 · 近期 1 块')
 recent.querySelector<HTMLButtonElement>('button')!.click();expect(handlers.forget).not.toHaveBeenCalled();recent.querySelector<HTMLButtonElement>('[data-memory-action="cancel-forget"]')!.click();expect(handlers.forget).not.toHaveBeenCalled()
 recent.querySelector<HTMLButtonElement>('button')!.click();recent.querySelector<HTMLButtonElement>('button')!.click();await flush()
 expect(handlers.forget).toHaveBeenCalledWith({revision:null,objectVersion:null,id:'recent-1',version:1})
 dispose();body.remove()
})
it('keeps a recent fold and source open through refresh, and filters both sections',async()=>{
 const body=document.createElement('div');document.body.append(body)
 let value:MemoryView={...view,entries:[recentEntry]}
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 const recent=body.querySelector<HTMLDetailsElement>('[data-memory-section="recent"] .memory-entry')!;recent.open=true
 const source=recent.querySelector<HTMLDetailsElement>('.memory-source')!;source.open=true
 value={...value,entries:[{...recentEntry,updatedAt:'2026-10-06',status:'paused',reason:'MEMORY_SOURCE_CHANGED'}]}
 window.dispatchEvent(new CustomEvent('rgent:memory',{detail:'session'}));await flush()
 expect(body.querySelector('[data-memory-section="recent"] .memory-entry')).toBe(recent);expect(recent.open).toBe(true);expect(source.open).toBe(true);expect(recent.textContent).toContain('来源需要检查')
 body.querySelector<HTMLButtonElement>('[data-memory-filter="usable"]')!.click();expect(recent.hidden).toBe(true)
 body.querySelector<HTMLButtonElement>('[data-memory-filter="attention"]')!.click();expect(recent.hidden).toBe(false)
 dispose();body.remove()
})
it('reports recent and long job updates separately without inventing missing entries',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const long:MemoryEntryView={id:'long-1',version:1,content:'结论',layer:'demand',scope:'本库',status:'active',reason:null,updatedAt:'today',sources:[]}
 const jobs=[{taskId:'task-1',materialVersion:'v1',outcome:'applied' as const,retryable:false,entryIds:['recent-1','long-1']}]
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:{...view,entries:[recentEntry,long],jobs}}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 expect(body.querySelector('.memory-job')?.textContent).toContain('更新近期背景 1 块 · 新增/更新长期内容 1 条')
 expect(body.querySelector('.memory-job')?.textContent).not.toContain('undefined')
 dispose();body.remove()
})
it('discloses partial consolidation: saved groups, rejected groups and the specific reason',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const jobs=[{taskId:'task-partial',materialVersion:'v1',outcome:'applied' as const,retryable:false,reason:'MEMORY_CHANGED',entryIds:['recent-1'],
  results:[{action:'recent' as const,outcome:'applied' as const},{action:'correct' as const,outcome:'rejected' as const,code:'MEMORY_CHANGED'}]}]
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:{...view,entries:[recentEntry],jobs}}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 const text=body.querySelector('.memory-job')?.textContent??''
 expect(text).toContain('部分保存：已保存 1 组、未保存 1 组')
 expect(text).toContain('未保存的分组：更正')
 expect(text).not.toContain('MEMORY_CHANGED')
 expect(text).toContain('记录在核对期间发生变化')
 dispose();body.remove()
})
describe('memory page drafts',()=>{
  it('discloses unverified learning quality without changing the saved library switch',async()=>{
    const body=document.createElement('div');document.body.append(body);const save=vi.fn()
    const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:{...view,config:{...view.config,vault:{...view.config.vault,enabled:true}}}}),models:async()=>({ok:false,error:'IO_ERROR'}),save} as never)
    await flush();expect(body.textContent).toContain('自动学习质量尚未通过验证');expect(body.querySelector<HTMLInputElement>('[data-memory="vault-enabled"]')?.checked).toBe(true);expect(save).not.toHaveBeenCalled();dispose();body.remove()
  })
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
 expect(body.querySelector('[data-task-id="retry-task"]')).toBe(row);expect(row.querySelector('.memory-preview')).toBe(preview)
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
 const row=body.querySelector<HTMLDetailsElement>('.memory-entry')!;row.open=true;row.querySelector<HTMLButtonElement>('[data-memory-action="edit"]')!.click()
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
   expect(row.querySelector('summary')!.textContent).toContain('来源需要检查');expect(row.textContent).toContain('来源片段已改变');expect([...row.querySelectorAll('button')].some(b=>b.textContent==='停用')).toBe(false)
   ;[...row.querySelectorAll('button')].find(b=>b.textContent==='检查来源并恢复')!.click();await flush()
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
 const row=body.querySelector<HTMLDetailsElement>('.memory-entry')!;row.open=true;row.querySelector<HTMLButtonElement>('[data-memory-action="edit"]')!.click();row.querySelector('textarea')!.value='草稿'
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
 ;body.querySelector<HTMLButtonElement>('[aria-label="刷新状态"]')!.click();await flush()
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
 ;[...body.querySelectorAll('button')].find(b=>b.textContent==='重置本设备的记忆设置…')!.click();await flush()
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

it('puts memories before optional configuration, filters every status and keeps edit drafts during refresh',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const statuses=['active','paused','pending','disabled','review','obsolete','disputed','deferred'] as const
 let value:MemoryView={...view,entries:statuses.map((status,i)=>({id:String(i),version:1,content:`记忆 ${status}`,layer:'demand',scope:'项目',status,reason:null,updatedAt:'now',sources:[]}))}
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 expect([...body.querySelectorAll('[data-memory-section]')].map(e=>(e as HTMLElement).dataset.memorySection)).toEqual(['status','recent','entries','models','jobs','maintenance'])
 expect(body.querySelector<HTMLDetailsElement>('[data-memory-section="models"]')!.open).toBe(true)
 expect(body.querySelector<HTMLDetailsElement>('[data-memory-section="jobs"]')!.open).toBe(false)
 const row=body.querySelector<HTMLDetailsElement>('.memory-entry')!;row.open=true
 expect(row.querySelector<HTMLElement>('.memory-editor')!.hidden).toBe(true)
 row.querySelector<HTMLButtonElement>('[data-memory-action="edit"]')!.click()
 const text=row.querySelector('textarea')!;text.value='本地草稿';text.focus();text.setSelectionRange(1,3)
 body.querySelector<HTMLButtonElement>('[data-memory-filter="attention"]')!.click()
 expect([...body.querySelectorAll<HTMLElement>('.memory-entry')].filter(r=>!r.hidden)).toHaveLength(5)
 window.dispatchEvent(new CustomEvent('rgent:memory',{detail:'session'}));await flush()
 expect(body.querySelector('.memory-entry')).toBe(row);expect(text.value).toBe('本地草稿')
 body.querySelector<HTMLButtonElement>('[data-memory-filter="all"]')!.click()
 row.querySelector<HTMLButtonElement>('[data-memory-action="cancel-edit"]')!.click()
 expect(text.value).toBe('记忆 active');expect(row.querySelector<HTMLElement>('.memory-editor')!.hidden).toBe(true)
 body.querySelector<HTMLButtonElement>('[data-memory-filter="usable"]')!.click()
 expect([...body.querySelectorAll<HTMLElement>('.memory-entry')].filter(r=>!r.hidden)).toHaveLength(1)
 dispose();body.remove()
})
it('keeps a changed vault switch visibly unsaved across refresh and commits it with the model draft',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const save=vi.fn(async()=>({ok:true,value:{...view,config:{...view.config,vault:{enabled:true,override:{mode:'inherit' as const}}}}}))
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:view}),models:async()=>({ok:false,error:'IO_ERROR'}),save} as never);await flush()
 const enabled=body.querySelector<HTMLInputElement>('[data-memory="vault-enabled"]')!;expect(body.querySelector<HTMLButtonElement>('[data-memory="save-vault"]')!.hidden).toBe(true);enabled.checked=true;enabled.dispatchEvent(new Event('change'))
 expect(body.querySelector('[data-memory="vault-draft"]')!.textContent).toContain('尚未保存')
 window.dispatchEvent(new CustomEvent('rgent:memory',{detail:'session'}));await flush()
 expect(enabled.checked).toBe(true);expect(body.querySelector('[data-memory="current-vault"]')!.textContent).toContain('已关闭')
 body.querySelector<HTMLButtonElement>('[data-memory="save-vault"]')!.click();await flush()
 expect(save).toHaveBeenCalledWith({target:'vault',vault:{enabled:true,override:{mode:'inherit'}}})
 expect(body.querySelector('[data-memory="vault-draft"]')!.textContent).toContain('已保存')
 dispose();body.remove()
})
it.each([['reset','确认清空记忆'],['watermark','确认停止旧材料学习'],['reset-config','确认重置记忆设置'],['retry','确认重新整理']] as const)('names %s confirmation by its effect', (kind,label)=>{
 const body=document.createElement('div')
 renderMemoryPreview(body,{id:'p',sessionId:'s',kind,content:'效果',layer:'demand',scope:'库',sources:[],warning:'说明'},{commit:vi.fn(),isCurrent:()=>true,onDone:vi.fn(),onCancel:vi.fn()} as never)
 expect(body.querySelector('button')!.textContent).toBe(label)
})

it.each(['ready','missing','unavailable'] as const)('opens model help only when %s and keeps existing memories available',async modelStatus=>{
 const body=document.createElement('div');document.body.append(body)
 const value:MemoryView={...view,config:{...view.config,modelStatus},entries:[{id:'a',version:1,content:'已有知识',layer:'demand',scope:'本库',status:'active',reason:null,updatedAt:'now',sources:[]}]}
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 const models=body.querySelector<HTMLDetailsElement>('[data-memory-section="models"]')!
 expect(models.open).toBe(modelStatus!=='ready');expect(body.querySelector('.memory-entry')!.textContent).toContain('已有知识')
 models.open=!models.open;window.dispatchEvent(new CustomEvent('rgent:memory',{detail:'session'}));await flush();expect(models.open).toBe(modelStatus==='ready')
 dispose();body.remove()
})
it('returns keyboard focus to the saved entry and allows cancelling a forget confirmation without losing its draft',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const entry:MemoryEntryView={id:'e',version:1,content:'原内容',layer:'demand',scope:'库',status:'active',reason:null,updatedAt:'now',sources:[]}
 let value:MemoryView={...view,entries:[entry]}
 const edit=vi.fn(async()=>({ok:true,value:{...value,entries:[{...entry,version:2,content:'已保存内容'}]}})),forget=vi.fn()
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value}),models:async()=>({ok:false,error:'IO_ERROR'}),edit,forget} as never);await flush()
 const row=body.querySelector<HTMLDetailsElement>('.memory-entry')!;row.open=true;row.querySelector<HTMLButtonElement>('[data-memory-action="edit"]')!.click();row.querySelector('textarea')!.value='已保存内容'
 ;[...row.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='删除并遗忘')!.click()
 row.querySelector<HTMLButtonElement>('[data-memory-action="cancel-forget"]')!.click();expect(forget).not.toHaveBeenCalled();expect(row.querySelector('textarea')!.value).toBe('已保存内容')
 row.querySelector<HTMLButtonElement>('[data-memory-action="save-edit"]')!.click();await flush()
 expect(document.activeElement).toBe(body.querySelector('.memory-entry > summary'))
 dispose();body.remove()
})
it('does not let an older manual refresh replace a newer memory event',async()=>{
 const body=document.createElement('div');document.body.append(body)
 let next:((v:unknown)=>void)|null=null
 const get=vi.fn().mockResolvedValueOnce({ok:true,value:view}).mockImplementationOnce(()=>new Promise(r=>next=r)).mockResolvedValueOnce({ok:true,value:{...view,config:{...view.config,vault:{enabled:true,override:{mode:'inherit'}}}}})
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get,models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 body.querySelector<HTMLButtonElement>('[aria-label="刷新状态"]')!.click()
 window.dispatchEvent(new CustomEvent('rgent:memory',{detail:'session'}));await flush()
 next!({ok:true,value:view});await flush()
 expect(body.querySelector('[data-memory="current-vault"]')!.textContent).toContain('已开启')
 dispose();body.remove()
})
it('saves the library model beside its selector through the same combined configuration and prevents duplicate saves',async()=>{
 const body=document.createElement('div');document.body.append(body)
 let finish!:(v:unknown)=>void
 const save=vi.fn(()=>new Promise(r=>finish=r))
 const config={defaultModelId:null,models:[{id:'m',modelId:'整理模型',provider:'custom',contextTokens:32000}],providers:[{provider:'custom',configured:true,hasKey:true,modelCount:1,baseURL:'http://localhost:1234'}],limits:{}}
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:view}),models:async()=>({ok:true,config}),save} as never);await flush()
 const model=body.querySelector<HTMLSelectElement>('[data-memory="vault-model"]')!;model.value='m';model.dispatchEvent(new Event('change'))
 const local=body.querySelector<HTMLButtonElement>('[data-memory="save-vault-model"]')!
 local.click();body.querySelector<HTMLButtonElement>('[data-memory="save-vault"]')!.click()
 expect(save).toHaveBeenCalledOnce();expect(save).toHaveBeenCalledWith({target:'vault',vault:{enabled:false,override:{mode:'model',modelId:'m'}}})
 finish({ok:false,error:'IO_ERROR'});await flush();expect(local.disabled).toBe(false);expect(model.value).toBe('m')
 dispose();body.remove()
})

it.each(['retirement','material'] as const)('shows the saved library diagnostic and next step for %s',async kind=>{
 const body=document.createElement('div');document.body.append(body)
 const value={...view,...(kind==='retirement'?{retirementFailure:'MEMORY_RETIREMENT_FAILED'}:{reason:'LEDGER_REGISTRY_INVALID',materialStatus:'invalid' as const})}
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 expect(body.textContent).toContain(kind==='retirement'?'旧记忆未能清除':'材料登记无法核验');expect(body.textContent).toContain(kind==='retirement'?'原文件已保留':'清空和推进学习进度已停止');dispose();body.remove()
})

it('shows invalid materials alongside an independent unavailable model configuration',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:{...view,reason:'MEMORY_CONFIG_UNAVAILABLE',materialStatus:'invalid'}}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 expect(body.textContent).toContain('材料登记无法核验');expect(body.textContent).toContain('记忆设置无法读取');dispose();body.remove()
})

it('renders simultaneous invalid memory, retirement failure and invalid materials received from the diagnostic view',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:{...view,status:'invalid',reason:'MEMORY_STORAGE_INVALID',materialStatus:'invalid',retirementFailure:'MEMORY_RETIREMENT_FAILED'}}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 expect(body.textContent).toContain('旧记忆未能清除');expect(body.textContent).toContain('材料登记无法核验');expect(body.textContent).toContain('清空和推进学习进度已停止');expect(body.textContent).not.toContain('MEMORY_RETIREMENT_FAILED');dispose();body.remove()
})

it('offers a retirement preview for a verified legacy object while keeping unknown files diagnostic',async()=>{
 for(const retryable of [true,false]){
  const body=document.createElement('div');document.body.append(body);const maintenance=vi.fn(async()=>({ok:false,error:'MEMORY_CONFLICT'}))
  const diagnosis={revision:'a'.repeat(64),objectVersion:'old',bytes:50}
  const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:{...view,retirementFailure:'MEMORY_RETIREMENT_FAILED',retirement:retryable?diagnosis:undefined}}),models:async()=>({ok:false,error:'IO_ERROR'}),maintenance} as never);await flush()
  const retry=Array.from(body.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='重试清除旧记忆…');expect(!!retry).toBe(retryable)
  if(retry){retry.click();await flush();expect(maintenance).toHaveBeenCalledWith({action:'retire',revision:diagnosis.revision,objectVersion:diagnosis.objectVersion})}
  dispose();body.remove()
 }
})

it('shows the four evidence states separately and marks missing human review',async()=>{
 const cases:[MemoryView['quality'],string[]][]=[
  [{state:'passed',humanReviewed:true,stale:false},['已通过本项目质量验收']],
  [{state:'passed',humanReviewed:true,stale:true},['旧成绩不再适用']],
  [{state:'failed',humanReviewed:true,stale:false},['已测试，未通过本轮质量验收']],
  [{state:'insufficient',humanReviewed:true,stale:false},['测试未完成或证据不足']],
  [{state:'testing',humanReviewed:false,stale:false},['正在测试中','未人工复核']],
  [undefined,['自动学习质量尚未通过验证']]
 ]
 for(const [quality,expected] of cases){
  const body=document.createElement('div');document.body.append(body)
  const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:{...view,...(quality?{quality}:{})}}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
  const text=body.querySelector('.memory-quality-status')?.textContent??''
  for(const fragment of expected)expect(text).toContain(fragment)
  expect(text).toContain('你可以查看、修改或遗忘记忆')
  dispose();body.remove()
 }
})

it('shows saved content together with a visible maintenance failure',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:{...view,maintenanceFailure:'MEMORY_FILE_LIMIT'}}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 const line=body.querySelector('.memory-status-line')!.textContent!;expect(line).toContain('已保存');expect(line).toContain('后续维护未完成');expect(line).not.toContain('MEMORY_FILE_LIMIT')
 dispose();body.remove()
})

it.each(['partial-recent','partial-long','all-rejected','no-recent'] as const)('reports %s according to actual job results',async kind=>{
 const body=document.createElement('div');document.body.append(body)
 const long:MemoryEntryView={id:'long-1',version:1,content:'固定规则',layer:'core',scope:'本库',status:'active',reason:null,updatedAt:'today',sources:[]}
 const results:NonNullable<MemoryView['jobs'][number]['results']>=kind==='partial-recent'?[{action:'correct',outcome:'applied'},{action:'recent',outcome:'rejected',code:'MEMORY_DEADLINE'}]:kind==='partial-long'?[{action:'recent',outcome:'applied'},{action:'correct',outcome:'rejected',code:'MEMORY_OUTPUT_INVALID'}]:kind==='all-rejected'?[{action:'correct',outcome:'rejected',code:'MEMORY_OUTPUT_INVALID'},{action:'recent',outcome:'rejected',code:'MEMORY_DEADLINE'}]:[{action:'correct',outcome:'applied'}]
 const entries=kind==='partial-long'?[recentEntry]:kind==='all-rejected'?[]:[long]
 const jobs:MemoryView['jobs']=[{taskId:'partial-job',materialVersion:'m1',outcome:'applied',retryable:false,entryIds:entries.map(e=>e.id),results}]
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:{...view,entries,jobs}}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 const text=body.querySelector('.memory-job')!.textContent!
 if(kind==='partial-recent'){expect(text).toContain('已保存可用部分；近期背景未更新');expect(text).toContain('长期内容 1 条');expect(text).not.toContain('没有写入新内容')}
 if(kind==='partial-long'){expect(text).toContain('近期背景 1 块');expect(text).toContain('长期内容未保存')}
 if(kind==='all-rejected'){expect(text).toContain('没有写入');expect(text).not.toContain('已完成')}
 if(kind==='no-recent')expect(text).not.toContain('近期背景未更新')
 dispose();body.remove()
})

it('keeps expanded job details and focus when a status refresh fails',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const get=vi.fn().mockResolvedValueOnce({ok:true,value:{...view,jobs:[{taskId:'job-open',materialVersion:'m1',outcome:'applied',entryIds:[],results:[{action:'recent',outcome:'rejected',code:'MEMORY_DEADLINE'}],retryable:false}]}}).mockResolvedValueOnce({ok:false,error:'MEMORY_SERVICE_FAILED'})
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get,models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 const panel=body.querySelector<HTMLDetailsElement>('[data-memory-section="jobs"]')!,detail=body.querySelector<HTMLDetailsElement>('.memory-job .memory-technical')!,summary=detail.querySelector<HTMLElement>('summary')!
 panel.open=true;detail.open=true;summary.focus();body.querySelector<HTMLButtonElement>('[aria-label="刷新状态"]')!.click();await flush()
 expect(panel.open).toBe(true);expect(detail.open).toBe(true);expect(document.activeElement).toBe(summary)
 expect(body.textContent).toContain('连接或服务请求失败');expect(body.textContent).not.toContain('没有自动重试')
 dispose();body.remove()
})

it('still reports saved groups and the rejected recent update when saved entries are no longer visible',async()=>{
 const body=document.createElement('div');document.body.append(body)
 const jobs:MemoryView['jobs']=[{taskId:'gone',materialVersion:'m1',outcome:'applied',retryable:false,entryIds:['old-id'],results:[{action:'correct',outcome:'applied'},{action:'recent',outcome:'rejected',code:'MEMORY_DEADLINE'}]}]
 const dispose=mountMemoryPage({body,isCurrent:()=>true,onChanged:vi.fn()},{get:async()=>({ok:true,value:{...view,jobs}}),models:async()=>({ok:false,error:'IO_ERROR'})} as never);await flush()
 expect(body.querySelector('.memory-job')!.textContent).toContain('已保存可用部分；近期背景未更新')
 expect(body.querySelector('.memory-job')!.textContent).toContain('部分条目当前不可查看')
 expect(body.querySelector('.memory-job')!.textContent).not.toContain('长期内容 1 条')
 dispose();body.remove()
})
