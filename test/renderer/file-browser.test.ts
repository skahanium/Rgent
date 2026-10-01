// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as tree from '../../src/renderer/src/tree.ts'
import type { TreeEntry } from '../../src/shared/ipc.ts'

const entries: TreeEntry[] = [
  { kind: 'note', name: '根.md', relPath: '根.md' },
  { kind: 'dir', name: '工作', relPath: '工作', children: [
    { kind: 'note', name: '会议.md', relPath: '工作/会议.md' },
    { kind: 'file', name: '图.png', relPath: '工作/图.png' },
    { kind: 'dir', name: '会议', relPath: '工作/会议', attachmentOf: '工作/会议.md', children: [
      { kind: 'note', name: '附记.md', relPath: '工作/会议/附记.md' },
      { kind: 'file', name: '附件.pdf', relPath: '工作/会议/附件.pdf' },
      { kind: 'dir', name: '子目录', relPath: '工作/会议/子目录', children: [] }
    ] },
    { kind: 'dir', name: '普通', relPath: '工作/普通', children: [
      { kind: 'note', name: '其他.md', relPath: '工作/普通/其他.md' }
    ] }
  ] }
]
beforeEach(() => { document.body.replaceChildren(); localStorage.clear() })
function setup(key = 'library-a') {
  const host = document.createElement('div'); document.body.append(host)
  const onAction = vi.fn(), onOpenNote = vi.fn()
  const browser = tree.createFileBrowser(host, { onAction, onOpenNote })
  browser.setVault(key); browser.update(entries, '根.md')
  const row = (selector: string, path: string) => [...host.querySelectorAll<HTMLElement>(selector)].find(el => el.dataset.path === path)!
  const select = (path: string) => row('.tree-select', path).click()
  const toggle = (path: string) => row('.tree-folder-toggle', path).click()
  return { host, browser, row, select, toggle, onAction, onOpenNote }
}
describe('split file browser', () => {
  it('keeps only ordinary folders above and direct resources below', () => {
    const { host, select, toggle } = setup()
    expect(host.querySelector('.folder-scroll .tree-note')).toBeNull()
    toggle(''); toggle('工作')
    expect([...host.querySelectorAll('.tree-select')].map(el => (el as HTMLElement).dataset.path)).toEqual(['', '工作', '工作/普通'])
    select('工作')
    expect(host.querySelector('.resource-scroll')!.textContent).toContain('会议')
    expect(host.querySelector('.resource-scroll')!.textContent).toContain('图.png')
    expect(host.querySelector('.resource-scroll')!.textContent).not.toContain('其他')
    expect(host.querySelector('.resource-scroll .attachment-folder')).toBeNull()
  })
  it('selects folder names independently from expansion, retaining both on refresh', () => {
    const { host, browser, select, toggle, row } = setup()
    toggle(''); select('工作')
    expect(browser.selectedFolder).toBe('工作')
    expect(row('.tree-folder-toggle', '工作').getAttribute('aria-expanded')).toBe('false')
    toggle('工作'); browser.update(entries, '根.md')
    expect(browser.selectedFolder).toBe('工作')
    expect(row('.tree-folder-toggle', '工作').getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.tree-select[aria-current="location"]')?.textContent).toBe('工作')
  })
  it('shows and enters attachments below, preserves top selection and prevents independent relocation', () => {
    const { host, browser, select, row } = setup(); select('工作')
    ;(host.querySelector('.attachment-toggle') as HTMLElement).click()
    expect(host.querySelector('.attachment-toggle')?.getAttribute('aria-pressed')).toBe('true')
    const attachment = row('.attachment-folder', '工作/会议')
    expect(attachment.textContent).toContain('附件 · 会议')
    attachment.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    attachment.click()
    expect(browser.selectedFolder).toBe('工作')
    expect(host.querySelector('.resource-scroll')!.textContent).toContain('附件.pdf')
    expect((host.querySelector('.resource-create') as HTMLButtonElement).hidden).toBe(true)
    row('.resource-folder', '工作/会议/子目录').click()
    ;(host.querySelector('.resource-back') as HTMLElement).click()
    expect(host.querySelector('.resource-path')!.textContent).toBe('工作/会议')
    ;(host.querySelector('.attachment-toggle') as HTMLElement).click()
    expect(host.querySelector('.resource-path')!.textContent).toBe('工作')
  })
  it('does not follow active tabs and uses an icon toggle beside the resource path', () => {
    const { browser, host, select } = setup(); select('工作')
    browser.setActive('工作/普通/其他.md')
    expect(browser.selectedFolder).toBe('工作')
    const toggle = host.querySelector('.attachment-toggle')!
    expect(toggle.querySelector('svg')).not.toBeNull()
    expect(toggle.getAttribute('aria-label')).toBe('显示附件')
    expect(toggle.textContent).toBe('')
    expect(toggle.parentElement).toBe(host.querySelector('.resource-path')!.parentElement)
    expect(host.querySelector('.resource-locate')).toBeNull()
  })
  it('persists preferences by library and rejects corrupt preferences', () => {
    const a = setup(); a.toggle(''); a.select('工作')
    ;(a.host.querySelector('.attachment-toggle') as HTMLElement).click()
    const restored = setup(); expect(restored.browser.selectedFolder).toBe('工作')
    expect(restored.host.querySelector('.attachment-toggle')!.getAttribute('aria-pressed')).toBe('true')
    expect(setup('library-b').browser.selectedFolder).toBe('')
    localStorage.setItem('rgent:file-browser:v1:library-a', '{broken')
    expect(setup().browser.selectedFolder).toBe('')
  })
  it('remaps app relocations, falls back only on successful listings and keeps state on failures', () => {
    const { browser, host, select } = setup(); select('工作/普通')
    browser.fail('读取失败')
    expect(browser.selectedFolder).toBe('工作/普通')
    expect(host.querySelector('.browser-notice')!.textContent).toContain('读取失败')
    browser.relocate([{ from: '工作', to: '新工作' }])
    const moved = JSON.parse(JSON.stringify(entries).replaceAll('工作', '新工作'))
    browser.update(moved, null); expect(browser.selectedFolder).toBe('新工作/普通')
    browser.update(moved.map((e: TreeEntry) => e.kind === 'dir' ? { ...e, children: [] } : e), null)
    expect(browser.selectedFolder).toBe('新工作')
    expect(host.querySelector('.browser-notice')!.textContent).toContain('目录已变化')
  })
  it('keeps scroll positions and keyboard-adjusts an accessible separator', () => {
    const { browser, host, select } = setup(); select('工作')
    const files = host.querySelector('.resource-scroll')!; files.scrollTop = 83
    browser.update(entries, '工作/会议.md'); expect(files.scrollTop).toBe(83)
    select(''); select('工作'); expect(files.scrollTop).toBe(83)
    const separator = host.querySelector('[role="separator"]')!
    const before = Number(separator.getAttribute('aria-valuenow'))
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(Number(separator.getAttribute('aria-valuenow'))).toBeGreaterThan(before)
  })
  it('restores session scroll after changing libraries without storing scroll on disk', () => {
    const { browser, host, select } = setup(); select('工作')
    const list = host.querySelector('.resource-scroll')!; list.scrollTop = 87
    browser.setVault('library-b'); browser.update(entries, null)
    browser.setVault('library-a'); browser.update(entries, null)
    expect(list.scrollTop).toBe(87)
    expect(localStorage.getItem('rgent:file-browser:v1:library-a')).not.toContain('scroll')
    host.style.display = 'none'; list.scrollTop = 0; browser.setActive('根.md')
    host.style.display = 'block'; browser.setActive('工作/会议.md')
    expect(list.scrollTop).toBe(87)
    browser.fail('失败'); browser.setActive('根.md')
    expect((host.querySelector('.resource-create') as HTMLButtonElement).disabled).toBe(true)
    expect(host.querySelector('.browser-notice')!.textContent).toBe('失败')
  })
  it('routes create actions to the browsed ordinary directory', () => {
    const { host, select, onAction, onOpenNote, row } = setup(); select('工作')
    ;(host.querySelector('.resource-create') as HTMLElement).click()
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ relPath: '工作' }), 'new-note')
    const folderCreate = host.querySelector('.folder-create') as HTMLButtonElement
    expect(folderCreate.textContent).toBe('')
    expect(folderCreate.querySelector('svg')).not.toBeNull()
    expect(folderCreate.getAttribute('aria-label')).toBe('在 工作 新建文件夹')
    folderCreate.click()
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ relPath: '工作' }), 'new-folder')
    row('.tree-note', '工作/会议.md').click()
    expect(onOpenNote).toHaveBeenCalledWith('工作/会议.md')
  })
})
