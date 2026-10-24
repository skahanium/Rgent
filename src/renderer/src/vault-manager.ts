import { LEDGER_ERROR_MESSAGES, ledgerErrorText } from '../../shared/ledger-errors.ts'
import type { LedgerRepairRequest, LedgerRepairResult, LedgerRecoveryView } from '../../shared/ledger.ts'
import type { LifecycleStatus, RecoveryAbandonResult, RecoveryConfirmResult, RecoveryScanResult, RecoveryScanView, RecoveryVerdict } from '../../shared/ipc.ts'
import type { VaultCatalogEntry, VaultCatalogView, VaultRootPreview, VaultCatalogChangeRequest, VaultCatalogChangeResult } from '../../shared/vault-management'
import { icon, type IconName } from './icons'
import { mountTrashManager, trashErrorText, type TrashManagerHandlers, type TrashManagerPage } from './trash-manager.ts'

type Catalog = VaultCatalogChangeResult & { activeId?: string | null; activeUnavailable?:boolean }
export type VaultManagerHandlers = {
  recovery?: {state():Promise<LifecycleStatus>;repair(request:LedgerRepairRequest):Promise<LedgerRepairResult>}
  externalRecovery?: {scan():Promise<RecoveryScanResult>;confirm(relPath:string):Promise<RecoveryConfirmResult>;abandon?(relPath:string):Promise<RecoveryAbandonResult>}
  /** 库内「已删除」；未提供时退回 preload 的同名接口（外壳尚未接线时页面仍可用）。 */
  trash?: TrashManagerHandlers
  get(): Promise<Catalog>
  open(id: string): Promise<void>
  pick(create: boolean): Promise<void>
  change(request: VaultCatalogChangeRequest): Promise<Catalog>
}

export type VaultManagerPage = { dispose(): void; isDirty(): boolean; isBusy(): boolean }

/** 设置内的设备库目录；文件核验与切换事务仍由调用方执行。 */
export function mountVaultManager(context: {
  body: HTMLElement
  isCurrent(): boolean
  onBusyChange?: (busy: boolean) => void
}, handlers: VaultManagerHandlers): VaultManagerPage {
  const root = context.body
  root.classList.add('vault-settings')
  let catalog: Catalog | null = null
  let busy = false
  let disposed = false
  let sequence = 0
  let trashPage: TrashManagerPage | null = null
  let trashCountSequence = 0
  const trash = handlers.trash ?? preloadTrashHandlers()
  const alive = (): boolean => !disposed && context.isCurrent()
  const rows = new Map<string, ReturnType<typeof createRow>>()
  const primary = element('div', 'vault-settings-primary')
  const shortcuts = element('div', 'vault-settings-shortcuts')
  const open = button('打开已有笔记库', () => { void run('正在打开笔记库…', () => handlers.pick(false)) }, 'folder')
  const create = button('新建笔记库', () => { void run('正在创建空库…', () => handlers.pick(true)) }, 'folder-plus')
  open.dataset.vaultAction = 'open'; create.dataset.vaultAction = 'create'
  shortcuts.append(open, create)
  // 「已删除（N）」只是这一页的次级入口，不新增导航项；没有列表接口时整行不出现。
  const trashLink = element('div', 'vault-settings-trash-link')
  const trashEntry = button('已删除（0）', () => openTrash())
  trashEntry.dataset.vaultAction = 'trash'
  const trashHint = element('p', 'vault-settings-diagnostic')
  trashHint.hidden = true; trashHint.setAttribute('role', 'status')
  trashLink.append(trashEntry, trashHint)
  const diagnostic = element('p', 'vault-settings-diagnostic')
  diagnostic.hidden = true; diagnostic.setAttribute('role', 'alert')
  const loading = element('p', 'vault-settings-empty', '正在读取库列表…')
  const current = element('section', 'vault-settings-active')
  current.setAttribute('aria-label', '正在使用的笔记库'); current.hidden = true
  const others = element('section', 'vault-settings-others')
  const list = element('div', 'vault-settings-list')
  const empty = element('p', 'vault-settings-empty', '没有其他笔记库。可以打开已有笔记库，或新建笔记库。')
  others.append(element('h3', '', '其他笔记库'), list, empty); others.hidden = true
  const status = element('p', 'vault-settings-status')
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
  primary.append(shortcuts)
  if (trash) primary.append(trashLink)
  primary.append(diagnostic, loading, current, others, status)
  const trashSection = element('section', 'vault-settings-trash')
  trashSection.hidden = true; trashSection.setAttribute('aria-label', '已删除')
  root.append(primary, trashSection)
  const recovery = element('section','vault-settings-recovery');recovery.hidden=true
  const recoveryMessage=element('p','vault-settings-hint'),recoveryRows=element('ul',''),recoveryActions=element('div','vault-settings-shortcuts')
  recovery.append(element('h3','','账本登记与整库恢复'),recoveryMessage,recoveryRows,recoveryActions);primary.append(recovery)
  let recoveryState:LifecycleStatus|null=null,recoveryPreview:LedgerRecoveryView|null=null
  const repair=async(request:LedgerRepairRequest)=>{const result=await handlers.recovery!.repair(request);if(!alive())return;if(!result.ok){
    if(request.action==='commit'||request.action==='cancel')recoveryPreview=null
    const state=await handlers.recovery!.state().catch(()=>null)
    if(!alive()||state&&state.sessionId!==request.sessionId)return
    if(state)recoveryState=state
    showRecovery();throw Error(result.error==='UNSAVED_DRAFT'?'RECOVERY_UNSAVED_DRAFT':result.error)
  }if(result.value&&'rows'in result.value){recoveryPreview=result.value;showRecovery()}else if(result.value&&'processed'in result.value){
    const progress=result.value;recoveryPreview=null
    // Completing one intent may trigger a pending-answer save which creates a
    // different intent. The current lifecycle, not the previous receipt, owns UI state.
    const state=await handlers.recovery!.state().catch(()=>null)
    if(!alive()||state&&state.sessionId!==request.sessionId)return
    recoveryState=state??{sessionId:request.sessionId,status:'invalid',revision:null,items:[]}
    showRecovery()
    if(!state)recoveryMessage.textContent='本次操作已返回，但当前恢复状态无法读取，请重新打开本页。已有回答和恢复记录保留。'
    else if(progress.status==='complete'&&state.status==='ready')recoveryMessage.textContent='恢复已完成。账本和合格来源已核验；未通过的来源仍暂停。'
    else if(progress.status==='pending'&&state.status==='pending'&&state.revision===progress.revision)recoveryMessage.textContent=`已核验 ${progress.processed} / ${progress.total} 项，可暂停并离开本库。进度保留；有窗口稿就先继续恢复，保存后再离库。`
  }}
  function showRecovery(){
    recovery.hidden=!recoveryState;recoveryRows.replaceChildren();recoveryActions.replaceChildren();if(!recoveryState)return
    const sessionId=recoveryState.sessionId
    if(recoveryPreview){const preview=recoveryPreview;recoveryMessage.textContent=preview.warning
      for(const row of preview.rows){const item=element('li','',`${row.relPath} · ${{associate:'可建立新关联','history-only':'只恢复历史，来源暂停',refused:'拒绝'}[row.outcome]}${row.reasons.length?'：'+row.reasons.join('；'):''}`);for(const source of row.sources)item.append(element('p','vault-settings-hint',`${source.status==='verified'?'来源核验通过':'来源暂停'}：${source.reason}`));recoveryRows.append(item)}
      const confirm=button(preview.mode==='restore'?'确认授权新关联':'确认重建原登记',()=>{void run('正在核验恢复…',()=>repair({sessionId,action:'commit',previewId:preview.id}))});confirm.disabled=!preview.canCommit;confirm.dataset.recoveryRefused=String(!preview.canCommit)
      const cancel=button('取消恢复预览',()=>{void run('取消预览…',async()=>{await repair({sessionId,action:'cancel',previewId:preview.id});if(alive()){recoveryPreview=null;showRecovery()}})})
      recoveryActions.append(cancel,confirm)
    }else if(recoveryState.status!=='ready'){
      recoveryMessage.textContent=recoveryState.status==='invalid'?'恢复记录无法核验，原记录保留。可以退出本页或切换笔记库。':recoveryState.operation?.kind==='ledger-repair'?'整库恢复已暂停，请核验并继续一批，或先离开本库。正文仍可读；编辑、保存、任务、结构操作和整理写入暂停，窗口稿保留。':'文件操作尚未完成，请先核验现有恢复记录。'
      if(recoveryState.status==='pending'&&recoveryState.operation?.kind==='ledger-repair'&&recoveryState.revision){const revision=recoveryState.revision;recoveryActions.append(button('核验并继续一批',()=>{void run('正在续接恢复…',()=>repair({sessionId,action:'resume',revision}))}))}
    }else{recoveryMessage.textContent='登记损坏可先重建原描述。整库复制或恢复后，须预览并明确授权新关联；单篇复制仍是新笔记。'
      for(const [mode,label]of [['rebuild','预览重建登记'],['restore','预览整库恢复']]as const)recoveryActions.append(button(label,()=>{void run('正在核验整库…',()=>repair({sessionId,action:'preview',mode}))}))
    }
  }
  if(handlers.recovery)void handlers.recovery.state().then(state=>{if(alive()){recoveryState=state;showRecovery()}},()=>{if(alive()){recovery.hidden=false;recoveryMessage.textContent='当前库的恢复状态无法读取，请重新打开本页。'}})

  // 外部消失（在库外被删或移走）的对象：只核验、只上报，不提供删除或替代路径。
  const external = element('section','vault-settings-recovery');external.hidden=true
  const externalMessage=element('p','vault-settings-hint'),externalRows=element('ul',''),externalActions=element('div','vault-settings-shortcuts')
  external.append(element('h3','','外部消失与恢复核验'),externalMessage,externalRows,externalActions);primary.append(external)
  let externalView:RecoveryScanView|null=null
  const verdictLabels:Record<RecoveryVerdict,string>={restored:'可以核验恢复','still-missing':'仍在库外','object-replaced':'原路径换成了另一个对象','content-changed':'内容已变','attachments-missing':'附件夹缺失（降级）','attachments-changed':'附件子树已变','permission-denied':'权限档禁止','permission-changed':'权限档已变（仍可恢复）','permission-unreadable':'权限名单无法核验','ledger-unverified':'账本登记无法核验'}
  /** 二次确认面板只在人点「放弃恢复」后才进 DOM：默认列表里不出现删除／废纸篓字样。 */
  function confirmAbandon(item:HTMLElement,relPath:string){
    if(item.querySelector('.vault-settings-confirmation'))return
    const panel=element('div','vault-settings-confirmation')
    panel.append(element('p','','只清除 Rgent 库内的恢复记录并释放路径。不会动系统废纸篓里的文件；若文件还在废纸篓，需要你自己处理。'))
    const actions=element('div','vault-settings-shortcuts')
    const cancel=button('取消',()=>panel.remove())
    const confirm=button('确认放弃恢复',()=>{
      panel.remove()
      let notice=''
      void run('正在放弃恢复…',async()=>{
        const result=await handlers.externalRecovery!.abandon!(relPath)
        if(!alive())return
        if(!result.ok)throw Error(result.error)
        notice=result.degraded==='ledger-failed'
          ?'恢复记录已清除、路径已释放；但账本留痕失败，这次放弃没有完整审计记录。'
          :'已放弃恢复：库内记录已清除，路径已释放；系统废纸篓里的文件未改动。'
        await rescanRows()
      }).then(()=>{if(alive()&&notice)status.textContent=notice})
    })
    confirm.dataset.recoveryAbandonConfirm='true'
    confirm.classList.add('vault-settings-danger')
    actions.append(cancel,confirm);panel.append(actions);item.append(panel)
  }
  function showExternal(){
    externalRows.replaceChildren();externalActions.replaceChildren()
    if(!externalView)return
    external.hidden=false
    if(externalView.rows.length===0){externalMessage.textContent='没有已登记对象在库外消失。恢复由人在访达／资源管理器执行，这里只做核验。';externalActions.append(rescan);return}
    externalMessage.textContent='这些对象曾在库外消失，来源仍对 AI 失效。记忆不会自动遗忘；内容、同名附件夹与权限档都与记录一致才恢复可用。'
    for(const row of externalView.rows){
      const item=element('li','',`${row.relPath} · ${verdictLabels[row.verdict]}：${row.message}`)
      item.dataset.recoveryVerdict=row.verdict
      if(row.canRestore&&row.verdict==='permission-changed')item.append(element('p','vault-settings-hint','恢复后按现行权限档生效；AI 是否可用以现行档为准。'))
      if(row.canRestore){const confirm=button('核验并恢复',()=>{let notice:string|null=null;void run('正在核验恢复…',async()=>{
        const result=await handlers.externalRecovery!.confirm(row.relPath)
        if(!alive())return
        if(!result.ok)throw Error(result.error)
        await rescanRows()
        notice=result.message
        // `run` 收尾会把没有返回值的操作状态清空；核验结论要在它之后再落到状态行，
        // 否则「核验通过…来源恢复可用」当场被抹掉（窗口专项实测）。
      }).then(()=>{if(alive()&&notice)status.textContent=notice})});confirm.dataset.recoveryConfirm=row.relPath;item.append(confirm)}
      if(row.canAbandon&&handlers.externalRecovery?.abandon){const abandon=button('放弃恢复',()=>confirmAbandon(item,row.relPath));abandon.dataset.recoveryAbandon=row.relPath;abandon.classList.add('vault-settings-danger');item.append(abandon)}
      externalRows.append(item)
    }
    externalActions.append(rescan)
  }
  async function rescanRows():Promise<void>{
    const result=await handlers.externalRecovery!.scan()
    if(!alive())return
    if(!result.ok)throw Error(result.error)
    externalView=result.value;showExternal()
  }
  const rescan=button('重扫并核验恢复',()=>{void run('正在重扫核验…',async()=>{await rescanRows();if(alive())status.textContent='重扫完成。'})})
  rescan.dataset.recoveryScan='true'
  if(handlers.externalRecovery){external.hidden=false;externalMessage.textContent='可重扫并核验外部消失的对象。';externalActions.append(rescan)}

  function refreshControls(): void {
    root.setAttribute('aria-busy', String(busy))
    open.disabled = busy; create.disabled = busy; trashEntry.disabled = busy
    for(const action of recoveryActions.querySelectorAll<HTMLButtonElement>('button'))action.disabled=busy||action.dataset.recoveryRefused==='true'
    for(const action of externalActions.querySelectorAll<HTMLButtonElement>('button'))action.disabled=busy
    for (const row of rows.values()) {
      for (const action of row.root.querySelectorAll<HTMLButtonElement>('button')) action.disabled = busy
      row.input.disabled = busy
      row.relocate.disabled = busy || row.entry.id === catalog?.activeId&&!catalog?.activeUnavailable
      row.save.disabled = busy || row.input.value.trim() === row.entry.label || !row.input.value.trim()
    }
  }
  async function run(message: string, operation: () => Promise<void | Catalog>, savedMessage = '已保存。'): Promise<void> {
    if (busy || !alive()) return
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null
    const selection = focused instanceof HTMLInputElement ? [focused.selectionStart, focused.selectionEnd] as const : null
    const focusedValue = focused instanceof HTMLInputElement ? focused.value : null
    busy = true; context.onBusyChange?.(true)
    const ticket = ++sequence
    status.textContent = message; refreshControls()
    try {
      const result = await operation()
      if (!alive() || ticket !== sequence) return
      if (result) showCatalog(result)
      status.textContent = result ? savedMessage : ''
    } catch (error) {
      if (!alive() || ticket !== sequence) return
      status.textContent = errorText(error)
    } finally {
      if (alive() && ticket === sequence) {
        busy = false; refreshControls(); context.onBusyChange?.(false)
        if (focused?.isConnected && !focused.closest('[hidden]')) {
          focused.focus()
          if (selection && focused instanceof HTMLInputElement && focused.value === focusedValue) focused.setSelectionRange(selection[0], selection[1])
        } else if (focused && !focused.isConnected) open.focus()
      }
    }
  }
  function applyTrashCount(count: number): void {
    const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
    trashEntry.textContent = `已删除（${next}）`
    trashHint.textContent = ''
    trashHint.hidden = true
  }
  async function refreshTrashCount(): Promise<void> {
    if (!trash || disposed || !alive()) return
    const ticket = ++trashCountSequence
    try {
      const result = await trash.list()
      if (!alive() || ticket !== trashCountSequence) return
      if (!result.ok) {
        applyTrashCount(0)
        trashHint.textContent = trashErrorText(result.error)
        trashHint.hidden = false
        return
      }
      applyTrashCount(result.entries.length)
    } catch (cause) {
      if (!alive() || ticket !== trashCountSequence) return
      applyTrashCount(0)
      trashHint.textContent = trashErrorText(cause)
      trashHint.hidden = false
    }
  }
  function openTrash(): void {
    if (!trash || busy || disposed || !alive()) return
    trashPage?.dispose(); trashPage = null
    trashSection.replaceChildren()
    primary.hidden = true
    trashSection.hidden = false
    root.dataset.vaultView = 'trash'
    trashPage = mountTrashManager({
      body: trashSection,
      isCurrent: () => alive() && !trashSection.hidden,
      onBack: closeTrash,
      // 列表是计数的唯一来源：读到后才改「已删除（N）」，失败时由入口自己显示 0 与提示。
      onChanged: count => { trashCountSequence++; applyTrashCount(count) },
      onBusyChange: next => { busy = next; context.onBusyChange?.(next); refreshControls() }
    }, trash)
    trashSection.querySelector<HTMLButtonElement>('.settings-back')?.focus()
  }
  function closeTrash(): void {
    if (busy || disposed) return
    trashPage?.dispose(); trashPage = null
    trashSection.replaceChildren()
    trashSection.hidden = true
    primary.hidden = false
    delete root.dataset.vaultView
    trashEntry.focus()
  }
  function change(entry: VaultCatalogEntry, action: 'pin' | 'label' | 'remove' | 'relocate', patch: { pinned?: boolean; label?: string } = {}): void {
    if (!catalog || busy) return
    const request = { id: entry.id, revision: catalog.revision, action, ...patch } as VaultCatalogChangeRequest
    const savedMessage = action === 'remove' && entry.id === catalog.activeId ? '已从本设备列表移除。当前笔记库仍保持打开；笔记、账本和记忆均保留。' : '已保存。'
    void run(action === 'relocate' ? '正在重新定位笔记库…' : '正在保存库列表…', async()=>{const result=await handlers.change(request);if(result.rootPreview){const row=rows.get(entry.id)!;row.rootPreview=result.rootPreview;row.showRoot(result.rootPreview)}return result}, savedMessage)
  }
  function createRow(entry: VaultCatalogEntry) {
    const root = element('article', 'vault-settings-row'); root.dataset.vaultId = entry.id
    const title = element('div', 'vault-settings-row-title')
    const labelText = element('strong', 'vault-settings-label', entry.label)
    const using = element('span', 'vault-settings-current', '正在使用')
    title.append(icon('folder'), labelText, using)
    const position = element('p', 'vault-settings-position', entry.path); position.title = entry.path
    const path = element('details', 'vault-settings-path')
    path.append(element('summary', '', '查看完整位置'), element('p', '', entry.path))
    path.addEventListener('click', event => { if (busy && (event.target as HTMLElement).closest('summary')) event.preventDefault() })
    const actions = element('div', 'vault-settings-row-actions')
    const open = button('切换', () => { void run('正在切换笔记库…', () => handlers.open(row.entry.id)) })
    open.dataset.vaultOpen = entry.id
    const pin = button(entry.pinned ? '取消固定' : '固定', () => change(row.entry, 'pin', { pinned: !row.entry.pinned }))
    const edit = button('编辑显示名称', () => { if (!busy) { form.hidden = false; input.focus() } })
    edit.dataset.vaultAction = 'edit-name'; pin.dataset.vaultAction = 'pin'
    const more = button('更多', () => { if (!busy) { menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)) } })
    more.dataset.vaultAction = 'more'; more.setAttribute('aria-expanded', 'false')
    actions.append(open, pin, edit, more)
    const menu = element('div', 'vault-settings-menu'); menu.hidden = true
    const relocate = button('重新定位', () => change(row.entry, 'relocate'))
    relocate.dataset.vaultAction = 'relocate'
    const relocateHint = element('p', 'vault-settings-hint', '正在使用的笔记库需先切换到其他库，再重新定位。')
    const remove = button('从列表移除', () => { if (!busy) { confirmation.hidden = false; cancelRemove.focus() } })
    remove.dataset.vaultAction = 'remove'
    const rootProof=element('div','vault-settings-confirmation');rootProof.hidden=true
    const previewRoot=button('预览恢复',()=>{void rootChange('root-preview')});previewRoot.dataset.vaultAction='root-preview'
    const chooseRoot=button('选择位置并预览恢复',()=>{void rootChange('root-preview',true)});chooseRoot.dataset.vaultAction='root-choose'
    async function rootChange(action:'root-preview'|'root-confirm'|'root-cancel',choose?:boolean){
      if(!catalog)return
      await run('正在核对恢复信息…',async()=>{
        let result:Catalog
        try{result=await handlers.change(action==='root-preview'?{id:row.entry.id,revision:catalog!.revision,action,...(choose?{choose:true}:{})}:{id:row.entry.id,revision:catalog!.revision,action,previewId:row.rootPreview!.id})}catch(error){if(action!=='root-preview'&&alive()){row.showRoot(null);const latest=await handlers.get().catch(()=>null);if(latest&&alive())showCatalog(latest)}throw error}
        if(alive()){
          row.showRoot(result.rootPreview??null)
        }
        return result
      })
    }
    function showRoot(p:VaultRootPreview|null){row.rootPreview=p;rootProof.replaceChildren();rootProof.hidden=!p
      if(p){
        const technical=element('details','vault-root-technical')
        technical.append(element('summary','','技术信息'),element('p','',`登记对象 ${p.previousIdentity} → 当前对象 ${p.rootIdentity}`))
        rootProof.append(element('p','',`${p.previousPath} → ${p.path}`),element('p','',p.workspace==='unavailable'?'无法恢复本库上次的工作位置；原记录保留，正文仍可打开。':p.workspace==='restore'?'恢复本库上次的工作位置。':'没有可恢复的上次工作位置。'),element('p','','确认只建立此设备上的新关联，不证明这是原来的目录。账本和记忆会分别核验；旧任务会停止，窗口稿和待保存回答保留。旧稿不会自动写入当前目录，另存正文需要再次确认。'),technical,button('取消恢复预览',()=>{void rootChange('root-cancel')}),button('确认建立新关联',()=>{void rootChange('root-confirm')}))
      }
    }
    menu.append(relocate,previewRoot,chooseRoot,remove,relocateHint)
    const form = element('form', 'vault-settings-name'); form.noValidate = true; form.hidden = true
    const label = element('label', '', '显示名称')
    const input = document.createElement('input'); input.type = 'text'; input.value = entry.label; input.maxLength = 80
    label.append(input)
    const save = button('保存名称', () => {}); save.type = 'submit'; save.dataset.vaultAction = 'label'
    const cancel = button('取消', () => { if (!busy) { input.value = row.entry.label; form.hidden = true; refreshControls(); edit.focus() } })
    cancel.dataset.vaultAction = 'cancel-name'
    form.append(label, save, cancel, element('p', 'vault-settings-hint', '只修改本设备上的显示名称，不会更改文件夹名称。'))
    const confirmation = element('div', 'vault-settings-confirmation'); confirmation.hidden = true
    confirmation.append(element('p', '', '只移除此设备上的笔记库登记。笔记、账本和记忆均保留，不会删除。'))
    const confirm = button('确认从列表移除', () => change(row.entry, 'remove')); confirm.dataset.vaultAction = 'confirm-remove'
    const cancelRemove = button('取消移除', () => { if (!busy) { confirmation.hidden = true; remove.focus() } }); cancelRemove.dataset.vaultAction = 'cancel-remove'
    confirmation.append(cancelRemove, confirm)
    root.append(title, position, path, actions, menu, form, confirmation,rootProof)
    const row = { showRoot,rootPreview:null as VaultRootPreview|null,entry, root, labelText, open, using, position, path, actions, pin, edit, more, menu, relocate, relocateHint, form, input, save, confirmation }
    form.addEventListener('submit', event => { event.preventDefault(); if (!busy && !save.disabled) change(row.entry, 'label', { label: input.value.trim() }) })
    input.addEventListener('input', refreshControls)
    return row
  }
  function showCatalog(next: Catalog): void {
    next = { ...next, activeId: next.activeId === undefined ? catalog?.activeId : next.activeId }
    catalog = next
    const ids = new Set(next.entries.map(entry => entry.id))
    for (const [id, row] of rows) if (!ids.has(id)) { row.root.remove(); rows.delete(id) }
    const ordered = [...next.entries].sort((a,b) => Number(b.pinned)-Number(a.pinned) || (b.lastUsed ?? -1)-(a.lastUsed ?? -1))
    const otherRows: HTMLElement[] = []
    current.hidden = !next.entries.some(entry => entry.id === next.activeId)
    for (const entry of ordered) {
      let row = rows.get(entry.id)
      if (!row) { row = createRow(entry); rows.set(entry.id, row) }
      // Keep both the node and a newer draft. A saved receipt becomes the new baseline.
      if (row.input.value === row.entry.label) row.input.value = entry.label
      row.entry = entry; row.labelText.textContent = entry.label
      const active = entry.id === next.activeId
      row.root.dataset.vaultCurrent = String(active)
      row.using.hidden = !active; row.using.textContent = active ? '正在使用' : ''; row.open.hidden = active
      if (active) row.open.removeAttribute('data-vault-open')
      else row.open.dataset.vaultOpen = entry.id
      row.relocateHint.hidden = !active
      row.relocateHint.textContent = active ? catalog?.activeUnavailable?'原根不可访问，可选择位置、预览并明确确认新关联；窗口稿保留。':'正在使用的稳定根需先切换到其他库，再重新定位。' : ''
      row.pin.textContent = entry.pinned ? '取消固定' : '固定'
      if (active && row.edit.parentElement !== row.actions) row.actions.insertBefore(row.edit, row.more)
      else if (!active && row.edit.parentElement !== row.menu) row.menu.prepend(row.edit)
      if (active && row.pin.parentElement !== row.menu) row.menu.prepend(row.pin)
      else if (!active && row.pin.parentElement !== row.actions) row.actions.insertBefore(row.pin, row.more)
      row.position.textContent = entry.path; row.position.title = entry.path; row.path.querySelector('p')!.textContent = entry.path
      if (active) { if (current.firstElementChild !== row.root) current.replaceChildren(row.root) }
      else otherRows.push(row.root)
    }
    otherRows.forEach((row,index) => { if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null) })
    others.hidden = !!next.diagnostic && !next.entries.length
    empty.hidden = otherRows.length > 0
    diagnostic.hidden = !next.diagnostic
    diagnostic.textContent = next.diagnostic ? '库列表无法读取，原记录已保留。可以手动打开已有笔记库；请先核查本设备的库列表。' : ''
    loading.hidden = true; loading.textContent = ''
    if (!next.entries.length && !next.diagnostic) { empty.textContent = '还没有登记笔记库。打开已有笔记库，或新建笔记库。' }
    refreshControls()
  }
  // Initial read may finish after a cancelled picker; unloaded pages ignore receipts.
  void Promise.resolve().then(() => alive() ? handlers.get() : null).then(next => {
    if (next && alive() && catalog === null) showCatalog(next)
  }, error => {
    if (!alive() || catalog !== null) return
    loading.hidden = true; diagnostic.hidden = false
    diagnostic.textContent = `库列表无法读取。${errorText(error)} 可以手动打开已有笔记库。`
  })
  if (trash) void refreshTrashCount()
  return {
    dispose: () => {
      disposed = true; sequence++; trashCountSequence++
      trashPage?.dispose(); trashPage = null
      if (busy) context.onBusyChange?.(false); busy = false
    },
    isDirty: () => [...rows.values()].some(row => !row.form.hidden && row.input.value.trim() !== row.entry.label),
    isBusy: () => busy
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}
function button(text: string, click: () => void, glyph?: IconName): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  if (glyph) node.append(icon(glyph), document.createTextNode(text))
  else node.textContent = text
  node.addEventListener('click', click)
  return node
}
/** 外壳尚未接线时的退路：直接走 preload 的库内已删除接口；测试仍注入 mock。 */
function preloadTrashHandlers(): TrashManagerHandlers | null {
  const api = (typeof window === 'undefined' ? undefined : window.rgent) as typeof window.rgent | undefined
  if (!api || typeof api.vaultTrashList !== 'function' || typeof api.vaultTrashRestore !== 'function' || typeof api.vaultTrashPurge !== 'function') return null
  return {
    list: () => api.vaultTrashList(),
    restore: id => api.vaultTrashRestore(id),
    purge: id => api.vaultTrashPurge(id),
    ...(typeof api.ledgerGetTrash === 'function' ? { ledger: async (id, cursor) => { const state = await api.vaultGet(); if (!state.sessionId) throw new Error('NO_VAULT'); return api.ledgerGetTrash({sessionId: state.sessionId, trashId: id, cursor}) } } : {})
  }
}
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if(Object.hasOwn(LEDGER_ERROR_MESSAGES,message))return ledgerErrorText(message)
  if(message.includes('STALE_PREVIEW'))return '根对象、目录登记、工作区或会话已变更，预览已失效。请重新预览；窗口稿保留。'
  if(message.includes('STALE_RECOVERY'))return '文件、附件或权限已改变，恢复已停止；已核验进度保留，请核查后重试。'
  if (message.includes('VAULT_SWITCH_CANCELLED')) return ''
  if (message.includes('VAULT_SWITCH_TIMEOUT')) return '切换准备超时，仍留在当前库。窗口稿和设置修改已保留；请重试，或先处理保存与任务问题。'
  if (message.includes('VAULT_SWITCH_BODY_CONFLICT')) return '窗口稿与磁盘稿发生冲突，两份均已保留。请先关闭设置处理正文保存冲突，再重试切换。'
  if (message==='RECOVERY_UNSAVED_DRAFT') return '窗口稿已保留。请先关闭设置处理保存问题，再重新预览；恢复未完成就先继续恢复，完成后保存草稿。'
  if (message.includes('UNSAVED_DRAFT')) return '笔记草稿尚未保存，已留在当前库。请先处理保存问题，再重试切换。'
  if (message.includes('PREVIOUS_TASK_UNSAVED')) return '生成回答尚未保存，已留在原库。请先处理保存问题，再重试切换。'
  if (message.includes('VAULT_TARGET_INVALID')) return '无法打开所选位置。请检查目录是否存在及访问权限后重试。'
  if (message.includes('VAULT_CATALOG_CONFLICT')) return '库列表已在别处更新。请离开本页后重新进入，再核对修改。'
  if(message.includes('VAULT_WORKSPACE_INVALID'))return '工作区位置记录损坏，原字节保留；正文可打开，位置不会覆盖。'
  if(message.includes('BAD_SENDER'))return '原窗口已变更，本次关联未提交；请重新预览。'
  if(message.includes('VAULT_PREVIEW_LIMIT'))return '最多保留四份根预览，请取消旧预览后重试。'
  if(message.includes('SOURCE_AVAILABLE'))return '笔记库仍可正常打开，无需恢复。'
  if (message.includes('VAULT_REPLACED')) return '这个位置现在放的是另一个目录（原库已被替换）。请核对后重新定位，不要直接打开。'
  if (message.includes('VAULT_RELOCATE_REQUIRED')) return '这个库换了位置，请用「重新定位」指到新的文件夹。'
  if (message.includes('VAULT_TARGET_CHANGED')) return '库目录不可访问或已移动，请检查目录后重试。'
  if (message.includes('VAULT_CATALOG_INVALID')) return '本设备的库列表损坏，原记录已保留，请先核查。'
  if (message.includes('VAULT_CATALOG_PATCH_INVALID')) return '显示名称无法保存，请填写有效名称后再试。'
  if (message.includes('ACTIVE_VAULT_RELOCATE')) return '当前库正在使用，请先切换到其他库后再重新定位。'
  if (message.includes('VAULT_NESTED')) return '登记的笔记库不能互相包含，请选择独立的目录。'
  if (message.includes('VAULT_ALREADY_REGISTERED')) return '这个笔记库已经登记，请从库列表中打开。'
  if (message.includes('VAULT_NOT_REGISTERED')) return '库列表已变化，请离开本页后重新进入再核对。'
  if (message.includes('VAULT_CATALOG_LIMIT')) return '库列表已达到容量上限，请先移除不再需要的目录项。'
  if (message.includes('VAULT_SWITCH_BUSY')) return '正在切换笔记库，请稍后再试。'
  return '操作未完成。请检查笔记库位置与访问权限后再试。'
}
