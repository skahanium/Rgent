import { memoryErrorText } from '../../shared/memory-errors.ts'
import type { ModelConfigResult, PublicModelConfig } from '../../shared/ipc.ts'
import type { MemoryConfigChange, MemoryCommitRequest, MemoryEditRequest, MemoryEntryView, MemoryItemRequest, MemoryJobRequest, MemoryMaintenanceRequest, MemoryPreview, MemoryResult, MemorySourceView, MemoryView } from '../../shared/memory.ts'
import { icon } from './icons.ts'
import { modelModuleGroups } from './statusbar.ts'

export { memoryErrorText } from '../../shared/memory-errors.ts'
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,className?:string)=>{const n=document.createElement(tag);if(className)n.className=className;return n}
const paragraph=(text:string,className='settings-hint')=>{const p=el('p',className);p.textContent=text;return p}
const button=(text:string,run:()=>void)=>{const b=el('button','settings-action');b.type='button';b.textContent=text;b.addEventListener('click',run);return b}
const field=(title:string,input:HTMLElement)=>{const label=el('label','settings-field wide');const span=el('span');span.textContent=title;label.append(span,input);return label}
const layerSelect=(value:string)=>{const s=el('select');for(const [v,label] of [['core','长期约定'],['demand','项目事实']]){const o=el('option');o.value=v!;o.textContent=label!;s.append(o)}s.value=value;return s}
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
    summary.textContent=`${source.relPath} · ${source.kind==='ledger'?'任务记录':'正文'} · ${source.classification==='adopted-ai'?'已采纳回答':source.classification==='command'?'你的口令':'人写内容'}`
    summary.title=source.relPath
    let technical=details.querySelector<HTMLElement>('.memory-source-id')
    if(source.taskId){if(!technical){technical=paragraph('','settings-hint memory-source-id');details.append(technical)}technical.textContent=`任务编号：${source.taskId}`}else technical?.remove()
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
  const panel=el('section','memory-preview'),heading=el('h3','settings-section-title');heading.textContent=({manual:'记住这段内容',retry:'重新整理这场任务',confirm:'确认记忆内容',undo:'撤销本场记忆变更',watermark:'不再从已有材料学习', 'reset-config':'重置本设备的记忆设置',reset:'清空本库记忆',restore:'恢复使用这条记忆',retire:'清除旧记忆'})[preview.kind];panel.append(heading)
  if(preview.previousContent!==undefined)panel.append(paragraph(`当前内容：${preview.previousContent}`,'memory-source-text'))
  const content=el('textarea');content.rows=4;content.value=preview.content;content.maxLength=4096;content.readOnly=preview.kind!=='manual';content.setAttribute('aria-label','将记住的内容')
  const layer=layerSelect(preview.layer),scope=el('input');scope.value=preview.scope;scope.maxLength=512
  if(preview.kind==='manual')panel.append(field('将记住的内容',content),field('记忆类别',layer),field('适用范围',scope))
  else panel.append(paragraph(preview.content,'memory-source-text'))
  panel.append(paragraph(preview.warning));sources(panel,preview.sources)
  if(preview.recipient)panel.append(paragraph(`接收方 ${preview.recipient.modelId} · ${preview.recipient.host}；用途：整理本场记忆。`))
  if(preview.limits)panel.append(paragraph(`最多用时 ${preview.limits.seconds} 秒，最多请求模型 ${preview.limits.calls} 次，不调用工具。`))
  const error=paragraph('','settings-error');error.setAttribute('role','alert');error.hidden=true
  const actions=el('div','settings-actions')
  const confirm=button(({manual:'确认记住',retry:'确认重新整理',confirm:'确认内容',undo:'确认撤销变更',watermark:'确认停止旧材料学习','reset-config':'确认重置记忆设置',reset:'确认清空记忆',restore:'确认恢复使用',retire:'确认清除旧记忆'})[preview.kind],()=>{
    if(preview.kind==='manual'&&!content.value.trim()){error.textContent='请输入将记住的内容；草稿及预览仍保留。';error.hidden=false;return}
    confirm.disabled=true;error.hidden=true
    const request:Omit<MemoryCommitRequest,'sessionId'>={id:preview.id,...(preview.kind==='manual'?{content:content.value,layer:layer.value as 'core'|'demand',scope:scope.value}:{})}
    void handlers.commit(request).then(result=>{
      if(!handlers.isCurrent())return
      if(result.ok)handlers.onDone(result.value)
      else {error.textContent=`${memoryErrorText(result.error)} 本次预览已失效，请重新预览后确认；草稿保留在此。`;error.hidden=false}
    }).catch(()=>{if(handlers.isCurrent()){error.textContent='确认结果未能读取，本次预览已失效；请重新预览，草稿保留在此。';error.hidden=false}})
  })
  if(preview.kind==='reset'||preview.kind==='reset-config'||preview.kind==='retire')confirm.classList.add('memory-danger')
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
/** 质量成绩四种状态分别如实显示；未取得人工复核时明确标注，不显示为通过。 */
export function qualityEvidenceText(quality:MemoryView['quality']):string{
 const base=(()=>{switch(quality?.state){
  case 'passed':return quality.stale?'曾通过本轮质量验收，但整理模型、主机或管线已变，旧成绩不再适用。':'已通过本项目质量验收。'
  case 'failed':return '已测试，未通过本轮质量验收：可能遗漏或错误整理信息。'
  case 'insufficient':return '测试未完成或证据不足，尚未得出结论。'
  case 'testing':return '正在测试中。'
  default:return '自动学习质量尚未通过验证。AI 可能遗漏或错误整理信息。'}})()
 const review=quality&&quality.state!=='unverified'&&!quality.humanReviewed?' 未人工复核。':''
 return `${base}${review}请在重要任务中核对原材料，你可以查看、修改或遗忘记忆。`
}
export type MemoryPageHost={body:HTMLElement;isCurrent:()=>boolean;onChanged:(view:MemoryView)=>void}
export function mountMemoryPage(host:MemoryPageHost,handlers:MemoryPageHandlers):()=>void{
  let disposed=false,view:MemoryView|null=null,readSerial=0,modelsSnapshot:PublicModelConfig|null=null
  const current=()=>!disposed&&host.isCurrent(),body=host.body,error=paragraph('','settings-error');error.setAttribute('role','alert');error.hidden=true
  const showError=(code:string)=>{error.textContent=memoryErrorText(code);error.hidden=false}
  body.classList.add('memory-page')
  const statusCard=el('section','memory-card memory-status-card');statusCard.dataset.memorySection='status'
  const status=paragraph('正在读取记忆…','memory-status-line'),statusHead=el('div','memory-card-heading')
  const heading=el('h3');heading.textContent='本库记忆'
  const refresh=button('',()=>void mutate(handlers.get,refresh));refresh.classList.add('memory-refresh');refresh.append(icon('refresh'));refresh.setAttribute('aria-label','刷新状态');refresh.title='刷新状态'
  const qualityNote=paragraph(qualityEvidenceText(undefined),'settings-hint memory-quality-status')
  statusHead.append(heading,refresh);statusCard.append(statusHead,status,qualityNote)
  const recentCard=el('section','memory-card memory-recent');recentCard.dataset.memorySection='recent'
  const recentTitle=el('h3');recentTitle.textContent='近期工作背景'
  const recentList=el('div','memory-list'),recentEmpty=el('div','memory-empty')
  recentCard.append(recentTitle,recentList,recentEmpty)
  const items=el('section','memory-card memory-entries');items.dataset.memorySection='entries'
  const fold=(title:string,section:string)=>{const d=el('details','memory-card memory-fold');d.dataset.memorySection=section;const summary=el('summary');summary.textContent=title;d.append(summary);return d}
  const modelPanel=fold('模型设置','models'),jobsPanel=fold('最近整理记录','jobs'),maintenancePanel=fold('高级维护','maintenance')
  const jobs=el('div','memory-jobs'),maintenance=el('div','memory-maintenance');jobsPanel.append(jobs);maintenancePanel.append(maintenance)
  body.append(statusCard,error,recentCard,items,modelPanel,jobsPanel,maintenancePanel)
  let currentDefault:HTMLElement|null=null,currentVault:HTMLElement|null=null
  let updateReceiver=(_value:MemoryView):void=>{},updateDrafts=():void=>{}
  let filter:'all'|'usable'|'attention'='all'
  let modelSetupChecked=false,lastModelStatus:MemoryView['config']['modelStatus']|null=null
  const filters=el('div','memory-filters');filters.setAttribute('role','group');filters.setAttribute('aria-label','筛选记忆')
  const listTitle=el('h3');listTitle.textContent='已记住的内容'
  const listHead=el('div','memory-list-heading');listHead.append(listTitle,filters)
  const list=el('div','memory-list'),empty=el('div','memory-empty');items.append(listHead,list,empty)
  for(const [key,label] of [['all','全部'],['usable','可使用'],['attention','需要处理']] as const){
    const b=button(label,()=>{filter=key;applyFilter()});b.dataset.memoryFilter=key;filters.append(b)
  }
  function applyFilter():void{
    for(const b of filters.querySelectorAll<HTMLButtonElement>('button'))b.setAttribute('aria-pressed',String(b.dataset.memoryFilter===filter))
    for(const row of body.querySelectorAll<HTMLElement>('.memory-list .memory-entry')){
      const entry=view?.entries.find(e=>e.id===row.dataset.memoryId)
      row.hidden=filter==='usable'?entry?.status!=='active':filter==='attention'?!entry||!['paused','pending','review','disputed','deferred'].includes(entry.status):false
    }
    const longs=view?.entries.filter(e=>e.category!=='recent')??[],recents=view?.entries.filter(e=>e.category==='recent')??[]
    const shownLong=Array.from(list.querySelectorAll<HTMLElement>('.memory-entry')).some(row=>!row.hidden)
    const shownRecent=Array.from(recentList.querySelectorAll<HTMLElement>('.memory-entry')).some(row=>!row.hidden)
    empty.hidden=shownLong
    empty.replaceChildren(paragraph(longs.length?'没有符合此筛选的长期内容。':'还没有长期内容','memory-empty-title'))
    if(!longs.length)empty.append(paragraph(view?.config.vault.enabled?'任务保存成功后，AI 会自动整理获准材料。你也可以从正文选区或账本口令中点击“记住”。':'开启本库记忆后，AI 会从保存成功的获准任务中自动整理。现有笔记不会被自动扫描。'))
    recentEmpty.hidden=shownRecent
    recentEmpty.replaceChildren(paragraph(recents.length?'没有符合此筛选的近期背景。':'还没有近期工作背景','memory-empty-title'))
  }
  const modelName=(id:string|null)=>id?(modelsSnapshot?.models.find(m=>m.id===id)?.modelId??'原模型不可用'):'未选择'
  const accept=(value:MemoryView)=>{
    view=value;host.onChanged(value);updateReceiver(value)
    const recentCount=value.entries.filter(e=>e.category==='recent').length
    status.textContent=`已保存 · ${value.config.vault.enabled?'已开启':'已关闭'} · 长期 ${value.entries.length-recentCount} 条 · 近期 ${recentCount} 块${value.reason||value.status==='invalid'?` · ${memoryErrorText(value.reason??'MEMORY_UNAVAILABLE')}`:''}`
    if(value.materialStatus==='invalid'&&value.reason!=='LEDGER_REGISTRY_INVALID')status.textContent+=` · ${memoryErrorText('LEDGER_REGISTRY_INVALID')}`
    if(value.retirementFailure)status.textContent+=` · ${memoryErrorText(value.retirementFailure)}`
    if(value.maintenanceFailure)status.textContent+=` · 后续维护未完成：${memoryErrorText(value.maintenanceFailure)}`
    if(value.bindingFailure)status.textContent+=` · ${memoryErrorText(value.bindingFailure)}`
    qualityNote.textContent=qualityEvidenceText(value.quality)
    if(currentDefault){currentDefault.dataset.modelId=value.config.defaultModelId??'';currentDefault.textContent=`已保存：${modelName(value.config.defaultModelId)}`}
    if(currentVault)currentVault.textContent=`已保存：${value.config.vault.enabled?'已开启':'已关闭'} · ${value.config.vault.override.mode==='inherit'?'跟随默认模型':modelName(value.config.vault.override.modelId)}`
    if(!modelSetupChecked||lastModelStatus!==value.config.modelStatus&&value.config.modelStatus!=='ready'){modelPanel.open=value.config.modelStatus!=='ready';modelSetupChecked=true}lastModelStatus=value.config.modelStatus
    updateDrafts();paintRecent();paintItems();paintJobs();paintMaintenance()
  }
  async function mutate(run:()=>Promise<MemoryResult<MemoryView>>,b:HTMLButtonElement):Promise<void>{
    b.disabled=true;error.hidden=true
    const refreshSerial=b===refresh?++readSerial:null
    try{const result=await run();if(!current()||refreshSerial!==null&&refreshSerial!==readSerial)return;if(result.ok){ readSerial++; const edited=b.closest<HTMLElement>('.memory-entry'),savedId=b.dataset.memoryAction==='save-edit'?edited?.dataset.memoryId:undefined; if(savedId)edited!.remove(); accept(result.value);if(savedId){const row=Array.from(list.querySelectorAll<HTMLElement>('.memory-entry')).find(r=>r.dataset.memoryId===savedId);if(row&&!row.hidden)row.querySelector<HTMLElement>('summary')?.focus({preventScroll:true})} }else showError(result.error)}catch{if(current())showError('MEMORY_UNAVAILABLE')}finally{if(!disposed)b.disabled=false}
  }
  const binding=(entry:MemoryEntryView)=>({revision:view!.revision,objectVersion:view!.objectVersion,id:entry.id,version:entry.version})
  const preview=async(hostNode:HTMLElement,run:()=>Promise<MemoryResult<MemoryPreview>>)=>{
    error.hidden=true
    const result=await run().catch(()=>({ok:false,error:'MEMORY_UNAVAILABLE'} as MemoryResult<MemoryPreview>));if(!current()||!hostNode.isConnected)return
    if(!result.ok){showError(result.error);return}
    hostNode.querySelector('.memory-preview')?.remove()
    renderMemoryPreview(hostNode,result.value,{commit:handlers.commit,isCurrent:()=>current()&&hostNode.isConnected,onDone:value=>{accept(value)},onCancel:()=>hostNode.querySelector('.memory-preview')?.remove()})
  }
  function paintRecent():void{
    const focus=document.activeElement instanceof HTMLElement&&recentCard.contains(document.activeElement)?document.activeElement:null
    const existing=new Map(Array.from(recentList.querySelectorAll<HTMLDetailsElement>('.memory-entry')).map(row=>[row.dataset.memoryId!,row]))
    recentList.replaceChildren()
    for(const entry of view?.entries.filter(e=>e.category==='recent')??[]){
      let row=existing.get(entry.id)
      if(!row||row.dataset.version!==String(entry.version)){
        row=el('details','memory-entry memory-recent-entry');row.dataset.memoryId=entry.id;row.dataset.version=String(entry.version)
        row.append(el('summary'),el('div','memory-recent-sections'),el('div','memory-entry-metadata'))
        const actions=el('div','settings-actions');let armed=false
        const forget=button('删除并遗忘',()=>{
          if(!armed){armed=true;const warning=paragraph('删除这块近期背景并阻止原材料自动重新生成。关联摘要会清除；无法确定无关的待整理材料也会一并清除。原笔记与账本不变，外部备份和已发送内容不会被清除。');warning.classList.add('memory-forget-warning');row!.append(warning);forget.textContent='确认删除并遗忘';cancelForget.hidden=false;return}
          const latest=view?.entries.find(e=>e.id===entry.id);if(latest)void mutate(()=>handlers.forget(binding(latest)),forget)
        })
        const cancelForget=button('取消遗忘',()=>{armed=false;row!.querySelector('.memory-forget-warning')?.remove();forget.textContent='删除并遗忘';cancelForget.hidden=true;forget.focus()});cancelForget.hidden=true;cancelForget.dataset.memoryAction='cancel-forget'
        forget.classList.add('memory-danger');actions.append(forget,cancelForget);row.append(actions)
      }
      const signature=JSON.stringify([entry.content,entry.status,entry.reason,entry.updatedAt,entry.sources,entry.recent])
      if(row.dataset.metadata!==signature){
        const summary=row.querySelector('summary')!,tags=el('span','memory-entry-tags'),badge=el('span','memory-badge')
        badge.textContent=({active:'可使用',paused:'来源需要检查',pending:'待确认',disabled:'已停用',review:'待复核',obsolete:'已过时',disputed:'有争议',deferred:'等待可用空间'})[entry.status];badge.dataset.status=entry.status
        tags.append(badge,paragraph('近期工作背景','memory-entry-category'))
        const copy=el('span','memory-entry-excerpt');copy.textContent=entry.recent?.sections.goal||entry.content
        summary.replaceChildren(icon('folder-open','memory-chevron'),copy,tags)
        const sections=row.querySelector<HTMLElement>('.memory-recent-sections')!
        sections.replaceChildren()
        for(const [key,label] of [['goal','目标'],['completed','已完成'],['blocked','受阻'],['next','下一步']] as const){
          const section=el('div','memory-recent-section'),title=el('strong');title.textContent=label
          section.append(title,paragraph(entry.recent?.sections[key]||'无','memory-source-text'));sections.append(section)
        }
        const metadata=row.querySelector<HTMLElement>('.memory-entry-metadata')!
        const outcome=entry.recent?.outcome?({completed:'已完成',cancelled:'已取消',failed:'失败',limit:'达到上限'})[entry.recent.outcome]:'未知'
        let detail=metadata.querySelector<HTMLElement>(':scope > .settings-hint')
        if(!detail){detail=paragraph('');metadata.prepend(detail)}
        const created=entry.recent?.createdAt,createdLabel=created&&Number.isFinite(Date.parse(created))?new Date(created).toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'未提供'
        detail.textContent=`任务结果：${outcome} · 建立：${createdLabel} · 有效期：${created?'建立后 14 天':'未提供'}${entry.reason?' · '+memoryErrorText(entry.reason):''}`
        let technical=metadata.querySelector<HTMLDetailsElement>(':scope > .memory-technical')
        if(!technical){technical=el('details','memory-technical');technical.append(Object.assign(el('summary'),{textContent:'详细信息'}),paragraph(''));metadata.append(technical)}
        technical.querySelector('p')!.textContent=`更新：${entry.updatedAt} · 版本 ${entry.version} · 任务编号：${entry.recent?.taskId||'未提供'}`
        sources(metadata,entry.sources)
        row.dataset.metadata=signature
      }
      recentList.append(row)
    }
    applyFilter()
    if(focus?.isConnected&&!focus.closest<HTMLElement>('[hidden]'))focus.focus({preventScroll:true})
  }
  function paintEntryMetadata(row: HTMLElement, entry: MemoryEntryView): void {
    const signature = JSON.stringify([entry.status, entry.reason, entry.sources, entry.updatedAt, entry.pendingTarget,entry.attribution,entry.reviewAt])
    if (row.dataset.metadata === signature) return
    const summary = row.querySelector('summary')!
    summary.replaceChildren()
    const copy=el('span','memory-entry-excerpt');copy.textContent=entry.content
    const tags=el('span','memory-entry-tags'),badge=el('span','memory-badge');badge.textContent=({active:'可使用',paused:'来源需要检查',pending:'待确认',disabled:'已停用',review:'待复核',obsolete:'已过时',disputed:'有争议',deferred:'等待可用空间'})[entry.status]
    badge.dataset.status=entry.status;tags.append(badge,paragraph(entry.layer==='core'?'长期约定':'项目事实','memory-entry-category'));summary.append(icon('folder-open','memory-chevron'),copy,tags)
    row.querySelector<HTMLElement>('.memory-entry-content')!.textContent=entry.content
    const metadata = row.querySelector<HTMLElement>('.memory-entry-metadata')!
    let detail = metadata.querySelector<HTMLElement>(':scope > .settings-hint')
    if (!detail) { detail = paragraph(''); metadata.prepend(detail) }
    detail.textContent=`适用范围：${entry.scope||'本库'}${entry.attribution?' · '+entry.attribution:''}${entry.reason?' · '+memoryErrorText(entry.reason):''}`
    const technical=row.querySelector<HTMLElement>('.memory-entry-technical')!
    technical.textContent=`更新：${entry.updatedAt} · 版本 ${entry.version} · ${entry.reviewAt?'复核日期：'+entry.reviewAt:'未设复核日期'}`
    sources(metadata, entry.sources)
    const action = row.querySelector<HTMLButtonElement>('.memory-entry-state-action')!
    action.textContent = entry.status === 'active' ? '停用' : entry.pendingTarget ? '核对更正' : entry.status==='pending'||entry.status==='disputed'?'确认新事实':'检查来源并恢复'
    action.onclick = () => { if (entry.status === 'active') void mutate(() => handlers.disable(binding(entry)), action); else void preview(row, () => handlers.restore(binding(entry))) }
    if (row.querySelector('.memory-preview')) {
      row.querySelector('.memory-preview')!.remove()
      row.append(paragraph('来源或状态已变化。请重新查看并确认，之前的预览不能继续使用。'))
    }
    row.dataset.metadata = signature
  }
  function paintItems():void{
    const focus = document.activeElement instanceof HTMLElement && items.contains(document.activeElement) ? document.activeElement : null
    const existing = new Map(Array.from(items.querySelectorAll<HTMLElement>('.memory-entry')).map(row => [row.dataset.memoryId!, row]))
    list.replaceChildren()
    for(const entry of view?.entries.filter(e=>e.category!=='recent')??[]){
      const previous = existing.get(entry.id)
      if (previous && previous.dataset.version === String(entry.version)) { paintEntryMetadata(previous, entry); list.append(previous); continue }
      if (previous instanceof HTMLDetailsElement && previous.open) {
        if (!previous.querySelector('.memory-stale-warning')) previous.append(paragraph('当前条目版本已变化；草稿保留。请关闭条目并刷新后重新核对。', 'settings-hint memory-stale-warning'))
        list.append(previous); continue
      }
      const row=el('details','memory-entry');row.dataset.memoryId=entry.id;row.dataset.version=String(entry.version)
      row.append(el('summary'),paragraph(entry.content,'memory-entry-content'),el('div','memory-entry-metadata'))
      const technical=el('details','memory-technical');technical.append(Object.assign(el('summary'),{textContent:'详细信息'}),paragraph('','settings-hint memory-entry-technical'));row.append(technical)
      const content=el('textarea');content.rows=3;content.value=entry.content;content.maxLength=4096;content.setAttribute('aria-label','记忆内容')
      const layer=layerSelect(entry.layer),scope=el('input');scope.value=entry.scope;scope.maxLength=512
      const editor=el('div','memory-editor');editor.hidden=true;editor.append(field('内容',content),field('记忆类别',layer),field('适用范围',scope));row.append(editor)
      const actions=el('div','settings-actions'),editActions=el('div','settings-actions')
      const edit=button('编辑',()=>{editor.hidden=false;edit.hidden=true;content.focus()});edit.dataset.memoryAction='edit';actions.append(edit)
      const save=button('保存条目',()=>void mutate(()=>handlers.edit({...binding(entry),content:content.value,layer:layer.value as 'core'|'demand',scope:scope.value}),save));save.dataset.memoryAction='save-edit';editActions.append(save)
      const cancel=button('取消编辑',()=>{const latest=view?.entries.find(e=>e.id===entry.id);content.value=latest?.content??entry.content;layer.value=latest?.layer??entry.layer;scope.value=latest?.scope??entry.scope;editor.hidden=true;edit.hidden=false;edit.focus();if(latest&&latest.version!==entry.version){row.open=false;paintItems()}});cancel.dataset.memoryAction='cancel-edit';editActions.append(cancel);editor.append(editActions)
      const stateAction = el('button', 'settings-action memory-entry-state-action'); stateAction.type = 'button'; actions.append(stateAction)
      let armed=false
      const forget=button('删除并遗忘',()=>{if(!armed){armed=true;const warning=paragraph('删除这条记忆并阻止原材料自动重新生成。关联摘要会清除；无法确定无关的待整理材料也会一并清除。原笔记与账本不变，外部备份和已发送内容不会被清除。');warning.classList.add('memory-forget-warning');row.append(warning);forget.textContent='确认删除并遗忘';cancelForget.hidden=false;return}void mutate(()=>handlers.forget(binding(entry)),forget)})
      const cancelForget=button('取消遗忘',()=>{armed=false;row.querySelector('.memory-forget-warning')?.remove();forget.textContent='删除并遗忘';cancelForget.hidden=true;forget.focus()});cancelForget.hidden=true;cancelForget.dataset.memoryAction='cancel-forget'
      forget.classList.add('memory-danger');actions.append(forget,cancelForget);row.append(actions);paintEntryMetadata(row, entry);list.append(row)
    }
    applyFilter()
    if (focus?.isConnected&&!focus.closest<HTMLElement>('[hidden]')) focus.focus({ preventScroll: true })
  }
  function paintMaintenance():void{
    if(!view)return
    const signature=JSON.stringify([view.learning,view.diagnosis,view.configDiagnosis,view.status,view.retirementFailure,view.retirement])
    if(maintenance.dataset.signature===signature)return
    maintenance.dataset.signature=signature;maintenance.replaceChildren()
    maintenance.append(paragraph('这些操作只在需要时使用。清空或重置前，会先展示具体影响供你确认。'))
    if(view.retirementFailure){maintenance.append(paragraph(memoryErrorText(view.retirementFailure)));if(view.retirement)maintenance.append(button('重试清除旧记忆…',()=>void preview(maintenance,()=>handlers.maintenance({action:'retire',revision:view!.retirement!.revision,objectVersion:view!.retirement!.objectVersion}))))}
    if(view.learning){maintenance.append(paragraph('保留现有记忆，阻止已登记的旧材料自动重新生成记忆；之后的新材料与手动“记住”仍可建立记忆。'))
      const range=el('details','memory-technical');range.append(Object.assign(el('summary'),{textContent:'学习范围详情'}),paragraph(`已停止自动学习的材料编号上限：${view.learning.watermark}；目前登记的材料编号上限：${view.learning.nextSequence}。`));maintenance.append(range)
      maintenance.append(button('不再从已有材料学习…',()=>void preview(maintenance,()=>handlers.maintenance({action:'watermark',revision:view!.revision,objectVersion:view!.objectVersion,watermark:view!.learning!.nextSequence}))))}
    if(view.diagnosis){maintenance.append(paragraph(`记忆占用 ${(view.diagnosis.bytes/1024).toFixed(1)} KiB。无法读取的记录会保留，供检查或重置。`))
      maintenance.append(Object.assign(button('清空本库记忆…',()=>void preview(maintenance,()=>handlers.maintenance({action:'reset',revision:view!.diagnosis!.revision,objectVersion:view!.diagnosis!.objectVersion}))),{className:'settings-action memory-danger'}))}
    if(view.configDiagnosis){maintenance.append(paragraph('记忆配置不可用；本库内容仍可查看和诊断，回答模型与密钥不受影响。'))
      maintenance.append(Object.assign(button('重置本设备的记忆设置…',()=>void preview(maintenance,()=>handlers.maintenance({action:'reset-config',revision:view!.configDiagnosis!.revision,objectVersion:null}))),{className:'settings-action memory-danger'}))}
  }
  function paintJobs():void{
    const focus=document.activeElement instanceof HTMLElement&&jobs.contains(document.activeElement)?document.activeElement:null
    const existing=new Map(Array.from(jobs.querySelectorAll<HTMLElement>('.memory-job')).map(row=>[row.dataset.taskId!,row]))
    jobs.replaceChildren();jobsPanel.querySelector('summary')!.textContent=`最近整理记录 · 正在整理 ${view?.running.active??0} / 等待整理 ${view?.running.pending??0}`
    if(!view?.jobs.length)jobs.append(paragraph('还没有整理记录。获准任务保存后，整理结果会显示在这里。'))
    const actionLabel:Record<string,string>={add:'新增',correct:'更正',conflict:'争议',obsolete:'过时',recent:'近期背景'}
    const jobResults=(job:MemoryView['jobs'][number])=>{
      const results=job.results??[]
      const applied=results.filter(result=>result.outcome==='applied').length,rejected=results.filter(result=>result.outcome==='rejected')
      return {applied,rejected,partial:applied>0&&rejected.length>0}
    }
    const jobLabel=(job:MemoryView['jobs'][number],index:number)=>{
      const {applied,rejected,partial}=jobResults(job)
      const partialNote=rejected.length?` · ${partial?`部分保存：已保存 ${applied} 组、未保存 ${rejected.length} 组`:`未保存 ${rejected.length} 组`}`:''
      return `${index===0?'最近一次整理':'整理记录 '+(index+1)} · ${({queued:'等待整理',running:'正在整理',applied:'已完成',rejected:'没有写入',interrupted:'已中断',unavailable:'暂不可用', 'handed-off':'已移交'})[job.outcome]}${partialNote}${job.reason?` · ${memoryErrorText(job.reason)}`:''}`
    }
    for(const [index,job] of [...(view?.jobs??[])].reverse().entries()){
      const signature=JSON.stringify([job,view?.config,view?.recipient,job.entryIds?.map(id=>view?.entries.find(e=>e.id===id)?.category??null)]),previous=existing.get(job.taskId)
      if(previous?.dataset.signature===signature){previous.querySelector('.memory-job-result')!.textContent=jobLabel(job,index);jobs.append(previous);continue}
      const row=el('div','memory-job');row.dataset.taskId=job.taskId;row.dataset.signature=signature
      row.append(paragraph(jobLabel(job,index),'settings-hint memory-job-result'));const detail=el('details','memory-technical');detail.append(Object.assign(el('summary'),{textContent:'任务详情'}),paragraph(`任务编号：${job.taskId}`));row.append(detail);const request={taskId:job.taskId,materialVersion:job.materialVersion!}
      if(job.outcome==='applied'&&!job.entryIds)row.append(paragraph('本场已完成；写入明细未提供。'))
      else if(job.outcome==='applied'){
        const matched=(job.entryIds??[]).map(id=>view?.entries.find(e=>e.id===id))
        if(matched.every(Boolean)){
          const recent=matched.filter(e=>e?.category==='recent').length,long=matched.length-recent
          row.append(paragraph(`${jobResults(job).partial?'部分保存：':''}更新近期背景 ${recent} 块 · 新增/更新长期内容 ${long} 条；可在上方查看或删除并遗忘。`))
        }else row.append(paragraph(`本场写入 ${job.entryIds?.length??0} 项；部分条目当前不可查看。`))
      }
      {const rejected=jobResults(job).rejected
       if(rejected.length)row.append(paragraph(`未保存的分组：${rejected.slice(0,4).map(result=>`${actionLabel[result.action]??result.action}${result.code?`（${memoryErrorText(result.code)}）`:''}`).join('、')}${rejected.length>4?` 等 ${rejected.length} 组`:''}`))}
      if(previous?.querySelector('.memory-preview'))row.append(paragraph('任务材料、状态或整理配置已变化；原预览已失效，请重新预览。'))
      if(job.undoable)row.append(button('撤销本场变更…',()=>void preview(row,()=>handlers.maintenance({action:'undo',taskId:job.taskId,materialVersion:job.materialVersion!,revision:view!.revision,objectVersion:view!.objectVersion}))))
      if(job.retryable)row.append(button('重新整理…',()=>void preview(row,()=>handlers.retry(request))))
      if(job.outcome==='queued'||job.outcome==='running'){const cancel=button('停止整理',()=>void mutate(()=>handlers.cancel(request),cancel));row.append(cancel)}
      jobs.append(row)
    }
    if(focus?.isConnected)focus.focus({preventScroll:true})
  }
  void Promise.all([handlers.get(),handlers.models()]).then(([result,models])=>{
    if(!current())return
    if(!result.ok){showError(result.error);status.textContent='记忆不可用；正文仍可编辑和保存。';return}
    view=result.value;const cfg=view.config,modelConfig=models.ok?models.config:null;modelsSnapshot=modelConfig
    const device=el('section','memory-config'),deviceTitle=el('h3');deviceTitle.textContent='默认整理模型';device.append(deviceTitle,paragraph('本设备所有笔记库默认使用。负责整理记忆，与回答正文的模型分开设置。'))
    const selected=modelSelect(modelConfig,cfg.defaultModelId,'未选择');selected.dataset.memory='default-model';device.append(field('默认使用的模型',selected));currentDefault=paragraph('');currentDefault.dataset.memory='current-default';device.append(currentDefault)
    const defaultDraft=paragraph('','memory-save-status');defaultDraft.setAttribute('role','status');device.append(defaultDraft)
    const saveDefault=button('保存默认模型',()=>void mutate(()=>handlers.save({target:'default',modelId:selected.value||null}),saveDefault));saveDefault.dataset.memory='save-default';device.append(saveDefault)
    const vault=el('section','memory-config'),title=el('h3');title.textContent='本库使用的模型';vault.append(title,paragraph('只影响当前笔记库，可跟随默认模型或单独选择。'))
    const enabled=el('input');enabled.type='checkbox';enabled.checked=cfg.vault.enabled;enabled.dataset.memory='vault-enabled';const permission=field('开启本库记忆',enabled);permission.classList.add('memory-permission-field');statusHead.insertBefore(permission,refresh)
    const override=modelSelect(modelConfig,cfg.vault.override.mode==='model'?cfg.vault.override.modelId:null,'跟随默认模型');override.dataset.memory='vault-model';vault.append(field('本库使用的整理模型',override))
    currentVault=paragraph('','memory-save-status');currentVault.dataset.memory='current-vault';vault.append(currentVault)
    const vaultDraft=paragraph('','memory-save-status');vaultDraft.dataset.memory='vault-draft';vaultDraft.setAttribute('role','status')
    let vaultSaving=false
    const saveVault=button('保存本库设置',()=>void saveLibrary(saveVault));saveVault.dataset.memory='save-vault'
    const saveVaultModel=button('保存本库设置',()=>void saveLibrary(saveVaultModel));saveVaultModel.dataset.memory='save-vault-model'
    async function saveLibrary(clicked:HTMLButtonElement):Promise<void>{
      if(vaultSaving)return
      vaultSaving=true;saveVault.disabled=saveVaultModel.disabled=true
      try{await mutate(()=>handlers.save({target:'vault',vault:{enabled:enabled.checked,override:override.value?{mode:'model',modelId:override.value}:{mode:'inherit'}}}),clicked)}
      finally{vaultSaving=false;if(!disposed){saveVault.disabled=false;updateDrafts()}}
    }
    const vaultActions=el('div','memory-save-row');vaultActions.append(saveVault,vaultDraft);statusCard.append(vaultActions)
    statusCard.append(paragraph('关闭后保留已有记忆，停止自动学习和使用。正在使用记忆的任务会停止后续调用，已有回答保留。'))
    vault.append(saveVaultModel,paragraph('本库开关和模型一起保存，不改变默认模型。'))
    updateDrafts=()=>{
      if(!view)return
      const dirty=enabled.checked!==view.config.vault.enabled||override.value!==(view.config.vault.override.mode==='model'?view.config.vault.override.modelId:'')
      vaultDraft.textContent=dirty?'尚未保存':'设置已保存';saveVault.hidden=!dirty;vaultDraft.hidden=!dirty;vaultActions.hidden=!dirty;saveVaultModel.disabled=vaultSaving||!dirty
      defaultDraft.textContent=selected.value!==(view.config.defaultModelId??'')?'尚未保存':'设置已保存'
    }
    for(const input of [enabled,override,selected])input.addEventListener('change',updateDrafts)
    const receiver=paragraph('','memory-receiver');statusCard.append(receiver)
    const sending=el('details','memory-technical');sending.append(Object.assign(el('summary'),{textContent:'会发送哪些内容'}),paragraph('只发送本场获准的口令、必要结果、实际使用的来源片段和相关记忆；不发送思维链、全库内容或完整历史。记忆不会扩大任务的笔记读取范围。'));modelPanel.append(sending)
    updateReceiver=(value:MemoryView)=>{receiver.textContent=value.recipient?`实际整理模型：${value.recipient.modelId} · ${value.recipient.host}`:'整理模型尚未选择或不可用。自动整理暂停；已有可使用的记忆仍可参考，不会改用其他模型。'}
    const modelGrid=el('div','memory-model-grid');modelGrid.append(device,vault);modelPanel.querySelector('summary')!.after(modelGrid)
    modelPanel.append(paragraph('长期约定：长期适用的要求，通常自动带入任务。项目事实：已确认的项目情况，相关时自动参考。近期工作背景：有期限的任务进展。'))
    accept(view)
  }).catch(()=>{if(current())showError('MEMORY_UNAVAILABLE')})
  const changed = (event: Event): void => {
    if (!current() || !view || (event as CustomEvent<string>).detail !== view.sessionId) return
    const serial = ++readSerial
    void handlers.get().then(result => { if (current() && serial === readSerial && result.ok) accept(result.value) }).catch(() => {})
  }
  let modelReadSerial=0
  const resume=()=>{
    if(view)changed(new CustomEvent('rgent:memory',{detail:view.sessionId}))
    const serial=++modelReadSerial
    void handlers.models().then(result=>{
      if(!current()||serial!==modelReadSerial||!result.ok)return
      modelsSnapshot=result.config
      for(const key of ['default-model','vault-model']){
        const select=body.querySelector<HTMLSelectElement>(`[data-memory="${key}"]`)
        if(!select)continue
        const options=modelSelect(modelsSnapshot,select.value||null,key==='default-model'?'未选择':'跟随默认模型')
        const selectedValue=options.value
        select.replaceChildren(...Array.from(options.childNodes));select.value=selectedValue
      }
      if(view)accept(view)
    }).catch(()=>{})
  }
  body.addEventListener('rgent:memory-resume',resume)
  window.addEventListener('rgent:memory', changed)
  return()=>{disposed=true;body.removeEventListener('rgent:memory-resume',resume);window.removeEventListener('rgent:memory', changed)}
}

/** Program-defined offsets in the typed ledger context, independently rechecked by main. */
export function ledgerRememberCommand(record:import('../../main/ledger-store.ts').LedgerRecord):{taskId:string;start:number;end:number}|null{
  if(record.state!=='saved'||!record.chapter?.prompt||record.legacyRaw)return null
  return {taskId:record.taskId,start:'口令：\n'.length,end:'口令：\n'.length+record.chapter.prompt.length}
}
