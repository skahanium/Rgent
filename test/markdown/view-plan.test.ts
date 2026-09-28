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
    // 口令就是自己的字：只给「删标记」，没有丢弃，也没有搬家。
    expect(prompt.accept).not.toBeNull()
    expect(prompt.discard).toBeNull()
    expect(prompt.moveUp).toBeNull()
    expect(prompt.moveDown).toBeNull()

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

describe('image layout plan', () => {
  it('distinguishes standalone pictures from pictures inside prose', () => {
    const doc = '![独立](https://images.example/a.png)\n\n文字 ![行内](https://images.example/b.png) 后文。\n\n- ![列表中的独立图片](https://images.example/c.png)\n'
    const images = planWidgets(compile(doc).index, doc, [{ from: 0, to: doc.length }]).filter((widget) => widget.kind === 'image')
    expect(images.map((widget) => widget.kind === 'image' && widget.standalone)).toEqual([true, false, true])
  })

  it('keeps an image on its own source line block sized when prose follows without a blank line', () => {
    const doc = '前文\n![图](https://images.example/chart.png)\n后文\n'
    const image = planWidgets(compile(doc).index, doc, [{ from: 0, to: doc.length }]).find((widget) => widget.kind === 'image')
    expect(image?.kind === 'image' && image.standalone).toBe(true)
  })

  it('keeps a heading after a standalone image as a separate heading', () => {
    const doc = '![图](https://images.example/chart.png)\n## 后面的标题\n'
    const result = compile(doc)
    expect(result.index.headings.map((heading) => heading.text)).toEqual(['后面的标题'])
    const image = planWidgets(result.index, doc, [{ from: 0, to: doc.length }]).find((widget) => widget.kind === 'image')
    expect(image?.kind === 'image' && image.standalone).toBe(true)
  })

  it('presents a leading image as a block even when imported prose starts on the same source line', () => {
    const doc = '![图](https://images.example/chart.png)正文继续。\n'
    const image = planWidgets(compile(doc).index, doc, [{ from: 0, to: doc.length }]).find((widget) => widget.kind === 'image')
    expect(image?.kind === 'image' && image.standalone && image.block).toBe(true)
    expect(image?.range.end).toBe(doc.indexOf('正文'))
  })

  it('recognizes a heading following a leading image on the same source line without changing source', () => {
    const doc = '![图](https://images.example/chart.png)## 后面的标题\n'
    const result = compile(doc)
    expect(result.source).toBe(doc)
    expect(result.index.headings.map((heading) => heading.text)).toEqual(['后面的标题'])
  })

  it('keeps exact source offsets with CRLF when splitting a leading figure for reading', () => {
    const doc = '前文\r\n\r\n![图](https://images.example/chart.png)## 标题\r\n后文\r\n'
    const result = compile(doc)
    const heading = result.index.headings[0]
    const image = result.index.images[0]
    expect(doc.slice(image!.range.start, image!.range.end)).toBe('![图](https://images.example/chart.png)')
    expect(doc.slice(heading!.range.start, heading!.range.end)).toBe('## 标题')
    expect(result.source).toBe(doc)
  })
})
