import { ROOT_GROUP, type SearchHit } from '@shared'

/** 把片段切成「命中前 / 命中 / 命中后」三段。偏移越界一律夹到合法范围。 */
export function highlightParts(
  text: string,
  start: number,
  length: number
): { before: string; hit: string; after: string } {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(from + Math.max(0, length), text.length))
  return { before: text.slice(0, from), hit: text.slice(from, to), after: text.slice(to) }
}

/**
 * 搜索结果面板。笔记内容是用户数据，所以片段一律用 DOM 拼，
 * 只有命中那一段用 <mark> 包起来。
 */
export function renderSearchResults(
  host: HTMLElement,
  hits: readonly SearchHit[],
  query: string,
  onOpen: (relPath: string) => void
): void {
  host.replaceChildren()
  if (!query.trim()) {
    host.hidden = true
    return
  }
  host.hidden = false

  if (hits.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'search-empty'
    empty.textContent = '没找到'
    host.append(empty)
    return
  }

  const list = document.createElement('ul')
  list.className = 'search-list'
  for (const hit of hits) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'search-hit'

    const title = document.createElement('span')
    title.className = 'search-hit-title'
    title.textContent = hit.title
    button.append(title)

    if (hit.folder && hit.folder !== ROOT_GROUP) {
      const folder = document.createElement('span')
      folder.className = 'search-hit-folder'
      folder.textContent = hit.folder
      button.append(folder)
    }

    if (hit.snippet) {
      const snippet = document.createElement('span')
      snippet.className = 'search-snippet'
      const { before, hit: marked, after } = highlightParts(hit.snippet, hit.matchStart, hit.matchLength)
      if (before) snippet.append(document.createTextNode(before))
      if (marked) {
        const mark = document.createElement('mark')
        mark.textContent = marked
        snippet.append(mark)
      }
      if (after) snippet.append(document.createTextNode(after))
      button.append(snippet)
    }

    button.addEventListener('click', () => onOpen(hit.relPath))
    item.append(button)
    list.append(item)
  }
  host.append(list)
}
