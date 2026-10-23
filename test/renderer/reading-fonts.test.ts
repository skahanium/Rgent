import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FONT_STACKS } from '../../src/renderer/src/reading.ts'
import { DEFAULT_READING_PREFERENCE } from '../../src/shared/reading-preference.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const renderer = path.join(here, '../../src/renderer/src')
const fontDir = path.join(renderer, 'fonts')
const css = readFileSync(path.join(renderer, 'styles.css'), 'utf8')
const faces = readFileSync(path.join(renderer, 'reading-fonts.css'), 'utf8')

describe('packaged reading fonts', () => {
  it('keeps default literary and humanist on the bundled families', () => {
    expect(DEFAULT_READING_PREFERENCE.bodyFont).toBe('literary')
    expect(DEFAULT_READING_PREFERENCE.headingFont).toBe('humanist')
    expect(FONT_STACKS.literary).toBe("'Rgent Serif', serif")
    expect(FONT_STACKS.humanist).toBe("'Rgent Sans', sans-serif")
    expect(FONT_STACKS.song).toContain('Rgent Serif')
    expect(FONT_STACKS.song).toContain('Songti SC')
    expect(FONT_STACKS.system).toContain('Microsoft YaHei')
  })

  it('does not name machine-only book faces on the default stacks', () => {
    const locked = [FONT_STACKS.literary, FONT_STACKS.humanist, css, faces].join('\n')
    expect(locked).not.toMatch(/Iowan|SimSun|Songti SC|Palatino|Noto Serif CJK/)
    expect(FONT_STACKS.song).not.toContain('SimSun')
  })

  it('ships OFL faces for both Latin and simplified Chinese at 400 and 600', () => {
    const names = readdirSync(fontDir)
    for (const file of [
      'source-serif-4-latin-400.woff2',
      'source-serif-4-latin-600.woff2',
      'source-sans-3-latin-400.woff2',
      'source-sans-3-latin-600.woff2',
      'noto-serif-sc-400.woff2',
      'noto-serif-sc-600.woff2',
      'noto-sans-sc-400.woff2',
      'noto-sans-sc-600.woff2',
      'OFL.txt',
      'NOTICE.txt'
    ]) expect(names).toContain(file)
    expect(faces).toContain("font-family: 'Rgent Serif'")
    expect(faces).toContain("font-family: 'Rgent Sans'")
    expect(faces).toContain('unicode-range')
    expect(faces).toContain('U+3000-303F')
    expect(faces).toContain('U+4E00-9FFF')
    expect(faces).not.toContain('U+20000')
    const bytes = names.filter((name) => name.endsWith('.woff2')).reduce((sum, name) => sum + statSync(path.join(fontDir, name)).size, 0)
    expect(bytes).toBeGreaterThan(1024 * 1024)
    expect(bytes).toBeLessThan(12 * 1024 * 1024)
  })

  it('loads packaged faces from the renderer entry and holds text until they arrive', () => {
    const main = readFileSync(path.join(renderer, 'main.ts'), 'utf8')
    expect(main).toMatch(/import '\.\/reading-fonts\.css'/)
    expect(faces).toContain('font-display: block')
    expect(faces).not.toContain('font-display: swap')
  })

  it('keeps canvas heading scale, quiet links and ledger reuse', () => {
    expect(css).toMatch(/\.md-h1[\s\S]*?1\.55em/)
    expect(css).toMatch(/\.md-strong \{\s*font-weight: 600/)
    expect(css).toMatch(/text-justify: inter-character/)
    expect(css).toMatch(/\.md-link \{ color: var\(--text-body\)/)
    expect(css).toMatch(/\.ledger-body h1 \{ font-size: 1\.55em/)
  })
})
