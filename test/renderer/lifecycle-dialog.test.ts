// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openLifecycleStatus } from '../../src/renderer/src/dialogs.ts'
import type { LifecycleStatus } from '../../src/shared/ipc.ts'

beforeEach(() => {
  document.body.replaceChildren()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true,
    value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
})
const pending: LifecycleStatus = {
  sessionId: 'session', status: 'pending', revision: 'a'.repeat(64),
  operation: { kind: 'note', source: '原篇.md', target: '归档/原篇.md' },
  reason: 'recovery-required', items: [
    { from: '原篇.md', to: '归档/原篇.md', state: 'moved' },
    { from: '原篇/图.png', to: '归档/原篇/图.png', state: 'source' },
    { from: '原篇/新图.png', to: '归档/原篇/新图.png', state: 'blocked' }
  ]
}
describe('lifecycle recovery dialog', () => {
  it('shows per-object progress and retry errors without clearing the record', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
    const retry = vi.fn(async () => ({ status: pending, message: '对象已变化，恢复记录保留。' }))
    const overlay = openLifecycleStatus(pending, retry)
    await Promise.resolve()
    expect(document.activeElement?.textContent).toBe('关闭')
    expect(overlay.root.textContent).toContain('已移动')
    expect(overlay.root.textContent).toContain('待移动')
    expect(overlay.root.textContent).toContain('无法核验')
    expect(overlay.root.textContent).not.toMatch(/强制完成|清空记录/)
    const retryButton = overlay.root.querySelector<HTMLButtonElement>('.lifecycle-retry')!
    retryButton.focus(); retryButton.click()
    await vi.waitFor(() => expect(overlay.root.querySelector('[role="status"]')?.textContent).toContain('恢复记录保留'))
    expect(document.activeElement).toBe(retryButton)
    expect(retry).toHaveBeenCalledWith({ sessionId: pending.sessionId, revision: pending.revision })
    overlay.close()
    expect(document.activeElement).toBe(trigger)
  })
  it('keeps keyboard focus inside after success and uses a visible return target', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
    const fallback = document.createElement('button'); document.body.append(fallback)
    const overlay = openLifecycleStatus(pending, async () => {
      trigger.hidden = true
      return { status: { ...pending, status: 'ready', items: [] } }
    }, () => fallback)
    await Promise.resolve()
    const again = overlay.root.querySelector<HTMLButtonElement>('.lifecycle-retry')!
    again.focus(); again.click()
    await vi.waitFor(() => expect(overlay.root.querySelector('.lifecycle-retry')).toBeNull())
    expect(document.activeElement?.textContent).toBe('关闭')
    overlay.close()
    expect(document.activeElement).toBe(fallback)
  })
  it('does not offer retry for an invalid record or interpret paths as HTML', () => {
    const invalid = openLifecycleStatus({ ...pending, status: 'invalid', items: [], reason: 'journal-invalid' }, vi.fn())
    expect(invalid.root.querySelector('.lifecycle-retry')).toBeNull()
    expect(invalid.root.textContent).toContain('损坏')
    invalid.close()
    const overlay = openLifecycleStatus({ ...pending, items: [{ from: '<img src=x>', to: '<script>x</script>', state: 'blocked' }] }, vi.fn())
    expect(overlay.root.querySelector('img, script')).toBeNull()
    expect(overlay.root.textContent).toContain('<img src=x>')
    overlay.close()
  })
})
