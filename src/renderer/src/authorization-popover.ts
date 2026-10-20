import type { AgentAuthorizationPreview, AgentAuthorizationResult, AgentStartResult, TreeEntry } from '@shared'
import { openOverlay, type Overlay } from './overlay.ts'
import { icon } from './icons.ts'
import { hostErrorText } from './host-errors.ts'
export type AuthorizationPopoverOptions = {
  anchor:{left:number;top:number;bottom:number}
  origin:string
  entries:TreeEntry[]
  /** `network` 是本场联网勾选：预览与 start 都带它，主进程核对一致才放行。 */
  preview:(references:string[],network:boolean)=>Promise<AgentAuthorizationResult>
  send:(preview:AgentAuthorizationPreview,network:boolean)=>Promise<AgentStartResult>
  discard?:(id:string)=>Promise<void>
  onClose?:()=>void
  returnFocus?:()=>HTMLElement|null
}
/** 预览文案与宿主宣告同源：补／建始终在；读搜要另有篇；结构只要可参考外篇。 */
function sessionToolLabels(origin:string, sources:readonly {relPath:string;tier:string}[]):string[] {
  const labels=['补发起篇','建笔记']
  const extras=sources.filter(source=>source.relPath!==origin)
  if(extras.length)labels.push('读库','搜库')
  if(extras.some(source=>source.tier!=='follow'))labels.push('改名','挪')
  return labels
}

/** Command-local confirmation; scope changes never reuse the previous displayed grant. */
export function openAuthorizationPopover(options:AuthorizationPopoverOptions):Overlay {
  const selected=new Set<string>();let prepared:AgentAuthorizationPreview|null=null;let generation=0;let submitting=false
  // 联网勾选默认不勾；只有主进程说可用时才出现，切换会重新核对预览（防重放）。
  let networkSelected=false
  const panel=openOverlay({label:'确认本场参考范围与模型接收方',initialFocus:()=>document.activeElement instanceof HTMLElement && panel.root.contains(document.activeElement)?document.activeElement:panel.root,returnFocus:options.returnFocus,onClose:()=>{generation++;if(prepared)void options.discard?.(prepared.id);prepared=null;options.onClose?.()}})
  panel.root.classList.add('overlay-authorization')
  panel.root.tabIndex=-1
  panel.root.innerHTML='<h2>本场口令</h2><p class="authorization-origin"></p><p class="authorization-recipient" aria-live="polite"></p><p class="authorization-disclosure">本场口令、获准资料与本篇账本会发送给下方显示的模型接收方。本场范围不会沿用到下一场。</p><fieldset class="authorization-scope"><legend>参考范围 · 默认仅本篇</legend></fieldset><div class="authorization-manifest"></div><p class="authorization-status" role="status"></p><footer><button type="button" class="authorization-cancel">取消</button><button type="button" class="authorization-send" disabled>确认并发送</button></footer>'
  panel.root.querySelector('.authorization-origin')!.textContent=`发起篇：${options.origin}（正文与本篇账本）`
  const recipient=panel.root.querySelector('.authorization-recipient')!
  const memoryDisclosure=document.createElement('p');memoryDisclosure.className='authorization-memory settings-hint';memoryDisclosure.setAttribute('aria-live','polite');panel.root.querySelector('.authorization-disclosure')!.after(memoryDisclosure)
  // 技能只报名称：正文不进这张卡（合同取舍）；不可用的另起一句，让人当场决定要不要重来。
  const skillsDisclosure=document.createElement('p');skillsDisclosure.className='authorization-skills settings-hint';skillsDisclosure.setAttribute('aria-live','polite');memoryDisclosure.after(skillsDisclosure)
  const networkDisclosure=document.createElement('div');networkDisclosure.className='authorization-network';networkDisclosure.setAttribute('aria-live','polite');skillsDisclosure.after(networkDisclosure)
  const manifest=panel.root.querySelector('.authorization-manifest')!
  const status=panel.root.querySelector('.authorization-status')!
  const send=panel.root.querySelector<HTMLButtonElement>('.authorization-send')!
  const fieldset=panel.root.querySelector<HTMLFieldSetElement>('.authorization-scope')!
  const choices=document.createElement('div');choices.className='authorization-choices';fieldset.append(choices)
  function renderEntries(entries:TreeEntry[],depth=0):void {
    for(const entry of entries){
      if(entry.attachmentOf !== undefined || entry.kind==='file' || entry.relPath===options.origin)continue
      const label=document.createElement('label');label.style.paddingInlineStart=`${depth*12}px`
      const input=document.createElement('input');input.type='checkbox';input.value=entry.relPath;input.disabled=entry.tier==='forbidden'
      const text=document.createElement('span');text.textContent=entry.relPath+(entry.kind==='dir'?'（确认时固定目录成员）':entry.tier==='follow'?'（必须遵循：可参考，不能改名／挪）':'')
      label.append(input,icon(entry.kind==='dir'?'folder':'note'),text);choices.append(label)
      input.addEventListener('change',()=>{if(input.checked)selected.add(entry.relPath);else selected.delete(entry.relPath);void refresh()})
      if(entry.children)renderEntries(entry.children,depth+1)
    }
  }
  renderEntries(options.entries)
  if(!choices.childElementCount)choices.textContent='当前没有其他可选笔记。'
  const viewportWidth=window.innerWidth;const viewportHeight=window.innerHeight
  panel.root.style.left=`${Math.max(12,Math.min(options.anchor.left,viewportWidth-432))}px`
  panel.root.style.top=`${Math.max(12,Math.min(options.anchor.bottom+8,viewportHeight-420))}px`
  panel.root.style.maxHeight=`${viewportHeight-parseFloat(panel.root.style.top)-12}px`
  async function refresh():Promise<void>{
    if(prepared)void options.discard?.(prepared.id)
    const current=++generation;prepared=null;manifest.replaceChildren();send.disabled=true;status.textContent='核对对象、权限与模型…'
    try{
      const result=await options.preview([...selected],networkSelected)
      if(current!==generation || !panel.isOpen()){if(result.ok)void options.discard?.(result.preview.id);return}
      if(!result.ok){recipient.textContent='接收方尚未核验';status.textContent=`无法准备：${hostErrorText(result.error)}`;return}
      prepared=result.preview
      const memory=prepared.memory
      memoryDisclosure.textContent=memory?.use
        ? `独立记忆使用许可：本场自动使用当前库有效核心与相关记忆，不扩大读库范围。${memory.consolidate && memory.recipient ? `独立整理许可：回答与账本保存后，将本场实际发送的口令、必要结果、来源片段及相关记忆交给 ${memory.recipient.modelId} · ${memory.recipient.host}，用于后台整理；总期限 ${memory.limits.seconds} 秒、最多 ${memory.limits.calls} 次模型调用、工具 0 次，不含思维链或完整历史。` : '整理模型未选择或不可用，本场不积累记忆。'}`
        : '当前库记忆关闭；本场不使用或整理记忆。'

      if(memory?.use)memoryDisclosure.textContent+=memory.search?.available?` 本场可检索记忆，最多 ${memory.search.calls} 次，计入已批准的 ${memory.search.sharedTools} 次工具额度。`:' 本场仅本机自动召回，不增加工具额度。'
      const skillNames=(prepared.skills??[]).map(skill=>skill.name)
      const unavailable=(prepared.skillsUnavailable??[]).map(item=>item.name??'未命名技能')
      // 合同取舍：这里只出现名称——正文、字数、原因文本都不在这张卡上；原因在设置页「技能」，证据在账本。
      skillsDisclosure.textContent=skillNames.length||unavailable.length
        ? `${skillNames.length?`本场技能：${skillNames.join('、')}。`:''}${unavailable.length?`已启用但未加载：${unavailable.join('、')}（原因见设置页「技能」）。`:''}技能内容不在此处展开，账本记有名称与内容哈希。`
        : '本场无技能。'
      if(prepared.summaryGenerators?.length){const generators=document.createElement('p');generators.textContent='本篇账本可复用历史摘要（仍须在发送前核验）：'+prepared.summaryGenerators.map(g=>`${g.modelId} · ${g.host} · ${g.time}`).join('；');manifest.append(generators)}
      // 联网只读：可用才给勾选（默认不勾）；不可用如实写原因，不提供降级绕过。
      networkDisclosure.replaceChildren()
      const network=prepared.network
      if(!network?.available){
        networkSelected=false
        const note=document.createElement('p');note.className='settings-hint'
        note.textContent=network?.reason==='not-configured'
          ? '本场不能联网只读：尚未配置联网服务（设置「模型」页）。'
          : network?.reason==='off'||!network
            ? '本场不能联网只读：联网总开关已关闭（设置「模型」页打开）。'
            : '本场不能联网只读。'
        networkDisclosure.append(note)
      }else{
        const label=document.createElement('label')
        const input=document.createElement('input');input.type='checkbox';input.checked=networkSelected
        const text=document.createElement('span')
        text.textContent=network.providerHost?`本场允许联网只读（抓网页；目标 ${network.providerHost}）`:'本场允许联网只读（抓网页）'
        input.addEventListener('change',()=>{networkSelected=input.checked;void refresh()})
        label.append(input,text);networkDisclosure.append(label)
      }
      const title=document.createElement('p');title.textContent='本场固定对象：';manifest.append(title)
      const paths=document.createElement('ul');for(const source of prepared.sources){const item=document.createElement('li');item.textContent=source.relPath;paths.append(item)}manifest.append(paths)
      recipient.textContent=`模型：${prepared.recipient.modelId} · 接口主机：${prepared.recipient.host}`
      const labels=sessionToolLabels(options.origin, prepared.sources)
      if(networkSelected&&prepared.network?.available)labels.push('联网只读（抓网页）')
      status.textContent=`已核对 ${prepared.sources.length} 篇笔记；本场工具：${labels.join('、')}。其他篇账本、附件不在本场范围。`
      send.disabled=false
      if(document.activeElement===panel.root)send.focus({preventScroll:true})
    }catch{if(current===generation && panel.isOpen())status.textContent='准备失败，请取消后重试。'}
  }
  async function submit():Promise<void>{
    if(!prepared || submitting || send.disabled)return
    submitting=true
    // Disabled focused controls can send focus to body; retain the confirmation context.
    panel.root.focus({preventScroll:true})
    send.disabled=true;fieldset.disabled=true
    networkDisclosure.querySelectorAll('input').forEach(input=>{input.disabled=true})
    const displayed=prepared
    try{
      const result=await options.send(displayed,networkSelected)
      if(!panel.isOpen())return
      if(result.ok){panel.close();return}
      status.textContent=`未发送：${hostErrorText(result.error)}`
      await refresh()
      if(prepared)status.textContent='范围与接收方已重新核对。请查看并再次确认；刚才没有启动任务。'

    }catch{if(panel.isOpen()){status.textContent='发送失败，口令仍保留。';send.disabled=false}}
    finally{submitting=false;fieldset.disabled=false;networkDisclosure.querySelectorAll('input').forEach(input=>{input.disabled=false})}
  }
  send.addEventListener('click',()=>void submit())
  panel.root.querySelector('.authorization-cancel')!.addEventListener('click',()=>panel.close())
  panel.root.addEventListener('keydown',event=>{
    if(event.key!=='Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229)return
    event.preventDefault();if(event.target instanceof Element && event.target.closest('.authorization-cancel')){panel.close();return};void submit()
  })
  void refresh()
  return panel
}
