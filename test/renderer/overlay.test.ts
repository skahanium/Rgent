// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modalOpen, openOverlay } from '../../src/renderer/src/overlay.ts'

const STYLES = readFileSync('src/renderer/src/styles.css', 'utf8')
const overlayPickerRule = (): string => {
  const match = /(?:^|\n)\.overlay-picker \{([^}]*)\}/u.exec(STYLES)
  if (!match) throw new Error('styles.css 里找不到 .overlay-picker 规则')
  return match[1]!
}

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

  it('lets the vault picker be a host, not a second card', () => {
    const overlay = openOverlay({ label: '选择笔记库', className: 'overlay-picker' })
    expect(overlay.root.className.split(/\s+/)).toEqual(expect.arrayContaining(['overlay', 'overlay-picker']))
    overlay.close()
    const rule = overlayPickerRule()
    expect(rule).toMatch(/background:\s*transparent/)
    expect(rule).toMatch(/border:\s*none/)
    expect(rule).toMatch(/box-shadow:\s*none/)
    expect(rule).toMatch(/place-items:\s*center/)
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
    const overlay = openOverlay({ label: 'card', modal: false, className: 'overlay-sample sample-card' })
    expect(seen[0]).toContain('overlay')
    expect(seen[0]).toContain('overlay-sample')
    expect(seen[0]).toContain('sample-card')
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
