import type { PermissionTier, TreeEntry } from '@shared'
import { noteTitle } from '../../shared/vault-rel.ts'

export { collectNotePaths, collectRelPaths } from '../../shared/vault-rel.ts'

export function renderTree(
  host: HTMLElement,
  entries: TreeEntry[],
  activePath: string | null,
  onOpenNote: (relPath: string) => void,
  onSetTier?: (relPath: string, tier: PermissionTier) => void
): void {
  host.replaceChildren()
  const list = document.createElement('ul')
  list.className = 'tree-list'
  for (const entry of entries) list.append(node(entry, activePath, onOpenNote, onSetTier))
  host.append(list)
}

function node(entry: TreeEntry, activePath: string | null, onOpenNote: (relPath: string) => void, onSetTier?: (relPath: string, tier: PermissionTier) => void): HTMLElement {
  const li = document.createElement('li')
  if (entry.kind === 'dir') {
    const details = document.createElement('details')
    details.open = true
    const summary = document.createElement('summary')
    summary.append(document.createTextNode(entry.name))
    addBadge(summary, entry.tier)
    if (onSetTier) summary.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      showTierMenu(event.clientX, event.clientY, entry.relPath, onSetTier)
    })
    details.append(summary)
    const nested = document.createElement('ul')
    nested.className = 'tree-list'
    for (const child of entry.children ?? []) nested.append(node(child, activePath, onOpenNote, onSetTier))
    details.append(nested)
    li.append(details)
    return li
  }
  if (entry.kind === 'note') {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tree-note'
    button.append(document.createTextNode(titleOf(entry.name)))
    addBadge(button, entry.tier)
    button.setAttribute('aria-current', entry.relPath === activePath ? 'page' : 'false')
    button.addEventListener('click', () => onOpenNote(entry.relPath))
    li.append(button)
    return li
  }
  const span = document.createElement('span')
  span.className = 'tree-file'
  span.textContent = entry.name
  addBadge(span, entry.tier)
  span.title = '不是笔记'
  li.append(span)
  return li
}

function addBadge(host: HTMLElement, tier: TreeEntry['tier']): void {
  if (!tier) return
  const badge = document.createElement('span')
  badge.className = `tier-badge tier-${tier}`
  badge.textContent = tier === 'forbidden' ? '禁止' : '遵循'
  host.append(badge)
}

let dismissTierMenu: (() => void) | null = null

function showTierMenu(x: number, y: number, relPath: string, onSetTier: (relPath: string, tier: PermissionTier) => void): void {
  dismissTierMenu?.()
  const menu = document.createElement('div')
  menu.className = 'tier-menu'
  menu.setAttribute('role', 'menu')
  for (const [tier, label] of [
    ['reference', '可参考'],
    ['follow', '必须遵循'],
    ['forbidden', '禁止触碰']
  ] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.textContent = label
    button.addEventListener('click', () => {
      dismiss()
      onSetTier(relPath, tier)
    })
    menu.append(button)
  }
  menu.style.left = `${Math.min(x, window.innerWidth - 170)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - 140)}px`
  document.body.append(menu)
  const dismiss = (): void => {
    menu.remove()
    document.removeEventListener('mousedown', close)
    if (dismissTierMenu === dismiss) dismissTierMenu = null
  }
  const close = (event: MouseEvent): void => {
    if (menu.contains(event.target as Node)) return
    dismiss()
  }
  dismissTierMenu = dismiss
  setTimeout(() => {
    if (dismissTierMenu === dismiss) document.addEventListener('mousedown', close)
  }, 0)
}

export function titleOf(fileName: string): string {
  return noteTitle(fileName)
}
