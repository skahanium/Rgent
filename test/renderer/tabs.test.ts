import { describe, expect, it } from 'vitest'
import { pendingWrites, type Tab } from '../../src/renderer/src/tabs.ts'

function tab(relPath: string, over: Partial<Tab> = {}): Tab {
  return { relPath, content: `内容 ${relPath}`, saved: `内容 ${relPath}`, dirty: false, ...over }
}

describe('tab writes', () => {
  it('writes every dirty tab, not just the one on screen', () => {
    const tabs = [
      tab('a.md', { content: 'a 改过', dirty: true }),
      tab('b.md', { content: 'b 改过', dirty: true }),
      tab('c.md')
    ]
    expect(pendingWrites(tabs, 'b.md', 'b 实时')).toEqual([
      { relPath: 'a.md', content: 'a 改过' },
      { relPath: 'b.md', content: 'b 实时' }
    ])
  })

  it('skips clean tabs', () => {
    expect(pendingWrites([tab('a.md'), tab('b.md')], 'a.md', '随便')).toEqual([])
  })

  it('takes the live editor text for the active tab only', () => {
    const tabs = [tab('a.md', { content: '旧', dirty: true }), tab('b.md', { content: '后台', dirty: true })]
    expect(pendingWrites(tabs, 'a.md', '实时')).toEqual([
      { relPath: 'a.md', content: '实时' },
      { relPath: 'b.md', content: '后台' }
    ])
  })

  it('falls back to stored content when no tab is active', () => {
    const tabs = [tab('a.md', { content: 'a 改过', dirty: true })]
    expect(pendingWrites(tabs, null, '编辑器里的残留')).toEqual([{ relPath: 'a.md', content: 'a 改过' }])
  })
})
