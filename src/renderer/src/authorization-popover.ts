import type { AgentAuthorizationPreview, AgentAuthorizationResult, AgentStartResult, TreeEntry } from '@shared'
import { openOverlay, type Overlay } from './overlay.ts'
import { icon } from './icons.ts'
import { hostErrorText } from './host-errors.ts'
export type AuthorizationPopoverOptions = {
  anchor:{left:number;top:number;bottom:number}
  origin:string
  entries:TreeEntry[]
  /** `network`／`mcp` 是两个独立的本场勾选：预览与 start 都带它们，主进程核对一致才放行。 */
  preview:(references:string[],network:boolean,mcp:boolean)=>Promise<AgentAuthorizationResult>
  send:(preview:AgentAuthorizationPreview,network:boolean,mcp:boolean)=>Promise<AgentStartResult>
  discard?:(id:string)=>Promise<void>
  onClose?:()=>void
  returnFocus?:()=>HTMLElement|null
}
export type AuthorizationPopover = Overlay & { setStale:()=>void }

/** 同一渲染会话里沿用上次勾选的范围：只在内存，重启即忘。
 *  恢复时只认当前树里还看得见的项；已消失或已变禁用的旧路径不会悄悄带进下一张卡。 */
let rememberedScope:string[]=[]

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

/** 预览文案与宿主宣告同源：补／建始终在；读搜要另有篇；结构只要可参考外篇。 */
function sessionToolLabels(origin:string, sources:readonly {relPath:string;tier:string}[]):string[] {
  const labels=['补发起篇','建笔记']
  const extras=sources.filter(source=>source.relPath!==origin)
  if(extras.length)labels.push('读库','搜库')
  if(extras.some(source=>source.tier!=='follow'))labels.push('改名','挪')
  return labels
}

/** Command-local confirmation; scope changes never reuse the previous displayed grant. */
export function openAuthorizationPopover(options:AuthorizationPopoverOptions):AuthorizationPopover {
  const selected=new Set<string>(rememberedScope);let prepared:AgentAuthorizationPreview|null=null;let generation=0;let submitting=false
  // 联网与 MCP 两个勾选默认都不勾、互不影响；只有主进程说可用时才出现，切换会重新核对预览（防重放）。
  let networkSelected=false
  let mcpSelected=false
  // 非模态：不抢编辑器焦点、不拦快捷键；Esc 由 overlay 在焦点进入卡片时接管。
  const panel=openOverlay({label:'确认本场参考范围与模型接收方',modal:false,returnFocus:options.returnFocus,onClose:()=>{generation++;if(prepared)void options.discard?.(prepared.id);prepared=null;options.onClose?.()}})
  panel.root.classList.add('overlay-authorization')
  panel.root.tabIndex=-1
  panel.root.innerHTML='<h2>本场口令</h2><p class="authorization-origin"></p><p class="authorization-recipient" aria-live="polite"></p><p class="authorization-disclosure">本场口令、获准资料与本篇账本会发送给下方模型接收方。授权仅本场有效。</p><fieldset class="authorization-scope"><legend>参考范围</legend></fieldset><div class="authorization-manifest"></div><p class="authorization-status" role="status"></p><footer><button type="button" class="authorization-cancel">取消</button><button type="button" class="authorization-send" disabled>确认并发送</button></footer>'
  panel.root.querySelector('.authorization-origin')!.textContent=`发起篇：${options.origin}（正文与账本）`
  const recipient=panel.root.querySelector('.authorization-recipient')!
  const memoryDisclosure=document.createElement('p');memoryDisclosure.className='authorization-memory settings-hint';memoryDisclosure.setAttribute('aria-live','polite');panel.root.querySelector('.authorization-disclosure')!.after(memoryDisclosure)
  // 技能只报名称：正文不进这张卡（合同取舍）；不可用的另起一句，让人当场决定要不要重来。
  const skillsDisclosure=document.createElement('p');skillsDisclosure.className='authorization-skills settings-hint';skillsDisclosure.setAttribute('aria-live','polite');memoryDisclosure.after(skillsDisclosure)
  const networkDisclosure=document.createElement('div');networkDisclosure.className='authorization-network';networkDisclosure.setAttribute('aria-live','polite');skillsDisclosure.after(networkDisclosure)
  // MCP 是另一条独立门：自己的勾选、自己的不可用原因，与联网勾选互不影响。
  const mcpDisclosure=document.createElement('div');mcpDisclosure.className='authorization-mcp';mcpDisclosure.setAttribute('aria-live','polite');networkDisclosure.after(mcpDisclosure)
  const manifest=panel.root.querySelector('.authorization-manifest')!
  const status=panel.root.querySelector('.authorization-status')!
  const send=panel.root.querySelector<HTMLButtonElement>('.authorization-send')!
  const fieldset=panel.root.querySelector<HTMLFieldSetElement>('.authorization-scope')!
  const scopeHint=document.createElement('p');scopeHint.className='authorization-scope-hint settings-hint';scopeHint.textContent='默认不选；同一会话沿用上次勾选。';scopeHint.style.margin='0 0 8px'
  const presets=document.createElement('div');presets.className='authorization-presets';presets.style.display='flex';presets.style.flexWrap='wrap';presets.style.gap='8px';presets.style.margin='0 0 10px'
  const onlyOrigin=document.createElement('button');onlyOrigin.type='button';onlyOrigin.className='authorization-preset-origin';onlyOrigin.textContent='只读本笔记'
  const directoryTarget=directoryPreset(options.entries,options.origin)
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
      const input=document.createElement('input');input.type='checkbox';input.value=entry.relPath;input.disabled=!selectable
      if(selectable && selected.has(entry.relPath))input.checked=true
      const text=document.createElement('span');text.textContent=entry.relPath+(entry.kind==='dir'?'（确认时固定目录成员）':entry.tier==='follow'?'（必须遵循：可参考，不能改名／挪）':'')
      label.append(input,icon(entry.kind==='dir'?'folder':'note'),text);choices.append(label)
      input.addEventListener('change',()=>{if(input.checked)selected.add(entry.relPath);else selected.delete(entry.relPath);rememberScope();void refresh()})
      if(entry.children)renderEntries(entry.children,depth+1)
    }
  }
  renderEntries(options.entries)
  // 记忆里的旧路径只有在当前卡里还可勾选时才算数；看不见的项不参与本场预览。
  for(const path of [...selected])if(!available.has(path))selected.delete(path)
  function rememberScope():void{rememberedScope=[...selected]}
  function applySelection(paths:string[]):void{
    selected.clear();for(const path of paths)selected.add(path)
    for(const input of choices.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))input.checked=!input.disabled && selected.has(input.value)
    rememberScope();void refresh()
  }
  onlyOrigin.addEventListener('click',()=>applySelection([]))
  if(onlyDirectory && directoryTarget && !directoryTarget.disabledReason)onlyDirectory.addEventListener('click',()=>applySelection([directoryTarget.relPath]))
  if(!choices.childElementCount)choices.textContent='当前没有其他可选笔记。'
  const viewportWidth=window.innerWidth;const viewportHeight=window.innerHeight
  panel.root.style.left=`${Math.max(12,Math.min(options.anchor.left,viewportWidth-432))}px`
  panel.root.style.top=`${Math.max(12,Math.min(options.anchor.bottom+8,viewportHeight-420))}px`
  panel.root.style.maxHeight=`${viewportHeight-parseFloat(panel.root.style.top)-12}px`
  /** 内容在卡片打开后发生变化：作废当前预览并拦住发送，等下一次成功预览再放行。
   *  已暴露给调用方；当前 shell 尚未接线，卡片打开期间改正文要等下一次 preview／send 才提示。 */
  function setStale(prefix=''):void{
    if(!panel.isOpen())return
    generation++
    if(prepared)void options.discard?.(prepared.id)
    prepared=null;send.disabled=true
    status.textContent=`${prefix}内容已改，重新核对。`
  }
  async function refresh():Promise<void>{
    if(prepared)void options.discard?.(prepared.id)
    const current=++generation;prepared=null;manifest.replaceChildren();send.disabled=true;status.textContent='核对范围与接收方…'
    try{
      const result=await options.preview([...selected],networkSelected,mcpSelected)
      if(current!==generation || !panel.isOpen()){if(result.ok)void options.discard?.(result.preview.id);return}
      if(!result.ok){
        recipient.textContent='接收方尚未核验'
        if(result.error==='STALE_AUTHORIZATION'){setStale('无法准备。');return}
        status.textContent=`无法准备。${hostErrorText(result.error)}`;return
      }
      prepared=result.preview
      const memory=prepared.memory
      const memoryParts:string[]=[]
      if(memory?.use){
        memoryParts.push('本场使用独立记忆（当前库），不扩大读库范围。')
        if(memory.consolidate && memory.recipient){
          memoryParts.push(`回答与账本保存后，交 ${memory.recipient.modelId} · ${memory.recipient.host} 后台整理。`)
          memoryParts.push('内容限本场口令、必要结果、来源片段与相关记忆。')
          memoryParts.push(`上限：${memory.limits.seconds} 秒、${memory.limits.calls} 次调用、0 次工具；不含思维链与完整历史。`)
        }else memoryParts.push('整理模型未选或不可用，本场不积累记忆。')
        memoryParts.push(memory.search?.available?`本场可检索记忆，最多 ${memory.search.calls} 次，计入 ${memory.search.sharedTools} 次工具额度。`:'本场仅本机召回，不增加工具额度。')
      }else memoryParts.push('当前库记忆关闭；本场不使用，也不整理记忆。')
      memoryDisclosure.textContent=memoryParts.join('')
      const skillNames=(prepared.skills??[]).map(skill=>skill.name)
      const unavailable=(prepared.skillsUnavailable??[]).map(item=>item.name??'未命名技能')
      // 合同取舍：这里只出现名称——正文、字数、原因文本都不在这张卡上；原因在设置页「技能」，证据在账本。
      skillsDisclosure.textContent=skillNames.length||unavailable.length
        ? `${skillNames.length?`本场技能：${skillNames.join('、')}。`:''}${unavailable.length?`已启用但未加载：${unavailable.join('、')}（原因见设置页「技能」）。`:''}技能正文不在此卡；账本记有名称与内容哈希。`
        : '本场无技能。'
      if(prepared.summaryGenerators?.length){const generators=document.createElement('p');generators.textContent='本篇账本可复用历史摘要（仍须在发送前核验）：'+prepared.summaryGenerators.map(g=>`${g.modelId} · ${g.host} · ${g.time}`).join('；');manifest.append(generators)}
      // 联网只读：抓页可用就给勾选（默认不勾）；搜索可用才在文案里带上搜索。
      // `not-configured` 只解释搜索为什么不可用，不影响抓页的勾选。
      networkDisclosure.replaceChildren()
      const network=prepared.network
      if(!network?.available){
        networkSelected=false
        const note=document.createElement('p');note.className='settings-hint'
        note.textContent=network?.reason==='not-configured'
          ? '本场不能联网只读。尚未配置联网服务（设置「模型」页）。'
          : network?.reason==='off'||!network
            ? '本场不能联网只读。联网总开关已关闭（设置「模型」页）。'
            : '本场不能联网只读。'
        networkDisclosure.append(note)
      }else{
        const label=document.createElement('label')
        const input=document.createElement('input');input.type='checkbox';input.checked=networkSelected
        const text=document.createElement('span')
        text.textContent=network.search
          ? network.providerHost?`本场允许联网只读（抓网页＋搜索；目标 ${network.providerHost}）`:'本场允许联网只读（抓网页＋搜索）'
          : '本场允许联网只读（抓网页）'
        input.addEventListener('change',()=>{networkSelected=input.checked;void refresh()})
        label.append(input,text);networkDisclosure.append(label)
        if(!network.search){
          // 不让「允许联网只读」被读成「本场也能搜索」。
          const hint=document.createElement('p');hint.className='settings-hint'
          hint.textContent=network.reason==='not-configured'
            ? '搜索服务尚未配置，本场只能抓网页。可在设置「模型」页配置服务与密钥。'
            : '搜索当前不可用，本场只能抓网页。'
          networkDisclosure.append(hint)
        }
      }
      // 远端只读 MCP：可用时才给勾选（默认不勾）；不可用时只给一句原因，不留可点的假入口。
      mcpDisclosure.replaceChildren()
      const mcp=prepared.mcp
      if(!mcp?.available){
        mcpSelected=false
        const note=document.createElement('p');note.className='settings-hint'
        note.textContent=mcp?.reason==='too-many-tools'
          ? '本场不能使用 MCP。获准工具清单超过 4 KiB，请精简白名单（设置「模型」页）。'
          : mcp?.reason==='off'
            ? '本场不能使用 MCP。设置里的 MCP 服务器都未启用（设置「模型」页）。'
            : mcp?.reason==='not-configured'
              ? '本场不能使用 MCP。还没有可用的服务器（启用并勾选白名单；公共只读服务器可免 token）。'
              : '本场不能使用 MCP。'
        mcpDisclosure.append(note)
      }else{
        const label=document.createElement('label')
        const input=document.createElement('input');input.type='checkbox';input.checked=mcpSelected
        const text=document.createElement('span')
        // 只报服务器名与工具数：token、schema 与服务器正文都不上这张卡。
        text.textContent=`本场允许只读 MCP（${mcp.servers.map(server=>`${server.name}：${server.tools.length} 个工具`).join('、')}）`
        input.addEventListener('change',()=>{mcpSelected=input.checked;void refresh()})
        label.append(input,text);mcpDisclosure.append(label)
      }
      const title=document.createElement('p');title.textContent='本场固定对象：';manifest.append(title)
      const paths=document.createElement('ul');for(const source of prepared.sources){const item=document.createElement('li');item.textContent=source.relPath;paths.append(item)}manifest.append(paths)
      recipient.textContent=`模型：${prepared.recipient.modelId} · 主机：${prepared.recipient.host}`
      const labels=sessionToolLabels(options.origin, prepared.sources)
      if(networkSelected&&prepared.network?.available)labels.push(prepared.network.search?'联网只读（抓网页＋搜索）':'联网只读（抓网页）')
      if(mcpSelected&&prepared.mcp?.available)labels.push('只读 MCP')
      status.textContent=`已核对 ${prepared.sources.length} 篇笔记。工具：${labels.join('、')}。其他篇账本与附件不在范围。`
      send.disabled=false
      // 只有焦点已经落在卡片里时才把键盘用户送到发送键；非模态打开不会主动抢焦点。
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
    mcpDisclosure.querySelectorAll('input').forEach(input=>{input.disabled=true})
    const displayed=prepared
    try{
      const result=await options.send(displayed,networkSelected,mcpSelected)
      if(!panel.isOpen())return
      if(result.ok){panel.close();return}
      const stale=result.error==='STALE_AUTHORIZATION'
      status.textContent=stale?'内容已改，重新核对。':`未发送。${hostErrorText(result.error)}`
      await refresh()
      if(prepared)status.textContent=stale
        ? '内容已改，重新核对。范围与接收方已更新，请再次确认。'
        : '范围与接收方已重新核对，请再次确认。刚才没有启动任务。'
    }catch{if(panel.isOpen()){status.textContent='发送失败，口令仍保留。';send.disabled=false}}
    finally{submitting=false;fieldset.disabled=false;networkDisclosure.querySelectorAll('input').forEach(input=>{input.disabled=false});mcpDisclosure.querySelectorAll('input').forEach(input=>{input.disabled=false})}
  }
  send.addEventListener('click',()=>void submit())
  panel.root.querySelector('.authorization-cancel')!.addEventListener('click',()=>panel.close())
  panel.root.addEventListener('keydown',event=>{
    if(event.defaultPrevented || event.key!=='Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229)return
    const target=event.target instanceof Element?event.target:null
    if(target?.closest('.authorization-cancel')){event.preventDefault();panel.close();return}
    // 回车是卡片的发送键，但不该抢掉文本框、下拉与预设按钮自己的回车。
    if(target?.closest('textarea, select, button:not(.authorization-send)'))return
    if(!prepared || send.disabled)return
    event.preventDefault();void submit()
  })
  void refresh()
  return Object.assign(panel,{setStale})
}
