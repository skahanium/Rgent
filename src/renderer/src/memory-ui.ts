import { memoryErrorText } from '../../shared/memory-errors.ts'
import type { ModelConfigResult, PublicModelConfig } from '../../shared/ipc.ts'
import type { MemoryConfigChange, MemoryCommitRequest, MemoryEditRequest, MemoryEntryView, MemoryItemRequest, MemoryJobRequest, MemoryMaintenanceRequest, MemoryPreview, MemoryResult, MemorySourceView, MemoryView } from '../../shared/memory.ts'
import { modelModuleGroups } from './statusbar.ts'

export { memoryErrorText } from '../../shared/memory-errors.ts'
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,className?:string)=>{const n=document.createElement(tag);if(className)n.className=className;return n}
const paragraph=(text:string,className='settings-hint')=>{const p=el('p',className);p.textContent=text;return p}
const button=(text:string,run:()=>void)=>{const b=el('button','settings-action');b.type='button';b.textContent=text;b.addEventListener('click',run);return b}
const field=(title:string,input:HTMLElement)=>{const label=el('label','settings-field wide');const span=el('span');span.textContent=title;label.append(span,input);return label}
const layerSelect=(value:string)=>{const s=el('select');for(const [v,label] of [['core','持续约定'],['demand','相关知识']]){const o=el('option');o.value=v!;o.textContent=label!;s.append(o)}s.value=value;return s}
const modelSelect=(config:PublicModelConfig|null,value:string|null,empty:string)=>{
  const select=el('select'),none=el('option');none.value='';none.textContent=empty;select.append(none)
  for(const group of config?modelModuleGroups(config):[]){const optgroup=el('optgroup');optgroup.label=group.label;for(const item of group.items){const option=el('option');option.value=item.id;option.textContent=item.label;optgroup.append(option)}select.append(optgroup)}
  if(value&&!Array.from(select.options).some(o=>o.value===value)){const option=el('option');option.value=value;option.textContent='原模型不可用，请重新选择';select.append(option)}
  select.value=value??'';return select
}
function sources(host:HTMLElement,items:MemorySourceView[]):void{
  const existing=Array.from(host.querySelectorAll<HTMLDetailsElement>(':scope > .memory-source'))
  items.forEach((source,index)=>{
    const details=existing[index]??el('details','memory-source'),summary=details.querySelector('summary')??el('summary')
    summary.textContent=`${source.relPath}${source.kind==='ledger'?` · 账本任务 ${source.taskId??'无法核对'}`:' · 正文'} · ${source.classification==='adopted-ai'?'人工采纳':source.classification==='command'?'口令':'人写'}`
    if(!summary.parentElement)details.append(summary)
    const text=details.querySelector<HTMLElement>('.memory-source-text')
    if(source.text){if(text)text.textContent=source.text;else details.append(paragraph(source.text,'memory-source-text'))}else text?.remove()
    if(!details.parentElement)host.append(details)
  })
  for(const details of existing.slice(items.length))details.remove()
}
export type MemoryPreviewHandlers={commit:(request:Omit<MemoryCommitRequest,'sessionId'>)=>Promise<MemoryResult<MemoryView>>;isCurrent:()=>boolean;onDone:(view:MemoryView)=>void;onCancel:()=>void}
/** Used inline for management and in the existing overlay for a body/ledger selection. */
export function renderMemoryPreview(host:HTMLElement,preview:MemoryPreview,handlers:MemoryPreviewHandlers):void{
  const panel=el('section','memory-preview'),heading=el('h3','settings-section-title');heading.textContent=preview.kind==='manual'?'记住预览':preview.kind==='retry'?'重试整理预览':preview.kind==='confirm'?'确认记忆更正':preview.kind==='undo'?'撤销本场记忆变更':preview.kind==='watermark'?'学习水位预览':preview.kind==='reset-config'?'设备配置重建预览':preview.kind==='reset'?'本库记忆重建预览':'恢复记忆预览';panel.append(heading)
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
  maintenance:(r:Omit<MemoryMaintenanceRequest,'sessionId'>)=>Promise<MemoryResult<MemoryPreview>>
  commit:(r:Omit<MemoryCommitRequest,'sessionId'>)=>Promise<MemoryResult<MemoryView>>
}
export type MemoryPageHost={body:HTMLElement;isCurrent:()=>boolean;onChanged:(view:MemoryView)=>void}
export function mountMemoryPage(host:MemoryPageHost,handlers:MemoryPageHandlers):()=>void{
  let disposed=false,view:MemoryView|null=null,readSerial=0,modelsSnapshot:PublicModelConfig|null=null
  const current=()=>!disposed&&host.isCurrent(),body=host.body,error=paragraph('','settings-error');error.setAttribute('role','alert');error.hidden=true
  const status=paragraph('读取当前库记忆…'),items=el('section','memory-entries'),jobs=el('section','memory-jobs'),maintenance=el('section','memory-maintenance');body.append(status,error)
  const showError=(code:string)=>{error.textContent=memoryErrorText(code);error.hidden=false}
  let currentDefault:HTMLElement|null=null,currentVault:HTMLElement|null=null
  let updateReceiver=(_value:MemoryView):void=>{}
  const accept=(value:MemoryView)=>{view=value;host.onChanged(value);updateReceiver(value);status.textContent=`当前库记忆${value.config.vault.enabled?'开启':'关闭'} · ${value.entries.length} 条${value.reason||value.status==='invalid'?` · ${memoryErrorText(value.reason??'MEMORY_UNAVAILABLE')}`:''}`;if(currentDefault){currentDefault.dataset.modelId=value.config.defaultModelId??'';currentDefault.textContent=`现值：${value.config.defaultModelId?(modelsSnapshot?.models.find(m=>m.id===value.config.defaultModelId)?.modelId??'原模型不可用'):'未选择'}`} ;if(currentVault)currentVault.textContent=`现值：${value.config.vault.enabled?'开启':'关闭'} · ${value.config.vault.override.mode==='inherit'?'继承设备默认':(modelsSnapshot?.models.find(m=>value.config.vault.override.mode==='model'&&m.id===value.config.vault.override.modelId)?.modelId??'原模型不可用')}`;paintItems();paintJobs();paintMaintenance()}
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
  function paintEntryMetadata(row: HTMLElement, entry: MemoryEntryView): void {
    const signature = JSON.stringify([entry.status, entry.reason, entry.sources, entry.updatedAt, entry.pendingTarget,entry.attribution,entry.reviewAt])
    if (row.dataset.metadata === signature) return
    const summary = row.querySelector('summary')!
    summary.textContent = `${({active:'有效',paused:'证据暂停',pending:'待确认',disabled:'停用',review:'待复核',obsolete:'过时',disputed:'争议',deferred:'容量暂缓'})[entry.status]} · ${entry.layer==='core'?'持续约定':'相关知识'} · ${entry.content}`
    const metadata = row.querySelector<HTMLElement>('.memory-entry-metadata')!
    let detail = metadata.querySelector<HTMLElement>(':scope > .settings-hint')
    if (!detail) { detail = paragraph(''); metadata.prepend(detail) }
    detail.textContent = `${entry.attribution??'归属未提供'} · ${entry.scope} · ${entry.reviewAt?'复核期 '+entry.reviewAt:'未设复核期'} · 版本 ${entry.version} · ${entry.updatedAt}${entry.reason?` · ${memoryErrorText(entry.reason)}`:''}`
    sources(metadata, entry.sources)
    const action = row.querySelector<HTMLButtonElement>('.memory-entry-state-action')!
    action.textContent = entry.status === 'active' ? '停用' : entry.pendingTarget ? '核对更正' : entry.status==='pending'||entry.status==='disputed'?'确认新事实':'核对来源并恢复'
    action.onclick = () => { if (entry.status === 'active') void mutate(() => handlers.disable(binding(entry)), action); else void preview(row, () => handlers.restore(binding(entry))) }
    if (row.querySelector('.memory-preview')) {
      row.querySelector('.memory-preview')!.remove()
      row.append(paragraph('来源或状态已变化；原预览已失效，请重新核对。'))
    }
    row.dataset.metadata = signature
  }
  function paintItems():void{
    const focus = document.activeElement instanceof HTMLElement && items.contains(document.activeElement) ? document.activeElement : null
    const existing = new Map(Array.from(items.querySelectorAll<HTMLElement>('.memory-entry')).map(row => [row.dataset.memoryId!, row]))
    items.replaceChildren();const title=el('h3','settings-section-title');title.textContent='记忆条目';items.append(title)
    if(!view?.entries.length)items.append(paragraph('还没有记忆。获准任务保存后可自动整理，也可从正文选区或本篇账本补充记住。'))
    for(const entry of view?.entries??[]){
      const previous = existing.get(entry.id)
      if (previous && previous.dataset.version === String(entry.version)) { paintEntryMetadata(previous, entry); items.append(previous); continue }
      if (previous instanceof HTMLDetailsElement && previous.open) {
        if (!previous.querySelector('.memory-stale-warning')) previous.append(paragraph('当前条目版本已变化；草稿保留。请关闭条目并刷新后重新核对。', 'settings-hint memory-stale-warning'))
        items.append(previous); continue
      }
      const row=el('details','memory-entry');row.dataset.memoryId=entry.id;row.dataset.version=String(entry.version)
      row.append(el('summary'), el('div', 'memory-entry-metadata'))
      const content=el('textarea');content.rows=3;content.value=entry.content;content.maxLength=4096;content.setAttribute('aria-label','记忆内容')
      const layer=layerSelect(entry.layer),scope=el('input');scope.value=entry.scope;scope.maxLength=512
      row.append(field('内容',content),field('层级',layer),field('适用范围',scope))
      const actions=el('div','settings-actions')
      const save=button('保存条目',()=>void mutate(()=>handlers.edit({...binding(entry),content:content.value,layer:layer.value as 'core'|'demand',scope:scope.value}),save));actions.append(save)
      const stateAction = el('button', 'settings-action memory-entry-state-action'); stateAction.type = 'button'; actions.append(stateAction)
      let armed=false
      const forget=button('删除并遗忘',()=>{if(!armed){armed=true;const warning=paragraph('删除记忆正文并阻断已知派生内容；取消待整理材料并清除摘要缓存。原笔记与账本不变，不保证清除外部备份或未知改写。');warning.classList.add('memory-forget-warning');row.append(warning);forget.textContent='确认删除并遗忘';return}void mutate(()=>handlers.forget(binding(entry)),forget)})
      actions.append(forget);row.append(actions);paintEntryMetadata(row, entry);items.append(row)
    }
    if (focus?.isConnected) focus.focus({ preventScroll: true })
  }
  function paintMaintenance():void{
    if(!view)return
    const signature=JSON.stringify([view.learning,view.diagnosis,view.configDiagnosis,view.status])
    if(maintenance.dataset.signature===signature)return
    maintenance.dataset.signature=signature;maintenance.replaceChildren()
    const title=el('h3','settings-section-title');title.textContent='学习与诊断';maintenance.append(title)
    if(view.learning){maintenance.append(paragraph(`自动学习材料截止于序号 ${view.learning.watermark}；当前材料序号 ${view.learning.nextSequence}。`))
      maintenance.append(button('预览推进学习水位',()=>void preview(maintenance,()=>handlers.maintenance({action:'watermark',revision:view!.revision,objectVersion:view!.objectVersion,watermark:view!.learning!.nextSequence}))))}
    if(view.diagnosis){maintenance.append(paragraph(`本库记忆记录 ${view.diagnosis.bytes} 字节；损坏记录不会当作空记录覆盖。`))
      maintenance.append(button('核对并重建本库记忆',()=>void preview(maintenance,()=>handlers.maintenance({action:'reset',revision:view!.diagnosis!.revision,objectVersion:view!.diagnosis!.objectVersion}))))}
    if(view.configDiagnosis){maintenance.append(paragraph('记忆配置不可用；本库内容仍可查看和诊断，回答模型与密钥不受影响。'))
      maintenance.append(button('核对并重建记忆设备配置',()=>void preview(maintenance,()=>handlers.maintenance({action:'reset-config',revision:view!.configDiagnosis!.revision,objectVersion:null}))))}
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
      if(job.outcome==='applied')row.append(paragraph(`本场新增或更新 ${job.entryIds?.length??0} 条；可在上方查看、编辑或删除并遗忘。`))
      if(previous?.querySelector('.memory-preview'))row.append(paragraph('任务材料、状态或整理配置已变化；原预览已失效，请重新预览。'))
      if(job.undoable)row.append(button('预览撤销本场变更',()=>void preview(row,()=>handlers.maintenance({action:'undo',taskId:job.taskId,materialVersion:job.materialVersion!,revision:view!.revision,objectVersion:view!.objectVersion}))))
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
    const refresh=button('刷新状态',()=>void mutate(handlers.get,refresh));body.append(device,vault,refresh,items,jobs,maintenance);accept(view)
  }).catch(()=>{if(current())showError('MEMORY_UNAVAILABLE')})
  const changed = (event: Event): void => {
    if (!current() || !view || (event as CustomEvent<string>).detail !== view.sessionId) return
    const serial = ++readSerial
    void handlers.get().then(result => { if (current() && serial === readSerial && result.ok) accept(result.value) }).catch(() => {})
  }
  window.addEventListener('rgent:memory', changed)
  return()=>{disposed=true;window.removeEventListener('rgent:memory', changed)}
}

/** Program-defined offsets in the typed ledger context, independently rechecked by main. */
export function ledgerRememberCommand(record:import('../../main/ledger-store.ts').LedgerRecord):{taskId:string;start:number;end:number}|null{
  if(record.state!=='saved'||!record.chapter?.prompt||record.legacyRaw)return null
  return {taskId:record.taskId,start:'口令：\n'.length,end:'口令：\n'.length+record.chapter.prompt.length}
}
