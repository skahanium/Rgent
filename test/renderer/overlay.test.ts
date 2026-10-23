// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modalOpen, openOverlay } from '../../src/renderer/src/overlay.ts'

/** jsdom 没有实现 dialog 的 show/showModal；这里只补最小行为，断言的是我们自己的分派。 */
beforeEach(() => {
  document.body.replaceChildren()
  Object.defineProperty(HTMLDialogElement.prototype, 'show', {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute('open', '') }
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute('open', ''); this.setAttribute('data-test-modal-shown', '') }
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) }
  })
})
afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('overlay modality', () => {
  it('keeps the modal default: showModal, focus goes in, modalOpen() sees it', () => {
    const button = document.createElement('button')
    document.body.append(button)
    const overlay = openOverlay({ label: 'x', initialFocus: () => button })
    expect(overlay.root.hasAttribute('data-test-modal-shown')).toBe(true)
    expect(overlay.root.dataset.modal).toBe('true')
    expect(modalOpen()).toBe(true)
    overlay.close()
    expect(modalOpen()).toBe(false)
  })

  it('opens non-modal cards without stealing focus and without blocking shortcuts', () => {
    const editor = document.createElement('textarea')
    document.body.append(editor)
    editor.focus()
    const overlay = openOverlay({ label: 'card', modal: false, initialFocus: () => editor })
    expect(overlay.root.dataset.modal).toBe('false')
    expect(overlay.root.hasAttribute('data-test-modal-shown')).toBe(false)
    expect(modalOpen()).toBe(false)
    expect(document.activeElement).toBe(editor)
    overlay.close()
  })

  it('lets Escape through for a non-modal card unless focus is inside the card', () => {
    const overlay = openOverlay({ label: 'card', modal: false })
    const inside = document.createElement('button')
    overlay.root.append(inside)
    const pressed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(pressed)
    expect(overlay.isOpen()).toBe(true)
    inside.focus()
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(handled)
    expect(overlay.isOpen()).toBe(false)
  })

  it('writes className before show so the first frame is the final state', () => {
    const seen: string[] = []
    Object.defineProperty(HTMLDialogElement.prototype, 'show', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        seen.push(this.className)
        this.setAttribute('open', '')
      }
    })
    const overlay = openOverlay({ label: 'card', modal: false, className: 'overlay-write-confirm write-confirm' })
    expect(seen[0]).toContain('overlay')
    expect(seen[0]).toContain('overlay-write-confirm')
    expect(seen[0]).toContain('write-confirm')
    overlay.close()
  })

  it('restores focus and closes the previous overlay only for modals', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const first = openOverlay({ label: 'first', modal: false })
    const second = openOverlay({ label: 'second' })
    expect(first.isOpen()).toBe(false)
    expect(modalOpen()).toBe(true)
    second.close()
    expect(document.activeElement).toBe(trigger)
  })
})
