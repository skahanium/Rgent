import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALL_STAGES,
  compile,
  expandToLineBlock,
  inViewport,
  listedStages,
  partitionSource,
  planWidgets,
  recoverCompile,
  STAGE_IDS,
  STUB_STAGE_IDS
} from '../../src/markdown/index.ts'

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures/basic.md'),
  'utf8'
)

describe('pipeline', () => {
  it('lists reserved stages without activating stubs', () => {
    expect([...listedStages()]).toEqual([...STAGE_IDS])
    for (const id of STUB_STAGE_IDS) {
      expect(STAGE_IDS).toContain(id)
    }
    const result = compile(fixture)
    expect(result.stages.math).toBe(false)
    expect(result.stages.callout).toBe(false)
    expect(result.stages.wikilink).toBe(false)
    expect(result.stages.mermaid).toBe(false)
    expect(new Set(ALL_STAGES.map((stage) => stage.id))).toEqual(new Set(STAGE_IDS))
  })

  it('partitions identity: whole file is body', () => {
    const part = partitionSource(fixture)
    expect(part.body).toBe(fixture)
    expect(part.ledger).toBeNull()
    expect(part.bodyOffset).toBe(0)
  })

  it('maps GFM table and image back onto original source', () => {
    const result = compile(fixture)
    expect(result.stale).toBe(false)
    expect(result.index.tables).toHaveLength(1)
    const table = result.index.tables[0]
    const slice = fixture.slice(table.range.start, table.range.end)
    expect(slice).toContain('| a | b |')
    expect(slice).toContain('| 1 | 2 |')
    expect(table.header).toEqual(['a', 'b'])
    expect(table.rows).toEqual([['1', '2']])

    expect(result.index.images).toHaveLength(1)
    const image = result.index.images[0]
    expect(fixture.slice(image.range.start, image.range.end)).toContain('![alt text](pic.png)')
    expect(image.alt).toBe('alt text')
    expect(image.url).toBe('pic.png')
  })

  it('parses yaml frontmatter as a block, not as body prose', () => {
    const result = compile(fixture)
    expect(result.index.blocks[0]?.type).toBe('yaml')
    const yaml = result.index.blocks[0]
    expect(fixture.slice(yaml.range.start, yaml.range.end)).toContain('title: demo')
  })

  it('indexes mermaid fences from code blocks without a second parser', () => {
    const result = compile(fixture)
    expect(result.index.mermaid).toHaveLength(1)
    const fence = fixture.slice(
      result.index.mermaid[0].range.start,
      result.index.mermaid[0].range.end
    )
    expect(fence).toContain('graph LR')
  })

  it('drops table nodes when GFM stage is off', () => {
    const on = compile(fixture)
    const off = compile(fixture, { stages: { gfm: false } })
    expect(on.index.tables.length).toBeGreaterThan(0)
    expect(off.index.tables).toEqual([])
    expect(off.stale).toBe(false)
  })

  it('drops yaml nodes when frontmatter stage is off', () => {
    const off = compile(fixture, { stages: { frontmatter: false } })
    expect(off.index.blocks.some((block) => block.type === 'yaml')).toBe(false)
  })

  it('does not throw on broken frontmatter or unclosed fence', () => {
    const garbage = '---\n:\n---\n```\nunterminated'
    expect(() => compile(garbage)).not.toThrow()
    const result = compile(garbage)
    expect(result.source).toBe(garbage)
  })

  it('filters widget ranges by viewport', () => {
    const result = compile(fixture)
    const table = result.index.tables[0]
    expect(inViewport(table.range, 0, fixture.length)).toBe(true)
    expect(inViewport(table.range, table.range.end, table.range.end + 10)).toBe(false)
  })

  it('keeps the last good index when compile recovery kicks in', () => {
    const prev = compile(fixture)
    const recovered = recoverCompile('new source', prev.stages, 'boom', prev)
    expect(recovered.stale).toBe(true)
    expect(recovered.source).toBe('new source')
    expect(recovered.index.tables).toEqual(prev.index.tables)
    expect(recoverCompile('x', prev.stages, 'boom').index.tables).toEqual([])
  })

  it('plans block table widgets on whole lines and drops them when GFM is off', () => {
    const on = compile(fixture)
    const widgets = planWidgets(on.index, fixture, [{ from: 0, to: fixture.length }])
    const table = widgets.find((widget) => widget.kind === 'table')
    expect(table).toBeDefined()
    if (!table) return
    const expanded = expandToLineBlock(fixture, on.index.tables[0].range)
    expect(table.range).toEqual(expanded)
    expect(table.range.start === 0 || fixture[table.range.start - 1] === '\n').toBe(true)
    expect(table.range.end === fixture.length || fixture[table.range.end - 1] === '\n').toBe(true)
    expect(widgets.some((widget) => widget.kind === 'image')).toBe(true)

    const off = compile(fixture, { stages: { gfm: false } })
    const offWidgets = planWidgets(off.index, fixture, [{ from: 0, to: fixture.length }])
    expect(offWidgets.filter((widget) => widget.kind === 'table')).toEqual([])
  })
})
