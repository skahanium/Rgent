import { describe, expect, it } from 'vitest'
import {
  AI_MARKER,
  PROMPT_MARKER,
  compile,
  composeSource,
  markerLine,
  parseMarker,
  partitionSource
} from '../../src/markdown/index.ts'

const AI = AI_MARKER
const PROMPT = PROMPT_MARKER

type AnyNode = { type: string; value?: string; children?: AnyNode[]; data?: Record<string, unknown> }

const treeOf = (source: string): AnyNode => compile(source).tree as AnyNode

/** 取每个顶层块的身份；缺省用 'human' 补齐，断言才读得出「这块是人写的」。 */
function identities(source: string): string[] {
  return compile(source).index.blocks.map((block) => block.identity ?? 'human')
}

describe('identity markers', () => {
  it('round-trips the two markers and their attributes', () => {
    expect(parseMarker(AI)).toEqual({ identity: 'ai', attrs: {} })
    expect(parseMarker(PROMPT)).toEqual({ identity: 'command', attrs: {} })
    expect(markerLine('ai')).toBe(AI)
    expect(markerLine('command')).toBe(PROMPT)
    expect(parseMarker(markerLine('command', { skill: '周报' }))).toEqual({
      identity: 'command',
      attrs: { skill: '周报' }
    })
  })

  it('does not mistake other HTML comments for markers', () => {
    // 不认识的注释要看得见：照旧落成一个块，不能悄悄吞掉。
    expect(parseMarker('<!-- TODO: 补一节 -->')).toBeNull()
    expect(parseMarker('<!-- rgent:ai:v2 -->')).toBeNull()
    expect(parseMarker('  <!-- rgent:ai:v1 -->  ')).toEqual({ identity: 'ai', attrs: {} })
    const result = compile('<!-- TODO -->\n正文\n')
    expect(result.index.markers).toEqual([])
    expect(result.index.blocks.map((block) => block.type)).toEqual(['html', 'paragraph'])
  })

  it('marks the block right below the marker and never lists the marker as a block', () => {
    const source = `人写的一段。\n\n${AI}\nAI 写的段落。\n\n人写的另一段。\n`
    const result = compile(source)
    expect(result.index.blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(identities(source)).toEqual(['human', 'ai', 'human'])
    expect(result.index.markers).toHaveLength(1)
    const marker = result.index.markers[0]!
    expect(marker.identity).toBe('ai')
    // 标记范围就是那一行注释本身，不含下面的正文。
    expect(source.slice(marker.range.start, marker.range.end)).toBe(AI)
  })

  it('gives the prompt its own identity', () => {
    expect(identities(`${PROMPT}\n把上周的会议整理成周报。\n\n${AI}\n好。\n`)).toEqual(['command', 'ai'])
  })

  it('marks each block with its own marker', () => {
    expect(identities(`${AI}\n第一段。\n\n${AI}\n第二段。\n\n人写的。\n`)).toEqual(['ai', 'ai', 'human'])
  })

  it('still marks a block when the marker carries attributes', () => {
    const source = `${markerLine('command', { skill: '周报' })}\n整理成周报。\n`
    expect(identities(source)).toEqual(['command'])
    expect(compile(source).index.markers).toHaveLength(1)
    // 属性落在被标块的 data 上，技能阶段才有东西可读。
    expect(treeOf(source).children![0]!.data?.rgentIdentity).toEqual({
      identity: 'command',
      attrs: { skill: '周报' }
    })
  })

  it('keeps a trailing marker out of the block list without marking anything', () => {
    const source = `正文\n\n${AI}\n`
    const result = compile(source)
    expect(result.index.blocks).toHaveLength(1)
    expect(result.index.markers).toHaveLength(1)
    expect(identities(source)).toEqual(['human'])
  })

  it('leaves an inline comment inside a paragraph alone', () => {
    // 段落里的 HTML 注释是行内节点，也报 'html'：当标记处理会把用户的句子摘掉。
    const source = '人写 <!-- rgent:ai:v1 --> 的字\n'
    const result = compile(source)
    expect(result.index.markers).toEqual([])
    expect(result.index.blocks).toHaveLength(1)
    expect(result.index.blocks[0]!.identity).toBeUndefined()
    expect(result.partition.body).toBe(source)
    const inline = treeOf(source).children![0]!
    expect(inline.type).toBe('paragraph')
    expect(inline.children!.some((node) => node.type === 'html' && node.value === AI)).toBe(true)
  })

  it('splits a paragraph when a marker is inserted mid-paragraph, and marks what follows', () => {
    // 这是 CommonMark 的既成事实（围栏已记）：标记只能写在块边界，写入侧靠这个断言自保。
    const source = '前半句\n' + AI + '\n后半句\n'
    expect(compile(source).index.blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph'])
    expect(identities(source)).toEqual(['human', 'ai'])
  })

  it('marks the block closest to the marker when two markers stack', () => {
    expect(identities(`${PROMPT}\n${AI}\n重叠的一段。\n`)).toEqual(['ai'])
    expect(compile(`${PROMPT}\n${AI}\n重叠的一段。\n`).index.markers).toHaveLength(2)
  })

  it('reports marker ranges in file coordinates when the note has a ledger', () => {
    const body = `正文\n\n${AI}\nAI 的段落。\n\n`
    const source = composeSource(body, '<!-- rgent:ledger:v1 -->\n## 2026-09-26\n\n口令原文\n')
    const part = partitionSource(source)
    expect(part.body).toBe(body)
    const result = compile(source)
    const marker = result.index.markers[0]!
    expect(source.slice(marker.range.start, marker.range.end)).toBe(AI)
    expect(identities(source)).toEqual(['human', 'ai'])
  })

  it('survives the compose round-trip byte for byte', () => {
    const body = `人写的。\n\n${AI}\nAI 写的。\n\n${PROMPT}\n口令。\n`
    const source = composeSource(body, null)
    const part = partitionSource(source)
    expect(composeSource(part.body, part.ledger)).toBe(source)
    expect(identities(source)).toEqual(['human', 'ai', 'command'])
  })

  it('leaves a marker inside a container alone, so nothing is marked that the index cannot act on', () => {
    // 索引只收顶层块；认了嵌套标记就会变成「管线标了、锁定与画布却管不着」的半实现。
    // 不认的注释照旧留在正文里看得见，不静默吞掉。
    const source = `> ${AI}\n> 引用里的一段。\n`
    const result = compile(source)
    expect(result.index.markers).toEqual([])
    expect(result.index.blocks).toHaveLength(1)
    expect(result.index.blocks[0]!.identity).toBeUndefined()
    const quote = treeOf(source).children![0]!
    expect(quote.type).toBe('blockquote')
    expect(quote.children!.some((node) => node.type === 'html' && node.value === AI)).toBe(true)
  })

  it('can be switched off, and then the marker is an ordinary block again', () => {
    const source = `${AI}\nAI 写的。\n`
    const off = compile(source, { stages: { identity: false } })
    expect(off.index.markers).toEqual([])
    expect(off.index.blocks.map((block) => block.type)).toEqual(['html', 'paragraph'])
  })
})
