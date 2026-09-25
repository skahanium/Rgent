import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALL_STAGES,
  compile,
  composeSource,
  expandToLineBlock,
  inViewport,
  listedStages,
  partitionSource,
  findLedgerStart,
  planWidgets,
  recoverCompile,
  STAGE_IDS
} from '../../src/markdown/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(join(here, 'fixtures/basic.md'), 'utf8')
const live = readFileSync(join(here, 'fixtures/live.md'), 'utf8')

describe('pipeline', () => {
  it('enables the v0 stage set by default', () => {
    expect([...listedStages()]).toEqual([...STAGE_IDS])
    const result = compile(fixture)
    expect(result.stages).toEqual({
      gfm: true,
      frontmatter: true,
      math: true,
      callout: true,
      wikilink: true,
      mermaid: true
    })
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

  it('indexes inline and block math from the original source', () => {
    const result = compile(live)
    expect(result.stale).toBe(false)
    const inline = result.index.maths.find((item) => !item.block)
    const block = result.index.maths.find((item) => item.block)
    expect(inline?.value).toBe('a')
    expect(live.slice(inline!.range.start, inline!.range.end)).toContain('$a$')
    expect(block?.value.replace(/\s+/g, '')).toBe('e=mc^2')
    expect(live.slice(block!.range.start, block!.range.end)).toContain('$$')
  })

  it('turns known callouts into callout nodes and leaves other quotes', () => {
    const result = compile(live)
    const kinds = result.index.callouts.map((item) => item.kind)
    expect(kinds).toEqual(['note', 'warning'])
    expect(result.index.callouts[0]?.title).toBe('笔记')
    expect(result.index.callouts[1]?.title).toBe('小心')
    const tree = result.tree as { children: { type: string }[] }
    expect(tree.children.some((child) => child.type === 'callout')).toBe(true)
    expect(tree.children.some((child) => child.type === 'blockquote')).toBe(true)
    const mystery = live.slice(
      live.indexOf('> [!mystery]'),
      live.indexOf('stay a quote') + 'stay a quote'.length
    )
    expect(mystery).toContain('[!mystery]')
    expect(result.index.callouts).toHaveLength(2)
  })

  it('keeps nested math and images inside callouts in the index', () => {
    const source = '> [!note]\n> $a$\n>\n> ![alt](pic.png)\n'
    const result = compile(source)
    expect(result.index.callouts).toHaveLength(1)
    expect(result.index.maths.some((item) => item.value === 'a' && !item.block)).toBe(true)
    expect(result.index.images.some((image) => image.url === 'pic.png' && image.alt === 'alt')).toBe(true)
  })

  it('indexes wikilinks with vault paths, filename display, and non-transcluding embeds', () => {
    const result = compile(live)
    const note = result.index.wikilinks.find((item) => item.target === '工作/会议纪要.md' && !item.embed)
    const embed = result.index.wikilinks.find((item) => item.target === '工作/会议纪要.md' && item.embed)
    const image = result.index.wikilinks.find((item) => item.target === 'pic.png')
    expect(note?.display).toBe('会议纪要')
    expect(embed?.display).toBe('会议纪要')
    expect(embed?.embed).toBe(true)
    expect(image?.embed).toBe(true)
    expect(live).not.toMatch(/嵌入了另一篇正文/)
    const widgets = planWidgets(result.index, live, [{ from: 0, to: live.length }])
    const embedWidget = widgets.find(
      (widget) => widget.kind === 'wikilink' && widget.wikilink.embed && widget.wikilink.target.endsWith('.md')
    )
    expect(embedWidget?.kind).toBe('wikilink')
    expect(widgets.some((widget) => widget.kind === 'image' && widget.image.url === 'pic.png')).toBe(true)
  })

  it('plans mermaid widgets from fences and leaves unknown fences as code', () => {
    const result = compile(live)
    expect(result.index.mermaid).toHaveLength(1)
    expect(result.index.mermaid[0]?.value).toContain('graph LR')
    const widgets = planWidgets(result.index, live, [{ from: 0, to: live.length }])
    const mermaid = widgets.find((widget) => widget.kind === 'mermaid')
    expect(mermaid).toBeDefined()
    if (!mermaid || mermaid.kind !== 'mermaid') return
    expect(expandToLineBlock(live, result.index.mermaid[0].range)).toEqual(mermaid.range)
    expect(widgets.some((widget) => widget.kind === 'mermaid' && widget.mermaid.value.includes('weird'))).toBe(
      false
    )
  })

  it('drops matching nodes and widgets when a stage is turned off', () => {
    const on = compile(live)
    const mathOff = compile(live, { stages: { math: false } })
    const calloutOff = compile(live, { stages: { callout: false } })
    const wikiOff = compile(live, { stages: { wikilink: false } })
    const mermaidOff = compile(live, { stages: { mermaid: false } })

    expect(on.index.maths.length).toBeGreaterThan(0)
    expect(mathOff.index.maths).toEqual([])
    expect(mathOff.index.callouts.length).toBeGreaterThan(0)

    expect(on.index.callouts.length).toBeGreaterThan(0)
    expect(calloutOff.index.callouts).toEqual([])
    expect(calloutOff.index.maths.length).toBeGreaterThan(0)

    expect(on.index.wikilinks.length).toBeGreaterThan(0)
    expect(wikiOff.index.wikilinks).toEqual([])
    expect(wikiOff.index.mermaid.length).toBeGreaterThan(0)

    expect(on.index.mermaid.length).toBeGreaterThan(0)
    expect(mermaidOff.index.mermaid).toEqual([])
    expect(mermaidOff.index.wikilinks.length).toBeGreaterThan(0)

    const viewport = [{ from: 0, to: live.length }]
    expect(planWidgets(mathOff.index, live, viewport).some((widget) => widget.kind === 'math')).toBe(false)
    expect(planWidgets(calloutOff.index, live, viewport).some((widget) => widget.kind === 'callout')).toBe(false)
    expect(planWidgets(wikiOff.index, live, viewport).some((widget) => widget.kind === 'wikilink')).toBe(false)
    expect(planWidgets(mermaidOff.index, live, viewport).some((widget) => widget.kind === 'mermaid')).toBe(false)
    expect(planWidgets(on.index, live, viewport).some((widget) => widget.kind === 'table' || widget.kind === 'image')).toBe(
      true
    )
  })

  it('plans block math and callouts on whole lines and keeps inline math on its source range', () => {
    const result = compile(live)
    const widgets = planWidgets(result.index, live, [{ from: 0, to: live.length }])
    const inline = result.index.maths.find((item) => !item.block)!
    const inlineWidget = widgets.find((widget) => widget.kind === 'math' && !widget.math.block)
    expect(inlineWidget?.range).toEqual(inline.range)

    const block = result.index.maths.find((item) => item.block)!
    const blockWidget = widgets.find((widget) => widget.kind === 'math' && widget.math.block)
    expect(blockWidget?.range).toEqual(expandToLineBlock(live, block.range))

    const callout = widgets.find((widget) => widget.kind === 'callout')
    expect(callout).toBeDefined()
    if (!callout) return
    expect(callout.range).toEqual(expandToLineBlock(live, result.index.callouts[0].range))
    expect(callout.range.start === 0 || live[callout.range.start - 1] === '\n').toBe(true)
  })

  it('keeps GFM images when wiki embeds are also present', () => {
    const source = '![alt](pic.png)\n![[pic.png]]\n'
    const result = compile(source)
    expect(result.index.images).toHaveLength(1)
    expect(result.index.images[0]?.url).toBe('pic.png')
    expect(result.index.wikilinks).toHaveLength(1)
    expect(result.index.wikilinks[0]?.embed).toBe(true)
  })

  it('does not stretch stale block widgets across a shorter document', () => {
    const result = compile('| a | b |\n| --- | --- |\n| 1 | 2 |\n')
    expect(result.index.tables[0]?.range.start).toBeLessThan(2)
    const widgets = planWidgets(result.index, 'x\n', [{ from: 0, to: 2 }])
    expect(widgets.filter((widget) => widget.kind === 'table')).toEqual([])
    for (const widget of widgets) {
      expect(widget.range.start).toBeGreaterThanOrEqual(0)
      expect(widget.range.end).toBeLessThanOrEqual(2)
      expect(widget.range.end).toBeGreaterThan(widget.range.start)
    }
  })

  it('does not import katex or mermaid into the markdown pipeline', () => {
    const markdownRoot = join(here, '../../src/markdown')
    const files = collectTs(markdownRoot)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/from\s+['"]katex['"]/)
      expect(text).not.toMatch(/from\s+['"]mermaid['"]/)
    }
  })
})

describe('ledger partition', () => {
  const anchor = '<!-- rgent:ledger:v1 -->'
  const body = '# 会议纪要\n\n正文一句。\n'
  const ledger = `${anchor}\n\n## 2026-09-24 第一次\n\n口令：总结一下\n\n[[幽灵链接]]\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n$$x^2$$\n\n**很粗**\n`

  it('keeps identity when there is no anchor line', () => {
    const part = partitionSource(fixture)
    expect(part.body).toBe(fixture)
    expect(part.ledger).toBeNull()
    expect(part.bodyOffset).toBe(0)
  })

  it('treats the anchor as a whole line only', () => {
    const inline = `正文提到 ${anchor} 这四个字嵌在句子里。\n`
    expect(findLedgerStart(inline)).toBe(-1)
    expect(partitionSource(inline).ledger).toBeNull()
  })

  it('splits the body as a prefix and the ledger from the anchor on', () => {
    const source = body + ledger
    const part = partitionSource(source)
    expect(part.body).toBe(body)
    expect(part.ledger).toBe(ledger)
    expect(part.bodyOffset).toBe(0)
    expect(source.startsWith(part.body)).toBe(true)
  })

  it('accepts trailing whitespace on the anchor line', () => {
    const source = `${body + anchor}   \n账本\n`
    expect(findLedgerStart(source)).toBe(body.length)
    expect(partitionSource(source).body).toBe(body)
  })

  it('uses the last anchor so prose quoting the anchor is not swallowed', () => {
    const source = `正文。\n${anchor}\n这是正文里引用的一行，不该进账本。\n${anchor}\n真账本\n`
    const part = partitionSource(source)
    expect(part.body).toContain('不该进账本')
    expect(part.ledger).toBe(`${anchor}\n真账本\n`)
  })

  it('yields an empty body when the whole file is a ledger', () => {
    const part = partitionSource(ledger)
    expect(part.body).toBe('')
    expect(part.ledger).toBe(ledger)
    expect(() => compile(ledger)).not.toThrow()
  })

  it('keeps the whole file as source while the index sees only the body', () => {
    const result = compile(body + ledger)
    expect(result.source).toBe(body + ledger)
    expect(result.stale).toBe(false)
    expect(result.partition.body).toBe(body)

    const seen = JSON.stringify(result.index)
    expect(seen).not.toContain('幽灵链接')
    expect(seen).not.toContain('2026-09-24')
    expect(result.index.wikilinks).toEqual([])
    expect(result.index.tables).toEqual([])
    expect(result.index.maths).toEqual([])
    expect(result.index.marks).toEqual([])
    expect(result.index.blocks.map((block) => block.type)).toEqual(['heading', 'paragraph'])
  })

  it('plans no widgets from the ledger region', () => {
    const source = body + ledger
    const result = compile(source)
    const widgets = planWidgets(result.index, source, [{ from: 0, to: source.length }])
    expect(widgets).toEqual([])
  })

  it('composes identity when there is no ledger', () => {
    expect(composeSource(fixture, null)).toBe(fixture)
    const part = partitionSource(fixture)
    expect(composeSource(part.body, part.ledger)).toBe(fixture)
  })

  it('round-trips body plus ledger, inserting a newline if the body lacks one', () => {
    const source = body + ledger
    const part = partitionSource(source)
    expect(composeSource(part.body, part.ledger)).toBe(source)
    expect(composeSource('正文没有换行', ledger)).toBe(`正文没有换行\n${ledger}`)
    const again = partitionSource(composeSource('正文没有换行', ledger))
    expect(again.body).toBe('正文没有换行\n')
    expect(again.ledger).toBe(ledger)
  })

  it('splits when the only whole-line anchor sits in the body', () => {
    const source = `正文。\n${anchor}\n后面本是正文，但会进账本。\n`
    expect(findLedgerStart(source)).toBeGreaterThanOrEqual(0)
    const part = partitionSource(source)
    expect(part.body).toBe('正文。\n')
    expect(part.ledger).toContain('后面本是正文，但会进账本。')
  })

  it('plans body tables and ignores tables that only exist in the ledger', () => {
    const source = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n' + ledger
    const result = compile(source)
    const widgets = planWidgets(result.index, source, [{ from: 0, to: source.length }])
    const tables = widgets.filter((widget) => widget.kind === 'table')
    expect(tables).toHaveLength(1)
    expect(source.slice(tables[0]!.range.start, tables[0]!.range.end)).toContain('| 1 | 2 |')
    expect(tables[0]!.range.end).toBeLessThan(findLedgerStart(source))
  })
})

function collectTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTs(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}
