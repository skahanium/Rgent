/**
 * 栏上任务浮层。围栏 docs/decisions.md §2026-10-23 底栏减负与任务浮层：
 * 生成态不进底栏；跟当前篇；节点复用，避免状态重绘拆掉按钮焦点。
 *
 * 今天 resume = 同口令新开一场。真断点接续未开，按钮仍走调用方的三个命名函数。
 */

import type { TaskFailure } from '../../shared/task-failure.ts'

export type TaskDockModel =
  | { kind: 'hidden' }
  | { kind: 'generating'; onAbort: () => void }
  | { kind: 'paused'; onResume: () => void; onEnd: () => void }
  | { kind: 'failed'; failure: TaskFailure; taskId: string; expanded: boolean; canRetry: boolean; onRetry: () => void; onClear: () => void; onToggleDetails: () => void; onCopy: () => void }
  | { kind: 'others'; count: number; onOpen: () => void }

let host: HTMLElement | null = null

function ensureHost(): HTMLElement {
  if (host?.isConnected) return host
  const made = document.createElement('div')
  made.className = 'task-dock'
  made.hidden = true
  made.dataset.kind = 'hidden'
  made.setAttribute('role', 'status')
  const status = document.querySelector('.status')
  if (status?.parentElement) status.parentElement.insertBefore(made, status)
  else document.body.append(made)
  host = made
  return made
}

function bindButton(button: HTMLButtonElement, run: () => void): void {
  button.onclick = run
}

export function renderTaskDock(model: TaskDockModel): void {
  const root = ensureHost()
  if (model.kind === 'hidden') {
    root.hidden = true
    root.dataset.kind = 'hidden'
    root.replaceChildren()
    root.removeAttribute('aria-label')
    return
  }
  root.hidden = false
  if (model.kind === 'generating') {
    if (root.dataset.kind !== 'generating') {
      root.dataset.kind = 'generating'
      root.setAttribute('aria-label', '生成中')
      root.replaceChildren()
      const label = document.createElement('span')
      label.className = 'task-dock-label'
      label.textContent = '生成中'
      const abort = document.createElement('button')
      abort.type = 'button'
      abort.className = 'task-dock-abort'
      abort.setAttribute('aria-label', '中止本场')
      abort.title = '中止本场'
      root.append(label, abort)
    }
    bindButton(root.querySelector<HTMLButtonElement>('.task-dock-abort')!, model.onAbort)
    return
  }
  if (model.kind === 'paused') {
    if (root.dataset.kind !== 'paused') {
      root.dataset.kind = 'paused'
      root.setAttribute('aria-label', '暂停中')
      root.replaceChildren()
      const label = document.createElement('span')
      label.className = 'task-dock-label'
      label.textContent = '暂停中'
      const resume = document.createElement('button')
      resume.type = 'button'
      resume.className = 'task-dock-resume'
      resume.setAttribute('aria-label', '用同一口令再开一场')
      resume.title = '用同一口令再开一场'
      const end = document.createElement('button')
      end.type = 'button'
      end.className = 'task-dock-end'
      end.setAttribute('aria-label', '彻底结束')
      end.title = '彻底结束'
      end.textContent = '×'
      root.append(label, resume, end)
    }
    bindButton(root.querySelector<HTMLButtonElement>('.task-dock-resume')!, model.onResume)
    bindButton(root.querySelector<HTMLButtonElement>('.task-dock-end')!, model.onEnd)
    return
  }
  if (model.kind === 'failed') {
    if (root.dataset.kind !== 'failed') {
      root.dataset.kind = 'failed'
      root.setAttribute('aria-label', '上一场失败')
      root.replaceChildren()
      const label = document.createElement('span')
      label.className = 'task-dock-label'
      label.textContent = model.failure.message
      const retry = document.createElement('button')
      retry.type = 'button'; retry.className = 'task-dock-retry'; retry.textContent = '重试'
      const details = document.createElement('button')
      details.type = 'button'; details.className = 'task-dock-details'; details.textContent = '详情'
      const clear = document.createElement('button')
      clear.type = 'button'; clear.className = 'task-dock-end'; clear.textContent = '清除标记'
      const panel = document.createElement('div')
      panel.className = 'task-dock-detail'
      const facts = document.createElement('code')
      facts.className = 'task-dock-facts'
      facts.textContent = `${model.failure.family} · ${model.failure.stage} · ${model.failure.action} · 可重试：${model.failure.retryable ? '是' : '否'}`
      const detail = document.createElement('pre')
      detail.className = 'task-dock-detail-json'
      detail.textContent = JSON.stringify({ code: model.failure.code, diagnosticId: model.failure.diagnosticId, detail: model.failure.detail ?? null }, null, 2)
      const copy = document.createElement('button')
      copy.type = 'button'; copy.className = 'task-dock-copy'; copy.textContent = '复制诊断'
      panel.append(facts, detail, copy)
      root.append(label)
      if (model.canRetry) root.append(retry)
      root.append(details, clear, panel)
    }
    const retry = root.querySelector<HTMLButtonElement>('.task-dock-retry')
    if (retry) bindButton(retry, model.onRetry)
    bindButton(root.querySelector<HTMLButtonElement>('.task-dock-details')!, model.onToggleDetails)
    bindButton(root.querySelector<HTMLButtonElement>('.task-dock-end')!, model.onClear)
    bindButton(root.querySelector<HTMLButtonElement>('.task-dock-copy')!, model.onCopy)
    const label = root.querySelector<HTMLElement>('.task-dock-label')
    if (label) label.textContent = model.failure.message
    const panel = root.querySelector<HTMLElement>('.task-dock-detail')!
    panel.hidden = !model.expanded
    panel.dataset.failure = JSON.stringify(model.failure)
    return
  }
  const text = `另有 ${model.count} 项`
  if (root.dataset.kind !== 'others') {
    root.dataset.kind = 'others'
    root.replaceChildren()
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'task-dock-others'
    more.textContent = text
    root.append(more)
  } else {
    const more = root.querySelector<HTMLButtonElement>('.task-dock-others')!
    more.textContent = text
  }
  root.setAttribute('aria-label', text)
  bindButton(root.querySelector<HTMLButtonElement>('.task-dock-others')!, model.onOpen)
}
