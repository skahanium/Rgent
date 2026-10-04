// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultCatalogEntry, VaultCatalogView } from '../../src/shared/vault-management.ts'
import type { Overlay } from '../../src/renderer/src/overlay.ts'

import { mountVaultManager } from '../../src/renderer/src/vault-manager.ts'
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const entry = (id: string, pinned = false, lastUsed: number | null = null): VaultCatalogEntry => ({
  id, label: `库 ${id}`, path: `/笔记/${id}`, rootIdentity: `root-${id}`, pinned, lastUsed
})
const view = (entries: VaultCatalogEntry[] = [], diagnostic: string | null = null): VaultCatalogView & { activeId?: string } => ({
  entries, diagnostic, revision: 'r1', lastVaultId: entries[0]?.id ?? null
})
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let overlays: Overlay[] = []
beforeEach(() => {
  document.body.replaceChildren()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
})
afterEach(() => { overlays.forEach(item => item.close()); overlays = [] })
function start(catalog = view(), overrides: Record<string, unknown> = {}) {
  expect(mountVaultManager, '嵌入库页入口尚未实现').toBeTypeOf('function')
  const handlers = { get: vi.fn(async () => catalog), open: vi.fn(async () => {}), pick: vi.fn(async () => {}), change: vi.fn(async () => catalog), ...overrides }
  const root = document.createElement('dialog'); document.body.append(root); root.showModal()
  const page = mountVaultManager({ body: root, isCurrent: () => root.open }, handlers)
  const overlay = { root, isOpen: () => root.open, close: () => { page.dispose(); root.close(); root.remove() } }
  overlays.push(overlay)
  const button = (name: string, root: ParentNode = overlay.root) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name)!
  const row = (id: string) => overlay.root.querySelector<HTMLElement>(`[data-vault-id="${id}"]`)!
  return { overlay, page, handlers, button, row }
}

describe('embedded vault settings page', () => {
  it('shows a truthful empty catalog and keeps manual open and create available', async () => {
    const { overlay, handlers, button } = start()
    await flush()
    expect(overlay.root.textContent).toContain('还没有登记笔记库')
    button('打开已有笔记库').click(); await flush()
    expect(handlers.pick).toHaveBeenCalledWith(false)
    expect(overlay.isOpen()).toBe(true)
  })
  it('shows damaged catalog diagnostic without inventing empty history and permits manual open', async () => {
    const { overlay, handlers, button } = start(view([], 'VAULT_CATALOG_INVALID'))
    await flush()
    expect(overlay.root.textContent).toContain('库列表无法读取')
    expect(overlay.root.textContent).not.toContain('还没有登记')
    expect(overlay.root.textContent).not.toContain('VAULT_CATALOG_INVALID')
    button('打开已有笔记库').click(); await flush()
    expect(handlers.pick).toHaveBeenCalledWith(false)
  })
  it('orders fixed and recent libraries, retains unused registered libraries, and marks only activeId', async () => {
    const catalog = { ...view([entry('old', false, 1), entry('never'), entry('new', false, 5), entry('pin', true, 2)]), activeId: 'new' }
    const { overlay, row } = start(catalog); await flush()
    expect([...overlay.root.querySelectorAll<HTMLElement>('[data-vault-id]')].map(item => item.dataset.vaultId)).toEqual(['new', 'pin', 'old', 'never'])
    expect(row('new').textContent).toContain('正在使用')
    expect(row('old').textContent).not.toContain('正在使用')
  })
  it('retains the same focused name input and unsaved value when saving fails', async () => {
    const failure = deferred<VaultCatalogView>()
    const { overlay, row, button, handlers } = start(view([entry('a')]), { change: vi.fn(() => failure.promise) }); await flush()
    button('编辑显示名称', row('a')).click()
    const input = row('a').querySelector<HTMLInputElement>('input')!; input.focus(); input.value = '新名称'; input.dispatchEvent(new Event('input'))
    button('保存名称', row('a')).click()
    expect(handlers.change).toHaveBeenCalledWith({ id: 'a', revision: 'r1', action: 'label', label: '新名称' })
    expect(document.activeElement).toBe(input)
    failure.reject(Error('SECRET_INTERNAL_ERROR')); await flush()
    expect(row('a').querySelector('input')).toBe(input); expect(input.value).toBe('新名称'); expect(document.activeElement).toBe(input)
    expect(overlay.root.textContent).toContain('操作未完成'); expect(overlay.root.textContent).not.toContain('SECRET_INTERNAL_ERROR')
  })
  it('requires explicit removal confirmation and explains library files and memory are retained', async () => {
    const { handlers, row, button } = start(view([entry('a')])); await flush(); button('编辑显示名称', row('a')).click()
    button('更多', row('a')).click(); button('从列表移除', row('a')).click()
    expect(handlers.change).not.toHaveBeenCalled()
    expect(row('a').textContent).toContain('笔记、账本和记忆均保留')
    button('取消移除', row('a')).click(); expect(handlers.change).not.toHaveBeenCalled()
    button('更多', row('a')).click(); button('从列表移除', row('a')).click(); button('确认从列表移除', row('a')).click(); await flush()
    expect(handlers.change).toHaveBeenCalledWith({ id: 'a', revision: 'r1', action: 'remove' })
  })
  it('prevents repeated or concurrent operations while showing readable progress', async () => {
    const pending = deferred<void>()
    const { handlers, overlay, button, row } = start(view([entry('a')]), { open: vi.fn(() => pending.promise) }); await flush()
    button('切换', row('a')).click(); button('切换', row('a')).click(); button('新建笔记库').click()
    expect(handlers.open).toHaveBeenCalledTimes(1); expect(handlers.pick).not.toHaveBeenCalled()
    expect(overlay.root.getAttribute('aria-busy')).toBe('true'); expect(overlay.root.textContent).toContain('正在切换笔记库')
    pending.resolve(); await flush(); expect(overlay.isOpen()).toBe(true)
  })
  it('keeps cancellation quiet and explains open failures without exposing raw errors', async () => {
    const { overlay, row, button, handlers } = start(view([entry('a')]), { open: vi.fn(async () => { throw Error('VAULT_SWITCH_CANCELLED') }) }); await flush()
    button('切换', row('a')).click(); await flush(); expect(overlay.isOpen()).toBe(true)
    expect(overlay.root.querySelector('[role="status"]')!.textContent).toBe('')
    handlers.open.mockImplementation(async () => { throw Error('VAULT_TARGET_CHANGED') })
    button('切换', row('a')).click(); await flush()
    expect(overlay.root.textContent).toContain('库的位置或身份发生变化'); expect(overlay.root.textContent).not.toContain('VAULT_TARGET_CHANGED')
  })
  it('ignores a late initial catalog after the overlay is closed', async () => {
    const pending = deferred<VaultCatalogView>()
    const { overlay } = start(view(), { get: vi.fn(() => pending.promise) }); overlay.close()
    const before = overlay.root.textContent
    pending.resolve(view([entry('late')])); await flush()
    expect(overlay.root.textContent).toBe(before); expect(document.querySelector('.vault-settings')).toBeNull()
  })
  it('keeps newer typing and focus after a late successful name change', async () => {
    const pending = deferred<VaultCatalogView>()
    const { row, button } = start(view([entry('a')]), { change: vi.fn(() => pending.promise) }); await flush(); button('编辑显示名称', row('a')).click()
    const input = row('a').querySelector<HTMLInputElement>('input')!; input.focus(); input.value = '先提交'; input.dispatchEvent(new Event('input')); button('保存名称', row('a')).click()
    input.value = '后来继续编辑'; input.dispatchEvent(new Event('input')); input.setSelectionRange(2, 4)
    pending.resolve({ ...view([{ ...entry('a'), label: '先提交' }]), revision: 'r2' }); await flush()
    expect(row('a').querySelector('input')).toBe(input); expect(input.value).toBe('后来继续编辑'); expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(2)
  })
  it('ignores a late change after the embedded page is disposed', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
    const pending = deferred<VaultCatalogView>()
    const { row, button, overlay } = start(view([entry('a')]), { change: vi.fn(() => pending.promise) }); await flush(); button('编辑显示名称', row('a')).click(); button('更多', row('a')).click(); button('固定', row('a')).click(); overlay.close()
    const before = overlay.root.textContent; pending.resolve(view([entry('a', true)])); await flush()
    expect(overlay.root.textContent).toBe(before); expect(document.querySelector('.vault-settings')).toBeNull()
  })
  it('retains active library and edited nodes when fixed sorting changes', async () => {
    const catalog = { ...view([entry('a', false, 1), entry('b', false, 2)]), activeId: 'a' }
    const { overlay, row, button, handlers } = start(catalog, { change: vi.fn(async () => view([entry('a', true, 1), entry('b', false, 2)])) }); await flush(); button('编辑显示名称', row('a')).click()
    const input = row('a').querySelector<HTMLInputElement>('input')!; input.focus(); input.value = '保留草稿'; input.dispatchEvent(new Event('input'))
    button('更多', row('a')).click(); button('固定', row('a')).click(); await flush()
    expect(handlers.change).toHaveBeenCalledWith({ id: 'a', revision: 'r1', action: 'pin', pinned: true })
    expect([...overlay.root.querySelectorAll<HTMLElement>('[data-vault-id]')].map(item => item.dataset.vaultId)).toEqual(['a', 'b'])
    expect(row('a').textContent).toContain('正在使用'); expect(document.activeElement).toBe(input); expect(input.value).toBe('保留草稿')
  })
  it('returns focus to management after removing the focused row', async () => {
    const { row, button, overlay } = start(view([entry('a')]), { change: vi.fn(async () => view()) }); await flush(); button('编辑显示名称', row('a')).click()
    button('更多', row('a')).click(); button('从列表移除', row('a')).click(); button('确认从列表移除', row('a')).click(); await flush()
    expect(overlay.root.querySelector('[data-vault-id="a"]')).toBeNull(); expect(document.activeElement).toBe(button('打开已有笔记库'))
  })
  it('uses the existing empty-create picker and retains a failed creation for retry', async () => {
    const { overlay, handlers, button } = start(view(), { pick: vi.fn(async () => { throw Error('bad disk') }) }); await flush()
    button('新建笔记库').click(); await flush(); expect(handlers.pick).toHaveBeenCalledWith(true); expect(overlay.isOpen()).toBe(true)
    expect(overlay.root.textContent).toContain('操作未完成')
  })
  it('relocates through the handler with catalog revision and keeps management inputs', async () => {
    const { row, button, handlers } = start(view([entry('a')])); await flush(); button('编辑显示名称', row('a')).click()
    const input = row('a').querySelector('input'); button('更多', row('a')).click(); button('重新定位', row('a')).click(); await flush()
    expect(handlers.change).toHaveBeenCalledWith({ id: 'a', revision: 'r1', action: 'relocate' }); expect(row('a').querySelector('input')).toBe(input)
  })

  it.each([
    ['ACTIVE_VAULT_RELOCATE', '当前库正在使用'],
    ['VAULT_NESTED', '不能互相包含'],
    ['VAULT_ALREADY_REGISTERED', '已经登记'],
    ['VAULT_REPLACED', '库的位置或身份发生变化'],
    ['VAULT_NOT_REGISTERED', '库列表已变化'],
    ['VAULT_CATALOG_LIMIT', '库列表已达到容量上限']
  ])('translates Electron-wrapped %s to a concrete message', async (code, message) => {
    const { overlay, button } = start(view(), { pick: vi.fn(async () => { throw Error(`Error invoking remote method: Error: ${code}`) }) }); await flush()
    button('打开已有笔记库').click(); await flush()
    expect(overlay.root.textContent).toContain(message); expect(overlay.root.textContent).not.toContain(code)
  })
  it('reports failed catalog loading and allows manual open without empty history', async () => {
    const { overlay, handlers, button } = start(view(), { get: vi.fn(async () => { throw Error('private failure') }) }); await flush()
    expect(overlay.root.textContent).toContain('库列表无法读取'); expect(overlay.root.textContent).not.toContain('还没有登记'); expect(overlay.root.textContent).not.toContain('private failure')
    button('打开已有笔记库').click(); await flush(); expect(handlers.pick).toHaveBeenCalledWith(false)
  })

  it.each([
    ['打开已有笔记库', false, 'VAULT_SWITCH_CANCELLED'],
    ['新建笔记库', true, 'VAULT_SWITCH_CANCELLED'],
    ['打开已有笔记库', false, 'picker failed'],
    ['新建笔记库', true, 'picker failed']
  ])('accepts the pending initial catalog after %s (create=%s) ends with %s', async (action, create, error) => {
    const initial = deferred<VaultCatalogView>()
    const { overlay, handlers, row, button } = start(view(), {
      get: vi.fn(() => initial.promise), pick: vi.fn(async () => { throw Error(error) })
    })
    button(action).click(); await flush()
    expect(handlers.pick).toHaveBeenCalledWith(create); expect(overlay.isOpen()).toBe(true)
    initial.resolve(view([entry('a')])); await flush()
    expect(row('a')).not.toBeNull(); expect(overlay.root.textContent).not.toContain('正在读取库列表')
    expect(overlay.root.querySelector('[role="status"]')!.textContent).toBe(error === 'VAULT_SWITCH_CANCELLED' ? '' : '操作未完成。请检查笔记库位置与访问权限后再试。')
    button('编辑显示名称', row('a')).click(); expect(row('a').querySelector<HTMLElement>('.vault-settings-name')!.hidden).toBe(false)
    expect(handlers.open).not.toHaveBeenCalled()
  })
  it('shows late initial catalog failure after a cancelled picker rather than keeping loading forever', async () => {
    const initial = deferred<VaultCatalogView>()
    const { overlay, button } = start(view(), {
      get: vi.fn(() => initial.promise), pick: vi.fn(async () => { throw Error('VAULT_SWITCH_CANCELLED') })
    })
    button('打开已有笔记库').click(); await flush(); initial.reject(Error('catalog failed')); await flush()
    expect(overlay.root.querySelector<HTMLElement>('.vault-settings-empty')!.hidden).toBe(true)
    expect(overlay.root.querySelector<HTMLElement>('.vault-settings-diagnostic')!.hidden).toBe(false)
    expect(overlay.root.textContent).toContain('库列表无法读取')
    expect(overlay.root.querySelector('[role="status"]')!.textContent).toBe(''); expect(overlay.isOpen()).toBe(true)
  })
  it('keeps catalog controls disabled when the initial read finishes before picker cancellation', async () => {
    const initial = deferred<VaultCatalogView>(); const picker = deferred<void>()
    const { overlay, row, button, handlers } = start(view(), { get: vi.fn(() => initial.promise), pick: vi.fn(() => picker.promise) })
    button('打开已有笔记库').click(); await flush(); initial.resolve(view([entry('a')])); await flush()
    expect(row('a')).not.toBeNull(); expect(button('切换', row('a')).disabled).toBe(true)
    button('切换', row('a')).click(); expect(handlers.open).not.toHaveBeenCalled()
    picker.reject(Error('VAULT_SWITCH_CANCELLED')); await flush()
    expect(button('切换', row('a')).disabled).toBe(false); expect(overlay.isOpen()).toBe(true)
    expect(overlay.root.querySelector('[role="status"]')!.textContent).toBe('')
  })

  it.each([
    ['UNSAVED_DRAFT', '笔记草稿尚未保存，已留在当前库。请先处理保存问题，再重试切换。'],
    ['PREVIOUS_TASK_UNSAVED', '生成回答尚未保存，已留在原库。请先处理保存问题，再重试切换。'],
    ['VAULT_TARGET_INVALID', '无法打开所选位置。请检查目录是否存在及访问权限后重试。']
  ])('keeps the overlay and provides recovery steps for %s', async (code, message) => {
    const { overlay, handlers, row, button } = start(view([entry('a')]), {
      open: vi.fn(async () => { throw Error(`Error invoking remote method: Error: ${code}`) })
    }); await flush()
    button('编辑显示名称', row('a')).click()
    const input = row('a').querySelector<HTMLInputElement>('input')!; input.value = '还在编辑的名称'; input.dispatchEvent(new Event('input'))
    button('切换', row('a')).click(); await flush()
    expect(overlay.isOpen()).toBe(true); expect(row('a').querySelector('input')).toBe(input); expect(input.value).toBe('还在编辑的名称')
    expect(overlay.root.querySelector('[role="status"]')!.textContent).toBe(message)
    expect(overlay.root.textContent).not.toContain(code); expect(button('切换', row('a')).disabled).toBe(false)
    handlers.open.mockImplementation(async () => {})
    button('切换', row('a')).click(); await flush(); expect(handlers.open).toHaveBeenCalledTimes(2); expect(overlay.isOpen()).toBe(true)
  })

})

 it('does not switch from names and disables active relocate with explanation', async () => {
  const { row, button, handlers, page } = start({ ...view([entry('a'), entry('b')]), activeId: 'a' }); await flush()
  row('b').querySelector<HTMLElement>('.vault-settings-label')!.click(); expect(handlers.open).not.toHaveBeenCalled()
  expect(row('a').querySelector('[data-vault-open]')).toBeNull()
  button('更多', row('a')).click(); expect(button('重新定位', row('a')).disabled).toBe(true)
  expect(row('a').textContent).toContain('先切换到其他库')
  button('编辑显示名称', row('a')).click(); const input = row('a').querySelector<HTMLInputElement>('input')!
  input.value='更名'; input.dispatchEvent(new Event('input')); expect(page.isDirty()).toBe(true)
  button('取消',row('a')).click(); expect(page.isDirty()).toBe(false)
 })

it('explains that removing the active registration keeps the current library open',async()=>{
 const {overlay,row,button}=start({...view([entry('a')]),activeId:'a'},{change:async()=>({...view(),activeId:null})}); await flush()
 button('更多',row('a')).click();button('从列表移除',row('a')).click();button('确认从列表移除',row('a')).click();await flush()
 expect(overlay.root.querySelector('[role="status"]')!.textContent).toContain('当前笔记库仍保持打开')
 expect(overlay.isOpen()).toBe(true)
})

it('retains rename and path expansion after catalog conflicts',async()=>{
 const {row,button,overlay}=start(view([entry('a')]),{change:async()=>{throw Error('VAULT_CATALOG_CONFLICT')}});await flush()
 button('更多',row('a')).click();button('编辑显示名称',row('a')).click()
 const path=row('a').querySelector<HTMLDetailsElement>('details')!;path.open=true
 const input=row('a').querySelector<HTMLInputElement>('input')!;input.value='冲突草稿';input.focus();input.dispatchEvent(new Event('input'));button('保存名称',row('a')).click();await flush()
 expect(path.open).toBe(true);expect(input.value).toBe('冲突草稿');expect(document.activeElement).toBe(input)
 expect(overlay.root.querySelector('[role="status"]')!.textContent).toContain('库列表已在别处更新')
})

it('retains settings drafts and explains how to resolve a deferred body conflict before switching', async () => {
 const {row,button,overlay,page}=start(view([entry('a')]),{open:async()=>{throw Error('VAULT_SWITCH_BODY_CONFLICT')}});await flush()
 button('更多',row('a')).click();button('编辑显示名称',row('a')).click()
 const path=row('a').querySelector<HTMLDetailsElement>('details')!;path.open=true
 const input=row('a').querySelector<HTMLInputElement>('input')!;input.value='未保存名称';input.focus();input.dispatchEvent(new Event('input'));input.setSelectionRange(1,3)
 button('切换',row('a')).click();await flush()
 expect(overlay.isOpen()).toBe(true);expect(row('a').querySelector('input')).toBe(input);expect(row('a').querySelector('details')).toBe(path)
 expect(input.value).toBe('未保存名称');expect(path.open).toBe(true);expect(document.activeElement).toBe(input);expect([input.selectionStart,input.selectionEnd]).toEqual([1,3])
 expect(page.isBusy()).toBe(false);expect(page.isDirty()).toBe(true)
 expect(overlay.root.querySelector('[role="status"]')!.textContent).toBe('窗口稿与磁盘稿发生冲突，两份均已保留。请先关闭设置，处理正文保存冲突后，再重试切换。')
 expect(overlay.root.textContent).not.toContain('VAULT_SWITCH_BODY_CONFLICT')
})
it('shows recovery authorization in the existing vault page and supports paused progress',async()=>{
 const root=document.createElement('div');document.body.append(root);const repair=vi.fn(async(request:import('../../src/shared/ledger.ts').LedgerRepairRequest):Promise<import('../../src/shared/ledger.ts').LedgerRepairResult>=>request.action==='preview'?{ok:true,value:{id:'preview',sessionId:'session',mode:'restore',canCommit:true,warning:'确认授权新关联，不证明同一物理文件',rows:[{noteId:'n',relPath:'a.md',outcome:'history-only',reasons:['附件证明不足'],sources:[]}]}}:{ok:true,value:{status:'pending',revision:'revision',processed:4,total:6}})
 const page=mountVaultManager({body:root,isCurrent:()=>true},{get:async()=>({...view([entry('a')]),activeId:'a'}),open:async()=>{},pick:async()=>{},change:async()=>view([]),recovery:{state:async()=>({sessionId:'session',status:'ready',revision:null,items:[]}),repair}})
 await flush();const click=(text:string)=>[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!.click()
 click('预览整库恢复');await flush();expect(root.textContent).toContain('不证明同一物理文件');expect(root.textContent).toContain('附件证明不足')
 click('确认授权新关联');await flush();expect(repair).toHaveBeenLastCalledWith({sessionId:'session',action:'commit',previewId:'preview'});expect(root.textContent).toContain('可暂停并离开本库');expect(page.isBusy()).toBe(false)
 page.dispose()
})
it('cancels an uncommitted recovery and ignores its late preview after leaving the page',async()=>{
 const root=document.createElement('div');document.body.append(root);let release!:(value:import('../../src/shared/ledger.ts').LedgerRepairResult)=>void
 const preview={ok:true as const,value:{id:'preview',sessionId:'session',mode:'restore' as const,canCommit:true,warning:'新关联',rows:[]}}
 let late=false;const repair=vi.fn(async(r:import('../../src/shared/ledger.ts').LedgerRepairRequest):Promise<import('../../src/shared/ledger.ts').LedgerRepairResult>=>r.action==='preview'?(late?await new Promise(resolve=>{release=resolve}):preview):{ok:true})
 const page=mountVaultManager({body:root,isCurrent:()=>true},{get:async()=>view([]),open:async()=>{},pick:async()=>{},change:async()=>view([]),recovery:{state:async()=>({sessionId:'session',status:'ready',revision:null,items:[]}),repair}})
 await flush();const click=(text:string)=>[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!.click()
 click('预览整库恢复');await flush();click('取消恢复预览');await flush();expect(repair).toHaveBeenLastCalledWith({sessionId:'session',action:'cancel',previewId:'preview'})
 late=true;click('预览整库恢复');await flush();page.dispose();const before=root.textContent;release(preview);await flush();expect(root.textContent).toBe(before)
 expect(repair.mock.calls.some(([request])=>request.action==='commit')).toBe(false)
})
