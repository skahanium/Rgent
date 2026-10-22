// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { lifecycleErrorText } from '../../src/renderer/src/shell.ts'

it('the reserved-name notice says recreating supersedes the record and still points at recovery', () => {
  const text = lifecycleErrorText(new Error('PATH_RESERVED'))
  // 路径保留不再拦人：从界面新建会接替旧记录，文案必须这么说，而不是“不能复用”。
  expect(text).toContain('会直接接替它')
  expect(text).toContain('旧记录转为历史')
  // 想找回原对象的人仍有一条可行路：原样放回后重扫核验。
  expect(text).toContain('原样放回')
  expect(text).toContain('重扫核验')
})
