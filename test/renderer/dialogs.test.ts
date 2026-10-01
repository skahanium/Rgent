// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { promptText } from '../../src/renderer/src/dialogs.ts'

beforeEach(() => {
  document.body.replaceChildren()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute('open', '') }
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    }
  })
})

const openPrompt = async () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const result = promptText('新建文件夹', '名称', '', '创建')
  await Promise.resolve()
  const dialog = document.querySelector<HTMLDialogElement>('.modal')!
  const form = dialog.querySelector('form')!
  const input = dialog.querySelector<HTMLInputElement>('input')!
  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)
  return { result, dialog, form, input, buttonByText }
}

describe('prompt dialog', () => {
  it('lets cancel close an empty prompt instead of showing a validation bubble', async () => {
    const { result, dialog, input, buttonByText } = await openPrompt()
    expect(input.required).toBe(false)
    expect(dialog.querySelector('form')!.noValidate).toBe(true)
    buttonByText('取消')!.click()
    await expect(result).resolves.toBeNull()
    expect(document.querySelector('.modal')).toBeNull()
  })

  it('keeps the dialog open and explains an empty confirm in our own words', async () => {
    const { result, dialog, buttonByText } = await openPrompt()
    buttonByText('创建')!.click()
    expect(dialog.open).toBe(true)
    const message = dialog.querySelector('.modal-error')!
    expect(message.textContent).toBe('请填写名称。')
    expect(message.hasAttribute('hidden')).toBe(false)
    await Promise.resolve()
    // 仍然可以取消，退出路径不被卡住
    buttonByText('取消')!.click()
    await expect(result).resolves.toBeNull()
  })

  it('treats Enter as confirm, not as cancel', async () => {
    const { result, input, form } = await openPrompt()
    input.value = '回车新建'
    form.requestSubmit()
    await expect(result).resolves.toBe('回车新建')
    expect(document.querySelector('.modal')).toBeNull()
  })

  it('trims the submitted name', async () => {
    const { result, input, form } = await openPrompt()
    input.value = '  带空白  '
    form.requestSubmit()
    await expect(result).resolves.toBe('带空白')
  })
})
