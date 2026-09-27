import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 对比度门（围栏 docs/frontend.md §可访问性与验收）：
 * 正文、标题、次要文字、强调底上的字 ≥ 4.5:1；控件边界与焦点指示 ≥ 3:1；
 * 日间与夜间两套都过。
 *
 * 直接解析 styles.css 的 token 段，不起浏览器——数值改了这里立刻红。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(here, '../../src/renderer/src/styles.css'), 'utf8')

function blockAfter(selector: string): Record<string, string> {
  const at = css.indexOf(selector)
  if (at < 0) throw new Error(`styles.css 里找不到 ${selector}`)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  const body = css.slice(open + 1, close)
  const tokens: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const match = /^\s*(--[a-z0-9-]+):\s*([^;]+);/.exec(line)
    if (match) tokens[match[1]!] = match[2]!.trim()
  }
  return tokens
}

const day = blockAfter(':root {')
const night = { ...day, ...blockAfter("[data-theme='night'] {") }

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) throw new Error(`token 必须是纯 hex（对比度测试要解析）：${hex}`)
  const n = Number.parseInt(match[1]!, 16)
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  )
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

/** [前景, 背景, 门槛] */
const PAIRS: Array<[string, string, number]> = [
  ['--text-body', '--surface-canvas', 4.5],
  ['--text-body', '--surface-nav', 4.5],
  ['--text-heading', '--surface-canvas', 4.5],
  ['--text-muted', '--surface-canvas', 4.5],
  ['--text-muted', '--surface-nav', 4.5],
  ['--text-on-accent', '--accent-solid', 4.5],
  ['--accent-primary', '--surface-canvas', 4.5],
  ['--accent-primary', '--surface-nav', 4.5],
  ['--ai-prompt', '--surface-canvas', 4.5],
  ['--ai-answer', '--surface-canvas', 4.5],
  ['--status-error', '--surface-canvas', 4.5],
  ['--border-strong', '--surface-canvas', 3],
  ['--border-strong', '--surface-nav', 3],
  ['--accent-focus', '--surface-canvas', 3],
  ['--accent-focus', '--surface-nav', 3],
  ['--status-online', '--surface-nav', 3],
  ['--status-offline', '--surface-nav', 3],
  ['--status-error', '--surface-nav', 3]
]

describe.each([
  ['日间', day],
  ['夜间', night]
])('语义 token 对比度（%s）', (label, tokens) => {
  it('每个要求的配对都达标', () => {
    const failures: string[] = []
    for (const [fg, bg, min] of PAIRS) {
      const fgValue = tokens[fg]
      const bgValue = tokens[bg]
      expect(fgValue, `${label}缺少 token ${fg}`).toBeTruthy()
      expect(bgValue, `${label}缺少 token ${bg}`).toBeTruthy()
      const ratio = contrast(fgValue!, bgValue!)
      if (ratio < min) failures.push(`${fg} on ${bg} = ${ratio.toFixed(2)} < ${min}`)
    }
    expect(failures).toEqual([])
  })
})

describe('token 段', () => {
  it('日夜两套给出同一批角色，不缺项', () => {
    const roles = Object.keys(day).filter((name) => !name.startsWith('--font') && !name.startsWith('--radius'))
    const missing = roles.filter((name) => {
      if (name === '--bg' || name === '--bg-side' || name === '--ink' || name === '--muted') return false
      if (name === '--line' || name === '--accent' || name === '--accent-weak') return false
      if (name === '--paper' || name === '--danger' || name === '--shadow') return false
      if (name === '--ui' || name === '--text') return false
      return !(name in night)
    })
    expect(missing).toEqual([])
  })

  it('旧名只是别名，值不重复写死', () => {
    for (const alias of ['--bg', '--ink', '--line', '--accent', '--paper', '--danger', '--ui', '--text']) {
      expect(day[alias], `${alias} 应该是 var() 别名`).toMatch(/^var\(--/)
    }
  })
})
