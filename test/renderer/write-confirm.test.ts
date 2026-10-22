// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { modalOpen } from '../../src/renderer/src/overlay.ts'
import { installWriteConfirm } from '../../src/renderer/src/write-confirm.ts'
import type { AgentWritePreview } from '../../src/shared/ipc.ts'

/** U5：卡片定位与尺寸搬进 styles.css；测试直接钉 CSS 规则，避免样式只活在 JS 内联里。 */
const STYLES = readFileSync('src/renderer/src/styles.css', 'utf8')
const writeConfirmRule = (): string => {
  const match = /(?:^|\n)\.write-confirm \{([^}]*)\}/u.exec(STYLES)
  if (!match) throw new Error('styles.css 里找不到 .write-confirm 规则')
  return match[1]!
}

/** U3：AI 写确认卡改成右下角的非模态卡片——不抢编辑器焦点、正文预览折 3 行、
 *  路径与引用／权限数字进「详情」，确认语义（逐次、允许才落盘、关闭算不允许）不变。 */

let showCalls = 0
let showModalCalls = 0
beforeEach(() => {
  showCalls = 0
  showModalCalls = 0
  Object.defineProperty(HTMLDialogElement.prototype, 'show', {
    configurable: true,
    value: function (this: HTMLDialogElement) { showCalls++; this.setAttribute('open', '') }
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) { showModalCalls++; this.setAttribute('open', ''); this.setAttribute('data-test-modal-shown', '') }
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) }
  })
})
const disposers: (() => void)[] = []
afterEach(() => {
  // 每个用例结束时先卸载，否则浮层栈里会留下上一张卡。
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
})

function mount() {
  const handlers: ((preview: AgentWritePreview) => void)[] = []
  const calls: { requestId: string; approved: boolean }[] = []
  const host = {
    onRequest: (handler: (preview: AgentWritePreview) => void) => {
      handlers.push(handler)
      return () => { const at = handlers.indexOf(handler); if (at >= 0) handlers.splice(at, 1) }
    },
    decide: (decision: { requestId: string; approved: boolean }) => { calls.push(decision) }
  }
  const dispose = installWriteConfirm(host)
  disposers.push(dispose)
  return {
    send: (preview: AgentWritePreview) => { handlers.forEach(handler => handler(preview)) },
    calls,
    dispose,
    // 多个用例各自 mount 时会同时开着几张卡（真实窗口里只有一张）；取最新挂上的那张。
    dialog: () => [...document.querySelectorAll<HTMLDialogElement>('.write-confirm')].at(-1) ?? null
  }
}

const createPreview = (overrides: Partial<Extract<AgentWritePreview, { kind: 'create' }>> = {}): AgentWritePreview => ({
  requestId: 'r1', kind: 'create', relPath: '工作/新笔记.md', body: '第一段正文。\n\n第二段正文。\n\n第三段正文。\n\n第四段正文。', ...overrides
})
const renamePreview: AgentWritePreview = { requestId: 'r9', kind: 'rename', source: '资料/参考篇.md', target: '资料/新名.md', moves: 1, linkChanges: 2, permissionChanges: 1 }
const movePreview: AgentWritePreview = { requestId: 'r10', kind: 'move', source: '资料/参考篇.md', target: '归档/参考篇.md', moves: 1, linkChanges: 0, permissionChanges: 0 }
const deletePreview: AgentWritePreview = { requestId: 'r11', kind: 'delete', relPath: '资料/参考篇.md', hasAttachments: true }

function focusEditor() {
  const editor = document.createElement('textarea')
  editor.value = '草稿'
  document.body.append(editor)
  editor.focus()
  return editor
}

it('打开卡片不抢焦点，也不是模态', () => {
  const editor = focusEditor()
  const app = mount()
  app.send(createPreview())
  const dialog = app.dialog()!
  expect(dialog.hasAttribute('open')).toBe(true)
  expect(dialog.dataset.modal).toBe('false')
  expect(dialog.hasAttribute('data-test-modal-shown')).toBe(false)
  expect(showCalls).toBe(1)
  expect(showModalCalls).toBe(0)
  expect(document.activeElement).toBe(editor)
  expect(modalOpen()).toBe(false)
})

it('卡片出现后编辑器仍能输入，Esc 也仍归编辑器', () => {
  const editor = focusEditor()
  const app = mount()
  app.send(createPreview())
  for (const key of ['a', 'Enter']) {
    const typed = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    editor.dispatchEvent(typed)
    expect(typed.defaultPrevented).toBe(false)
  }
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  editor.dispatchEvent(escape)
  expect(escape.defaultPrevented).toBe(false)
  // 焦点不在卡里，Esc 不能把卡关掉，更不能替人答「不允许」。
  expect(app.dialog()).not.toBeNull()
  expect(app.calls).toHaveLength(0)
  expect(document.activeElement).toBe(editor)
})

it('点「允许」回同意并关掉卡片，同一请求只回一次', () => {
  const app = mount()
  app.send(createPreview())
  const accept = app.dialog()!.querySelector<HTMLButtonElement>('.write-confirm-accept')!
  expect(accept.textContent).toBe('允许')
  accept.click()
  accept.click()
  expect(app.calls).toEqual([{ requestId: 'r1', approved: true }])
  expect(app.dialog()).toBeNull()
})

it('点「不允许」回拒绝并关掉卡片', () => {
  const app = mount()
  app.send(createPreview())
  const cancel = app.dialog()!.querySelector<HTMLButtonElement>('.write-confirm-cancel')!
  expect(cancel.textContent).toBe('不允许')
  cancel.click()
  expect(app.calls).toEqual([{ requestId: 'r1', approved: false }])
  expect(app.dialog()).toBeNull()
})

it('标题按 kind 与笔记名生成，且不超过 40 字', () => {
  const cases: [AgentWritePreview, string][] = [
    [createPreview(), 'AI 想新建《新笔记》'],
    [renamePreview, 'AI 想改名《参考篇》'],
    [movePreview, 'AI 想挪走《参考篇》'],
    [deletePreview, 'AI 想删除《参考篇》']
  ]
  for (const [preview, expected] of cases) {
    const app = mount()
    app.send(preview)
    const title = app.dialog()!.querySelector('.write-confirm-title')!.textContent!
    expect(title).toBe(expected)
    expect(title.length).toBeLessThanOrEqual(40)
    // 标题只给笔记名，目录路径属于「详情」，不上首行。
    expect(title).not.toContain('/')
  }
  // 名字本身超长时截断，首行硬上限仍然成立。
  const long = mount()
  long.send(createPreview({ requestId: 'long', relPath: `工作/${'很长的笔记名'.repeat(8)}.md` }))
  const longTitle = long.dialog()!.querySelector('.write-confirm-title')!.textContent!
  expect(longTitle.length).toBe(40)
  expect(longTitle.endsWith('…')).toBe(true)
})

it('正文预览默认折 3 行，「展开」与「收起」来回切', () => {
  const app = mount()
  app.send(createPreview())
  const dialog = app.dialog()!
  const body = dialog.querySelector<HTMLElement>('.write-confirm-body')!
  const expand = dialog.querySelector<HTMLButtonElement>('.write-confirm-expand')!
  expect(body.textContent).toContain('第四段正文。')
  expect(body.dataset.collapsed).toBe('true')
  expect(body.style.getPropertyValue('-webkit-line-clamp')).toBe('3')
  expect(body.style.getPropertyValue('line-clamp')).toBe('3')
  expect(body.style.display).toBe('-webkit-box')
  expect(body.style.overflow).toBe('hidden')
  expect(expand.textContent).toBe('展开')
  expect(expand.getAttribute('aria-expanded')).toBe('false')
  expand.click()
  expect(body.dataset.collapsed).toBe('false')
  expect(body.style.getPropertyValue('-webkit-line-clamp')).toBe('')
  expect(body.style.getPropertyValue('line-clamp')).toBe('')
  expect(body.style.display).toBe('block')
  expect(expand.textContent).toBe('收起')
  expect(expand.getAttribute('aria-expanded')).toBe('true')
  expect(body.textContent).toContain('第四段正文。')
  expand.click()
  expect(body.dataset.collapsed).toBe('true')
  expect(body.style.getPropertyValue('-webkit-line-clamp')).toBe('3')
  expect(expand.textContent).toBe('展开')
})

it('路径与说明在默认折叠的「详情」里', () => {
  const app = mount()
  app.send(createPreview())
  const dialog = app.dialog()!
  const details = dialog.querySelector<HTMLDetailsElement>('details.write-confirm-details')!
  const path = dialog.querySelector<HTMLElement>('.write-confirm-path')!
  expect(details.open).toBe(false)
  expect(details.querySelector('summary')!.textContent).toBe('详情')
  expect(details.contains(path)).toBe(true)
  expect(path.textContent).toBe('将新建：工作/新笔记.md')
  expect(dialog.querySelector('.write-confirm-note')!.textContent).toContain('正文由模型给出')
})

it('改名／挪动的旧→新路径与引用、权限数字都在详情里', () => {
  const renamed = mount()
  renamed.send(renamePreview)
  const renameDialog = renamed.dialog()!
  expect(renameDialog.textContent).toContain('将改名：资料/参考篇.md → 资料/新名.md')
  expect(renameDialog.querySelector('.write-confirm-note')!.textContent).toContain('会影响 2 处引用、1 处权限')
  expect(renameDialog.querySelector<HTMLDetailsElement>('details')!.open).toBe(false)
  // 结构操作没有正文预览，也就没有折叠按钮。
  expect(renameDialog.querySelector('.write-confirm-body')).toBeNull()
  expect(renameDialog.querySelector('.write-confirm-expand')).toBeNull()

  const moved = mount()
  moved.send(movePreview)
  expect(moved.dialog()!.textContent).toContain('将移动：资料/参考篇.md → 归档/参考篇.md')
})

it('删除卡标题是「AI 想删除」，详情写明送篓且不代改引用', () => {
  const app = mount()
  app.send(deletePreview)
  const dialog = app.dialog()!
  expect(dialog.querySelector('.write-confirm-title')!.textContent).toBe('AI 想删除《参考篇》')
  expect(dialog.getAttribute('aria-label')).toBe('AI 想删除《参考篇》')
  expect(dialog.textContent).toContain('将删除：资料/参考篇.md')
  // 窗口专项按这句原文断言（scripts/verify-ui.mjs），旧按钮文案撤掉后由详情承担。
  expect(dialog.textContent).toContain('移入废纸篓')
  expect(dialog.textContent).toContain('系统废纸篓')
  expect(dialog.textContent).toContain('链接会失效')
  expect(dialog.textContent).toContain('不会代为改字')
  expect(dialog.querySelector('.write-confirm-accept')!.textContent).toBe('允许')
  expect(dialog.querySelector('.write-confirm-cancel')!.textContent).toBe('不允许')
  expect(app.calls).toHaveLength(0)
})

it('卡片固定在右下角：宽 360px、最高 60vh、内部滚动，样式在 styles.css 里', () => {
  const app = mount()
  app.send(createPreview())
  const dialog = app.dialog()!
  expect(dialog.classList.contains('write-confirm')).toBe(true)
  // 定位不再写在 JS 内联里：样式只在 styles.css 维护一份。
  expect(dialog.style.position).toBe('')
  expect(dialog.style.right).toBe('')
  expect(dialog.style.width).toBe('')
  const rule = writeConfirmRule()
  expect(rule).toContain('position: fixed')
  expect(rule).toContain('right: 16px')
  expect(rule).toContain('bottom: 16px')
  expect(rule).toContain('width: 360px')
  expect(rule).toContain('max-width: calc(100vw - 32px)')
  expect(rule).toContain('max-height: 60vh')
  expect(rule).toContain('overflow-y: auto')
  expect(rule).toContain('z-index: 40')
  expect(rule).toContain('padding: 14px 16px')
  expect(rule).toContain('display: grid')
  // 保留既有类名与两个按钮选择器。
  expect(STYLES).toMatch(/\.write-confirm \.write-confirm-accept/u)
  expect(STYLES).toMatch(/\.write-confirm \.write-confirm-cancel/u)
})

it('卡片是读屏的状态更新，且关闭「×」等于不允许', () => {
  const app = mount()
  app.send(createPreview())
  const dialog = app.dialog()!
  expect(dialog.getAttribute('role')).toBe('status')
  expect(dialog.getAttribute('aria-live')).toBe('polite')
  const close = dialog.querySelector<HTMLButtonElement>('.write-confirm-close')!
  expect(close.textContent).toBe('×')
  expect(close.getAttribute('aria-label')).toBe('关闭，不允许这次操作')
  close.click()
  expect(app.calls).toEqual([{ requestId: 'r1', approved: false }])
  expect(app.dialog()).toBeNull()
})

it('关掉卡片（焦点在卡里按 Esc、程序关闭）都按不允许结清', () => {
  const escaped = mount()
  escaped.send(createPreview())
  escaped.dialog()!.querySelector<HTMLButtonElement>('.write-confirm-accept')!.focus()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  expect(escaped.calls).toEqual([{ requestId: 'r1', approved: false }])
  expect(escaped.dialog()).toBeNull()

  // 宿主卸载卡片也不能留下一个「不知道答没答」的请求。
  const disposed = mount()
  disposed.send(createPreview({ requestId: 'r-closed' }))
  disposed.dispose()
  expect(disposed.calls).toEqual([{ requestId: 'r-closed', approved: false }])
  expect(disposed.dialog()).toBeNull()
})

it('前一张没答就来了新请求：旧请求按不允许结清，只留一张卡', () => {
  const app = mount()
  app.send(createPreview({ requestId: 'r4', relPath: '工作/第一篇.md' }))
  app.send(createPreview({ requestId: 'r5', relPath: '工作/第二篇.md' }))
  expect(app.calls).toEqual([{ requestId: 'r4', approved: false }])
  expect(document.querySelectorAll('.write-confirm')).toHaveLength(1)
  expect(app.dialog()!.querySelector('.write-confirm-title')!.textContent).toBe('AI 想新建《第二篇》')
})
