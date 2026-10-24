// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { renderTaskDock } from '../../src/renderer/src/task-dock.ts'
import { makeTaskFailure } from '../../src/shared/task-failure.ts'

afterEach(() => { document.body.replaceChildren() })

describe('task dock', () => {
  it('hides when idle and reuses the abort button while generating', () => {
    const status = document.createElement('footer')
    status.className = 'status'
    document.body.append(status)
    let aborted = 0
    renderTaskDock({ kind: 'generating', onAbort: () => { aborted += 1 } })
    const first = document.querySelector<HTMLButtonElement>('.task-dock-abort')!
    expect(document.querySelector<HTMLElement>('.task-dock')?.dataset.kind).toBe('generating')
    expect(document.querySelector('.task-dock-label')?.textContent).toBe('生成中')
    renderTaskDock({ kind: 'generating', onAbort: () => { aborted += 2 } })
    expect(document.querySelector('.task-dock-abort')).toBe(first)
    first.click()
    expect(aborted).toBe(2)
    renderTaskDock({ kind: 'hidden' })
    expect(document.querySelector<HTMLElement>('.task-dock')?.hidden).toBe(true)
  })

  it('shows resume and end while paused', () => {
    const status = document.createElement('footer')
    status.className = 'status'
    document.body.append(status)
    const hits: string[] = []
    renderTaskDock({ kind: 'paused', onResume: () => hits.push('resume'), onEnd: () => hits.push('end') })
    expect(document.querySelector('.task-dock-label')?.textContent).toBe('暂停中')
    document.querySelector<HTMLButtonElement>('.task-dock-resume')!.click()
    document.querySelector<HTMLButtonElement>('.task-dock-end')!.click()
    expect(hits).toEqual(['resume', 'end'])
  })

  it('lists other running notes without putting them in the status bar', () => {
    const status = document.createElement('footer')
    status.className = 'status'
    document.body.append(status)
    let opened = 0
    renderTaskDock({ kind: 'others', count: 2, onOpen: () => { opened += 1 } })
    expect(document.querySelector('.task-dock-others')?.textContent).toBe('另有 2 项')
    document.querySelector<HTMLButtonElement>('.task-dock-others')!.click()
    expect(opened).toBe(1)
  })
})

  it('shows concise failure with retry, details, clear and copy actions', () => {
    const status = document.createElement('footer'); status.className = 'status'; document.body.append(status)
    const hits: string[] = []
    const failure = makeTaskFailure({ code: 'MODEL_REQUEST_FAILED', diagnosticId: 'diag', detail: { httpStatus: 503 } })
    renderTaskDock({ kind: 'failed', failure, taskId: 'task-1', expanded: true, canRetry: true,
      onRetry: () => hits.push('retry'), onClear: () => hits.push('clear'),
      onToggleDetails: () => hits.push('details'), onCopy: () => hits.push('copy') })
    expect(document.querySelector<HTMLElement>('.task-dock')?.dataset.kind).toBe('failed')
    expect(document.querySelector('.task-dock-label')?.textContent).toContain('模型服务没完成请求')
    expect(document.querySelector<HTMLElement>('.task-dock-detail')?.hidden).toBe(false)
    document.querySelector<HTMLButtonElement>('.task-dock-retry')!.click()
    document.querySelector<HTMLButtonElement>('.task-dock-details')!.click()
    document.querySelector<HTMLButtonElement>('.task-dock-end')!.click()
    document.querySelector<HTMLButtonElement>('.task-dock-copy')!.click()
    expect(hits).toEqual(['retry','details','clear','copy'])
  })
