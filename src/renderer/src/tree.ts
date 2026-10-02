import type { PermissionTier, TreeEntry } from '@shared'
import { icon, iconForFile } from './icons.ts'
import { noteTitle } from '../../shared/vault-rel.ts'

export { collectNotePaths, collectRelPaths } from '../../shared/vault-rel.ts'
export type TreeAction = 'new-note' | 'new-folder' | 'rename' | 'move'

type BrowserPreference = {
  version: 1; selected: string; resource: string; expanded: string[]; ratio: number; attachments: boolean; width?: number
}
type BrowserOptions = {
  onOpenNote: (path: string) => void
  onSetTier?: (path: string, tier: PermissionTier) => void
  onAction?: (entry: TreeEntry, action: TreeAction) => void
}
export type FileBrowser = {
  readonly selectedFolder: string
  readonly canCreate: boolean
  readonly preferredWidth: number | null
  setPreferredWidth(width: number | null): void
  captureScroll(): void
  setVault(key: string | null): void
  update(entries: TreeEntry[], active: string | null): void
  setActive(path: string | null): void
  fail(message: string): void
  relocate(moved: { from: string; to: string }[]): void
}
const defaults = (): BrowserPreference => ({ version: 1, selected: '', resource: '', expanded: [''], ratio: 0.4, attachments: false })
const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/')
const within = (path: string, root: string): boolean => path === root || path.startsWith(root + '/')
const validRelative = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 &&
  (value === '' || value.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.includes('\\') && !part.includes('\0') && !part.includes(':')))
const validWidth = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 192 && value <= 360

function readPreference(key: string): BrowserPreference {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!value || value.version !== 1 || !validRelative(value.selected) || !validRelative(value.resource) ||
      !Array.isArray(value.expanded) || value.expanded.length > 2000 || !value.expanded.every(validRelative) ||
      typeof value.attachments !== 'boolean' || !Number.isFinite(value.ratio) || value.ratio < 0.15 || value.ratio > 0.8) return defaults()
    return { version: 1, selected: value.selected, resource: value.resource, expanded: [...new Set<string>(value.expanded)], ratio: value.ratio, attachments: value.attachments,
      ...(validWidth(value.width) ? { width: value.width } : {}) }
  } catch { return defaults() }
}

/** Navigation is display state only. All disk operations still use the existing main-process gates. */
export function createFileBrowser(host: HTMLElement, options: BrowserOptions): FileBrowser {
  host.classList.add('file-browser')
  host.innerHTML = `
    <div class="browser-notice" role="status" hidden></div>
    <section class="folder-pane" aria-label="文件夹导航">
      <div class="browser-tools"><span>文件夹</span><button type="button" class="folder-create" aria-label="新建文件夹"></button></div>
      <div class="folder-scroll"></div>
    </section>
    <div class="browser-divider" role="separator" tabindex="0" aria-label="调整目录与资源区高度" aria-orientation="horizontal" aria-valuemin="15" aria-valuemax="80"></div>
    <section class="resource-pane" aria-label="当前目录资源">
      <div class="browser-tools resource-tools">
        <button type="button" class="resource-back" hidden>返回</button>
        <div class="resource-path"></div>
        <button type="button" class="attachment-toggle" aria-label="显示附件" title="显示附件" aria-pressed="false"></button>
        <button type="button" class="resource-create" aria-label="新建笔记"></button>
      </div>
      <div class="resource-scroll"></div>
    </section>`
  const get = <T extends HTMLElement>(selector: string): T => host.querySelector(selector) as T
  const folders = get<HTMLElement>('.folder-scroll'), resources = get<HTMLElement>('.resource-scroll')
  const folderPane = get<HTMLElement>('.folder-pane')
  const divider = get<HTMLElement>('.browser-divider'), notice = get<HTMLElement>('.browser-notice')
  const back = get<HTMLButtonElement>('.resource-back'), create = get<HTMLButtonElement>('.resource-create')
  create.append(icon('plus'))
  get<HTMLButtonElement>('.folder-create').append(icon('folder-plus'))
  const attachmentToggle = get<HTMLButtonElement>('.attachment-toggle')
  attachmentToggle.append(icon('eye'))
  let state = defaults(), storageKey: string | null = null, active: string | null = null
  let index = new Map<string, TreeEntry>(), attachmentOwners = new Map<string, string>()
  let ordinary = new Set<string>(['']), roots: TreeEntry[] = [], listingReady = false
  let displayedResource = '', folderScroll = 0
  let resourceScroll = new Map<string, number>()
  const sessions = new Map<string, { folder: number; resources: Map<string, number> }>()
  const save = (): void => {
    if (!storageKey) return
    try { localStorage.setItem(storageKey, JSON.stringify(state)) } catch { /* Preferences never block note operations. */ }
  }
  const rememberScroll = (): void => {
    if (!listingReady || getComputedStyle(host).display === 'none') return
    folderScroll = folders.scrollTop
    resourceScroll.set(displayedResource, resources.scrollTop)
  }
  const inform = (message: string): void => { notice.textContent = message; notice.hidden = !message }
  const entryFor = (path: string): TreeEntry => path === '' ? { kind: 'dir', name: '笔记库', relPath: '', children: roots } : index.get(path)!
  const contentOf = (path: string): TreeEntry[] => entryFor(path)?.children ?? []
  const ancestorAttachment = (path: string): string | undefined => [...attachmentOwners.keys()].find(root => within(path, root))
  const verticalPadding = (): number => { const style = getComputedStyle(host); return (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0) }
  const availableHeight = (): number => host.clientHeight - verticalPadding() - divider.offsetHeight - (notice.hidden ? 0 : notice.offsetHeight)
  const actualRatio = (): number => availableHeight() > 0 ? folderPane.offsetHeight / availableHeight() : state.ratio
  const layout = (): void => {
    const available = availableHeight()
    const min = available > 0 ? Math.max(0.15, 96 / available) : 0.15
    const max = available > 0 ? Math.min(0.8, 1 - 160 / available) : 0.8
    const ratio = Math.max(min, Math.min(max, state.ratio))
    if (available > 0) folderPane.style.height = `${Math.round(available * ratio)}px`
    host.style.setProperty('--browser-folder-share', `${ratio * 100}%`)
    divider.setAttribute('aria-valuemin', String(Math.round(min * 100)))
    divider.setAttribute('aria-valuemax', String(Math.round(max * 100)))
    divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }
  let paneVisible = false
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
    const visible = host.clientHeight > 0
    layout()
    if (visible && !paneVisible) { folders.scrollTop = folderScroll; resources.scrollTop = resourceScroll.get(state.resource) ?? 0 }
    paneVisible = visible
  }).observe(host)
  const setRatio = (ratio: number): void => { state.ratio = Math.max(0.15, Math.min(0.8, ratio)); layout(); save() }
  const switchFolder = (path: string): void => {
    rememberScroll(); state.selected = path; state.resource = path; inform(''); redraw(); save()
  }
  const browse = (path: string): void => { rememberScroll(); state.resource = path; redraw(); save() }
  const actionable = (row: HTMLElement, entry: TreeEntry, allowStructure = true): void => {
    if (!(allowStructure && options.onAction) && !(entry.kind === 'dir' && options.onSetTier)) return
    row.addEventListener('contextmenu', event => {
      if (!listingReady) return
      event.preventDefault(); event.stopPropagation()
      showTreeMenu(event.clientX, event.clientY, entry, options.onSetTier, allowStructure ? options.onAction : undefined)
    })
  }
  function folderNode(entry: TreeEntry): HTMLElement {
    const item = document.createElement('li')
    const row = document.createElement('div'); row.className = 'tree-row tree-dir'; row.dataset.path = entry.relPath
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'tree-folder-toggle'; toggle.dataset.path = entry.relPath
    const expanded = state.expanded.includes(entry.relPath)
    toggle.setAttribute('aria-expanded', String(expanded)); toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'}${entry.name}`)
    toggle.append(icon('folder', 'icon-folder'), icon('folder-open', 'icon-folder-open'))
    toggle.addEventListener('click', () => {
      rememberScroll()
      state.expanded = expanded ? state.expanded.filter(path => path !== entry.relPath) : [...state.expanded, entry.relPath]
      redraw(); save()
    })
    const select = document.createElement('button'); select.type = 'button'; select.className = 'tree-select tree-label'; select.dataset.path = entry.relPath
    select.textContent = entry.name; select.title = entry.relPath || '笔记库根目录'
    if (state.selected === entry.relPath) select.setAttribute('aria-current', 'location')
    select.addEventListener('click', () => { if (listingReady) switchFolder(entry.relPath) })
    row.append(toggle, select); addBadge(row, entry.tier)
    actionable(row, entry)
    const children = document.createElement('ul'); children.className = 'tree-list'; children.hidden = !expanded
    for (const child of entry.children ?? []) if (child.kind === 'dir' && ordinary.has(child.relPath)) children.append(folderNode(child))
    item.append(row, children)
    return item
  }
  function resourceNode(entry: TreeEntry): HTMLElement {
    const item = document.createElement('li')
    const interactive = entry.kind !== 'file'
    const row = interactive ? document.createElement('button') : document.createElement('span')
    if (row instanceof HTMLButtonElement) row.type = 'button'
    row.dataset.path = entry.relPath
    row.className = `tree-row ${entry.kind === 'note' ? 'tree-note' : entry.kind === 'dir' ? 'resource-folder' : 'tree-file'}`
    row.append(icon(entry.kind === 'dir' ? 'folder' : iconForFile(entry.name), 'icon-type'))
    const label = document.createElement('span'); label.className = 'tree-label'; label.textContent = entry.kind === 'note' ? titleOf(entry.name) : entry.name
    row.append(label); row.title = entry.relPath; addBadge(row, entry.tier)
    if (entry.kind === 'dir') {
      const owner = attachmentOwners.get(entry.relPath)
      if (owner) {
        row.classList.add('attachment-folder')
        const note = document.createElement('span'); note.className = 'attachment-label'; note.textContent = `附件 · ${noteTitle(owner)}`
        label.append(note)
      }
      row.addEventListener('click', () => { if (listingReady) browse(entry.relPath) })
      // Attachment folders are browsable, but cannot be detached from their owning note by structure actions.
      if (options.onSetTier) actionable(row, entry, false)
    } else if (entry.kind === 'note') {
      if (entry.relPath === active) row.setAttribute('aria-current', 'page')
      row.addEventListener('click', () => options.onOpenNote(entry.relPath))
      actionable(row, entry)
    }
    item.append(row); return item
  }
  function redraw(): void {
    const focused = host.contains(document.activeElement) ? document.activeElement as HTMLElement : null
    const focusPath = focused?.dataset.path, focusClass = focused?.className
    const list = document.createElement('ul'); list.className = 'tree-list'
    list.append(folderNode(entryFor(''))); folders.replaceChildren(list)
    const inAttachment = state.resource !== state.selected
    const files = document.createElement('ul'); files.className = 'resource-list'
    for (const entry of contentOf(state.resource)) {
      if (entry.kind === 'dir' && !inAttachment && (!state.attachments || !attachmentOwners.has(entry.relPath))) continue
      files.append(resourceNode(entry))
    }
    if (!files.childElementCount) {
      const empty = document.createElement('li'); empty.className = 'browser-empty'; empty.textContent = '此目录暂无资源'; files.append(empty)
    }
    resources.replaceChildren(files)
    const title = get<HTMLElement>('.resource-path'); title.textContent = state.resource || '笔记库'; title.title = state.resource || '笔记库根目录'
    back.hidden = !inAttachment
    create.hidden = inAttachment
    create.disabled = !listingReady
    get<HTMLButtonElement>('.folder-create').disabled = !listingReady
    create.title = `在 ${state.selected || '笔记库根目录'} 新建笔记`
    create.setAttribute('aria-label', create.title)
    const folderCreate = get<HTMLButtonElement>('.folder-create')
    folderCreate.title = `在 ${state.selected || '笔记库根目录'} 新建文件夹`
    folderCreate.setAttribute('aria-label', folderCreate.title)
    attachmentToggle.setAttribute('aria-pressed', String(state.attachments))
    attachmentToggle.title = state.attachments ? '隐藏附件' : '显示附件'
    attachmentToggle.setAttribute('aria-label', attachmentToggle.title)
    displayedResource = state.resource; folders.scrollTop = folderScroll; resources.scrollTop = resourceScroll.get(state.resource) ?? 0
    layout()
    if (focusPath !== undefined) [...host.querySelectorAll<HTMLElement>('[data-path]')].find(el => el.dataset.path === focusPath && el.className === focusClass)?.focus({ preventScroll: true })
  }
  function validateState(): void {
    const previous = state.selected, previousResource = state.resource
    while (!ordinary.has(state.selected)) state.selected = parentOf(state.selected)
    state.expanded = state.expanded.filter(path => ordinary.has(path))
    const owner = ancestorAttachment(state.resource)
    if (state.resource !== state.selected && (!state.attachments || !owner || parentOf(owner) !== state.selected || index.get(state.resource)?.kind !== 'dir')) state.resource = state.selected
    if (state.selected !== previous || state.resource !== previousResource) inform('目录已变化，已返回可用目录。')
  }
  get<HTMLButtonElement>('.folder-create').addEventListener('click', () => { if (listingReady) options.onAction?.(entryFor(state.selected), 'new-folder') })
  create.addEventListener('click', () => { if (listingReady && state.resource === state.selected) options.onAction?.(entryFor(state.selected), 'new-note') })
  attachmentToggle.addEventListener('click', () => {
    rememberScroll(); state.attachments = !state.attachments
    if (!state.attachments) state.resource = state.selected
    redraw(); save()
  })
  back.addEventListener('click', () => browse(parentOf(state.resource)))
  divider.addEventListener('keydown', event => {
    const delta = event.key === 'ArrowDown' ? 0.05 : event.key === 'ArrowUp' ? -0.05 : 0
    if (delta || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); setRatio(event.key === 'Home' ? 0.15 : event.key === 'End' ? 0.8 : actualRatio() + delta)
    }
  })
  let dragging: number | null = null
  divider.addEventListener('pointerdown', event => { if (event.button !== 0) return; dragging = event.pointerId; divider.setPointerCapture(event.pointerId); event.preventDefault() })
  divider.addEventListener('pointermove', event => {
    if (dragging !== event.pointerId) return
    const rect = host.getBoundingClientRect(), available = availableHeight()
    const top = rect.top + (parseFloat(getComputedStyle(host).paddingTop) || 0) + (notice.hidden ? 0 : notice.offsetHeight)
    if (available > 0) setRatio((event.clientY - top) / available)
  })
  divider.addEventListener('pointerup', event => { if (dragging === event.pointerId) { dragging = null; divider.releasePointerCapture(event.pointerId) } })
  divider.addEventListener('pointercancel', () => { dragging = null })
  const browser: FileBrowser = {
    captureScroll: rememberScroll,
    get selectedFolder() { return state.selected },
    get canCreate() { return listingReady && ordinary.has(state.selected) },
    get preferredWidth() { return state.width ?? null },
    setPreferredWidth(width) {
      if (width === null) delete state.width
      else if (validWidth(width)) state.width = width
      else return
      save()
    },
    setVault(key) {
      const next = key ? `rgent:file-browser:v1:${key}` : null
      if (next === storageKey) return
      rememberScroll(); save()
      if (storageKey) sessions.set(storageKey, { folder: folderScroll, resources: resourceScroll })
      storageKey = next; state = next ? readPreference(next) : defaults()
      folderScroll = (next && sessions.get(next)?.folder) || 0
      resourceScroll = (next && sessions.get(next)?.resources) || new Map()
      displayedResource = state.resource; index.clear(); ordinary = new Set(['']); roots = []; attachmentOwners.clear(); active = null; listingReady = false
      inform(''); redraw()
    },
    setActive(path) { rememberScroll(); active = path; redraw() },
    update(entries, activePath) {
      rememberScroll(); roots = entries; active = activePath; index = new Map(); attachmentOwners = new Map(); ordinary = new Set(['']); listingReady = true
      const visit = (children: TreeEntry[], inAttachment = false): void => {
        for (const entry of children) {
          index.set(entry.relPath, entry)
          if (entry.kind !== 'dir') continue
          const owner = entry.attachmentOf
          if (owner && !inAttachment) attachmentOwners.set(entry.relPath, owner)
          if (!owner && !inAttachment) ordinary.add(entry.relPath)
          visit(entry.children ?? [], inAttachment || !!owner)
        }
      }
      visit(entries); inform(''); validateState(); redraw(); save()
    },
    fail(message) { rememberScroll(); listingReady = false; inform(message); create.disabled = true; get<HTMLButtonElement>('.folder-create').disabled = true; layout() },
    relocate(moved) {
      rememberScroll()
      const remap = (path: string): string => {
        const match = [...moved].sort((a, b) => b.from.length - a.from.length).find(item => within(path, item.from))
        return match ? match.to + path.slice(match.from.length) : path
      }
      state.selected = remap(state.selected); state.resource = remap(state.resource); state.expanded = state.expanded.map(remap)
      resourceScroll = new Map([...resourceScroll].map(([path, value]) => [remap(path), value])); displayedResource = remap(displayedResource); save()
    }

  }
  redraw()
  return browser
}

function titleOf(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name
}

function addBadge(host: HTMLElement, tier: TreeEntry['tier']): void {
  if (!tier) return
  const badge = document.createElement('span')
  badge.className = `tier-badge tier-${tier}`
  badge.textContent = tier === 'forbidden' ? '禁止' : '遵循'
  host.append(badge)
}

let dismissTreeMenu: (() => void) | null = null

function showTreeMenu(
  x: number, y: number, entry: TreeEntry,
  onSetTier?: (relPath: string, tier: PermissionTier) => void,
  onAction?: (entry: TreeEntry, action: TreeAction) => void
): void {
  dismissTreeMenu?.()
  const menu = document.createElement('div')
  menu.className = 'tier-menu'
  menu.setAttribute('role', 'menu')
  const add = (label: string, onClick: () => void): void => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.textContent = label
    button.addEventListener('click', () => {
      dismiss()
      onClick()
    })
    menu.append(button)
  }
  if (onAction) {
    const actions = entry.relPath === ''
      ? [['new-note', '在此新建笔记'], ['new-folder', '新建文件夹']] as const
      : entry.kind === 'dir'
      ? [['new-note', '在此新建笔记'], ['new-folder', '新建文件夹'], ['rename', '改名'], ['move', '移动']] as const
      : [['rename', '改名'], ['move', '移动']] as const
    for (const [action, label] of actions) add(label, () => onAction(entry, action))
  }
  if (entry.kind === 'dir' && entry.relPath && onSetTier) {
    if (onAction) menu.append(document.createElement('hr'))
    for (const [tier, label] of [
      ['reference', '可参考'], ['follow', '必须遵循'], ['forbidden', '禁止触碰']
    ] as const) add(label, () => onSetTier(entry.relPath, tier))
  }
  menu.style.left = `${Math.min(x, window.innerWidth - 170)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - 130)}px`
  const dismiss = (): void => {
    document.removeEventListener('click', dismiss, true)
    document.removeEventListener('keydown', onKey, true)
    menu.remove()
    dismissTreeMenu = null
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') dismiss()
  }
  document.addEventListener('click', dismiss, true)
  document.addEventListener('keydown', onKey, true)
  document.body.append(menu)
  dismissTreeMenu = dismiss
  ;(menu.querySelector('button') as HTMLButtonElement | null)?.focus()
}

export { titleOf }
