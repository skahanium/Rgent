// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOST_ERROR_CODES, hostErrorText } from '../../src/renderer/src/host-errors.ts'
import { TRASH_CONFIRM_NOTES } from '../../src/renderer/src/trash-confirm.ts'
import { writeConfirmLead, writeConfirmTitle } from '../../src/renderer/src/write-confirm.ts'
import type { AgentWritePreview } from '../../src/shared/ipc.ts'

/**
 * U5 文案判据（交互减负合同第 6 条）：
 * - 首句（到第一个「。」或「；」前）只讲发生了什么，汉字 ≤40；
 * - 首句不出现形如 `MACHINE_CODE` 的机器码；
 * - 渲染层不再用原生 `window.alert`／`window.confirm`。
 *
 * 被测的写确认文案通过导出函数取实际渲染值，而不是在测试里抄一遍字符串。
 */
const MACHINE_CODE = /\b[A-Z][A-Z0-9_]{5,}\b/u
const HAN = /\p{Script=Han}/u
const CJK_LIMIT = 40

const cjkCount = (text: string): number => [...text].filter(char => HAN.test(char)).length
/** 首句＝到第一个句号／分号前；没有标点就整句都算首句。 */
const firstSentence = (text: string): string => text.split(/[。；]/u, 1)[0] ?? ''

const expectShortLead = (text: string): void => {
  const lead = firstSentence(text).trim()
  expect(lead).not.toBe('')
  expect(cjkCount(lead)).toBeLessThanOrEqual(CJK_LIMIT)
  expect(lead).not.toMatch(MACHINE_CODE)
}

describe('host error copy', () => {
  it.each(HOST_ERROR_CODES)('%s 的首句是短人话，不带机器码', (code) => {
    const text = hostErrorText(code)
    expect(text).not.toBe(code)
    expectShortLead(text)
  })
})

describe('trash confirmation copy', () => {
  it('两条说明的首句都只说会发生什么', () => {
    for (const note of Object.values(TRASH_CONFIRM_NOTES)) expectShortLead(note)
    // 第二轮句子才讲链接失效；窗口专项依赖这两句原话。
    for (const note of Object.values(TRASH_CONFIRM_NOTES)) expect(note).toContain('链接会失效，不会代为改字')
    expect(TRASH_CONFIRM_NOTES.withAttachments).toContain('同名附件夹')
    expect(TRASH_CONFIRM_NOTES.withoutAttachments).toContain('没有同名附件夹')
  })
})

describe('write confirmation copy', () => {
  const previews: AgentWritePreview[] = [
    { requestId: 'c1', kind: 'create', relPath: '工作/新笔记.md', body: '正文' },
    { requestId: 'c2', kind: 'rename', source: '资料/参考篇.md', target: '资料/新名.md', moves: 1, linkChanges: 2, permissionChanges: 1 },
    { requestId: 'c3', kind: 'move', source: '资料/参考篇.md', target: '归档/参考篇.md', moves: 1, linkChanges: 0, permissionChanges: 0 },
    { requestId: 'c4', kind: 'delete', relPath: '资料/参考篇.md', hasAttachments: true },
    { requestId: 'c5', kind: 'delete', relPath: '资料/参考篇.md', hasAttachments: false }
  ]

  it.each(previews)('$kind 的首句与标题都短且无机器码', (preview) => {
    expectShortLead(writeConfirmLead(preview))
    const title = writeConfirmTitle(preview)
    expect(title.length).toBeLessThanOrEqual(40)
    expect(title).not.toMatch(MACHINE_CODE)
  })

  it('标题超长时截到 40 字并带省略号，与卡片实际渲染一致', () => {
    const title = writeConfirmTitle({
      requestId: 'long', kind: 'create', relPath: `工作/${'很长的笔记名'.repeat(8)}.md`, body: '正文'
    })
    expect(title.length).toBe(40)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('native dialogs', () => {
  it('src/renderer/src 的源码不再使用 window.alert／window.confirm', () => {
    const dir = 'src/renderer/src'
    const offenders = readdirSync(dir)
      .filter(name => name.endsWith('.ts'))
      .filter(name => {
        const source = readFileSync(`${dir}/${name}`, 'utf8')
        return source.includes('window.alert(') || source.includes('window.confirm(')
      })
    expect(offenders).toEqual([])
  })
})
