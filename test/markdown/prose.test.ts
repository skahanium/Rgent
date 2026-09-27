import { describe, expect, it } from 'vitest'
import { compile } from '../../src/markdown/index.ts'
import { countWords, proseOf } from '../../src/markdown/prose.ts'

describe('proseOf', () => {
  it('把标记换成等长空格，偏移不变', () => {
    const source = '人写的。\n\n<!-- rgent:ai:v1 -->\nAI 的回答。\n'
    const index = compile(source).index
    const prose = proseOf(source, index.markers)
    expect(prose).toHaveLength(source.length)
    expect(prose).not.toContain('rgent')
    expect(prose).toContain('人写的。')
    expect(prose).toContain('AI 的回答。')
    expect(prose.indexOf('AI 的回答。')).toBe(source.indexOf('AI 的回答。'))
  })

  it('没有标记时原样返回', () => {
    expect(proseOf('甲。\n', [])).toBe('甲。\n')
  })
})

describe('countWords', () => {
  it('中文逐字、英文按串', () => {
    expect(countWords('中文三个字')).toBe(5)
    expect(countWords('hello world')).toBe(2)
    expect(countWords('你好 world 再见')).toBe(5)
  })

  it('数字与下划线跟着拉丁串走', () => {
    expect(countWords('v0 与 v1')).toBe(3)
    expect(countWords('a_b 二次')).toBe(3)
  })

  it('Markdown 记号只断开连续串，不算字', () => {
    expect(countWords('# 标题\n\n- 项目一\n- 项目二')).toBe(8)
  })

  it('标记行不计入', () => {
    const source = '正文两字。\n\n<!-- rgent:ai:v1 -->\n回答两字。\n'
    const index = compile(source).index
    expect(countWords(proseOf(source, index.markers))).toBe(8)
  })

  it('空白与标点不算', () => {
    expect(countWords('  \n\t 。，！ ')).toBe(0)
  })
})
