// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileBrowser } from '../../src/renderer/src/tree.ts'

beforeEach(() => { document.body.replaceChildren() })

describe('file tree actions', () => {
  it('offers note relocation without deletion unless canTrash is on', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const action = vi.fn()
    createFileBrowser(host, { onOpenNote: () => {}, onAction: action }).update([{ name: '甲.md', relPath: '甲.md', kind: 'note' }], null)
    host.querySelector('.tree-note')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }))
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(labels).toContain('改名')
    expect(labels).toContain('移动')
    expect(labels).not.toContain('删除')
    ;(document.querySelector('[role="menuitem"]') as HTMLButtonElement).click()
    expect(action).toHaveBeenCalled()
  })

  it('offers deletion only for notes when canTrash is on, never for folders', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const action = vi.fn()
    createFileBrowser(host, { onOpenNote: () => {}, onAction: action, canTrash: true }).update([
      { name: '甲.md', relPath: '甲.md', kind: 'note' },
      { name: '资料', relPath: '资料', kind: 'dir', children: [] }
    ], null)
    host.querySelector('.tree-note')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }))
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['改名', '移动', '删除'])
    document.querySelector('[role="menuitem"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    host.querySelector('.tree-dir')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 80 }))
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).not.toContain('删除')
  })
})
