import type { ModelConfigResult, PublicModelConfig } from '../../shared/ipc.ts'
import type { MemoryConfigChange, MemoryCommitRequest, MemoryEditRequest, MemoryEntryView, MemoryItemRequest, MemoryJobRequest, MemoryPreview, MemoryResult, MemorySourceView, MemoryView } from '../../shared/memory.ts'
import { modelModuleGroups } from './statusbar.ts'

export function memoryErrorText(code:string):string {
  const text:Record<string,string>={IO_ERROR:'保存失败，请重试；当前配置未改动。',BAD_REQUEST:'内容或上限不合法，请检查后重试。',STALE_SESSION:'笔记库已改变，请重新打开记忆页。',VAULT_CHANGED:'笔记库已改变，请重新打开记忆页。',STALE_PREVIEW:'预览已失效，请重新核对。',MEMORY_CONFLICT:'记忆版本已变化，请刷新后重新核对。',MEMORY_SOURCE_CHANGED:'来源片段已改变或无法核验，请重新查看原文。',MEMORY_SOURCE_REPLACED:'来源对象已替换，请从新来源重新记住。',MEMORY_SOURCE_FORBIDDEN:'来源禁止触碰，不能记住或恢复。',MEMORY_SOURCE_PERMISSION:'来源权限已收紧，记忆已暂停。',MEMORY_SOURCE_UNCONFIRMED:'该选区包含未采纳的 AI 或无法确认的材料。',MEMORY_DEPENDENCY_CHANGED:'依赖的记忆或来源已失效，不能通过摘录恢复。',MEMORY_MATERIAL_FORGOTTEN:'材料已因遗忘清理，不可重试。',MEMORY_MODEL_UNAVAILABLE:'整理模型不可用；当前任务不积累记忆，正文仍可保存。',MEMORY_PERMISSION_DISABLED:'当前库记忆关闭；本场未积累。',MEMORY_SESSION_CLOSED:'已停止；旧会话材料不会自动重试。',MEMORY_DEADLINE:'整理超过有限期限，未提交；如材料仍有效可明确重试。',MEMORY_DISABLED:'当前库记忆已关闭，不能整理。',NO_MEMORY_MODEL:'尚未选择记忆模型；已有有效记忆仍可使用。',MEMORY_CONFIG_UNAVAILABLE:'记忆配置不可用，笔记仍可编辑和保存。',MEMORY_PIN_FAILED:'记忆写入核验失败，已停止使用；请检查本机存储。',LIFECYCLE_RECOVERY_REQUIRED:'文件迁移尚未核验，请先处理恢复记录。'}
  return text[code]??`记忆操作未完成（${code}），请核对来源或配置后重试。`
}
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,className?:string)=>{const n=document.createElement(tag);if(className)n.className=className;return n}
const paragraph=(text:string,className='settings-hint')=>{const p=el('p',className);p.textContent=text;return p}
const button=(text:string,run:()=>void)=>{const b=el('button','settings-action');b.type='button';b.textContent=text;b.addEventListener('click',run);return b}
const field=(title:string,input:HTMLElement)=>{const label=el('label','settings-field wide');const span=el('span');span.textContent=title;label.append(span,input);return label}
const layerSelect=(value:string)=>{const s=el('select');for(const [v,label] of [['core','核心'],['demand','按需']]){const o=el('option');o.value=v!;o.textContent=label!;s.append(o)}s.value=value;return s}
const modelSelect=(config:PublicModelConfig|null,value:string|null,empty:string)=>{
  const select=el('select'),none=el('option');none.value='';none.textContent=empty;select.append(none)
  for(const group of config?modelModuleGroups(config):[]){const optgroup=el('optgroup');optgroup.label=group.label;for(const item of group.items){const option=el('option');option.value=item.id;option.textContent=item.label;optgroup.append(option)}select.append(optgroup)}
  if(value&&!Array.from(select.options).some(o=>o.value===value)){const option=el('option');option.value=value;option.textContent='原模型不可用，请重新选择';select.append(option)}
  select.value=value??'';return select
}
function sources(host:HTMLElement,items:MemorySourceView[]):void{
  for(const source of items){const details=el('details','memory-source');const summary=el('summary');summary.textContent=`${source.relPath}${source.kind==='ledger'?` · 账本任务 ${source.taskId??'无法核对'}`:' · 正文'} · ${source.classification==='adopted-ai'?'人工采纳':source.classification==='command'?'口令':'人写'}`;details.append(summary);if(source.text)details.append(paragraph(source.text,'memory-source-text'));host.append(details)}
}
export type MemoryPreviewHandlers={commit:(request:Omit<MemoryCommitRequest,'sessionId'>)=>Promise<MemoryResult<MemoryView>>;isCurrent:()=>boolean;onDone:(view:MemoryView)=>void;onCancel:()=>void}
/** Used inline for management and in the existing overlay for a body/ledger selection. */
export function renderMemoryPreview(host:HTMLElement,preview:MemoryPreview,handlers:MemoryPreviewHandlers):void{
  const panel=el('section','memory-preview'),heading=el('h3','settings-section-title');heading.textContent=preview.kind==='manual'?'记住预览':preview.kind==='retry'?'重试整理预览':preview.kind==='confirm'?'确认记忆更正':'恢复记忆预览';panel.append(heading)
  if(preview.previousContent!==undefined)panel.append(paragraph(`当前内容：${preview.previousContent}`,'memory-source-text'))
  const content=el('textarea');content.rows=4;content.value=preview.content;content.maxLength=4096;content.readOnly=preview.kind!=='manual';content.setAttribute('aria-label','将记住的内容')
  const layer=layerSelect(preview.layer),scope=el('input');scope.value=preview.scope;scope.maxLength=512
  if(preview.kind==='manual')panel.append(field('将记住的内容',content),field('层级',layer),field('适用范围',scope))
  else panel.append(paragraph(preview.content,'memory-source-text'))
  panel.append(paragraph(preview.warning));sources(panel,preview.sources)
  if(preview.recipient)panel.append(paragraph(`接收方 ${preview.recipient.modelId} · ${preview.recipient.host}；用途：有限后台整理。`))
  if(preview.limits)panel.append(paragraph(`总期限 ${preview.limits.seconds} 秒，最多 ${preview.limits.calls} 次模型调用，工具 0 次。`))
  const error=paragraph('','settings-error');error.setAttribute('role','alert');error.hidden=true
  const actions=el('div','settings-actions')
  const confirm=button(preview.kind==='manual'?'确认记住':'确认',()=>{
    if(preview.kind==='manual'&&!content.value.trim()){error.textContent='请输入将记住的内容；草稿及预览仍保留。';error.hidden=false;return}
    confirm.disabled=true;error.hidden=true
    const request:Omit<MemoryCommitRequest,'sessionId'>={id:preview.id,...(preview.kind==='manual'?{content:content.value,layer:layer.value as 'core'|'demand',scope:scope.value}:{})}
    void handlers.commit(request).then(result=>{
      if(!handlers.isCurrent())return
      if(result.ok)handlers.onDone(result.value)
      else {error.textContent=`${memoryErrorText(result.error)} 本次预览已失效，请重新预览后确认；草稿保留在此。`;error.hidden=false}
    }).catch(()=>{if(handlers.isCurrent()){error.textContent='确认结果未能读取，本次预览已失效；请重新预览，草稿保留在此。';error.hidden=false}})
  })
  actions.append(confirm,button('取消',handlers.onCancel));panel.append(actions,error);host.append(panel)
}
export type MemoryPageHandlers={
  get:()=>Promise<MemoryResult<MemoryView>>
  models:()=>Promise<ModelConfigResult>
  save:(r:MemoryConfigChange)=>Promise<MemoryResult<MemoryView>>
  edit:(r:Omit<MemoryEditRequest,'sessionId'>)=>Promise<MemoryResult<MemoryView>>
  disable:(r:Omit<MemoryItemRequest,'sessionId'>)=>Promise<MemoryResult<MemoryView>>
  forget:(r:Omit<MemoryItemRequest,'sessionId'>)=>Promise<MemoryResult<MemoryView>>
  restore:(r:Omit<MemoryItemRequest,'sessionId'>)=>Promise<MemoryResult<MemoryPreview>>
  retry:(r:Omit<MemoryJobRequest,'sessionId'>)=>Promise<MemoryResult<MemoryPreview>>
  cancel:(r:Omit<MemoryJobRequest,'sessionId'>)=>Promise<MemoryResult<MemoryView>>
  commit:(r:Omit<MemoryCommitRequest,'sessionId'>)=>Promise<MemoryResult<MemoryView>>
}
export type MemoryPageHost={body:HTMLElement;isCurrent:()=>boolean;onChanged:(view:MemoryView)=>void}
export function mountMemoryPage(host:MemoryPageHost,handlers:MemoryPageHandlers):()=>void{
  let disposed=false,view:MemoryView|null=null,readSerial=0,modelsSnapshot:PublicModelConfig|null=null
  const current=()=>!disposed&&host.isCurrent(),body=host.body,error=paragraph('','settings-error');error.setAttribute('role','alert');error.hidden=true
  const status=paragraph('读取当前库记忆…'),items=el('section','memory-entries'),jobs=el('section','memory-jobs');body.append(status,error)
  const showError=(code:string)=>{error.textContent=memoryErrorText(code);error.hidden=false}
  let currentDefault:HTMLElement|null=null,currentVault:HTMLElement|null=null
  let updateReceiver=(_value:MemoryView):void=>{}
  const accept=(value:MemoryView)=>{view=value;host.onChanged(value);updateReceiver(value);status.textContent=`当前库记忆${value.config.vault.enabled?'开启':'关闭'} · ${value.entries.length} 条${value.status==='invalid'?` · ${memoryErrorText(value.reason??'MEMORY_UNAVAILABLE')}`:''}`;if(currentDefault){currentDefault.dataset.modelId=value.config.defaultModelId??'';currentDefault.textContent=`现值：${value.config.defaultModelId?(modelsSnapshot?.models.find(m=>m.id===value.config.defaultModelId)?.modelId??'原模型不可用'):'未选择'}`} ;if(currentVault)currentVault.textContent=`现值：${value.config.vault.enabled?'开启':'关闭'} · ${value.config.vault.override.mode==='inherit'?'继承设备默认':(modelsSnapshot?.models.find(m=>value.config.vault.override.mode==='model'&&m.id===value.config.vault.override.modelId)?.modelId??'原模型不可用')}`;paintItems();paintJobs()}
  async function mutate(run:()=>Promise<MemoryResult<MemoryView>>,b:HTMLButtonElement):Promise<void>{
    b.disabled=true;error.hidden=true
    try{const result=await run();if(!current())return;if(result.ok){ readSerial++; const edited=b.closest<HTMLElement>('.memory-entry'); if (edited && b.textContent==='保存条目') edited.remove(); accept(result.value) }else showError(result.error)}catch{if(current())showError('MEMORY_UNAVAILABLE')}finally{if(current())b.disabled=false}
  }
  const binding=(entry:MemoryEntryView)=>({revision:view!.revision,objectVersion:view!.objectVersion,id:entry.id,version:entry.version})
  const preview=async(hostNode:HTMLElement,run:()=>Promise<MemoryResult<MemoryPreview>>)=>{
    error.hidden=true
    const result=await run().catch(()=>({ok:false,error:'MEMORY_UNAVAILABLE'} as MemoryResult<MemoryPreview>));if(!current()||!hostNode.isConnected)return
    if(!result.ok){showError(result.error);return}
    hostNode.querySelector('.memory-preview')?.remove()
    renderMemoryPreview(hostNode,result.value,{commit:handlers.commit,isCurrent:()=>current()&&hostNode.isConnected,onDone:value=>{accept(value)},onCancel:()=>hostNode.querySelector('.memory-preview')?.remove()})
  }
  function paintItems():void{
    const focus = document.activeElement instanceof HTMLElement && items.contains(document.activeElement) ? document.activeElement : null
    const existing = new Map(Array.from(items.querySelectorAll<HTMLElement>('.memory-entry')).map(row => [row.dataset.memoryId!, row]))
    items.replaceChildren();const title=el('h3','settings-section-title');title.textContent='记忆条目';items.append(title)
    if(!view?.entries.length)items.append(paragraph('还没有记忆。获准任务保存后可自动整理，也可从正文选区或本篇账本补充记住。'))
    for(const entry of view?.entries??[]){
      const previous = existing.get(entry.id)
      if (previous && previous.dataset.version === String(entry.version)) { items.append(previous); continue }
      if (previous instanceof HTMLDetailsElement && previous.open) {
        if (!previous.querySelector('.memory-stale-warning')) previous.append(paragraph('当前条目版本已变化；草稿保留。请关闭条目并刷新后重新核对。', 'settings-hint memory-stale-warning'))
        items.append(previous); continue
      }
      const row=el('details','memory-entry');row.dataset.memoryId=entry.id;row.dataset.version=String(entry.version)
      const summary=el('summary');summary.textContent=`${({active:'有效',paused:'暂停',pending:'待确认',disabled:'停用'})[entry.status]} · ${entry.layer==='core'?'核心':'按需'} · ${entry.content}`;row.append(summary)
      row.append(paragraph(`版本 ${entry.version} · ${entry.updatedAt}${entry.reason?` · ${memoryErrorText(entry.reason)}`:''}`));sources(row,entry.sources)
      const content=el('textarea');content.rows=3;content.value=entry.content;content.maxLength=4096;content.setAttribute('aria-label','记忆内容')
      const layer=layerSelect(entry.layer),scope=el('input');scope.value=entry.scope;scope.maxLength=512
      row.append(field('内容',content),field('层级',layer),field('适用范围',scope))
      const actions=el('div','settings-actions')
      const save=button('保存条目',()=>void mutate(()=>handlers.edit({...binding(entry),content:content.value,layer:layer.value as 'core'|'demand',scope:scope.value}),save));actions.append(save)
      if(entry.status==='active'){const disable=button('停用',()=>void mutate(()=>handlers.disable(binding(entry)),disable));actions.append(disable)}
      else actions.append(button(entry.pendingTarget?'核对更正':'核对来源并恢复',()=>void preview(row,()=>handlers.restore(binding(entry)))))
      let armed=false
      const forget=button('删除并遗忘',()=>{if(!armed){armed=true;const warning=paragraph('同时清除无法证明无关的待整理重试材料，原笔记及账本不变。');warning.classList.add('memory-forget-warning');row.append(warning);forget.textContent='确认删除并遗忘';return}void mutate(()=>handlers.forget(binding(entry)),forget)})
      actions.append(forget);row.append(actions);items.append(row)
    }
    if (focus?.isConnected) focus.focus({ preventScroll: true })
  }
  function paintJobs():void{
    const focus=document.activeElement instanceof HTMLElement&&jobs.contains(document.activeElement)?document.activeElement:null
    const existing=new Map(Array.from(jobs.querySelectorAll<HTMLElement>('.memory-job')).map(row=>[row.dataset.taskId!,row]))
    jobs.replaceChildren();const title=el('h3','settings-section-title');title.textContent='后台整理';jobs.append(title)
    jobs.append(paragraph(`运行 ${view?.running.active??0} · 待处理 ${view?.running.pending??0}`))
    for(const job of view?.jobs??[]){
      const signature=JSON.stringify([job,view?.config,view?.recipient]),previous=existing.get(job.taskId)
      if(previous?.dataset.signature===signature){jobs.append(previous);continue}
      const row=el('div','memory-job');row.dataset.taskId=job.taskId;row.dataset.signature=signature
      row.append(paragraph(`任务 ${job.taskId} · ${({queued:'排队',running:'整理中',applied:'已完成',rejected:'未提交',interrupted:'已中断',unavailable:'不可用', 'handed-off':'已移交'})[job.outcome]}${job.reason?` · ${memoryErrorText(job.reason)}`:''}`));const request={taskId:job.taskId,materialVersion:job.materialVersion!}
      if(previous?.querySelector('.memory-preview'))row.append(paragraph('任务材料、状态或整理配置已变化；原预览已失效，请重新预览。'))
      if(job.retryable)row.append(button('预览并重试',()=>void preview(row,()=>handlers.retry(request))))
      if(job.outcome==='queued'||job.outcome==='running'){const cancel=button('停止整理',()=>void mutate(()=>handlers.cancel(request),cancel));row.append(cancel)}
      jobs.append(row)
    }
    if(focus?.isConnected)focus.focus({preventScroll:true})
  }
  void Promise.all([handlers.get(),handlers.models()]).then(([result,models])=>{
    if(!current())return
    if(!result.ok){showError(result.error);status.textContent='记忆不可用；正文仍可编辑和保存。';return}
    view=result.value;const cfg=view.config,modelConfig=models.ok?models.config:null;modelsSnapshot=modelConfig
    const device=el('section','memory-config'),deviceTitle=el('h3','settings-section-title');deviceTitle.textContent='设备默认记忆模型';device.append(deviceTitle)
    const selected=modelSelect(modelConfig,cfg.defaultModelId,'未选择');selected.dataset.memory='default-model';device.append(field('所有笔记库的默认模型',selected));currentDefault=paragraph('');currentDefault.dataset.memory='current-default';device.append(currentDefault)
    const saveDefault=button('保存设备默认',()=>void mutate(()=>handlers.save({target:'default',modelId:selected.value||null}),saveDefault));saveDefault.dataset.memory='save-default';device.append(saveDefault)
    const vault=el('section','memory-config'),title=el('h3','settings-section-title');title.textContent='当前库许可与模型';vault.append(title)
    const enabled=el('input');enabled.type='checkbox';enabled.checked=cfg.vault.enabled;enabled.dataset.memory='vault-enabled';const permission=field('允许独立使用记忆及后台整理',enabled);permission.classList.add('memory-permission-field');vault.append(permission)
    const override=modelSelect(modelConfig,cfg.vault.override.mode==='model'?cfg.vault.override.modelId:null,'继承设备默认');override.dataset.memory='vault-model';vault.append(field('当前库模型覆盖',override));currentVault=paragraph('');currentVault.dataset.memory='current-vault';vault.append(currentVault)
    vault.append(paragraph('开启允许同库任务自动使用有效核心与相关记忆；已有独立许可只用于已授权任务材料。关闭将停止已使用记忆的任务并保稿。'))
    const saveVault=button('保存当前库',()=>void mutate(()=>handlers.save({target:'vault',vault:{enabled:enabled.checked,override:override.value?{mode:'model',modelId:override.value}:{mode:'inherit'}}}),saveVault));saveVault.dataset.memory='save-vault';vault.append(saveVault)
    const receiver=paragraph('');updateReceiver=(value:MemoryView)=>{receiver.textContent=value.recipient?`整理接收方 ${value.recipient.modelId} · ${value.recipient.host}。用途：仅本任务实际发送的口令、必要结果、来源片段及相关记忆；不含思维链、全库或完整历史。`:'整理模型未选择或不可用；不会回退到其他模型，已有有效记忆仍可使用。'};updateReceiver(view);vault.append(receiver)
    const refresh=button('刷新状态',()=>void mutate(handlers.get,refresh));body.append(device,vault,refresh,items,jobs);accept(view)
  }).catch(()=>{if(current())showError('MEMORY_UNAVAILABLE')})
  const changed = (event: Event): void => {
    if (!current() || !view || (event as CustomEvent<string>).detail !== view.sessionId) return
    const serial = ++readSerial
    void handlers.get().then(result => { if (current() && serial === readSerial && result.ok) accept(result.value) }).catch(() => {})
  }
  window.addEventListener('rgent:memory', changed)
  return()=>{disposed=true;window.removeEventListener('rgent:memory', changed)}
}

/** Display-only chapter ranges; main independently parses and classifies every request. */
export function ledgerRememberRanges(ledger:string):{taskId:string;label:string;start:number;end:number}[]{
  const chapters=[...ledger.matchAll(/^<!-- rgent:ledger-task:v1 id="([A-Za-z0-9_-]+)"(?: sources="v[12]")? -->\r?$/gm)]
  const result:{taskId:string;label:string;start:number;end:number}[]=[]
  for(let at=0;at<chapters.length;at++){
    const chapter=ledger.slice(chapters[at]!.index,chapters[at+1]?.index??ledger.length),taskId=chapters[at]![1]!
    const completed = /^## .* · completed\r?$/m.test(chapter)
    const prompt=[...chapter.matchAll(/^### 口令\r?\n\r?\n/gm)],answer=[...chapter.matchAll(/^### 回答\r?\n\r?\n/gm)],tools=[...chapter.matchAll(/^### 工具摘要\r?$/gm)]
    if(prompt.length!==1||answer.length!==1||tools.length!==1)continue
    for(const [label,from,to] of [['口令',prompt[0]!,answer[0]!],['回答',answer[0]!,tools[0]!]] as const){
      if (label === '回答' && !completed) continue
      const start=from.index+from[0].length,end=to.index-(chapter.slice(0,to.index).match(/(?:\r?\n){2}$/u)?.[0].length ?? 0)
      if(end>start)result.push({taskId,label,start,end})
    }
  }
  return result
}
