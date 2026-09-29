import type { PermissionTier, TreeEntry } from '@shared'
import { icon, iconForFile } from './icons.ts'
import { noteTitle } from '../../shared/vault-rel.ts'

export { collectNotePaths, collectRelPaths } from '../../shared/vault-rel.ts'
export type TreeAction = 'new-note' | 'new-folder' | 'rename' | 'move'

/**
 * 文件树。规则见围栏 docs/frontend.md §顶栏与侧栏：
 * 文件夹平时显示文件夹图标，悬停或键盘聚焦时**同一位置**变成展开／折叠的目标，
 * 不在旁边另加一枚箭头；图标位置始终可点，无悬停设备直接点它。
 *
 * 做法：整行就是一个 aria-expanded 的按钮，图标是它的一部分——点图标就是点行，
 * 少一个控件也少一处焦点站。文件夹与笔记的差别只在图标与行类名。
 */

export function renderTree(
  host: HTMLElement,
  entries: TreeEntry[],
  activePath: string | null,
  onOpenNote: (relPath: string) => void,
  onSetTier?: (relPath: string, tier: PermissionTier) => void,
  onAction?: (entry: TreeEntry, action: TreeAction) => void
): void {
  host.replaceChildren()
  const list = document.createElement('ul')
  list.className = 'tree-list'
  for (const entry of entries) list.append(node(entry, activePath, onOpenNote, onSetTier, onAction))
  host.append(list)
}

function node(
  entry: TreeEntry,
  activePath: string | null,
  onOpenNote: (relPath: string) => void,
  onSetTier?: (relPath: string, tier: PermissionTier) => void,
  onAction?: (entry: TreeEntry, action: TreeAction) => void
): HTMLElement {
  const li = document.createElement('li')
  if (entry.kind === 'dir') {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'tree-row tree-dir'
    row.setAttribute('aria-expanded', 'true')
    row.append(icon('folder', 'icon-folder'), icon('folder-open', 'icon-folder-open'))
    const label = document.createElement('span')
    label.className = 'tree-label'
    label.textContent = entry.name
    row.append(label)
    addBadge(row, entry.tier)
    if (onSetTier || onAction) {
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        showTreeMenu(event.clientX, event.clientY, entry, onSetTier, onAction)
      })
    }

    const nested = document.createElement('ul')
    nested.className = 'tree-list'
    nested.dataset.parent = entry.relPath
    for (const child of entry.children ?? []) nested.append(node(child, activePath, onOpenNote, onSetTier, onAction))
    row.addEventListener('click', () => {
      const open = row.getAttribute('aria-expanded') === 'true'
      row.setAttribute('aria-expanded', String(!open))
      nested.hidden = open
    })
    li.append(row, nested)
    return li
  }

  if (entry.kind === 'note') {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tree-row tree-note'
    button.append(icon('note', 'icon-type'))
    const label = document.createElement('span')
    label.className = 'tree-label'
    label.textContent = titleOf(entry.name)
    button.append(label)
    addBadge(button, entry.tier)
    if (entry.relPath === activePath) button.setAttribute('aria-current', 'page')
    button.addEventListener('click', () => onOpenNote(entry.relPath))
    if (onAction) button.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      showTreeMenu(event.clientX, event.clientY, entry, onSetTier, onAction)
    })
    li.append(button)
    return li
  }

  const span = document.createElement('span')
  span.className = 'tree-row tree-file'
  span.append(icon(iconForFile(entry.name), 'icon-type'))
  const label = document.createElement('span')
  label.className = 'tree-label'
  label.textContent = entry.name
  span.append(label)
  addBadge(span, entry.tier)
  span.title = '不是笔记'
  li.append(span)
  return li
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
    const actions = entry.kind === 'dir'
      ? [['new-note', '在此新建笔记'], ['new-folder', '新建文件夹'], ['rename', '改名'], ['move', '移动']] as const
      : [['rename', '改名'], ['move', '移动']] as const
    for (const [action, label] of actions) add(label, () => onAction(entry, action))
  }
  if (entry.kind === 'dir' && onSetTier) {
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
