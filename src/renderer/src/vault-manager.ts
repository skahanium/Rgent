import type { VaultCatalogEntry, VaultCatalogView } from '../../shared/vault-management'
import { icon, type IconName } from './icons'
import { openOverlay, type Overlay } from './overlay'

type Catalog = VaultCatalogView & { activeId?: string | null }
export type VaultManagerHandlers = {
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

/** 设备库目录的展示入口；文件核验与切换事务仍由调用方执行。 */
export function openVaultManager(handlers: VaultManagerHandlers, returnFocus?: () => HTMLElement | null): Overlay {
  const overlay = openOverlay({ label: '笔记库', returnFocus })
  const root = overlay.root
  root.classList.add('vault-manager')
  let catalog: Catalog | null = null
  let busy = false
  let sequence = 0
  let managing = false
  const rows = new Map<string, ReturnType<typeof createRow>>()
  const actions: HTMLButtonElement[] = []
  const heading = element('header', 'vault-manager-heading')
  heading.append(element('h2', '', '笔记库'))
  const close = button('关闭', () => overlay.close(), 'close')
  close.classList.add('vault-manager-close')
  close.setAttribute('aria-label', '关闭笔记库浮层')
  heading.append(close)
  const layout = element('div', 'vault-manager-layout')
  const shortcuts = element('nav', 'vault-manager-shortcuts')
  shortcuts.setAttribute('aria-label', '笔记库操作')
  const open = button('打开现有库', () => { void run('正在打开笔记库…', () => handlers.pick(false), true) }, 'folder')
  const create = button('创建空库', () => { void run('正在创建空库…', () => handlers.pick(true), true) }, 'folder-plus')
  const manage = button('管理笔记库', () => {
    if (busy) return
    managing = !managing
    manage.setAttribute('aria-expanded', String(managing))
    for (const row of rows.values()) row.management.hidden = !managing
  }, 'settings')
  manage.setAttribute('aria-expanded', 'false')
  manage.dataset.vaultAction = 'manage'
  open.dataset.vaultAction = 'open'
  create.dataset.vaultAction = 'create'
  shortcuts.append(open, create, manage, element('p', 'vault-manager-hint', '每次只打开一个笔记库。'))
  actions.push(open, create, manage)
  const content = element('main', 'vault-manager-content')
  const diagnostic = element('p', 'vault-manager-diagnostic')
  diagnostic.hidden = true
  diagnostic.setAttribute('role', 'alert')
  const empty = element('p', 'vault-manager-empty', '正在读取库列表…')
  const fixed = group('已固定')
  const recent = group('最近使用')
  const registered = group('其他已登记库')
  content.append(diagnostic, empty, fixed.section, recent.section, registered.section)
  layout.append(shortcuts, content)
  const status = element('p', 'vault-manager-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  root.append(heading, layout, status)

  function refreshControls(): void {
    root.setAttribute('aria-busy', String(busy))
    for (const action of actions) action.disabled = busy
    for (const row of rows.values()) {
      row.open.disabled = busy
      for (const action of row.management.querySelectorAll<HTMLButtonElement>('button')) action.disabled = busy
      row.save.disabled = busy || row.input.value.trim() === row.entry.label || !row.input.value.trim()
    }
  }

  async function run(message: string, operation: () => Promise<void | Catalog>, closes = false): Promise<void> {
    if (busy || !overlay.isOpen()) return
    busy = true
    const ticket = ++sequence
    status.textContent = message
    refreshControls()
    try {
      const result = await operation()
      if (!overlay.isOpen() || ticket !== sequence) return
      if (closes) { overlay.close(); return }
      if (result) { busy = false; showCatalog(result) }
      status.textContent = '已保存。'
    } catch (error) {
      if (!overlay.isOpen() || ticket !== sequence) return
      status.textContent = errorText(error)
    } finally {
      if (overlay.isOpen() && ticket === sequence) { busy = false; refreshControls() }
    }
  }

  function change(entry: VaultCatalogEntry, action: 'pin' | 'label' | 'remove' | 'relocate', patch: { pinned?: boolean; label?: string } = {}): void {
    if (!catalog || busy) return
    const request = { id: entry.id, revision: catalog.revision, action, ...patch }
    void run(action === 'relocate' ? '正在重新定位笔记库…' : '正在保存库列表…', () => handlers.change(request))
  }

  function createRow(entry: VaultCatalogEntry) {
    const root = element('article', 'vault-manager-row')
    root.dataset.vaultId = entry.id
    const title = element('div', 'vault-manager-row-title')
    const open = button(entry.label, () => { void run('正在切换笔记库…', () => handlers.open(entry.id), true) }, 'folder')
    open.classList.add('vault-manager-open')
    open.dataset.vaultOpen = entry.id
    const current = element('span', 'vault-manager-current', '当前库')
    title.append(open, current)
    const path = element('details', 'vault-manager-path')
    path.append(element('summary', '', '查看位置'), element('p', '', entry.path))
    const management = element('div', 'vault-manager-management')
    management.hidden = !managing
    const form = element('form', 'vault-manager-name')
    form.noValidate = true
    const label = element('label', '', '显示名称')
    const input = document.createElement('input')
    input.type = 'text'
    input.value = entry.label
    input.maxLength = 80
    label.append(input)
    const save = button('保存名称', () => {})
    save.type = 'submit'
    save.dataset.vaultAction = 'label'
    form.append(label, save)
    const rowActions = element('div', 'vault-manager-row-actions')
    const pin = button(entry.pinned ? '取消固定' : '固定', () => change(row.entry, 'pin', { pinned: !row.entry.pinned }))
    const relocate = button('重新定位', () => change(row.entry, 'relocate'))
    const remove = button('移除目录项', () => {
      if (busy) return
      confirmation.hidden = false
      confirm.focus()
    })
    pin.dataset.vaultAction = 'pin'
    relocate.dataset.vaultAction = 'relocate'
    remove.dataset.vaultAction = 'remove'
    rowActions.append(pin, relocate, remove)
    const confirmation = element('div', 'vault-manager-confirmation')
    confirmation.hidden = true
    confirmation.append(element('p', '', '只从本设备的库列表移除此项；库文件、记忆和账本都保留，不会删除。'))
    const confirm = button('确认移除目录项', () => change(row.entry, 'remove'))
    confirm.dataset.vaultAction = 'confirm-remove'
    const cancel = button('取消移除', () => {
      if (busy) return
      confirmation.hidden = true
      remove.focus()
    })
    confirmation.append(confirm, cancel)
    management.append(form, rowActions, confirmation)
    root.append(title, path, management)
    const row = { entry, root, open, current, path, input, save, pin, management, confirmation }
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (busy || save.disabled) return
      change(row.entry, 'label', { label: input.value.trim() })
    })
    input.addEventListener('input', refreshControls)
    return row
  }

  function showCatalog(next: Catalog): void {
    // Keep existing row and input nodes: completing a save must not replace a newer draft.
    next = { ...next, activeId: next.activeId === undefined ? catalog?.activeId : next.activeId }
    catalog = next
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const ids = new Set(next.entries.map(entry => entry.id))
    for (const [id, row] of rows) if (!ids.has(id)) { row.root.remove(); rows.delete(id) }
    const ordered = [...next.entries].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastUsed ?? -1) - (a.lastUsed ?? -1))
    const groups = [fixed, recent, registered]
    const lists: HTMLElement[][] = [[], [], []]
    for (const entry of ordered) {
      let row = rows.get(entry.id)
      if (!row) { row = createRow(entry); rows.set(entry.id, row) }
      row.entry = entry
      row.open.lastChild!.textContent = entry.label
      row.current.hidden = next.activeId !== entry.id
      row.current.textContent = next.activeId === entry.id ? '当前库' : ''
      row.pin.textContent = entry.pinned ? '取消固定' : '固定'
      row.path.querySelector('p')!.textContent = entry.path
      lists[entry.pinned ? 0 : entry.lastUsed !== null ? 1 : 2].push(row.root)
    }
    groups.forEach((group, index) => {
      const list = lists[index]
      group.section.hidden = list.length === 0
      // Only move rows whose order changed. Unchanged focused inputs stay attached.
      list.forEach((row, position) => { if (group.list.children[position] !== row) group.list.insertBefore(row, group.list.children[position] ?? null) })
    })
    diagnostic.hidden = !next.diagnostic
    diagnostic.textContent = next.diagnostic ? '库列表无法读取，原记录已保留。可以手动打开现有库；请先核查本设备的库列表。' : ''
    empty.hidden = next.entries.length > 0 || !!next.diagnostic
    empty.textContent = next.diagnostic ? '' : '还没有登记笔记库。打开现有库，或创建一个空库。'
    refreshControls()
    if (focused?.isConnected && document.activeElement !== focused) focused.focus()
    else if (focused && !focused.isConnected) manage.focus()
  }

  // Picker cancellation/failure does not replace the catalog. Accept the initial read
  // until a catalog has been applied, while still ignoring closed or superseded views.
  void Promise.resolve().then(() => handlers.get()).then(next => {
    if (overlay.isOpen() && catalog === null) showCatalog(next)
  }, error => {
    if (!overlay.isOpen() || catalog !== null) return
    empty.hidden = true
    diagnostic.hidden = false
    diagnostic.textContent = `库列表无法读取。${errorText(error)} 可以手动打开现有库。`
  })
  return overlay
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
function group(label: string) {
  const section = element('section', 'vault-manager-group')
  const list = element('div', 'vault-manager-list')
  section.hidden = true
  section.append(element('h3', '', label), list)
  return { section, list }
}
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('VAULT_SWITCH_CANCELLED')) return ''
  if (message.includes('UNSAVED_DRAFT')) return '笔记草稿尚未保存，已留在当前库。请先处理保存问题，再重试切换。'
  if (message.includes('PREVIOUS_TASK_UNSAVED')) return '生成回答尚未保存，已留在原库。请先处理保存问题，再重试切换。'
  if (message.includes('VAULT_TARGET_INVALID')) return '无法打开所选位置。请检查目录是否存在及访问权限后重试。'
  if (message.includes('VAULT_CATALOG_CONFLICT')) return '库列表已在别处更新。请关闭后重新打开管理，再核对修改。'
  if (message.includes('VAULT_TARGET_CHANGED') || message.includes('VAULT_RELOCATE_REQUIRED') || message.includes('VAULT_REPLACED')) return '库的位置或身份发生变化，请重新定位后再打开。'
  if (message.includes('VAULT_CATALOG_INVALID')) return '本设备的库列表损坏，原记录已保留，请先核查。'
  if (message.includes('VAULT_CATALOG_PATCH_INVALID')) return '显示名称无法保存，请填写有效名称后再试。'
  if (message.includes('ACTIVE_VAULT_RELOCATE')) return '当前库正在使用，请先切换到其他库后再重新定位。'
  if (message.includes('VAULT_NESTED')) return '登记的笔记库不能互相包含，请选择独立的目录。'
  if (message.includes('VAULT_ALREADY_REGISTERED')) return '这个笔记库已经登记，请从库列表中打开。'
  if (message.includes('VAULT_NOT_REGISTERED')) return '库列表已变化，请关闭后重新打开管理再核对。'
  if (message.includes('VAULT_CATALOG_LIMIT')) return '库列表已达到容量上限，请先移除不再需要的目录项。'
  if (message.includes('VAULT_SWITCH_BUSY')) return '正在切换笔记库，请稍后再试。'
  return '操作未完成。请检查笔记库位置与访问权限后再试。'
}
