import { describe, expect, it } from 'vitest'
import { MEMORY_QUALITY_CASES } from '../fixtures/memory-quality'

const groups = ['standing', 'fact', 'correction', 'duplicate', 'temporary', 'attribution', 'ai', 'ambiguous', 'scope', 'malicious'] as const

describe('固定虚构记忆质量材料（仅验证材料，不评判模型语义）', () => {
  it('固定为十组各十二例，每组末四例留出，共四十例', () => {
    expect(MEMORY_QUALITY_CASES).toHaveLength(120)
    expect(MEMORY_QUALITY_CASES.filter(c => c.heldOut)).toHaveLength(40)
    expect(new Set(MEMORY_QUALITY_CASES.map(c => c.group))).toEqual(new Set(groups))
    for (const group of groups) {
      const rows = MEMORY_QUALITY_CASES.filter(c => c.group === group)
      expect(rows).toHaveLength(12)
      expect(rows.map(c => c.heldOut)).toEqual([false, false, false, false, false, false, false, false, true, true, true, true])
    }
  })
  it('具有独立身份与不同材料，明确虚构，不以编号替换制造重复', () => {
    expect(new Set(MEMORY_QUALITY_CASES.map(c => c.id)).size).toBe(120)
    expect(new Set(MEMORY_QUALITY_CASES.map(c => c.prompt + '\n' + c.body)).size).toBe(120)
    for (const c of MEMORY_QUALITY_CASES) {
      expect(c.id).toMatch(new RegExp(`^${c.group}-\\d{2}$`))
      expect(c.body).toContain('虚构')
      expect(c.body.length).toBeGreaterThan(35)
      expect(c.prompt.trim().length).toBeGreaterThan(8)
      expect(c.answer.trim().length).toBeGreaterThan(0)
      expect(c.expected.notes.trim().length).toBeGreaterThan(15)
      expect(Array.isArray(c.expected.required)).toBe(true)
      expect(Array.isArray(c.expected.forbidden)).toBe(true)
      expect(c.expected.required.every(s => s.trim().length > 0)).toBe(true)
      expect(c.expected.forbidden.every(s => s.trim().length > 0)).toBe(true)
      expect(c.expected.required.filter(s => c.expected.forbidden.includes(s))).toEqual([])
    }
  })
  it('正例有明确内容要求，不能用全部不学习通过质量评估', () => {
    for (const group of ['standing', 'fact', 'correction', 'duplicate', 'scope'] as const) {
      expect(MEMORY_QUALITY_CASES.filter(c => c.group === group).every(c => c.expected.required.length > 0)).toBe(true)
    }
    for (const group of ['temporary', 'attribution', 'ai', 'malicious'] as const) {
      const rows = MEMORY_QUALITY_CASES.filter(c => c.group === group)
      expect(rows.some(c => c.expected.required.length > 0)).toBe(true)
      expect(rows.some(c => c.expected.required.length === 0)).toBe(true)
    }
  })
  it('更正、去重和含糊例均有有据可核的旧知识，含糊不能替换为确定事实', () => {
    for (const c of MEMORY_QUALITY_CASES.filter(c => ['correction', 'duplicate', 'ambiguous'].includes(c.group))) {
      expect(c.seed?.content.trim().length).toBeGreaterThan(8)
      expect(c.seed?.scope.trim().length).toBeGreaterThan(0)
      expect(c.seed?.attribution.trim().length).toBeGreaterThan(0)
      expect(['core', 'demand']).toContain(c.seed?.layer)
      expect(['standing', 'fact']).toContain(c.seed?.semantic)
      expect(c.expected.maxActive).toBe(1)
      if (c.group === 'correction') expect(c.expected.action).toBe('correct')
      if (c.group === 'duplicate') expect(c.expected.action).toBe('unchanged')
      if (c.group === 'ambiguous') expect(['unchanged', 'conflict']).toContain(c.expected.action)
    }
  })
  it('保留中英文、时间限定、第三方归属和注入载荷这些实际区分点', () => {
    for (const group of groups) {
      expect(MEMORY_QUALITY_CASES.filter(c => c.group === group).some(c => /[A-Za-z]{5}/.test(c.prompt))).toBe(true)
    }
    expect(MEMORY_QUALITY_CASES.filter(c => c.group === 'scope').every(c => c.expected.scope && c.expected.scope !== '本库')).toBe(true)
    expect(MEMORY_QUALITY_CASES.filter(c => c.group === 'attribution' && c.expected.required.length > 0).every(c => c.expected.attribution && c.expected.attribution !== '用户本人')).toBe(true)
    expect(MEMORY_QUALITY_CASES.filter(c => c.group === 'malicious').every(c => c.expected.forbidden.length > 0)).toBe(true)
  })
})
