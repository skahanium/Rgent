import { describe, expect, it } from 'vitest'
import { AI_MARKER, PROMPT_MARKER, compile } from '../../src/markdown/index.ts'
import { editBlocked, lockedRanges, planIdentityEdit } from '../../src/markdown/identity-lock.ts'

const AI = AI_MARKER
const PROMPT = PROMPT_MARKER

/** 语料：人写的一段、未采纳的 AI 块、口令块、再一段人写的。 */
const source = `人的甲。\n\n${AI}\nAI 的乙。\n\n${PROMPT}\n口令的丙。\n\n人的丁。\n`
const index = compile(source).index
const locked = lockedRanges(index)
const aiBlock = index.blocks[1]!.range
const promptBlock = index.blocks[2]!.range
const humanBlock = index.blocks[0]!.range
const marker = index.markers[0]!.range

const blocked = (from: number, to: number, insert?: string): boolean =>
  editBlocked([{ from, to, insert }], locked)

describe('locked ranges', () => {
  it('locks markers and unadopted AI blocks, but not prompts or human text', () => {
    const covered = (pos: number): boolean => locked.some((range) => range.start <= pos && pos < range.end)
    expect(covered(marker.start)).toBe(true)
    expect(covered(aiBlock.start)).toBe(true)
    expect(covered(humanBlock.start)).toBe(false)
    // 围栏：你的口令不是 AI 块——它就是给人改的字。
    expect(covered(promptBlock.start)).toBe(false)
    expect(locked.some((range) => range.start === promptBlock.start)).toBe(false)
  })
})

describe('edit lock', () => {
  it('blocks typing inside an unadopted AI block', () => {
    expect(blocked(aiBlock.start + 1, aiBlock.start + 1, '改')).toBe(true)
    expect(blocked(aiBlock.end, aiBlock.end, '加字')).toBe(true)
    expect(blocked(aiBlock.start, aiBlock.start, '前置')).toBe(true)
  })

  it('blocks partial deletion inside an unadopted AI block', () => {
    expect(blocked(aiBlock.start, aiBlock.end - 1, '')).toBe(true)
    expect(blocked(aiBlock.start + 2, aiBlock.start + 3, '')).toBe(true)
  })

  it('blocks typing inside the marker itself', () => {
    expect(blocked(marker.start + 2, marker.start + 2, 'x')).toBe(true)
    expect(blocked(marker.start, marker.end - 1, '')).toBe(true)
  })

  it('allows editing human text and prompts', () => {
    expect(blocked(humanBlock.start + 1, humanBlock.start + 1, '补')).toBe(false)
    expect(blocked(humanBlock.start, humanBlock.end, '整段换掉')).toBe(false)
    expect(blocked(promptBlock.start + 1, promptBlock.start + 1, '补')).toBe(false)
    expect(blocked(promptBlock.start, promptBlock.end, '')).toBe(false)
  })

  it('allows deleting a whole AI block or a whole marker, because that is discard and adopt', () => {
    expect(blocked(aiBlock.start, aiBlock.end, '')).toBe(false)
    // 采纳走的是删整行，范围比标记本身宽，也必须放行。
    expect(blocked(marker.start - 1, marker.end + 1, '')).toBe(false)
  })

  it('blocks deletions that would break the marker or merge a neighbour into the locked block', () => {
    // 删掉标记行自己的换行：注释会变成行内节点，这个块就不再是 AI 块了——等于偷偷采纳。
    expect(blocked(marker.end, marker.end + 1, '')).toBe(true)
    // 在标记行开头按退格：把标记行并进上一段，同样会毁掉标记。
    expect(blocked(marker.start - 1, marker.start, '')).toBe(true)
    // 删掉 AI 块尾的换行：下一段人的字会被并进这个被锁的块里。
    expect(blocked(aiBlock.end, aiBlock.end + 1, '')).toBe(true)
  })

  it('lets everything through when nothing is locked', () => {
    expect(editBlocked([{ from: 0, to: 10, insert: 'x' }], [])).toBe(false)
  })

  it('blocks a change that touches one locked range even when another is untouched', () => {
    expect(editBlocked([{ from: humanBlock.start, to: humanBlock.end, insert: '' }, { from: aiBlock.start + 1, to: aiBlock.start + 1, insert: 'x' }], locked)).toBe(true)
  })
})

describe('planIdentityEdit', () => {
  const plan = (changes: Array<{ from: number; to: number; insert?: string }>) =>
    planIdentityEdit(source, changes, index)

  it('lets ordinary edits in human text through untouched', () => {
    const result = plan([{ from: humanBlock.start, to: humanBlock.start, insert: '补' }])
    expect(result.blocked).toBe(false)
    expect(result.extra).toEqual([])
  })

  it('drops a transaction that would type inside an unadopted AI block', () => {
    expect(plan([{ from: aiBlock.start + 1, to: aiBlock.start + 1, insert: 'x' }]).blocked).toBe(true)
  })

  it('drops the whole transaction when any one change touches a locked range', () => {
    // 半途生效比整批拒绝更危险：人以为改了，磁盘上却只改了一半。
    const result = plan([
      { from: humanBlock.start, to: humanBlock.end, insert: '换掉' },
      { from: aiBlock.start + 1, to: aiBlock.start + 1, insert: 'x' }
    ])
    expect(result.blocked).toBe(true)
  })

  it('adopts by deleting the marker line, with no extra change', () => {
    const line = { from: marker.start, to: marker.end + 1, insert: '' }
    const result = plan([line])
    expect(result.blocked).toBe(false)
    expect(result.extra).toEqual([])
  })

  it('takes the marker with it when a whole unadopted block is deleted by hand', () => {
    // 否则标记会就近标到下一段人写的字上，把它锁住、还带一个会删掉人字的「丢弃」。
    const result = plan([{ from: aiBlock.start, to: aiBlock.end, insert: '' }])
    expect(result.blocked).toBe(false)
    // 补的正是标记那一整行（含换行）。
    expect(result.extra).toEqual([{ from: marker.start, to: marker.end + 1, insert: '' }])
  })

  it('does not add a second deletion when the marker is already inside the change', () => {
    const result = plan([{ from: marker.start - 1, to: aiBlock.end, insert: '' }])
    expect(result.blocked).toBe(false)
    expect(result.extra).toEqual([])
  })

  it('has nothing to do when no range is locked', () => {
    const plain = compile('人写的一段。\n')
    expect(planIdentityEdit('人写的一段。\n', [], plain.index)).toEqual({ blocked: false, extra: [] })
  })
})
