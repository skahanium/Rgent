import { describe, expect, it } from 'vitest'
import { AI_MARKER, PROMPT_MARKER, compile, composeSource } from '../../src/markdown/index.ts'
import {
  acceptMarker,
  discardMarkedBlock,
  identityUnits,
  markerLineBlock,
  moveUnit
} from '../../src/markdown/identity-edit.ts'

const AI = AI_MARKER
const PROMPT = PROMPT_MARKER

function apply(source: string, edit: { from: number; to: number; insert: string } | null): string {
  if (!edit) throw new Error('没有算出变更')
  return source.slice(0, edit.from) + edit.insert + source.slice(edit.to)
}

function onlyMarker(source: string) {
  const marker = compile(source).index.markers[0]
  if (!marker) throw new Error('这条语料里没有标记')
  return marker
}

describe('marker line', () => {
  it('covers the whole comment line including its newline', () => {
    const source = `甲\n\n${AI}\n乙\n`
    const line = markerLineBlock(source, onlyMarker(source).range)
    expect(source.slice(line.start, line.end)).toBe(`${AI}\n`)
  })

  it('works when the marker is the first and the last line', () => {
    const first = `${AI}\n乙\n`
    expect(first.slice(...(() => {
      const line = markerLineBlock(first, onlyMarker(first).range)
      return [line.start, line.end] as const
    })())).toBe(`${AI}\n`)
    const last = `甲\n${AI}`
    const line = markerLineBlock(last, onlyMarker(last).range)
    expect(last.slice(line.start, line.end)).toBe(AI)
  })
})

describe('accept', () => {
  it('deletes only the marker line and leaves the words untouched', () => {
    const source = `人写的。\n\n${AI}\nAI 写的。\n\n人写的二。\n`
    const after = apply(source, acceptMarker(source, onlyMarker(source)))
    expect(after).toBe('人写的。\n\nAI 写的。\n\n人写的二。\n')
    expect(compile(after).index.markers).toEqual([])
    expect(compile(after).index.blocks.every((block) => block.identity === undefined)).toBe(true)
  })
})

describe('discard', () => {
  it('takes the marker and the block, and leaves one blank line between neighbours', () => {
    const source = `人写的。\n\n${AI}\nAI 写的。\n\n人写的二。\n`
    const marker = onlyMarker(source)
    const block = compile(source).index.blocks[1]!.range
    const after = apply(source, discardMarkedBlock(source, marker, block))
    expect(after).toBe('人写的。\n\n人写的二。\n')
  })

  it('leaves no trailing blank line when the block was last', () => {
    const source = `人写的。\n\n${AI}\nAI 写的。\n`
    const marker = onlyMarker(source)
    const block = compile(source).index.blocks[1]!.range
    expect(apply(source, discardMarkedBlock(source, marker, block))).toBe('人写的。\n')
  })

  it('drops the whole block from the index', () => {
    const source = `甲。\n\n${AI}\n乙。\n\n丙。\n`
    const marker = onlyMarker(source)
    const block = compile(source).index.blocks[1]!.range
    const after = apply(source, discardMarkedBlock(source, marker, block))
    expect(compile(after).index.blocks).toHaveLength(2)
    expect(compile(after).index.markers).toEqual([])
  })
})

describe('move', () => {
  it('lists every top-level block as a unit and attaches the marker to its block', () => {
    const source = `甲。\n\n${AI}\n乙。\n\n丙。\n`
    const units = identityUnits(compile(source).index)
    expect(units).toHaveLength(3)
    expect(units[0]!.marker).toBeNull()
    expect(units[1]!.marker?.identity).toBe('ai')
    expect(units[2]!.marker).toBeNull()
  })

  it('keeps the marker glued to its block when moving up', () => {
    const source = `甲。\n\n${AI}\n乙。\n\n丙。\n`
    const block = compile(source).index.blocks[1]!.range
    const after = apply(source, moveUnit(source, compile(source).index, block.start, 'up'))
    expect(after).toBe(`${AI}\n乙。\n\n甲。\n\n丙。\n`)
    // 身份跟着块走：乙 仍是未采纳的 AI 块。
    expect(compile(after).index.blocks.map((item) => item.identity ?? 'human')).toEqual(['ai', 'human', 'human'])
  })

  it('keeps both markers glued when swapping two AI blocks', () => {
    const source = `${AI}\n甲。\n\n${AI}\n乙。\n`
    const block = compile(source).index.blocks[0]!.range
    const after = apply(source, moveUnit(source, compile(source).index, block.start, 'down'))
    expect(after).toBe(`${AI}\n乙。\n\n${AI}\n甲。\n`)
    expect(compile(after).index.blocks.map((item) => item.identity ?? 'human')).toEqual(['ai', 'ai'])
  })

  it('refuses to move past either end', () => {
    const source = `甲。\n\n${AI}\n乙。\n`
    const index = compile(source).index
    expect(moveUnit(source, index, index.blocks[0]!.range.start, 'up')).toBeNull()
    expect(moveUnit(source, index, index.blocks[1]!.range.start, 'down')).toBeNull()
  })

  it('does not disturb the ledger when a marked body block moves', () => {
    const body = `甲。\n\n${AI}\n乙。\n\n`
    const source = composeSource(body, '<!-- rgent:ledger:v1 -->\n## 2026-09-26\n\n口令\n')
    const index = compile(source).index
    const after = apply(source, moveUnit(source, index, index.blocks[1]!.range.start, 'up'))
    expect(after.slice(after.indexOf('<!-- rgent:ledger:v1 -->'))).toBe('<!-- rgent:ledger:v1 -->\n## 2026-09-26\n\n口令\n')
    expect(compile(after).index.markers).toHaveLength(1)
  })

  it('hands the prompt marker to the prompt block, not to the AI block below it', () => {
    const source = `${PROMPT}\n口令。\n\n${AI}\n回答。\n`
    const units = identityUnits(compile(source).index)
    expect(units.map((unit) => unit.marker?.identity ?? 'none')).toEqual(['command', 'ai'])
  })
})
