// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderTree } from '../../src/renderer/src/tree.ts'

beforeEach(() => { document.body.replaceChildren() })

describe('file tree actions', () => {
  it('offers note relocation and a folder target without exposing deletion before its safety gate', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const action = vi.fn()
    renderTree(host, [{ name: '甲.md', relPath: '甲.md', kind: 'note' }], null, () => {}, undefined, action)
    host.querySelector('.tree-note')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }))
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(labels).toContain('改名')
    expect(labels).toContain('移动')
    expect(labels).not.toContain('删除')
    ;(document.querySelector('[role="menuitem"]') as HTMLButtonElement).click()
    expect(action).toHaveBeenCalled()
  })
})
