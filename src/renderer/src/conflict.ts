import type { DiffRow } from './diff.ts'
import { diffPreview } from './diff.ts'
import { openOverlay } from './overlay.ts'

/**
 * 冲突决策：并排两份**可读**预览，同样的前后文，各自强调变化处，
 * 并写明各自会舍弃什么（围栏 decisions.md §库、文件、窗口）。
 *
 * 只读渲染：这里不写盘。调用方分别走人的 noteWrite 或 Host 专用写入通道。
 */

export type ConflictChoice = 'window' | 'disk' | 'continue'

export type ConflictInput = {
  title: string
  /** 窗口里的正文（人会丢掉的那份是磁盘的改动）。 */
  windowText: string
  /** 磁盘上的正文。 */
  diskText: string
  labels?: {
    heading: string
    description: string
    window: string
    disk: string
    windowAction: string
    diskAction: string
    windowHint: string
    diskHint: string
  }
}

export function promptConflict(input: ConflictInput): Promise<ConflictChoice> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: ConflictChoice): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const overlay = openOverlay({
      label: '稿不一样了',
      initialFocus: () => overlay.root.querySelector<HTMLElement>('[data-action="continue"]'),
      // 被上层浮层顶掉或 Esc 关闭：按「继续编辑」算，什么都不丢。
      onClose: () => finish('continue')
    })
    const dialog = overlay.root
    dialog.classList.add('conflict')
    const preview = diffPreview(input.windowText, input.diskText)

    const heading = document.createElement('h2')
    heading.textContent = input.labels?.heading ?? '稿不一样了'
    const sub = document.createElement('p')
    sub.className = 'conflict-sub'
    sub.textContent = input.labels?.description ?? `${input.title}：窗口里的稿和磁盘上这份文件都不一样了。下面并排显示，只强调不同的地方。`

    const grid = document.createElement('div')
    grid.className = 'conflict-grid'
    // 表头：两栏各自标明是哪一份。
    grid.append(cell('head', input.labels?.window ?? '窗口里还没保存的稿'), cell('head', input.labels?.disk ?? '磁盘上这份文件'))

    let hiddenRow: DiffRow | null = null
    if (preview.hidden > 0) hiddenRow = { kind: 'gap', lines: preview.hidden }

    for (const row of preview.rows) {
      if (row.kind === 'same') {
        grid.append(cell('same', row.text), cell('same', row.text))
        continue
      }
      if (row.kind === 'gap') {
        const note = document.createElement('div')
        note.className = 'conflict-gap'
        note.textContent = `⋯ 省略 ${row.lines} 行相同内容`
        grid.append(note, document.createElement('div'))
        continue
      }
      grid.append(
        cell('changed', row.windowLine, row.windowMarks, row.oneSided === 'disk' ? 'absent' : null),
        cell('changed', row.diskLine, row.diskMarks, row.oneSided === 'window' ? 'absent' : null)
      )
    }

    if (hiddenRow && preview.hidden > 0) {
      const note = document.createElement('div')
      note.className = 'conflict-gap'
      note.textContent = `⋯ 还有 ${preview.hidden} 处差异没有展开`
      grid.append(note, document.createElement('div'))
    }

    const panes = document.createElement('div')
    panes.className = 'conflict-actions'
    panes.append(
      action('window', input.labels?.windowAction ?? '听窗口', input.labels?.windowHint ?? '采用左侧窗口稿写盘；右侧磁盘稿的修改会被丢弃。'),
      action('disk', input.labels?.diskAction ?? '听磁盘', input.labels?.diskHint ?? '采用右侧磁盘稿；左侧窗口里未保存的修改会被丢弃。')
    )
    const continueAction = action('continue', '继续编辑', '两份都留着，什么都不写，等你决定。')
    continueAction.classList.add('conflict-continue')

    dialog.append(heading, sub, grid, panes, continueAction)

    function action(value: ConflictChoice, label: string, hint: string): HTMLElement {
      const wrapper = document.createElement('div')
      wrapper.className = 'conflict-action'
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.action = value
      button.textContent = label
      const note = document.createElement('span')
      note.className = 'conflict-note'
      note.textContent = hint
      button.addEventListener('click', () => {
        overlay.close()
        finish(value)
      })
      wrapper.append(button, note)
      return wrapper
    }
  })
}

function cell(
  kind: 'same' | 'changed' | 'head',
  text: string,
  marks: Array<[number, number]> = [],
  absent: 'absent' | null = null
): HTMLElement {
  const div = document.createElement('div')
  div.className = `conflict-cell conflict-${kind}`
  if (absent) div.dataset.absent = absent
  if (kind === 'head' || text === '') {
    div.textContent = kind === 'head' ? text : absent ? '（这一份没有这行）' : ''
    return div
  }
  if (marks.length === 0) {
    div.textContent = text
    return div
  }
  let at = 0
  for (const [from, to] of marks) {
    if (from > at) div.append(document.createTextNode(text.slice(at, from)))
    const mark = document.createElement('span')
    mark.className = 'conflict-emph'
    mark.textContent = text.slice(from, to)
    div.append(mark)
    at = to
  }
  if (at < text.length) div.append(document.createTextNode(text.slice(at)))
  return div
}
