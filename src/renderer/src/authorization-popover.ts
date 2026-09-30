import type { AgentAuthorizationPreview, AgentAuthorizationResult, AgentStartResult, TreeEntry } from '@shared'
import { openOverlay, type Overlay } from './overlay.ts'
import { icon } from './icons.ts'
export type AuthorizationPopoverOptions = {
  anchor:{left:number;top:number;bottom:number}
  origin:string
  entries:TreeEntry[]
  preview:(references:string[])=>Promise<AgentAuthorizationResult>
  send:(preview:AgentAuthorizationPreview)=>Promise<AgentStartResult>
  discard?:(id:string)=>Promise<void>
  onClose?:()=>void
  returnFocus?:()=>HTMLElement|null
}
/** Command-local confirmation; scope changes never reuse the previous displayed grant. */
export function openAuthorizationPopover(options:AuthorizationPopoverOptions):Overlay {
  const selected=new Set<string>();let prepared:AgentAuthorizationPreview|null=null;let generation=0;let submitting=false
  const panel=openOverlay({label:'确认本场参考范围与模型接收方',initialFocus:()=>document.activeElement instanceof HTMLElement && panel.root.contains(document.activeElement)?document.activeElement:panel.root,returnFocus:options.returnFocus,onClose:()=>{generation++;if(prepared)void options.discard?.(prepared.id);prepared=null;options.onClose?.()}})
  panel.root.classList.add('overlay-authorization')
  panel.root.tabIndex=-1
  panel.root.innerHTML='<h2>本场口令</h2><p class="authorization-origin"></p><p class="authorization-recipient" aria-live="polite"></p><p class="authorization-disclosure">本场口令、获准资料与本篇账本会发送给下方显示的模型接收方。本场范围不会沿用到下一场。</p><fieldset class="authorization-scope"><legend>参考范围 · 默认仅本篇</legend></fieldset><div class="authorization-manifest"></div><p class="authorization-status" role="status"></p><footer><button type="button" class="authorization-cancel">取消</button><button type="button" class="authorization-send" disabled>确认并发送</button></footer>'
  panel.root.querySelector('.authorization-origin')!.textContent=`发起篇：${options.origin}（正文与本篇账本）`
  const recipient=panel.root.querySelector('.authorization-recipient')!
  const manifest=panel.root.querySelector('.authorization-manifest')!
  const status=panel.root.querySelector('.authorization-status')!
  const send=panel.root.querySelector<HTMLButtonElement>('.authorization-send')!
  const fieldset=panel.root.querySelector<HTMLFieldSetElement>('.authorization-scope')!
  const choices=document.createElement('div');choices.className='authorization-choices';fieldset.append(choices)
  function renderEntries(entries:TreeEntry[],depth=0):void {
    for(const entry of entries){
      if(entry.kind==='file' || entry.relPath===options.origin)continue
      const label=document.createElement('label');label.style.paddingInlineStart=`${depth*12}px`
      const input=document.createElement('input');input.type='checkbox';input.value=entry.relPath;input.disabled=entry.tier==='forbidden'
      const text=document.createElement('span');text.textContent=entry.relPath+(entry.kind==='dir'?'（确认时固定目录成员）':entry.tier==='follow'?'（只读）':'')
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
      const result=await options.preview([...selected])
      if(current!==generation || !panel.isOpen()){if(result.ok)void options.discard?.(result.preview.id);return}
      if(!result.ok){recipient.textContent='接收方尚未核验';status.textContent=`无法准备：${result.error}`;return}
      prepared=result.preview
      const title=document.createElement('p');title.textContent='本场固定对象：';manifest.append(title)
      const paths=document.createElement('ul');for(const source of prepared.sources){const item=document.createElement('li');item.textContent=source.relPath;paths.append(item)}manifest.append(paths)
      recipient.textContent=`模型：${prepared.recipient.modelId} · 接口主机：${prepared.recipient.host}`
      status.textContent=`已核对 ${prepared.sources.length} 篇笔记；其他篇账本、附件不在本场范围。`
      send.disabled=false
      if(document.activeElement===panel.root)send.focus()
    }catch{if(current===generation && panel.isOpen())status.textContent='准备失败，请取消后重试。'}
  }
  async function submit():Promise<void>{
    if(!prepared || submitting || send.disabled)return
    submitting=true;send.disabled=true;fieldset.disabled=true
    const displayed=prepared
    try{
      const result=await options.send(displayed)
      if(!panel.isOpen())return
      if(result.ok){panel.close();return}
      status.textContent=`未发送：${result.error}`
      await refresh()
      if(prepared)status.textContent='范围与接收方已重新核对。请查看并再次确认；刚才没有启动任务。'

    }catch{if(panel.isOpen()){status.textContent='发送失败，口令仍保留。';send.disabled=false}}
    finally{submitting=false;fieldset.disabled=false}
  }
  send.addEventListener('click',()=>void submit())
  panel.root.querySelector('.authorization-cancel')!.addEventListener('click',()=>panel.close())
  panel.root.addEventListener('keydown',event=>{
    if(event.key!=='Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing)return
    event.preventDefault();if(event.target instanceof Element && event.target.closest('.authorization-cancel')){panel.close();return};void submit()
  })
  void refresh()
  return panel
}
