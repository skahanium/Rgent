import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { markdownField } from '../../src/renderer/src/view/editor.ts'

function hiddenSource(state: EditorState): string[] {
  const out: string[] = []
  state.field(markdownField).decorations.between(0, state.doc.length, (from, to, deco) => {
    if (deco.spec.rgentSyntax === 'hide') out.push(state.doc.sliceString(from, to))
  })
  return out
}

describe('live Markdown presentation', () => {
  it('opens a note in reading presentation even when its first block owns the initial caret', () => {
    const doc = '### **开头**\n\n正文。\n'
    const initial = EditorState.create({ doc, extensions: [markdownField] })
    expect(hiddenSource(initial)).toEqual(expect.arrayContaining(['### ', '**']))
  })
  it('hides inactive syntax and reveals the whole block when caret enters it', () => {
    const doc = '普通段落。\n\n### **标题**\n'
    const initial = EditorState.create({ doc, extensions: [markdownField] })
    expect(hiddenSource(initial)).toEqual(expect.arrayContaining(['### ', '**']))
    const inside = initial.update({ selection: { anchor: doc.indexOf('标题') } }).state
    expect(hiddenSource(inside)).toEqual([])
    expect(inside.doc.toString()).toBe(doc)
  })

  it('uses rendered code and frontmatter blocks until their source is selected', () => {
    const doc = '---\ntitle: 测试\n---\n\n开头。\n\n```ts\nconst x = 1\n```\n'
    const initial = EditorState.create({ doc, selection: { anchor: doc.indexOf('开头') }, extensions: [markdownField] })
    const kinds: string[] = []
    initial.field(markdownField).decorations.between(0, doc.length, (_from, _to, deco) => {
      if (deco.spec.rgentBlock) kinds.push(deco.spec.rgentBlock)
    })
    expect(kinds).toEqual(expect.arrayContaining(['frontmatter', 'code']))
    const active = initial.update({ selection: { anchor: doc.indexOf('const x') } }).state
    const nextKinds: string[] = []
    active.field(markdownField).decorations.between(0, doc.length, (_from, _to, deco) => {
      if (deco.spec.rgentBlock) nextKinds.push(deco.spec.rgentBlock)
    })
    expect(nextKinds).toContain('frontmatter')
    expect(nextKinds).not.toContain('code')
  })
})
