import { describe, expect, it } from 'vitest'
import { AI_MARKER, PROMPT_MARKER, compile, planWidgets } from '../../src/markdown/index.ts'

const AI = AI_MARKER
const PROMPT = PROMPT_MARKER

const source = `人写的一段。\n\n${AI}\nAI 写的回答。\n\n${PROMPT}\n把上周的会议整理成周报。\n\n${AI}\n第二段 AI 的话。\n`
const index = compile(source).index

function plan(doc = source, viewport?: { from: number; to: number }) {
  const port = viewport ?? { from: 0, to: doc.length }
  return planWidgets(compile(doc).index, doc, [port]).filter((widget) => widget.kind === 'marker')
}

describe('marker chips', () => {
  it('plans one chip per marker, over the comment text only', () => {
    const chips = plan()
    expect(chips).toHaveLength(3)
    for (const chip of chips) {
      expect(chip.kind).toBe('marker')
      if (chip.kind !== 'marker') continue
      // 只换注释本身，不连整行一起换：块级替换会吞掉紧随其后的行装饰。
      expect(source.slice(chip.range.start, chip.range.end)).toBe(
        chip.marker.identity === 'ai' ? AI : PROMPT
      )
    }
  })

  it('offers accept, discard and both moves for an AI block, and no buttons for a prompt', () => {
    const chips = plan()
    const ai = chips[0]
    const prompt = chips[1]
    if (ai?.kind !== 'marker' || prompt?.kind !== 'marker') throw new Error('计划里没有 chip')
    expect(ai.accept).not.toBeNull()
    expect(ai.discard).not.toBeNull()
    // 它上面还有一段人写的字，所以能上移。
    expect(ai.moveUp).not.toBeNull()
    expect(ai.moveDown).not.toBeNull()
    // 口令就是自己的字，没有采纳 / 丢弃可言。
    expect(prompt.accept).not.toBeNull()
    expect(prompt.discard).not.toBeNull()

    const last = chips[2]
    if (last?.kind !== 'marker') throw new Error('少了第三个 chip')
    expect(last.moveUp).not.toBeNull()
    expect(last.moveDown).toBeNull() // 最后一块没有下一块
  })

  it('plans nothing for a marker outside the viewport', () => {
    expect(plan(source, { from: source.length - 5, to: source.length })).toEqual([])
  })

  it('never overlaps two chips on the same marker', () => {
    const ranges = plan().map((chip) => chip.range)
    expect(new Set(ranges.map((range) => range.start)).size).toBe(ranges.length)
  })
})
