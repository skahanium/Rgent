// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { confirmTrash } from '../../src/renderer/src/trash-confirm.ts'

beforeEach(() => {
  document.body.replaceChildren()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
})

const preview = { id: 't1', sessionId: 's', relPath: '甲.md', title: '甲', hasAttachments: true }

it('摆出路径和附件说明，点「移入废纸篓」才同意', async () => {
  const decided = confirmTrash(preview)
  const dialog = document.querySelector('.overlay-write-confirm')!
  expect(dialog.textContent).toContain('甲.md')
  expect(dialog.textContent).toContain('同名附件夹')
  expect(dialog.textContent).toContain('链接会失效，不会代为改字')
  expect(document.activeElement?.className).toContain('write-confirm-cancel')
  dialog.querySelector<HTMLButtonElement>('.write-confirm-accept')!.click()
  await expect(decided).resolves.toBe(true)
})

it('点「不删」或关掉浮层都是零动作', async () => {
  const decided = confirmTrash({ ...preview, hasAttachments: false })
  const dialog = document.querySelector('.overlay-write-confirm')!
  expect(dialog.textContent).toContain('没有同名附件夹')
  expect(dialog.textContent).toContain('链接会失效，不会代为改字')
  dialog.querySelector<HTMLButtonElement>('.write-confirm-cancel')!.click()
  await expect(decided).resolves.toBe(false)
})
