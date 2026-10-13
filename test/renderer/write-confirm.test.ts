// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installWriteConfirm } from '../../src/renderer/src/write-confirm.ts'
import type { AgentWritePreview } from '../../src/shared/ipc.ts'

/** 包 3b：建的确认浮层——摆出路径与正文，点一下才建，Esc 就是不建。 */

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
})
const disposers: (() => void)[] = []
afterEach(() => {
  // 每个用例结束时先卸载，否则浮层栈里会留下上一张卡，Esc 就轮不到新的那张。
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
})

function mount() {
  const handlers: ((preview: AgentWritePreview) => void)[] = []
  const decide = vi.fn()
  const dispose = installWriteConfirm({ onRequest: handler => { handlers.push(handler); return () => { const at = handlers.indexOf(handler); if (at >= 0) handlers.splice(at, 1) } }, decide })
  disposers.push(dispose)
  return { send: (preview: AgentWritePreview) => handlers.forEach(handler => handler(preview)), decide, dispose, dialog: () => document.querySelector<HTMLDialogElement>('.overlay-write-confirm') }
}

it('摆出落点与正文，并把焦点放在「建」上', () => {
  const app = mount()
  app.send({ requestId: 'r1', relPath: '工作/新笔记.md', body: '新笔记正文。' })
  const dialog = app.dialog()!
  expect(dialog.textContent).toContain('将新建：工作/新笔记.md')
  expect(dialog.textContent).toContain('新笔记正文。')
  expect(document.activeElement?.className).toContain('write-confirm-accept')
})

it('点「建」回一个同意，且同一请求只回一次', () => {
  const app = mount()
  app.send({ requestId: 'r1', relPath: '新笔记.md', body: '正文' })
  const accept = app.dialog()!.querySelector<HTMLButtonElement>('.write-confirm-accept')!
  accept.click()
  accept.click()
  expect(app.decide).toHaveBeenCalledTimes(1)
  expect(app.decide).toHaveBeenCalledWith({ requestId: 'r1', approved: true })
  expect(app.dialog()).toBeNull()
})

it('点「不建」回一个拒绝，什么都不写', () => {
  const app = mount()
  app.send({ requestId: 'r2', relPath: '新笔记.md', body: '正文' })
  app.dialog()!.querySelector<HTMLButtonElement>('.write-confirm-cancel')!.click()
  expect(app.decide).toHaveBeenCalledWith({ requestId: 'r2', approved: false })
  expect(app.dialog()).toBeNull()
})

it('按 Esc 当作不建', () => {
  const app = mount()
  app.send({ requestId: 'r3', relPath: '新笔记.md', body: '正文' })
  // 浏览器里 Esc 落在模态 <dialog> 上就是 cancel 事件；浮层正是照它收口的。
  document.querySelector<HTMLDialogElement>('.overlay-write-confirm')!.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(app.decide).toHaveBeenCalledWith({ requestId: 'r3', approved: false })
})

it('前一张没答就来了新请求：旧请求按不建结清，纸面上只留一张卡', () => {
  const app = mount()
  app.send({ requestId: 'r4', relPath: '第一篇.md', body: '甲' })
  app.send({ requestId: 'r5', relPath: '第二篇.md', body: '乙' })
  expect(app.decide).toHaveBeenCalledWith({ requestId: 'r4', approved: false })
  expect(document.querySelectorAll('.overlay-write-confirm')).toHaveLength(1)
  expect(app.dialog()!.textContent).toContain('第二篇.md')
})
