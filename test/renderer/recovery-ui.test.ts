// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { mountVaultManager } from '../../src/renderer/src/vault-manager.ts'
import type { RecoveryScanResult } from '../../src/shared/ipc.ts'
import type { VaultCatalogView } from '../../src/shared/vault-management.ts'

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const catalog = (): VaultCatalogView & { activeId?: string } => ({ entries: [], diagnostic: null, revision: 'r1', lastVaultId: null })
beforeEach(() => {
  document.body.replaceChildren()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
})
function start(scan: () => Promise<RecoveryScanResult>, confirm: (relPath: string) => Promise<import('../../src/shared/ipc.ts').RecoveryConfirmResult> = async () => ({ ok: true as const, verdict: 'restored' as const, restored: true, message: '核验通过：内容、附件与权限档都与记录一致；该对象与相关来源恢复可用。' })) {
  const handlers = {
    get: vi.fn(async () => catalog()), open: vi.fn(async () => {}), pick: vi.fn(async () => {}), change: vi.fn(async () => catalog()),
    externalRecovery: { scan: vi.fn(scan), confirm: vi.fn(confirm) }
  }
  const root = document.createElement('dialog'); document.body.append(root); root.showModal()
  const page = mountVaultManager({ body: root, isCurrent: () => root.open }, handlers)
  const button = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name)
  return { root, page, handlers, button, text: () => root.textContent ?? '' }
}

it('rescans external disappearances and offers the verification entry, reporting every branch honestly', async () => {
  const scan = vi.fn(async (): Promise<RecoveryScanResult> => ({ ok: true, value: { sessionId: 's1', rows: [
    { relPath: 'a.md', verdict: 'restored', message: '内容、附件与权限档都与记录一致，可以核验恢复。', canRestore: true },
    { relPath: 'b.md', verdict: 'content-changed', message: '内容与登记记录不一致；对象与来源对 AI 保持失效，且不自动遗忘记忆。', canRestore: false },
    { relPath: 'c.md', verdict: 'attachments-missing', message: '同名附件夹没有一起放回；这是降级状态，不冒充核验通过。', canRestore: false }
  ] } }))
  const { button, text } = start(scan)
  await flush()
  expect(button('重扫并核验恢复')).toBeTruthy()
  button('重扫并核验恢复')!.click(); await flush()
  expect(scan).toHaveBeenCalledTimes(1)
  expect(text()).toContain('a.md · 可以核验恢复')
  expect(text()).toContain('内容已变')
  expect(text()).toContain('附件夹缺失（降级）')
  expect(text()).toContain('不自动遗忘记忆')
  // 只有全部分支通过的那一条才有核验恢复入口；降级与内容已变不许冒充通过。
  const confirmButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-recovery-confirm]')]
  expect(confirmButtons.map(item => item.dataset.recoveryConfirm)).toEqual(['a.md'])
  expect(text()).not.toMatch(/删除|废纸篓|移入回收站/)
})

it('confirms a passing verification, rescans afterwards and never shows a deletion entry', async () => {
  let pass = false
  const scan = vi.fn(async (): Promise<RecoveryScanResult> => ({ ok: true, value: { sessionId: 's1', rows: pass ? [] : [
    { relPath: 'a.md', verdict: 'restored', message: '内容、附件与权限档都与记录一致，可以核验恢复。', canRestore: true }
  ] } }))
  const confirm = vi.fn(async (relPath: string) => { pass = true; return { ok: true as const, verdict: 'restored' as const, restored: true, message: `核验通过：${relPath}` } })
  const { button, text, root, handlers } = start(scan, confirm)
  await flush()
  button('重扫并核验恢复')!.click(); await flush()
  root.querySelector<HTMLButtonElement>('[data-recovery-confirm="a.md"]')!.click(); await flush()
  expect(handlers.externalRecovery.confirm).toHaveBeenCalledWith('a.md')
  expect(scan).toHaveBeenCalledTimes(2)
  expect(text()).toContain('没有已登记对象在库外消失')
  expect(root.querySelector('[data-recovery-confirm]')).toBeNull()
  expect(text()).not.toMatch(/删除|废纸篓|移入回收站/)
})
