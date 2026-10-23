// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOST_ERROR_CODES, hostErrorText } from '../../src/renderer/src/host-errors.ts'

/**
 * U5 文案判据（交互减负合同第 6 条，2026-10-23 三档轮后保留）：
 * - 首句（到第一个「。」或「；」前）只讲发生了什么，汉字 ≤40；
 * - 首句不出现形如 `MACHINE_CODE` 的机器码；
 * - 渲染层不再用原生 `window.alert`／`window.confirm`。
 *
 * 授权卡、写确认卡与删除确认卡已随零确认移除；它们的文案测试也一并删除，
 * 不把已不存在的界面留成假的安全证据。
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
