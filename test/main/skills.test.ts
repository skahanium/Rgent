import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, truncateSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKILL_LIMITS, type SkillRegistration } from '../../src/shared/skills.ts'
import { readRegisteredSkills } from '../../src/main/skills.ts'
import { closeSecureFs } from '../../src/main/secure-fs.ts'

/** 包 1：只读发现与校验。失败必须给原因，不得降级成「没有这个技能」。 */
describe('skill discovery', () => {
  let vault: string
  const write = (relPath: string, content: string | Buffer) => {
    const target = path.join(vault, relPath)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  const read = (registrations: SkillRegistration[]) => readRegisteredSkills(vault, registrations)

  beforeEach(() => { vault = mkdtempSync(path.join(os.tmpdir(), 'rgent-skills-')) })
  afterEach(() => { closeSecureFs(vault); rmSync(vault, { recursive: true, force: true }) })

  it('loads an ordinary note and reports its title, size and object version', () => {
    write('技能/写作规范.md', '# 写作规范\n\n先写结论，再给一个例子。\n')
    const view = read([{ id: 's1', relPath: '技能/写作规范.md' }])
    expect(view.ignored).toBe(0)
    expect(view.skills).toHaveLength(1)
    const skill = view.skills[0]!
    expect(skill.state).toBe('available')
    if (skill.state !== 'available') throw new Error('unreachable')
    expect(skill.title).toBe('写作规范')
    expect(skill.content).toContain('先写结论')
    expect(skill.bytes).toBeGreaterThan(0)
    expect(skill.objectVersion.length).toBeGreaterThan(0)
  })

  it('falls back to the first non-empty line, then the file name', () => {
    write('a.md', '\n\n没有标题的一行\n')
    write('b.md', '   \n')
    const view = read([{ id: 'a', relPath: 'a.md' }, { id: 'b', relPath: 'b.md' }])
    expect(view.skills.map(skill => (skill.state === 'available' ? skill.title : skill.reason))).toEqual(['没有标题的一行', 'b'])
  })

  it('rejects anything that is not a Markdown note, is hidden, or escapes the vault', () => {
    write('notes.txt', 'x')
    write('.secret/skill.md', '# 隐藏\n')
    const view = read([
      { id: 'txt', relPath: 'notes.txt' },
      { id: 'hidden', relPath: '.secret/skill.md' },
      { id: 'escape', relPath: '../outside.md' },
      { id: 'absolute', relPath: path.join(vault, 'notes.txt') }
    ])
    expect(view.skills.map(skill => (skill.state === 'unavailable' ? skill.reason : 'available')))
      .toEqual(['not-a-note', 'hidden-path', 'outside-vault', 'not-a-note'])
  })

  it('reports missing files, directories and symbolic links instead of pretending they are absent', () => {
    write('real.md', '# 真身\n')
    mkdirSync(path.join(vault, 'folder.md'))
    symlinkSync(path.join(vault, 'real.md'), path.join(vault, 'link.md'))
    write('outside-target.md', '# 外目标\n')
    const view = read([
      { id: 'missing', relPath: 'gone.md' },
      { id: 'dir', relPath: 'folder.md' },
      { id: 'link', relPath: 'link.md' }
    ])
    expect(view.skills.map(skill => (skill.state === 'unavailable' ? skill.reason : 'available')))
      .toEqual(['missing', 'not-ordinary-file', 'not-ordinary-file'])
  })

  it('rejects empty, oversized and non-UTF-8 files', () => {
    write('empty.md', '')
    const big = path.join(vault, 'big.md')
    writeFileSync(big, 'x')
    truncateSync(big, SKILL_LIMITS.maxBytes + 1)
    write('binary.md', Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    const view = read([{ id: 'empty', relPath: 'empty.md' }, { id: 'big', relPath: 'big.md' }, { id: 'binary', relPath: 'binary.md' }])
    expect(view.skills.map(skill => (skill.state === 'unavailable' ? skill.reason : 'available')))
      .toEqual(['empty', 'too-large', 'not-utf8'])
  })

  it('accepts a file exactly at the size limit and ignores registrations beyond the count limit', () => {
    const exact = 'y'.repeat(SKILL_LIMITS.maxBytes)
    write('exact.md', exact)
    expect(read([{ id: 'exact', relPath: 'exact.md' }]).skills[0]!.state).toBe('available')
    const many: SkillRegistration[] = Array.from({ length: SKILL_LIMITS.maxCount + 2 }, (_, index) => {
      write(`bulk/s${index}.md`, `# s${index}\n`)
      return { id: `s${index}`, relPath: `bulk/s${index}.md` }
    })
    const view = read(many)
    expect(view.skills).toHaveLength(SKILL_LIMITS.maxCount)
    expect(view.ignored).toBe(2)
    expect(view.skills.filter(skill => skill.state === 'unavailable')).toHaveLength(0)
  })

  it('keeps each registration independent: one bad entry never hides the others', () => {
    write('good.md', '# 好的\n')
    const view = read([{ id: 'bad', relPath: 'gone.md' }, { id: 'good', relPath: 'good.md' }])
    expect(view.skills.map(skill => skill.state)).toEqual(['unavailable', 'available'])
  })
})
