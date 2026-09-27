import type { SearchHit } from '@shared'
import { icon } from './icons.ts'
import { openOverlay } from './overlay.ts'
import { renderSearchResults } from './search.ts'

/**
 * 悬浮搜索。围栏 docs/frontend.md §浮层与特殊状态：
 * 独立于文件树按钮的悬浮页；弹出后聚焦输入框，Esc 可关闭；
 * 键盘能访问结果并返回原工作区。内容的范围与排序仍按检索合同，不从视觉稿推导。
 */

export type SearchOverlayHandlers = {
  search: (query: string) => Promise<SearchHit[]>
  onOpenNote: (relPath: string) => void
}

export type SearchOverlay = {
  open: () => void
  isOpen: () => boolean
}

const DEBOUNCE_MS = 120

export function createSearchOverlay(handlers: SearchOverlayHandlers): SearchOverlay {
  let overlay: ReturnType<typeof openOverlay> | null = null
  let timer: number | null = null
  let token = 0

  const close = (): void => overlay?.close()

  const run = async (input: HTMLInputElement, results: HTMLElement): Promise<void> => {
    const mine = ++token
    const hits = await handlers.search(input.value)
    if (mine !== token || !overlay?.isOpen()) return
    renderSearchResults(results, hits, input.value, (relPath) => {
      handlers.onOpenNote(relPath)
      close()
    })
  }

  const open = (): void => {
    if (overlay?.isOpen()) return
    const current = openOverlay({
      label: '搜索笔记',
      onClose: () => {
        overlay = null
        if (timer != null) window.clearTimeout(timer)
        timer = null
      }
    })
    overlay = current

    const head = document.createElement('div')
    head.className = 'overlay-search-head'
    head.append(icon('note', 'icon-type'))
    const input = document.createElement('input')
    input.type = 'search'
    input.className = 'overlay-search-input'
    input.placeholder = '搜标题或正文'
    input.setAttribute('aria-label', '搜标题或正文')
    input.autocomplete = 'off'
    head.append(input)

    const results = document.createElement('div')
    results.className = 'overlay-search-results'
    const hint = document.createElement('p')
    hint.className = 'overlay-hint'
    hint.textContent = '输入关键字，回车打开第一条；Esc 关闭。'
    results.append(hint)

    const root = current.root
    root.classList.add('overlay-search')
    root.append(head, results)

    input.addEventListener('input', () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void run(input, results), DEBOUNCE_MS)
    })
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      const first = results.querySelector<HTMLButtonElement>('.search-hit')
      first?.click()
    })

    current.root.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') return
      const first = results.querySelector<HTMLButtonElement>('.search-hit')
      if (first) {
        event.preventDefault()
        first.focus()
      }
    })

    void run(input, results)
  }

  return {
    open,
    isOpen: () => overlay?.isOpen() === true
  }
}
