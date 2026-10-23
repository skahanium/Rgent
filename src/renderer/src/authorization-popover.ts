import type { AgentAuthorizationPreview, AgentAuthorizationResult, AgentPermissionLevel, AgentStartResult, TreeEntry } from '@shared'
import { openOverlay, type Overlay } from './overlay.ts'
import { icon } from './icons.ts'
import { hostErrorText } from './host-errors.ts'
export type AuthorizationPopoverOptions = {
  anchor:{left:number;top:number;bottom:number}
  origin:string
  entries:TreeEntry[]
  initialLevel:AgentPermissionLevel
  preview:(references:string[],level:AgentPermissionLevel)=>Promise<AgentAuthorizationResult>
  send:(preview:AgentAuthorizationPreview,level:AgentPermissionLevel)=>Promise<AgentStartResult>
  discard?:(id:string)=>Promise<void>
  onClose?:()=>void
  returnFocus?:()=>HTMLElement|null
}
export type AuthorizationPopover = Overlay & { setStale:()=>void }

/** 同一渲染会话里沿用上次勾选的范围：只在内存，重启即忘。
 *  恢复时只认当前树里还看得见的项；已消失或已变禁用的旧路径不会悄悄带进下一张卡。 */
let rememberedScope:string[]=[]
/** 换库时清空：同名路径在新库里可能是另一篇笔记，不能沿用上一库的勾选。 */
export function resetScopeMemory():void{rememberedScope=[]}

/** 四档：只读／参考不宣告写工具；自动只自动批准新建，改名／挪／删除仍逐次确认。 */
const LEVELS:{level:AgentPermissionLevel;label:string;hint:string}[]=[
  {level:'read',label:'只读本笔记',hint:'只读发起篇，不提供写工具。'},
  {level:'reference',label:'参考本目录',hint:'可参考本目录笔记，不提供写工具。'},
  {level:'write',label:'可写',hint:'可补写、建、改名、挪；每次写操作仍逐次确认。'},
  {level:'auto',label:'自动',hint:'自动批准新建；改名、挪、删除仍逐次确认。'}
]
const levelHint=(level:AgentPermissionLevel):string=>LEVELS.find(item=>item.level===level)?.hint??''

function parentDirectory(relPath:string):string{const at=relPath.lastIndexOf('/');return at<0?'':relPath.slice(0,at)}
/** 只找树里看得见的目录项：附件子树不渲染，文件不是目录。 */
function findVisibleDirectory(entries:TreeEntry[],relPath:string):TreeEntry|null{
  for(const entry of entries){
    if(entry.attachmentOf!==undefined || entry.kind==='file')continue
    if(entry.kind==='dir' && entry.relPath===relPath)return entry
    if(entry.kind==='dir' && entry.children){const found=findVisibleDirectory(entry.children,relPath);if(found)return found}
  }
  return null
}
/** 「本目录只读」只勾父目录这一项，让主进程按既有递归成员语义展开。
 *  根目录不提供该预设；父目录不可见或禁读时只禁用并说明，不降级成子笔记列表。 */
type DirectoryPreset = {relPath:string;disabledReason:string|null}
function directoryPreset(entries:TreeEntry[],origin:string):DirectoryPreset|null{
  const parent=parentDirectory(origin)
  if(!parent)return null
  const entry=findVisibleDirectory(entries,parent)
  if(!entry)return {relPath:parent,disabledReason:'当前目录不在可选范围（不可见或属于附件），不能一键选择。'}
  if(entry.tier==='forbidden')return {relPath:parent,disabledReason:'当前目录被标为禁止参考，不能一键选择。'}
  return {relPath:parent,disabledReason:null}
}

/** 工具摘要与主进程宣告同源：写工具只看档位，读搜只看是否另有参考篇，结构只看可参考外篇。
 *  删笔记只在主进程披露 `deleteEnabled` 时出现，渲染层不猜平台。 */
function sessionToolLabels(level:AgentPermissionLevel, origin:string, sources:readonly {relPath:string;tier:string}[], deleteEnabled?:boolean):string[] {
  const labels:string[]=[]
  if(level==='write'||level==='auto')labels.push('补发起篇','建笔记')
  const extras=sources.filter(source=>source.relPath!==origin)
  if(extras.length)labels.push('读库','搜库')
  if(extras.some(source=>source.tier!=='follow')){
    labels.push('改名','挪')
    if(deleteEnabled)labels.push('删笔记')
  }
  return labels
}

/** Command-local confirmation; scope changes never reuse the previous displayed grant. */
export function openAuthorizationPopover(options:AuthorizationPopoverOptions):AuthorizationPopover {
  let level:AgentPermissionLevel=options.initialLevel
  const selected=new Set<string>(level==='read'?[]:rememberedScope)
  let prepared:AgentAuthorizationPreview|null=null;let generation=0;let submitting=false
  // 非模态：不抢编辑器焦点、不拦快捷键；Esc 由 overlay 在焦点进入卡片时接管。
  let panel: Overlay
  const placeCard=():void=>{
    if(!panel?.isOpen())return
    const viewportWidth=window.innerWidth
    const viewportHeight=window.innerHeight
    panel.root.style.left=`${Math.max(12,Math.min(options.anchor.left,viewportWidth-432))}px`
    panel.root.style.top=`${Math.max(12,Math.min(options.anchor.bottom+8,viewportHeight-420))}px`
    panel.root.style.maxHeight=`${viewportHeight-parseFloat(panel.root.style.top)-12}px`
  }
  const onMove=():void=>placeCard()
  panel=openOverlay({label:'确认本场授权档位与模型接收方',className:'overlay-authorization',modal:false,returnFocus:options.returnFocus,onClose:()=>{
    window.removeEventListener('resize',onMove)
    window.removeEventListener('scroll',onMove,true)
    generation++;if(prepared)void options.discard?.(prepared.id);prepared=null;options.onClose?.()
  }})
  panel.root.tabIndex=-1
  panel.root.innerHTML='<h2>本场</h2><p class="authorization-origin"></p><p class="authorization-recipient" aria-live="polite"></p><div class="authorization-levels" role="radiogroup" aria-label="本场授权档位"></div><p class="authorization-level-hint" aria-live="polite"></p><div class="authorization-scope-summary"><span class="authorization-scope-text">范围：仅本篇</span><button type="button" class="authorization-scope-toggle" aria-expanded="false">调整</button></div><div class="authorization-scope-detail" hidden><fieldset class="authorization-scope"><legend>参考范围</legend></fieldset><div class="authorization-manifest"></div><p class="authorization-disclosure">本场口令、获准资料与本篇账本会发送给下方模型接收方。授权仅本场有效。</p></div><p class="authorization-memory settings-hint" aria-live="polite" hidden></p><p class="authorization-skills settings-hint" aria-live="polite" hidden></p><p class="authorization-status" role="status"></p><footer><button type="button" class="authorization-cancel">取消</button><button type="button" class="authorization-send" disabled>确认并发送</button></footer>'
  panel.root.querySelector('.authorization-origin')!.textContent=`发起篇：${options.origin}`
  const recipient=panel.root.querySelector('.authorization-recipient')!
  const levels=panel.root.querySelector<HTMLElement>('.authorization-levels')!
  const levelHintEl=panel.root.querySelector<HTMLElement>('.authorization-level-hint')!
  const scopeText=panel.root.querySelector<HTMLElement>('.authorization-scope-text')!
  const scopeToggle=panel.root.querySelector<HTMLButtonElement>('.authorization-scope-toggle')!
  const scopeDetail=panel.root.querySelector<HTMLElement>('.authorization-scope-detail')!
  const memoryDisclosure=panel.root.querySelector<HTMLElement>('.authorization-memory')!
  const skillsDisclosure=panel.root.querySelector<HTMLElement>('.authorization-skills')!
  const manifest=panel.root.querySelector('.authorization-manifest')!
  const status=panel.root.querySelector('.authorization-status')!
  const send=panel.root.querySelector<HTMLButtonElement>('.authorization-send')!
  const fieldset=panel.root.querySelector<HTMLFieldSetElement>('.authorization-scope')!
  const scopeHint=document.createElement('p');scopeHint.className='authorization-scope-hint settings-hint';scopeHint.textContent='默认不选；同一会话沿用上次勾选。';scopeHint.style.margin='0 0 8px'
  const presets=document.createElement('div');presets.className='authorization-presets'
  const onlyOrigin=document.createElement('button');onlyOrigin.type='button';onlyOrigin.className='authorization-preset-origin';onlyOrigin.textContent='只读本笔记'
  const directoryTarget=directoryPreset(options.entries,options.origin)
  // 参考/可写/自动的首开默认本目录；库根没有父目录，保持仅本篇。
  if(level!=='read' && selected.size===0 && directoryTarget && !directoryTarget.disabledReason)selected.add(directoryTarget.relPath)
  const onlyDirectory=directoryTarget?document.createElement('button'):null
  if(onlyDirectory && directoryTarget){
    onlyDirectory.type='button';onlyDirectory.className='authorization-preset-directory';onlyDirectory.textContent='本目录只读'
    if(directoryTarget.disabledReason){onlyDirectory.disabled=true;onlyDirectory.title=directoryTarget.disabledReason}
  }
  presets.append(onlyOrigin)
  if(onlyDirectory)presets.append(onlyDirectory)
  const choices=document.createElement('div');choices.className='authorization-choices'
  fieldset.append(scopeHint,presets,choices)
  const available=new Set<string>()
  function renderEntries(entries:TreeEntry[],depth=0):void {
    for(const entry of entries){
      if(entry.attachmentOf !== undefined || entry.kind==='file' || entry.relPath===options.origin)continue
      const selectable=entry.tier!=='forbidden'
      if(selectable)available.add(entry.relPath)
      const label=document.createElement('label');label.style.paddingInlineStart=`${depth*12}px`
      const input=document.createElement('input');input.type='checkbox';input.value=entry.relPath;input.dataset.blocked=selectable?'0':'1'
      const text=document.createElement('span');text.textContent=entry.relPath+(entry.kind==='dir'?'（确认时固定目录成员）':entry.tier==='follow'?'（必须遵循：可参考，不能改名／挪）':'')
      label.append(input,icon(entry.kind==='dir'?'folder':'note'),text);choices.append(label)
      input.addEventListener('change',()=>{
        if(input.checked)selected.add(entry.relPath);else selected.delete(entry.relPath)
        rememberScope();paintSelection()
        void refresh()
      })
      if(entry.children)renderEntries(entry.children,depth+1)
    }
  }
  renderEntries(options.entries)
  // 记忆里的旧路径只有在当前卡里还可勾选时才算数；看不见的项不参与本场预览。
  for(const path of [...selected])if(!available.has(path))selected.delete(path)
  // 只读档不带参考：打开时若沿用记忆范围，也一并清掉。
  if(level==='read')selected.clear()
  // 记忆只保留这张卡里仍可勾的项，别让已消失的旧路径混进下一次记忆。
  rememberScope()
  function rememberScope():void{rememberedScope=[...selected]}
  /** 档位与范围共用一份选中集合：只读档永远为空，非只读档不许写复选框。 */
  function paintSelection():void{
    for(const input of choices.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')){
      input.disabled=level==='read'||input.dataset.blocked==='1'
      input.checked=!input.disabled && selected.has(input.value)
    }
    if(onlyDirectory)onlyDirectory.disabled=level==='read'||Boolean(directoryTarget?.disabledReason)
    for(const button of levels.querySelectorAll<HTMLButtonElement>('.authorization-level'))button.setAttribute('aria-checked',String(button.dataset.level===level))
    levelHintEl.textContent=levelHint(level)
    updateScopeSummary()
  }
  function updateScopeSummary():void{
    // 预览回来后按主进程实际展开的笔记数报数（目录是一整棵子树），未回来时按勾选项数。
    const count=prepared?prepared.sources.filter(source=>source.relPath!==options.origin).length:selected.size
    scopeText.textContent=count>0?`范围：本篇 + ${count} 篇参考`:'范围：仅本篇'
  }
  function setLevel(next:AgentPermissionLevel):void{
    if(next===level)return
    level=next
    // 只读档不带参考；其余档在范围为空时默认收到父目录（库根保持空，不扩大整库）。
    if(level==='read')selected.clear()
    else if(!selected.size && directoryTarget && !directoryTarget.disabledReason)selected.add(directoryTarget.relPath)
    rememberScope();paintSelection()
    void refresh()
  }
  function applySelection(paths:string[]):void{
    selected.clear();for(const path of paths)selected.add(path)
    rememberScope();paintSelection()
    void refresh()
  }
  const levelButtons:HTMLButtonElement[]=[]
  for(const item of LEVELS){
    const button=document.createElement('button');button.type='button';button.className='authorization-level';button.dataset.level=item.level
    button.setAttribute('role','radio');button.setAttribute('aria-checked',String(item.level===level));button.textContent=item.label
    button.addEventListener('click',()=>setLevel(item.level))
    levelButtons.push(button);levels.append(button)
  }
  scopeToggle.addEventListener('click',()=>{
    const open=scopeDetail.hidden
    scopeDetail.hidden=!open
    scopeToggle.setAttribute('aria-expanded',String(open))
  })
  onlyOrigin.addEventListener('click',()=>applySelection([]))
  if(onlyDirectory && directoryTarget && !directoryTarget.disabledReason)onlyDirectory.addEventListener('click',()=>applySelection([directoryTarget.relPath]))
  if(!choices.childElementCount)choices.textContent='当前没有其他可选笔记。'
  paintSelection()
  placeCard()
  window.addEventListener('resize',onMove)
  window.addEventListener('scroll',onMove,true)
  /** 内容在卡片打开后发生变化：作废当前预览并拦住发送，等下一次成功预览再放行。 */
  function setStale(prefix=''):void{
    if(!panel.isOpen())return
    generation++
    if(prepared)void options.discard?.(prepared.id)
    prepared=null;send.disabled=true
    updateScopeSummary()
    status.textContent=`${prefix}内容已改，重新核对。`
  }
  function paintDisclosures():void{
    const memory=prepared?.memory
    memoryDisclosure.hidden=!memory
    if(memory){
      const recipientText=memory.consolidate&&memory.recipient?`${memory.recipient.modelId} · ${memory.recipient.host}`:null
      memoryDisclosure.textContent=memory.use
        ?`本场使用独立记忆（当前库）。${recipientText?`回答与账本交 ${recipientText} 后台整理。`:'本场不积累记忆。'}`
        :'当前库记忆关闭。本场不使用。'
    }
    const names=(prepared?.skills??[]).map(skill=>skill.name)
    const unavailable=(prepared?.skillsUnavailable??[]).map(item=>item.name??'未命名技能')
    // 合同取舍：这里只出现名称——正文、字数、原因文本都不在这张卡上；原因在设置页「技能」，证据在账本。
    skillsDisclosure.hidden=!names.length && !unavailable.length
    if(!skillsDisclosure.hidden){
      skillsDisclosure.textContent=`${names.length?`本场技能：${names.join('、')}。`:''}${unavailable.length?`已启用但未加载：${unavailable.join('、')}（原因见设置页「技能」）。`:''}`
    }
  }
  async function refresh():Promise<void>{
    if(prepared)void options.discard?.(prepared.id)
    const current=++generation;prepared=null;manifest.replaceChildren();send.disabled=true;status.textContent='核对范围与接收方…'
    paintDisclosures();updateScopeSummary()
    // 只读档在发送时也必须带空 references；渲染层不借空档偷带范围。
    const references=level==='read'?[]:[...selected]
    try{
      const result=await options.preview(references,level)
      if(current!==generation || !panel.isOpen()){if(result.ok)void options.discard?.(result.preview.id);return}
      if(!result.ok){
        recipient.textContent='接收方尚未核验'
        if(result.error==='STALE_AUTHORIZATION'){setStale('无法准备。');return}
        status.textContent=`无法准备。${hostErrorText(result.error)}`;return
      }
      prepared=result.preview
      if(prepared.summaryGenerators?.length){const generators=document.createElement('p');generators.textContent='本篇账本可复用历史摘要（仍须在发送前核验）：'+prepared.summaryGenerators.map(g=>`${g.modelId} · ${g.host} · ${g.time}`).join('；');manifest.append(generators)}
      const title=document.createElement('p');title.textContent='本场固定对象：';manifest.append(title)
      const paths=document.createElement('ul');for(const source of prepared.sources){const item=document.createElement('li');item.textContent=source.relPath;paths.append(item)}manifest.append(paths)
      recipient.textContent=`模型：${prepared.recipient.modelId} · ${prepared.recipient.host}`
      paintDisclosures();updateScopeSummary()
      const labels=sessionToolLabels(level,options.origin,prepared.sources,prepared.deleteEnabled)
      status.textContent=`已核对 ${prepared.sources.length} 篇笔记。工具：${labels.length?labels.join('、'):'无'}。其他篇账本与附件不在范围。`
      send.disabled=false
      // 只有焦点已经落在卡片里时才把键盘用户送到发送键；非模态打开不会主动抢焦点。
      if(document.activeElement===panel.root)send.focus({preventScroll:true})
    }catch{if(current===generation && panel.isOpen())status.textContent='准备失败，请取消后重试。'}
  }
  function setControlsDisabled(disabled:boolean):void{
    fieldset.disabled=disabled
    for(const button of levelButtons)button.disabled=disabled
    scopeToggle.disabled=disabled
  }
  async function submit():Promise<void>{
    if(!prepared || submitting || send.disabled)return
    // 只读档发送时不带参考：与预览时的范围保持一致。
    if(level==='read'&&selected.size)selected.clear()
    submitting=true
    // Disabled focused controls can send focus to body; retain the confirmation context.
    panel.root.focus({preventScroll:true})
    send.disabled=true;setControlsDisabled(true)
    const displayed=prepared;const sendLevel=level
    try{
      const result=await options.send(displayed,sendLevel)
      if(!panel.isOpen())return
      if(result.ok){panel.close();return}
      const stale=result.error==='STALE_AUTHORIZATION'
      status.textContent=stale?'内容已改，重新核对。':`未发送。${hostErrorText(result.error)}`
      await refresh()
      if(prepared)status.textContent=stale
        ? '内容已改，重新核对。范围与接收方已更新，请再次确认。'
        : '范围与接收方已重新核对，请再次确认。刚才没有启动任务。'
    }catch{if(panel.isOpen()){status.textContent='发送失败，口令仍保留。';send.disabled=false}}
    finally{submitting=false;setControlsDisabled(false);paintSelection()}
  }
  send.addEventListener('click',()=>void submit())
  panel.root.querySelector('.authorization-cancel')!.addEventListener('click',()=>panel.close())
  panel.root.addEventListener('keydown',event=>{
    if(event.defaultPrevented || event.key!=='Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229)return
    const target=event.target instanceof Element?event.target:null
    if(target?.closest('.authorization-cancel')){event.preventDefault();panel.close();return}
    // 回车是卡片的发送键，但不该抢掉文本框、下拉与预设／档位按钮自己的回车。
    if(target?.closest('textarea, select, button:not(.authorization-send)'))return
    if(!prepared || send.disabled)return
    event.preventDefault();void submit()
  })
  void refresh()
  return Object.assign(panel,{setStale})
}
