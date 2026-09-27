import { describe, expect, it } from 'vitest'
import { diffPreview, markLine } from '../../src/renderer/src/diff.ts'

describe('markLine', () => {
  it('只强调公共前后缀之外的那一段', () => {
    // 「今天发布了 v」是公共前缀（7 个字），差异只在第 8 个字符那个数字上。
    const [before, after] = markLine('今天发布了 v1 版本。', '今天发布了 v2 版本。')
    expect(before).toEqual([[7, 8]])
    expect(after).toEqual([[7, 8]])
    expect('今天发布了 v1 版本。'.slice(7, 8)).toBe('1')
  })

  it('同一行返回空强调', () => {
    expect(markLine('一样', '一样')).toEqual([[], []])
  })

  it('超长行整行强调，不做字符级细化', () => {
    const long = '甲'.repeat(300)
    expect(markLine(long, `${long}乙`, 240)).toEqual([[[0, 300]], [[0, 301]]])
  })

  it('整行新增时只有一边有强调', () => {
    const [before] = markLine('', '新的一行')
    expect(before).toEqual([])
  })
})

describe('diffPreview', () => {
  it('完全相同时没有变化行', () => {
    const preview = diffPreview('甲\n乙\n丙', '甲\n乙\n丙')
    expect(preview.rows.every((row) => row.kind !== 'changed')).toBe(true)
    expect(preview.truncated).toBe(false)
    expect(preview.hidden).toBe(0)
  })

  it('改一行的中间：两边都强调，行仍配对', () => {
    const preview = diffPreview('开头\n今天发布了 v1 版本。\n结尾', '开头\n今天发布了 v2 版本。\n结尾')
    const changed = preview.rows.filter((row) => row.kind === 'changed')
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({ kind: 'changed', oneSided: null })
    if (changed[0]!.kind === 'changed') {
      expect(changed[0]!.windowMarks).toEqual([[7, 8]])
      expect(changed[0]!.diskMarks).toEqual([[7, 8]])
    }
  })

  it('一边新增一行时标记成单边', () => {
    const preview = diffPreview('甲\n乙', '甲\n乙\n丙')
    const changed = preview.rows.filter((row) => row.kind === 'changed')
    expect(changed).toHaveLength(1)
    if (changed[0]!.kind === 'changed') {
      expect(changed[0]!.oneSided).toBe('disk')
      expect(changed[0]!.diskLine).toBe('丙')
      expect(changed[0]!.windowLine).toBe('')
    }
  })

  it('长段相同内容折叠成省略行', () => {
    const shared = Array.from({ length: 40 }, (_, i) => `第 ${i} 行`).join('\n')
    const preview = diffPreview(`${shared}\n改动前`, `${shared}\n改动后`)
    const gaps = preview.rows.filter((row) => row.kind === 'gap')
    expect(gaps.length).toBeGreaterThan(0)
    expect(preview.rows.filter((row) => row.kind === 'changed')).toHaveLength(1)
  })

  it('变化簇太多时只渲染前几簇并报出剩余处数', () => {
    const before = Array.from({ length: 40 }, (_, i) => `原文 ${i}`).join('\n')
    const after = Array.from({ length: 40 }, (_, i) => `改后 ${i}`).join('\n')
    const preview = diffPreview(before, after, { maxHunks: 2, context: 0 })
    expect(preview.hidden).toBeGreaterThan(0)
    expect(preview.truncated).toBe(true)
  })

  it('空文本不炸', () => {
    expect(diffPreview('', '甲').rows.length).toBeGreaterThan(0)
    expect(diffPreview('', '').rows.length).toBeGreaterThan(0)
  })

  it('超长输入走退化路径也不卡（不做 DP）', () => {
    const before = Array.from({ length: 900 }, (_, i) => `甲 ${i}`).join('\n')
    const after = Array.from({ length: 900 }, (_, i) => `乙 ${i}`).join('\n')
    const started = Date.now()
    const preview = diffPreview(before, after, { maxHunks: 1, context: 0 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(preview.rows.length).toBeGreaterThan(0)
  })
})
