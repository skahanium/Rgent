import type { BacklinkGroup } from '@shared'

/** 反链面板：谁链到了当前这篇，按所在文件夹分组。全部用 DOM 构造，不拼 HTML。 */
export function renderBacklinks(
  host: HTMLElement,
  groups: readonly BacklinkGroup[],
  onOpenNote: (relPath: string) => void,
  emptyText: string
): void {
  host.replaceChildren()

  const heading = document.createElement('p')
  heading.className = 'backlinks-title'
  heading.textContent = '反链'
  host.append(heading)

  if (groups.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'backlinks-empty'
    empty.textContent = emptyText
    host.append(empty)
    return
  }

  for (const group of groups) {
    const section = document.createElement('section')
    section.className = 'backlinks-group'

    const folder = document.createElement('h2')
    folder.className = 'backlinks-folder'
    folder.textContent = group.folder
    section.append(folder)

    const list = document.createElement('ul')
    list.className = 'backlinks-list'
    for (const note of group.notes) {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'backlinks-note'
      button.textContent = note.title
      button.title = note.relPath
      button.addEventListener('click', () => onOpenNote(note.relPath))
      item.append(button)
      list.append(item)
    }
    section.append(list)
    host.append(section)
  }
}
