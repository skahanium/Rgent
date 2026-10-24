import type { PermissionTier, TrashEntryView, TrashListResult, TrashPurgeResult, TrashRestorePermission, TrashRestoreResult } from '../../shared/ipc.ts'

/**
 * 设置「笔记库 → 已删除」次级页。
 *
 * 只经注入的 handlers 走 IPC：列表、还原、移入系统废纸篓各一条。这里不读文件、
 * 不判断权限；记录是否损坏、还剩几天都由主进程给的字段为准。
 * 围栏 docs/decisions.md §2026-10-23 三档工作范围与库内已删除 第 5 条。
 */
export type TrashManagerHandlers = {
  list: () => Promise<TrashListResult>
  restore: (id: string) => Promise<TrashRestoreResult>
  purge: (id: string) => Promise<TrashPurgeResult>
}

export type TrashManagerContext = {
  body: HTMLElement
  isCurrent: () => boolean
  onBack: () => void
  /** 列表读取成功后回报条数；「笔记库」页用它刷新「已删除（N）」入口。 */
  onChanged?: (count: number) => void
  /** 还原／删除进行中沿用设置页的忙锁。 */
  onBusyChange?: (busy: boolean) => void
  /** 剩余天数按此刻计算；默认取当前时间。 */
  now?: () => number
}

export type TrashManagerPage = { dispose: () => void; isBusy: () => boolean }

const DAY_MS = 24 * 60 * 60 * 1000

/** 主进程错误码翻成人话；原文（含代码）只留在日志里，不铺到页面上。 */
export function trashErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (text.includes('NO_VAULT')) return '还没有打开笔记库。先返回打开一个笔记库，再查看已删除。'
  if (text.includes('TRASH_ENTRY_MISSING') || text.includes('TRASH_NOT_FOUND')) return '这条记录已不在已删除里。回到列表时会重新读取。'
  if (text.includes('TRASH_DAMAGED')) return '这条记录已损坏，无法还原；可以移入系统废纸篓，文件不会留在库里。'
  if (text.includes('TRASH_CONFLICT')) return '原路径和恢复副本名都被占用，没有移动任何文件；请先处理占用。'
  if (text.includes('TRASH_PARENT_INVALID')) return '原路径的上级位置不是文件夹，无法还原；没有移动任何文件。'
  if (text.includes('TRASH_PARTIAL')) return '操作只完成了一部分，文件可能已经移动。请回到列表核对后再试。'
  if (text.includes('TRASH_KEPT')) return '没有还原：记录目录暂时清理不掉，文件仍在已删除里，可以重试。'
  if (text.includes('TRASH_RECORD_LIMIT')) return '已删除记录已满（256 条），这次没有删除。请先在这里还原或移入系统废纸篓一些条目。'
  if (text.includes('TRASH_UNSAFE')) return '这条记录的位置不安全，没有移入系统废纸篓。'
  if (text.includes('PATH_RESERVED')) return '原路径已被保留占用，无法还原到原位。'
  if (text.includes('PATH_CHANGED')) return '原路径或对象已变化，没有改动任何文件；请核对后再试。'
  if (text.includes('PLATFORM_UNPROVEN')) return '这个平台还没有证明系统废纸篓可用，记录仍留在库内。'
  if (text.includes('VAULT_SWITCH_BUSY')) return '正在切换笔记库，请稍后再试。'
  if (text.includes('BAD_REQUEST')) return '这次请求无效，没有执行任何操作。'
  if (text.includes('IO_ERROR')) return '读写笔记库失败，请检查访问权限后再试。'
  if (text.includes('TRASH_RESTORE_FAILED')) return '没有还原，记录仍在已删除里。'
  if (text.includes('TRASH_PURGE_FAILED')) return '没有移入系统废纸篓，记录仍在已删除里。'
  return '操作未完成，请稍后重试；仍然失败时请检查笔记库。'
}

const TIER_LABELS: Record<PermissionTier, string> = { reference: '参考', follow: '跟随', forbidden: '禁止' }

/** 还原后的权限档如实说明：原档写回、保留删除后新设的档，或写回失败但文件未受影响。 */
export function trashPermissionText(permission: TrashRestorePermission | undefined): string {
  if (!permission) return ''
  const original = TIER_LABELS[permission.original]
  const current = TIER_LABELS[permission.current]
  if (permission.outcome === 'restored') return `；已把删除时的权限档「${original}」写回${permission.rulePath ? `文件夹 ${permission.rulePath}` : '原位置'}。`
  if (permission.outcome === 'kept-new') {
    return `；目标位置在删除后已有显式权限档「${current}」，保留没有覆盖（删除时是「${original}」）。`
  }
  return `；文件已还原，但删除时的权限档「${original}」没有写回（当前「${current}」），文件未受影响。`
}

/** 体积按二进制单位显示，0 与非法值一律 0 B。 */
export function formatTrashBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.floor(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/u, '')
  return `${text} ${units[unit]}`
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** 本地时区的可读时间；不依赖 ICU 的 locale 数据。 */
export function formatTrashTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 到期日按剩余整天向上取整；已过期或时间无法解析时显示 0 天。 */
export function trashRemainingDays(expiresAt: string, now: number): number {
  const expires = Date.parse(expiresAt)
  if (!Number.isFinite(expires)) return 0
  return Math.max(0, Math.ceil((expires - now) / DAY_MS))
}

export function mountTrashManager(context: TrashManagerContext, handlers: TrashManagerHandlers): TrashManagerPage {
  const root = context.body
  root.classList.add('trash-view')
  const now = context.now ?? Date.now
  let disposed = false
  let busy = false
  let listSequence = 0
  let entries: TrashEntryView[] | null = null
  const alive = (): boolean => !disposed && context.isCurrent()

  const back = button('← 笔记库', () => { if (!busy) context.onBack() })
  back.classList.add('settings-back')
  back.setAttribute('aria-label', '返回笔记库')
  back.dataset.trashAction = 'back'
  const title = element('h3', 'settings-section-title', '已删除')
  const intro = element('p', 'trash-intro', '删除的笔记和附件会留在这里 30 天；过期或你明确删除后移入系统废纸篓。')
  const capacity = element('p', 'trash-capacity')
  const status = element('p', 'trash-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const error = element('p', 'trash-error')
  error.hidden = true
  error.setAttribute('role', 'alert')
  const loading = element('p', 'trash-loading', '正在读取已删除…')
  const empty = element('p', 'trash-empty', '没有已删除的笔记。')
  empty.hidden = true
  const list = element('ul', 'trash-list')
  list.hidden = true
  root.append(back, title, intro, capacity, status, error, loading, empty, list)

  function refreshControls(): void {
    root.setAttribute('aria-busy', String(busy))
    back.disabled = busy
    for (const action of list.querySelectorAll<HTMLButtonElement>('button')) {
      action.disabled = busy || action.dataset.trashBlocked === 'true'
    }
  }

  function showError(value: unknown): void {
    error.textContent = trashErrorText(value)
    error.hidden = false
  }

  function clearError(): void {
    error.textContent = ''
    error.hidden = true
  }

  function paint(next: TrashEntryView[], bytes = next.reduce((sum, item) => sum + item.bytes, 0)): void {
    entries = next
    list.replaceChildren()
    // 新的在前；时间无法解析的按最旧处理，不因此打乱其余顺序。
    const ordered = [...next].sort((left, right) =>
      (Date.parse(right.deletedAt) || 0) - (Date.parse(left.deletedAt) || 0))
    for (const entry of ordered) list.append(createRow(entry))
    list.hidden = ordered.length === 0
    empty.hidden = ordered.length > 0
    // 容量按主进程给的累计字节；损坏／半截条目也占磁盘，必须一起显示，不能看起来是空的。
    capacity.textContent = `已用 ${formatTrashBytes(bytes)}（损坏和半截条目也计入）。`
    refreshControls()
  }

  function createRow(entry: TrashEntryView): HTMLElement {
    const damaged = entry.state === 'damaged'
    const row = element('li', 'trash-row')
    row.dataset.trashId = entry.id
    row.dataset.trashKind = entry.kind
    row.dataset.trashState = entry.state
    const head = element('div', 'trash-row-head')
    const name = element('strong', 'trash-name', entry.name)
    const state = element('span', 'trash-state', damaged ? '损坏' : '正常')
    head.append(name, state)
    const meta = element('dl', 'trash-meta')
    const field = (label: string, value: string, wide = false): void => {
      const group = element('div', wide ? 'trash-field trash-field-wide' : 'trash-field')
      group.append(element('dt', '', label), element('dd', '', value))
      meta.append(group)
    }
    field('原路径', entry.originalRelPath || '未知', true)
    field('类型', entry.kind === 'attachment' ? '附件夹' : '笔记')
    field('删除时间', formatTrashTime(entry.deletedAt))
    field('剩余', `${trashRemainingDays(entry.expiresAt, now())} 天`)
    field('体积', formatTrashBytes(entry.bytes))
    field('来源', entry.source === 'ai' ? 'AI' : '人')
    row.append(head, meta)
    if (damaged) {
      row.append(element('p', 'trash-damaged-hint', '记录已损坏，无法还原；可以移入系统废纸篓，文件不会留在库里。'))
    }
    const actions = element('div', 'trash-actions')
    for (const action of ['restore', 'purge'] as const) {
      const label = action === 'restore' ? '还原' : '删除'
      const node = button(label, () => { void operate(entry, action) })
      node.dataset.trashAction = action
      if (action === 'purge') node.classList.add('trash-danger')
      // 损坏条目不能还原，但必须留「移入系统废纸篓」的出口，不能无路可走。
      if (damaged && action === 'restore') { node.disabled = true; node.dataset.trashBlocked = 'true' }
      actions.append(node)
    }
    row.append(actions)
    return row
  }

  async function load(initial: boolean): Promise<void> {
    const ticket = ++listSequence
    if (initial || entries === null) {
      loading.hidden = false
      list.hidden = true
      empty.hidden = true
    }
    try {
      const result = await handlers.list()
      if (!alive() || ticket !== listSequence) return
      loading.hidden = true
      if (!result.ok) {
        showError(result.error)
        if (entries === null) { list.hidden = true; empty.hidden = true }
        return
      }
      clearError()
      paint(result.entries, result.bytes)
      context.onChanged?.(result.entries.length)
    } catch (cause) {
      if (!alive() || ticket !== listSequence) return
      loading.hidden = true
      showError(cause)
      if (entries === null) { list.hidden = true; empty.hidden = true }
    }
  }

  async function operate(entry: TrashEntryView, action: 'restore' | 'purge'): Promise<void> {
    if (busy || disposed || !alive() || (action === 'restore' && entry.state === 'damaged')) return
    busy = true
    context.onBusyChange?.(true)
    clearError()
    status.textContent = action === 'restore' ? '正在还原…' : '正在移入系统废纸篓…'
    refreshControls()
    try {
      if (action === 'restore') {
        const result = await handlers.restore(entry.id)
        if (!alive()) return
        if (!result.ok) { showError(result.error); return }
        const restored = result.copied ? `已还原为副本：${result.relPath}` : `已还原到：${result.relPath}`
        status.textContent = `${restored}${trashPermissionText(result.permission)}`
      } else {
        const result = await handlers.purge(entry.id)
        if (!alive()) return
        if (!result.ok) { showError(result.error); return }
        status.textContent = '已移入系统废纸篓。'
      }
      // 成功就先把这一行从本地删掉：主进程已经动了文件，旧列表不能再声称它还在已删除里。
      // 下面仍重新读一次列表，以主进程的结果为准（可能有并发变化）。
      if (entries) {
        const next = entries.filter(item => item.id !== entry.id)
        paint(next)
        context.onChanged?.(next.length)
      }
      await load(false)
    } catch (cause) {
      if (alive()) showError(cause)
    } finally {
      if (!disposed) {
        busy = false
        context.onBusyChange?.(false)
        refreshControls()
        // 行被移除或按钮从禁用恢复后，焦点会掉到 body；放回返回入口，键盘还能继续用。
        if (!root.contains(document.activeElement)) back.focus()
      }
    }
  }

  void load(true)

  return {
    dispose: () => { disposed = true; listSequence++ },
    isBusy: () => busy
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(text: string, click: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.textContent = text
  node.addEventListener('click', click)
  return node
}
