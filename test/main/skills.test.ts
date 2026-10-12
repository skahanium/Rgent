import { describe, expect, it } from 'vitest'
import { corruptSkillsView, enabledSnapshot, resolveSkills } from '../../src/main/skills.ts'
import type { SkillsDeviceConfig } from '../../src/main/skills-store.ts'
import { SKILL_LIMITS, type SkillRecord, type SkillView } from '../../src/shared/skills.ts'

/** 包 1：技能库 → 逐条视图 → 本场快照。语义不合只标不可用并给原因，绝不降级成「没有技能」。 */
const VAULT = 'a'.repeat(64)
const record = (over: Partial<SkillRecord> = {}): SkillRecord => ({
  id: 'skill-1',
  name: '答案批改',
  description: '按规则给客观题判分',
  triggers: ['批改'],
  body: '先核对题号，再按等价词典判分。',
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
  ...over
})
const config = (skills: SkillRecord[], enabled: string[] = []): SkillsDeviceConfig => ({ version: 1, skills, vaults: { [VAULT]: { enabled } } })
const reasons = (view: { skills: SkillView[] }): (string | null)[] => view.skills.map(skill => (skill.state === 'unavailable' ? skill.reason : null))

describe('skill resolution', () => {
  it('exposes an available record with byte size and content hash', () => {
    const view = resolveSkills(config([record()], ['skill-1']), VAULT)
    expect(view.state).toBe('ready')
    expect(view.ignored).toBe(0)
    const skill = view.skills[0]!
    expect(skill.state).toBe('available')
    if (skill.state !== 'available') throw new Error('unreachable')
    expect(skill.enabled).toBe(true)
    expect(skill.bytes).toBe(Buffer.byteLength(skill.body, 'utf8'))
    expect(skill.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(skill.triggers).toEqual(['批改'])
  })

  it('maps every semantic violation to its own reason', () => {
    const cases: [SkillRecord, string][] = [
      [record({ id: 'a', name: 'x'.repeat(SKILL_LIMITS.name + 1) }), 'invalid-name'],
      [record({ id: 'b', name: ' 前后有空格' }), 'invalid-name'],
      [record({ id: 'c', description: '' }), 'invalid-description'],
      [record({ id: 'd', triggers: Array.from({ length: SKILL_LIMITS.triggers + 1 }, (_, i) => `t${i}`) }), 'invalid-triggers'],
      [record({ id: 'e', triggers: [' 空格'] }), 'invalid-triggers'],
      [record({ id: 'f', body: '   \n  ' }), 'empty-body'],
      [record({ id: 'g', body: 'x'.repeat(SKILL_LIMITS.bodyBytes + 1) }), 'too-large'],
      [record({ id: 'h', body: '坏的\ud800代理项' }), 'not-utf8']
    ]
    const view = resolveSkills(config(cases.map(([item]) => item)), VAULT)
    expect(reasons(view)).toEqual(cases.map(([, reason]) => reason))
    expect(view.skills.every(skill => !skill.enabled)).toBe(true)
  })

  it('keeps one bad record from hiding the others, and flags duplicate ids', () => {
    const view = resolveSkills(config([
      record({ id: 'ok-1' }),
      record({ id: 'bad', description: '' }),
      record({ id: 'ok-2', name: '第二条' }),
      record({ id: 'ok-1', name: '重复的' })
    ]), VAULT)
    expect(reasons(view)).toEqual([null, 'invalid-description', null, 'duplicate-id'])
    expect(view.skills.filter(skill => skill.state === 'available')).toHaveLength(2)
    const duplicate = view.skills[3]!
    expect(duplicate).toMatchObject({ state: 'unavailable', reason: 'duplicate-id', id: 'ok-1', name: '重复的' })
  })

  it('ignores records beyond the count limit but reports how many', () => {
    const many = Array.from({ length: SKILL_LIMITS.maxCount + 3 }, (_, index) => record({ id: `s-${index}`, name: `第 ${index} 条` }))
    const view = resolveSkills(config(many), VAULT)
    expect(view.skills).toHaveLength(SKILL_LIMITS.maxCount)
    expect(view.ignored).toBe(3)
  })

  it('marks enablement per vault', () => {
    const other = 'b'.repeat(64)
    const base: SkillsDeviceConfig = { version: 1, skills: [record()], vaults: { [VAULT]: { enabled: ['skill-1'] }, [other]: { enabled: [] } } }
    expect(resolveSkills(base, VAULT).skills[0]!.enabled).toBe(true)
    expect(resolveSkills(base, other).skills[0]!.enabled).toBe(false)
    expect(resolveSkills(base, 'c'.repeat(64)).skills[0]!.enabled).toBe(false)
  })
})

describe('skill snapshot', () => {
  it('freezes enabled available skills with hashes, and lists the rest as unavailable', () => {
    const view = resolveSkills(config([record({ id: 'on' }), record({ id: 'off', name: '未启用' }), record({ id: 'broken', description: '' })], ['on', 'broken']), VAULT)
    const snapshot = enabledSnapshot(view, 'rev-1')
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]).toMatchObject({ id: 'on', name: '答案批改' })
    expect(snapshot.entries[0]!.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.unavailable).toEqual([{ id: 'broken', name: '答案批改', reason: 'invalid-description' }])
    expect(snapshot.signature).toMatch(/^[a-f0-9]{64}$/)
  })

  it('fails the whole set closed when the enabled bodies exceed the total budget', () => {
    const big = 'x'.repeat(SKILL_LIMITS.bodyBytes)
    const count = Math.ceil(SKILL_LIMITS.totalBytes / SKILL_LIMITS.bodyBytes) + 1
    const skills = Array.from({ length: count }, (_, index) => record({ id: `big-${index}`, body: big }))
    const view = resolveSkills(config(skills, skills.map(skill => skill.id)), VAULT)
    const snapshot = enabledSnapshot(view, 'rev-1')
    expect(snapshot.entries).toEqual([])
    expect(snapshot.unavailable).toHaveLength(count)
    expect(snapshot.unavailable.every(item => item.reason === 'set-too-large')).toBe(true)
  })

  it('turns an unreadable library into an explicit reason instead of an empty set', () => {
    const snapshot = enabledSnapshot(corruptSkillsView(), null)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.unavailable).toEqual([{ id: null, name: null, reason: 'corrupt-store' }])
  })

  it('changes the signature when content, enablement or the library revision changes', () => {
    const base = resolveSkills(config([record({ id: 'on' })], ['on']), VAULT)
    const first = enabledSnapshot(base, 'rev-1')
    expect(enabledSnapshot(base, 'rev-1').signature).toBe(first.signature)
    expect(enabledSnapshot(base, 'rev-2').signature).not.toBe(first.signature)
    const edited = resolveSkills(config([record({ id: 'on', body: '改过的正文' })], ['on']), VAULT)
    expect(enabledSnapshot(edited, 'rev-1').signature).not.toBe(first.signature)
    const disabled = resolveSkills(config([record({ id: 'on' })], []), VAULT)
    expect(enabledSnapshot(disabled, 'rev-1').signature).not.toBe(first.signature)
    expect(enabledSnapshot(disabled, 'rev-1').entries).toEqual([])
    expect(enabledSnapshot(disabled, 'rev-1').unavailable).toEqual([])
  })
})
