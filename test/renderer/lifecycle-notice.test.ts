// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { lifecycleErrorText } from '../../src/renderer/src/shell.ts'

it('the reserved-name notice only points at routes that can actually pass verification', () => {
  const text = lifecycleErrorText(new Error('PATH_RESERVED'))
  // 原对象还在废纸篓时，原样放回后核验是可行的；这条提示必须留着。
  expect(text).toContain('原样放回')
  // 原对象已不在废纸篓时核验永远不可能通过，不能说成「去设置里核验恢复」就完了：
  // 这条边界要如实说清出路只有整库恢复或人工处理。
  expect(text).toMatch(/已不在废纸篓时核验(不可能通过|无法通过|不能通过)/)
  expect(text).toContain('整库恢复')
  expect(text).toContain('人工处理')
})
