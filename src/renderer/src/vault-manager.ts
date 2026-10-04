import { LEDGER_ERROR_MESSAGES, ledgerErrorText } from '../../shared/ledger-errors.ts'
import type { LedgerRepairRequest, LedgerRepairResult, LedgerRecoveryView } from '../../shared/ledger.ts'
import type { LifecycleStatus } from '../../shared/ipc.ts'
import type { VaultCatalogEntry, VaultCatalogView } from '../../shared/vault-management'
import { icon, type IconName } from './icons'

type Catalog = VaultCatalogView & { activeId?: string | null }
export type VaultManagerHandlers = {
  recovery?: {state():Promise<LifecycleStatus>;repair(request:LedgerRepairRequest):Promise<LedgerRepairResult>}
  get(): Promise<Catalog>
  open(id: string): Promise<void>
  pick(create: boolean): Promise<void>
  change(request: {
    id: string
    revision: string
    action: 'pin' | 'label' | 'remove' | 'relocate'
    pinned?: boolean
    label?: string
  }): Promise<Catalog>
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
  const alive = (): boolean => !disposed && context.isCurrent()
  const rows = new Map<string, ReturnType<typeof createRow>>()
  const shortcuts = element('div', 'vault-settings-shortcuts')
  const open = button('打开已有笔记库', () => { void run('正在打开笔记库…', () => handlers.pick(false)) }, 'folder')
  const create = button('新建笔记库', () => { void run('正在创建空库…', () => handlers.pick(true)) }, 'folder-plus')
  open.dataset.vaultAction = 'open'; create.dataset.vaultAction = 'create'
  shortcuts.append(open, create)
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
  root.append(shortcuts, diagnostic, loading, current, others, status)
  const recovery = element('section','vault-settings-recovery');recovery.hidden=true
  const recoveryMessage=element('p','vault-settings-hint'),recoveryRows=element('ul',''),recoveryActions=element('div','vault-settings-shortcuts')
  recovery.append(element('h3','','账本登记与整库恢复'),recoveryMessage,recoveryRows,recoveryActions);root.append(recovery)
  let recoveryState:LifecycleStatus|null=null,recoveryPreview:LedgerRecoveryView|null=null
  const repair=async(request:LedgerRepairRequest)=>{const result=await handlers.recovery!.repair(request);if(!alive())return;if(!result.ok){
    if(request.action==='commit'||request.action==='cancel')recoveryPreview=null
    const state=await handlers.recovery!.state().catch(()=>null)
    if(!alive()||state&&state.sessionId!==request.sessionId)return
    if(state)recoveryState=state
    showRecovery();throw Error(result.error==='UNSAVED_DRAFT'?'RECOVERY_UNSAVED_DRAFT':result.error)
  }if(result.value&&'rows'in result.value){recoveryPreview=result.value;showRecovery()}else if(result.value&&'processed'in result.value){const progress=result.value;recoveryPreview=null;recoveryState={...recoveryState!,status:progress.status==='complete'?'ready':'pending',revision:progress.revision,operation:progress.status==='complete'?undefined:{kind:'ledger-repair',source:'',target:''}};showRecovery();recoveryMessage.textContent=progress.status==='complete'?'恢复已完成。账本和合格来源已核验；未通过的来源仍暂停。':`已核验 ${progress.processed} / ${progress.total} 项。可暂停并离开本库，进度保留；如有窗口稿，请先继续恢复，再保存后离库。`}}
  function showRecovery(){
    recovery.hidden=!recoveryState;recoveryRows.replaceChildren();recoveryActions.replaceChildren();if(!recoveryState)return
    const sessionId=recoveryState.sessionId
    if(recoveryPreview){const preview=recoveryPreview;recoveryMessage.textContent=preview.warning
      for(const row of preview.rows){const item=element('li','',`${row.relPath} · ${{associate:'可建立新关联','history-only':'只恢复历史，来源暂停',refused:'拒绝'}[row.outcome]}${row.reasons.length?'：'+row.reasons.join('；'):''}`);for(const source of row.sources)item.append(element('p','vault-settings-hint',`${source.status==='verified'?'来源核验通过':'来源暂停'}：${source.reason}`));recoveryRows.append(item)}
      const confirm=button(preview.mode==='restore'?'确认授权新关联':'确认重建原登记',()=>{void run('正在核验恢复…',()=>repair({sessionId,action:'commit',previewId:preview.id}))});confirm.disabled=!preview.canCommit;confirm.dataset.recoveryRefused=String(!preview.canCommit)
      const cancel=button('取消恢复预览',()=>{void run('取消预览…',async()=>{await repair({sessionId,action:'cancel',previewId:preview.id});if(alive()){recoveryPreview=null;showRecovery()}})})
      recoveryActions.append(cancel,confirm)
    }else if(recoveryState.status!=='ready'){
      recoveryMessage.textContent=recoveryState.status==='invalid'?'恢复记录无法核验，原记录保留。可以退出本页或切换笔记库。':recoveryState.operation?.kind==='ledger-repair'?'整库恢复已暂停，可核验并继续一批，或离开本库。正文可读，编辑和保存暂停；已有窗口稿保留，先继续恢复再保存后离库。任务、结构操作和整理写入暂停。':'文件操作尚未完成，请先核验现有恢复记录。'
      if(recoveryState.status==='pending'&&recoveryState.operation?.kind==='ledger-repair'&&recoveryState.revision){const revision=recoveryState.revision;recoveryActions.append(button('核验并继续一批',()=>{void run('正在续接恢复…',()=>repair({sessionId,action:'resume',revision}))}))}
    }else{recoveryMessage.textContent='登记损坏可先重建原描述；整库复制或恢复后，须预览并明确授权新关联。单篇复制仍是新笔记。'
      for(const [mode,label]of [['rebuild','预览重建登记'],['restore','预览整库恢复']]as const)recoveryActions.append(button(label,()=>{void run('正在核验整库…',()=>repair({sessionId,action:'preview',mode}))}))
    }
  }
  if(handlers.recovery)void handlers.recovery.state().then(state=>{if(alive()){recoveryState=state;showRecovery()}},()=>{if(alive()){recovery.hidden=false;recoveryMessage.textContent='当前库的恢复状态无法读取，请重新打开本页。'}})

  function refreshControls(): void {
    root.setAttribute('aria-busy', String(busy))
    open.disabled = busy; create.disabled = busy
    for(const action of recoveryActions.querySelectorAll<HTMLButtonElement>('button'))action.disabled=busy||action.dataset.recoveryRefused==='true'
    for (const row of rows.values()) {
      for (const action of row.root.querySelectorAll<HTMLButtonElement>('button')) action.disabled = busy
      row.input.disabled = busy
      row.relocate.disabled = busy || row.entry.id === catalog?.activeId
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
  function change(entry: VaultCatalogEntry, action: 'pin' | 'label' | 'remove' | 'relocate', patch: { pinned?: boolean; label?: string } = {}): void {
    if (!catalog || busy) return
    const request = { id: entry.id, revision: catalog.revision, action, ...patch }
    const savedMessage = action === 'remove' && entry.id === catalog.activeId ? '已从本设备列表移除。当前笔记库仍保持打开；笔记、账本和记忆均保留。' : '已保存。'
    void run(action === 'relocate' ? '正在重新定位笔记库…' : '正在保存库列表…', () => handlers.change(request), savedMessage)
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
    menu.append(relocate, remove, relocateHint)
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
    root.append(title, position, path, actions, menu, form, confirmation)
    const row = { entry, root, labelText, open, using, position, path, actions, pin, edit, more, menu, relocate, relocateHint, form, input, save, confirmation }
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
      row.relocateHint.textContent = active ? '正在使用的笔记库需先切换到其他库，再重新定位。' : ''
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
  return {
    dispose: () => { disposed = true; sequence++; if (busy) context.onBusyChange?.(false); busy = false },
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
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if(Object.hasOwn(LEDGER_ERROR_MESSAGES,message))return ledgerErrorText(message)
  if(message.includes('STALE_PREVIEW')||message.includes('STALE_RECOVERY'))return '文件、附件或权限已改变，恢复已停止；已核验进度保留，请核查后重试。'
  if (message.includes('VAULT_SWITCH_CANCELLED')) return ''
  if (message.includes('VAULT_SWITCH_BODY_CONFLICT')) return '窗口稿与磁盘稿发生冲突，两份均已保留。请先关闭设置，处理正文保存冲突后，再重试切换。'
  if (message==='RECOVERY_UNSAVED_DRAFT') return '窗口稿已保留。请先关闭设置处理保存问题，再重新预览；如恢复尚未完成，请先继续恢复，完成后保存草稿。'
  if (message.includes('UNSAVED_DRAFT')) return '笔记草稿尚未保存，已留在当前库。请先处理保存问题，再重试切换。'
  if (message.includes('PREVIOUS_TASK_UNSAVED')) return '生成回答尚未保存，已留在原库。请先处理保存问题，再重试切换。'
  if (message.includes('VAULT_TARGET_INVALID')) return '无法打开所选位置。请检查目录是否存在及访问权限后重试。'
  if (message.includes('VAULT_CATALOG_CONFLICT')) return '库列表已在别处更新。请离开本页后重新进入，再核对修改。'
  if (message.includes('VAULT_TARGET_CHANGED') || message.includes('VAULT_RELOCATE_REQUIRED') || message.includes('VAULT_REPLACED')) return '库的位置或身份发生变化，请重新定位后再打开。'
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
