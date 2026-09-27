import { EditorState, Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { markdownField, identityLock } from '../../src/renderer/src/view/editor.ts'

/**
 * 执法层（事务过滤器 + CM6 状态）的状态级测试，不需要 DOM。
 *
 * 这一层以前零覆盖，绕过和光标错位都藏在这里：Alt-上下移行、Ctrl-T 换位能改掉
 * 未采纳 AI 块里的字；在块下方打字补断段符之后，光标若不跟着右移，下一键会插到
 * 断段符之前，字序就乱了。
 */

const doc = '人写的一段。\n\n<!-- rgent:ai:v1 -->\nAI 写的回答。\n\n人写的第二段。\n'

function state(): EditorState {
  return EditorState.create({ doc, extensions: [markdownField, identityLock] })
}

/** 从 state 里取块范围，避免测试里硬编码偏移。 */
function ranges(from: EditorState) {
  const index = from.field(markdownField).result.index
  const ai = index.blocks.find((block) => block.identity === 'ai')!
  return { ai: ai.range, risky: doc.indexOf('\n', ai.range.end) + 1 }
}

function type(from: EditorState, at: number, text: string) {
  const tr = from.update({
    changes: { from: at, to: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: 'input.type'
  })
  return tr.state
}

describe('identity guard, state level', () => {
  it('drops typing inside an unadopted AI block', () => {
    const before = state()
    const { ai } = ranges(before)
    const after = type(before, ai.start + 2, '改')
    expect(after.doc.toString()).toBe(doc)
  })

  it('drops a transpose inside the block, which reports move.character', () => {
    // 这条就是实测里被绕过的那一下：Ctrl-T 报的是 move.character，不是 input。
    const before = state()
    const { ai } = ranges(before)
    const tr = before.update({
      changes: { from: ai.start + 1, to: ai.start + 2, insert: 'I' },
      userEvent: 'move.character'
    })
    expect(tr.state.doc.toString()).toBe(doc)
  })

  it('separates the paragraph when typing right below the block, and keeps the caret after the typed char', () => {
    const before = state()
    const { risky } = ranges(before)
    const after = type(before, risky, '我')
    expect(after.doc.toString()).toBe(
      '人写的一段。\n\n<!-- rgent:ai:v1 -->\nAI 写的回答。\n\n我\n人写的第二段。\n'
    )
    // 光标必须落在刚打的那个字之后，否则下一键会插到断段符前面去。
    expect(after.doc.sliceString(after.selection.main.anchor - 1, after.selection.main.anchor)).toBe('我')
  })

  it('keeps typing in order after the inserted break', () => {
    let current = state()
    const { risky } = ranges(current)
    current = type(current, risky, '我')
    current = type(current, current.selection.main.anchor, '写')
    current = type(current, current.selection.main.anchor, '的')
    expect(current.doc.toString()).toContain('\n我写的\n')
  })

  it('makes the freshly typed words human, not locked', () => {
    let current = state()
    const { risky } = ranges(current)
    current = type(current, risky, '我写的。')
    // 再往回改一个字：此时它在人的段落里，必须改得动。
    const at = current.doc.toString().indexOf('我写的。')
    const edited = current.update({
      changes: { from: at, to: at + 3, insert: '我的' },
      userEvent: 'input.type'
    })
    expect(edited.state.doc.toString()).toContain('我的。')
  })

  it('adopts by deleting the marker line and then allows editing the words', () => {
    const before = state()
    const marker = before.field(markdownField).result.index.markers[0]!
    const adopted = before.update({
      changes: { from: marker.range.start, to: marker.range.end + 1, insert: '' },
      userEvent: 'rgent.markerAction'
    }).state
    // 采纳之后这一段不再有身份，也就没有锁定范围。
    const index = adopted.field(markdownField).result.index
    expect(index.markers).toEqual([])
    expect(index.blocks.every((block) => block.identity === undefined)).toBe(true)
    const at = adopted.doc.toString().indexOf('AI 写的回答。')
    const edited = type(adopted, at, 'X')
    expect(edited.doc.toString()).toContain('XAI 写的回答。')
  })

  it('takes the marker with it when the whole block is deleted by hand', () => {
    const before = state()
    const { ai } = ranges(before)
    const after = before.update({
      changes: { from: ai.start, to: ai.end, insert: '' },
      userEvent: 'delete.selection'
    }).state
    expect(after.doc.toString()).not.toContain('rgent:ai:v1')
    expect(after.doc.toString()).not.toContain('AI 写的回答。')
    // 下一段人写的字没被标成 AI、也没被锁住。
    const remaining = after.field(markdownField).result.index
    expect(remaining.markers).toEqual([])
    expect(remaining.blocks.every((block) => block.identity === undefined)).toBe(true)
  })
})

describe('换笔记', () => {
  it('整篇替换把光标带回篇首，并换掉撤销历史', () => {
    const before = state()
    const { ai } = ranges(before)
    const moved = before.update({ selection: { anchor: ai.end } }).state
    expect(moved.selection.main.anchor).toBe(ai.end)
    // 与 editor.setText 同形：整篇替换 + selection 归零 + 不进历史。
    const replaced = moved.update({
      changes: { from: 0, to: moved.doc.length, insert: '另一篇。\n' },
      selection: { anchor: 0 },
      annotations: Transaction.addToHistory.of(false),
      userEvent: 'rgent.setText'
    }).state
    expect(replaced.doc.toString()).toBe('另一篇。\n')
    expect(replaced.selection.main.anchor).toBe(0)
  })
})
