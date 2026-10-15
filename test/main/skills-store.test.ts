import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSkillsStore, emptySkillsConfig, parseSkillsConfig, requireVaultKey, type SkillsDeviceConfig } from '../../src/main/skills-store.ts'
import { SKILL_LIMITS, type SkillRecord } from '../../src/shared/skills.ts'

/** 包 1：设备级技能库。语义限额逐条判成「不可用」，结构不合才是整库损坏。 */
const directories: string[] = []
const directory = (): string => {
  const result = mkdtempSync(path.join(os.tmpdir(), 'rgent-skills-'))
  directories.push(result)
  return result
}
const VAULT_A = 'a'.repeat(64)
const VAULT_B = 'b'.repeat(64)

const record = (over: Partial<SkillRecord> = {}): SkillRecord => ({
  id: 'skill-1',
  name: '答案批改',
  description: '按规则给客观题判分',
  triggers: ['批改', '判分'],
  body: '先核对题号，再按等价词典判分。',
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
  ...over
})
const config = (skills: SkillRecord[], vaults: SkillsDeviceConfig['vaults'] = {}): SkillsDeviceConfig => ({ version: 1, skills, vaults })

afterEach(() => {
  for (const item of directories.splice(0)) rmSync(item, { recursive: true, force: true })
})

describe('skills store', () => {
  it('starts empty without creating a file, and reports that in the diagnosis', () => {
    const root = directory()
    const store = createSkillsStore(root)
    expect(store.get()).toEqual(emptySkillsConfig())
    expect(store.diagnosis()).toEqual({ revision: null, bytes: 0, invalid: false })
    expect(existsSync(path.join(root, 'skills.json'))).toBe(false)
  })

  it('writes atomically, round-trips, and keeps the file private', () => {
    const root = directory()
    const store = createSkillsStore(root)
    store.write(config([record()], { [VAULT_A]: { enabled: ['skill-1'] } }), null)
    const target = path.join(root, 'skills.json')
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600)
    const fresh = createSkillsStore(root)
    expect(fresh.get().skills[0]!.name).toBe('答案批改')
    expect(fresh.get().vaults[VAULT_A]!.enabled).toEqual(['skill-1'])
    // 临时文件不残留
    expect(readFileSync(root + '/skills.json', 'utf8')).not.toContain('.tmp')
    expect(store.diagnosis().revision).toMatch(/^[a-f0-9]{64}$/)
  })

  it('refuses a stale revision instead of overwriting a newer file', () => {
    const root = directory()
    const store = createSkillsStore(root)
    store.write(config([record()]), null)
    const stale = store.diagnosis().revision
    store.write(config([record(), record({ id: 'skill-2', name: '第二' })]), stale)
    expect(() => store.write(config([]), stale)).toThrow('SKILLS_STORE_CONFLICT')
    expect(JSON.parse(readFileSync(path.join(root, 'skills.json'), 'utf8')).skills).toHaveLength(2)
  })

  it('treats a corrupt or non-UTF-8 file as a diagnosis and never rewrites it', () => {
    for (const bytes of [Buffer.from('{broken'), Buffer.from(JSON.stringify({ version: 2, skills: [], vaults: {} })), Buffer.from([0xff, 0xfe, 0x00, 0x41])]) {
      const root = directory()
      const target = path.join(root, 'skills.json')
      writeFileSync(target, bytes)
      const store = createSkillsStore(root)
      expect(store.diagnosis().invalid).toBe(true)
      expect(() => store.get()).toThrow('SKILLS_STORE_INVALID')
      expect(readFileSync(target).equals(bytes)).toBe(true)
    }
  })

  it('rejects structurally invalid writes without touching the disk', () => {
    const root = directory()
    const store = createSkillsStore(root)
    store.write(config([record()]), null)
    const before = readFileSync(path.join(root, 'skills.json'), 'utf8')
    const bad: unknown[] = [
      { version: 2, skills: [], vaults: {} },
      { version: 1, skills: [], vaults: {}, extra: 1 },
      { version: 1, skills: [{ ...record(), id: '有空格 id' }], vaults: {} },
      { version: 1, skills: [{ ...record(), name: undefined }], vaults: {} },
      { version: 1, skills: [], vaults: { [VAULT_A]: { enabled: ['a', 'a'] } } },
      { version: 1, skills: [], vaults: { 'not-a-key': { enabled: [] } } },
      { version: 1, skills: Array.from({ length: 129 }, (_, index) => record({ id: `s-${index}` })), vaults: {} }
    ]
    for (const value of bad) expect(() => store.write(value as SkillsDeviceConfig, store.diagnosis().revision)).toThrow()
    // 结构不合与库键不合是两种拒绝，但都不得动盘。
    expect(() => store.write({ version: 2, skills: [], vaults: {} } as unknown as SkillsDeviceConfig, store.diagnosis().revision)).toThrow('SKILLS_STORE_INVALID')
    expect(() => store.write({ version: 1, skills: [], vaults: { 'not-a-key': { enabled: [] } } }, store.diagnosis().revision)).toThrow('BAD_VAULT_KEY')
    expect(readFileSync(path.join(root, 'skills.json'), 'utf8')).toBe(before)
  })

  it('keeps semantic limits out of the store: an over-long name still parses', () => {
    const overLong = record({ name: 'x'.repeat(SKILL_LIMITS.name + 1) })
    const parsed = parseSkillsConfig(JSON.stringify(config([overLong])))
    expect(parsed.skills[0]!.name).toHaveLength(SKILL_LIMITS.name + 1)
  })

  it('toggles enablement per vault, rejecting unknown ids and bad keys', () => {
    const root = directory()
    const store = createSkillsStore(root)
    store.write(config([record(), record({ id: 'skill-2', name: '第二', description: '另一条' })]), null)
    store.setEnabled(VAULT_A, ['skill-1', 'skill-1'], store.diagnosis().revision)
    expect(store.get().vaults[VAULT_A]!.enabled).toEqual(['skill-1'])
    store.setEnabled(VAULT_B, ['skill-2'], store.diagnosis().revision)
    expect(store.get().vaults[VAULT_A]!.enabled).toEqual(['skill-1'])
    expect(store.get().vaults[VAULT_B]!.enabled).toEqual(['skill-2'])
    expect(() => store.setEnabled(VAULT_A, ['missing'], store.diagnosis().revision)).toThrow('SKILLS_UNKNOWN_ID')
    expect(() => store.setEnabled('nope', [], store.diagnosis().revision)).toThrow('BAD_VAULT_KEY')
  })

  it('fails the write when the directory is gone and leaves no temporary file behind', () => {
    const root = directory()
    const store = createSkillsStore(root)
    const missing = path.join(root, 'gone')
    const broken = createSkillsStore(missing)
    expect(() => broken.write(config([record()]), null)).toThrow()
    expect(existsSync(path.join(missing, 'skills.json'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
    expect(() => store.write(config([record()]), store.diagnosis().revision)).toThrow()
  })

  it('requires a 64-hex vault key', () => {
    expect(() => requireVaultKey(VAULT_A)).not.toThrow()
    expect(() => requireVaultKey('A'.repeat(64))).toThrow('BAD_VAULT_KEY')
    expect(() => requireVaultKey('a'.repeat(63))).toThrow('BAD_VAULT_KEY')
  })
})
