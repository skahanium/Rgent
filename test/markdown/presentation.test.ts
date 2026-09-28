import { describe, expect, it } from 'vitest'
import { compile, compileFragment } from '../../src/markdown/pipeline.ts'
import { planPresentation } from '../../src/markdown/presentation.ts'

describe('Markdown presentation plan', () => {
  it('marks only top-level prose lines for justified reading and editing', () => {
    const source = '中文 English 混排\n续行内容。\n\n- 列表文字\n\n> 引用文字\n\n## 标题\n'
    const plan = planPresentation(compile(source).tree, source)
    const prose = plan.lines.filter((line) => line.className === 'md-prose').map((line) => source.slice(line.at).split('\n')[0])
    expect(prose).toEqual(['中文 English 混排', '续行内容。'])
  })
  it('can render a read-only ledger fragment without treating an anchor-looking line as a partition', () => {
    const source = '## 第一场\n\n<!-- rgent:ledger:v1 -->\n\n## 第二场\n'
    expect(compile(source).index.headings).toHaveLength(1)
    expect(compileFragment(source).index.headings).toHaveLength(2)
  })
  it('hides heading and emphasis delimiters without changing source offsets', () => {
    const source = '### **1. 设计动机**\n\n普通 *斜体* 与 ~~删除~~。\n'
    const result = compile(source)
    const plan = planPresentation(result.tree, result.partition.body)
    const hidden = plan.syntax.filter((item) => item.kind === 'hide').map((item) => source.slice(item.range.start, item.range.end))
    expect(hidden).toEqual(expect.arrayContaining(['### ', '**', '*', '~~']))
    expect(plan.lines.some((line) => line.className.includes('md-h3'))).toBe(true)
    expect(plan.styles.some((item) => item.className === 'md-delete')).toBe(true)
    expect(source).toBe('### **1. 设计动机**\n\n普通 *斜体* 与 ~~删除~~。\n')
  })

  it('plans lists, quotes, links and fenced code from AST ranges', () => {
    const source = '- [ ] 待办\n- 第二项\n\n> 引用\n\n[站点](https://example.com)\n\n```ts\nconst n = 1\n```\n'
    const result = compile(source)
    const plan = planPresentation(result.tree, result.partition.body)
    expect(plan.syntax.some((item) => item.kind === 'task')).toBe(true)
    expect(plan.syntax.some((item) => item.kind === 'bullet')).toBe(true)
    expect(plan.lines.some((line) => line.className.includes('md-quote'))).toBe(true)
    expect(plan.links).toContainEqual(expect.objectContaining({ url: 'https://example.com' }))
    expect(plan.blocks.some((block) => block.kind === 'code')).toBe(true)
  })
})
