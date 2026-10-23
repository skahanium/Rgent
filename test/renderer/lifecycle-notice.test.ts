// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { lifecycleErrorText } from '../../src/renderer/src/shell.ts'
import { hostErrorText } from '../../src/renderer/src/host-errors.ts'

it('the reserved-name notice says recreating supersedes the record and still points at recovery', () => {
  const text = lifecycleErrorText(new Error('PATH_RESERVED'))
  // 路径保留不再拦人：从界面新建会接替旧记录，文案必须这么说，而不是“不能复用”。
  expect(text).toContain('从界面新建同名笔记会接替旧记录')
  // 想找回原对象的人仍有一条可行路：原样放回后重扫核验。
  expect(text).toContain('原样放回')
  expect(text).toContain('重扫核验')
})

it('overlapping codes use host-errors as the single authority', () => {
  for (const code of ['LEDGER_BOUNDARY_INVALID', 'UNSAVED_DRAFT', 'TRASH_CONFLICT', 'VAULT_CHANGED']) {
    expect(lifecycleErrorText(new Error(code))).toBe(hostErrorText(code))
  }
})
