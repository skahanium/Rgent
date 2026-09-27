import type { MarkerRef } from '@markdown'

/**
 * 底栏。围栏 docs/frontend.md §编辑画布与辅助信息：
 * 与上方用一条细线分开，显示行列、字数与库名。
 *
 * 联网总闸与生成任务状态属于 Host / 联网阶段：这里只留位置与「离线」这一如实状态，
 * 不做一个点不动的死控件。等功能接线的那一刀再把它们变成可操作的控件。
 */

export type StatusInput = {
  line: number
  column: number
  words: number
  vaultName: string | null
  noteOpen: boolean
}

export type StatusModel = {
  position: string | null
  words: string | null
  vault: string
  network: 'offline'
}

export function statusModel(input: StatusInput): StatusModel {
  return {
    position: input.noteOpen ? `第 ${input.line} 行, 第 ${input.column} 列` : null,
    words: input.noteOpen ? `字数 ${input.words}` : null,
    vault: input.vaultName ?? '未选库',
    network: 'offline'
  }
}

/** 正文（含标记行）→ 字数。标记行不算，机器语法不是文章。 */
export function wordsOf(body: string, markers: readonly MarkerRef[]): number {
  const ranges = [...markers].map(({ range }) => range).sort((a, b) => a.start - b.start)
  const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u
  const wordish = /[\p{L}\p{N}_]/u
  let count = 0
  let inRun = false
  let rangeIndex = 0
  for (let at = 0; at < body.length;) {
    const range = ranges[rangeIndex]
    if (range && at >= range.start) {
      at = Math.max(at, range.end)
      rangeIndex += 1
      inRun = false
      continue
    }
    const char = String.fromCodePoint(body.codePointAt(at)!)
    if (cjk.test(char)) {
      count += 1
      inRun = false
    } else if (wordish.test(char)) {
      if (!inRun) count += 1
      inRun = true
    } else {
      inRun = false
    }
    at += char.length
  }
  return count
}

export function renderStatusbar(host: HTMLElement, model: StatusModel): void {
  host.replaceChildren()

  const left = document.createElement('div')
  left.className = 'status-left'
  if (model.position) {
    const position = document.createElement('span')
    position.className = 'status-item'
    position.textContent = model.position
    left.append(position)
  }
  if (model.words) {
    const words = document.createElement('span')
    words.className = 'status-item'
    words.textContent = model.words
    left.append(words)
  }

  const right = document.createElement('div')
  right.className = 'status-right'
  const dot = document.createElement('span')
  dot.className = 'status-dot'
  dot.dataset.state = model.network
  dot.setAttribute('role', 'img')
  dot.setAttribute('aria-label', '联网状态：离线')
  dot.title = '离线'
  const vault = document.createElement('span')
  vault.className = 'status-item status-vault'
  vault.textContent = model.vault
  vault.title = model.vault
  right.append(dot, vault)

  host.append(left, right)
}
