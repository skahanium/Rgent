import type { TreeEntry } from '@shared'

export function renderTree(
  host: HTMLElement,
  entries: TreeEntry[],
  activePath: string | null,
  onOpenNote: (relPath: string) => void
): void {
  host.replaceChildren()
  const list = document.createElement('ul')
  list.className = 'tree-list'
  for (const entry of entries) list.append(node(entry, activePath, onOpenNote))
  host.append(list)
}

function node(entry: TreeEntry, activePath: string | null, onOpenNote: (relPath: string) => void): HTMLElement {
  const li = document.createElement('li')
  if (entry.kind === 'dir') {
    const details = document.createElement('details')
    details.open = true
    const summary = document.createElement('summary')
    summary.textContent = entry.name
    details.append(summary)
    const nested = document.createElement('ul')
    nested.className = 'tree-list'
    for (const child of entry.children ?? []) nested.append(node(child, activePath, onOpenNote))
    details.append(nested)
    li.append(details)
    return li
  }
  if (entry.kind === 'note') {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tree-note'
    button.textContent = titleOf(entry.name)
    button.setAttribute('aria-current', entry.relPath === activePath ? 'page' : 'false')
    button.addEventListener('click', () => onOpenNote(entry.relPath))
    li.append(button)
    return li
  }
  const span = document.createElement('span')
  span.className = 'tree-file'
  span.textContent = entry.name
  span.title = '不是笔记'
  li.append(span)
  return li
}

export function titleOf(fileName: string): string {
  return fileName.replace(/\.md$/i, '')
}

export function collectNotePaths(entries: TreeEntry[], into = new Set<string>()): Set<string> {
  for (const entry of entries) {
    if (entry.kind === 'note') into.add(entry.relPath)
    if (entry.children) collectNotePaths(entry.children, into)
  }
  return into
}

export function collectRelPaths(entries: TreeEntry[], into = new Set<string>()): Set<string> {
  for (const entry of entries) {
    if (entry.kind !== 'dir') into.add(entry.relPath)
    if (entry.children) collectRelPaths(entry.children, into)
  }
  return into
}
