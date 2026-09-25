import { describe, expect, it } from 'vitest'
import { LEDGER_ANCHOR } from '../../src/markdown/partition.ts'
import { applySaved, diskOf, pendingWrites, type Tab } from '../../src/renderer/src/tabs.ts'

function tab(relPath: string, over: Partial<Tab> = {}): Tab {
  return {
    relPath,
    content: `内容 ${relPath}`,
    ledger: null,
    saved: `内容 ${relPath}`,
    revision: 'r0',
    dirty: false,
    ...over
  }
}

describe('tab writes', () => {
  it('writes every dirty tab, not just the one on screen', () => {
    const tabs = [
      tab('a.md', { content: 'a 改过', dirty: true }),
      tab('b.md', { content: 'b 改过', dirty: true }),
      tab('c.md')
    ]
    expect(pendingWrites(tabs, 'b.md', 'b 实时')).toEqual([
      { relPath: 'a.md', body: 'a 改过', content: 'a 改过', expectedRevision: 'r0' },
      { relPath: 'b.md', body: 'b 实时', content: 'b 实时', expectedRevision: 'r0' }
    ])
  })

  it('skips clean tabs', () => {
    expect(pendingWrites([tab('a.md'), tab('b.md')], 'a.md', '随便')).toEqual([])
  })

  it('takes the live editor text for the active tab only', () => {
    const tabs = [tab('a.md', { content: '旧', dirty: true }), tab('b.md', { content: '后台', dirty: true })]
    expect(pendingWrites(tabs, 'a.md', '实时')).toEqual([
      { relPath: 'a.md', body: '实时', content: '实时', expectedRevision: 'r0' },
      { relPath: 'b.md', body: '后台', content: '后台', expectedRevision: 'r0' }
    ])
  })

  it('falls back to stored content when no tab is active', () => {
    const tabs = [tab('a.md', { content: 'a 改过', dirty: true })]
    expect(pendingWrites(tabs, null, '编辑器里的残留')).toEqual([
      { relPath: 'a.md', body: 'a 改过', content: 'a 改过', expectedRevision: 'r0' }
    ])
  })

  it('composes the ledger onto disk without putting it in the editor body', () => {
    const ledger = `${LEDGER_ANCHOR}\n口令：旧场\n`
    const tabs = [tab('a.md', { content: '正文', ledger, dirty: true })]
    expect(pendingWrites(tabs, 'a.md', '新正文')).toEqual([
      { relPath: 'a.md', body: '新正文', content: `新正文\n${ledger}`, expectedRevision: 'r0' }
    ])
    expect(diskOf(tabs[0]!, '新正文')).toContain(LEDGER_ANCHOR)
    expect(diskOf(tabs[0]!, '新正文').startsWith('新正文')).toBe(true)
  })

  it('keeps edits made during an in-flight write dirty', () => {
    const item = tab('a.md', { content: '新改', saved: '旧', dirty: true })
    applySaved(item, '旧', 'r1')
    expect(item).toMatchObject({ content: '新改', saved: '旧', revision: 'r1', dirty: true })
    applySaved(item, '新改', 'r2')
    expect(item).toMatchObject({ saved: '新改', revision: 'r2', dirty: false })
  })
})
