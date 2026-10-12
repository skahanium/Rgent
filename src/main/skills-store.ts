import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { SKILL_LIMITS, skillId, type SkillRecord } from '../shared/skills.ts'

export type VaultSkills = { enabled: string[] }
export type SkillsDeviceConfig = { version: 1; skills: SkillRecord[]; vaults: Record<string, VaultSkills> }

/** 设备级技能库。语义限额（名称／正文／触发条件）在 resolve 阶段逐条判定；
 *  这里只做结构校验：结构不合＝整库损坏，语义不合＝单条不可用——一条坏条目不得连累其他条目。 */
const FILE = 'skills.json'
const MAX_FILE_BYTES = 1024 * 1024
/** 结构层的条数护栏：语义上限是 32，多余的按「忽略」如实报数，而不是让整库损坏。 */
const STRUCTURAL_MAX_SKILLS = 128

export const emptySkillsConfig = (): SkillsDeviceConfig => ({ version: 1, skills: [], vaults: {} })

export function requireVaultKey(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error('BAD_VAULT_KEY')
}

const fields = (value: unknown, names: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === names.sort().join()

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max

const SKILL_FIELDS = ['id', 'name', 'description', 'triggers', 'body', 'createdAt', 'updatedAt']

function structuralSkill(value: unknown): SkillRecord {
  if (!fields(value, SKILL_FIELDS)) throw Error('SKILLS_STORE_INVALID')
  const record = value as Record<string, unknown>
  if (!skillId(record.id)) throw Error('SKILLS_STORE_INVALID')
  // 结构层只挡住病态体积；超限本身由语义校验逐条判成「不可用」。
  if (!text(record.name, SKILL_LIMITS.name * 4) || !text(record.description, SKILL_LIMITS.description * 4) || !text(record.body, SKILL_LIMITS.bodyBytes * 4)) throw Error('SKILLS_STORE_INVALID')
  if (!text(record.createdAt, 40) || !text(record.updatedAt, 40)) throw Error('SKILLS_STORE_INVALID')
  if (!Array.isArray(record.triggers) || record.triggers.length > SKILL_LIMITS.triggers * 4 || !record.triggers.every(item => text(item, SKILL_LIMITS.trigger * 4))) throw Error('SKILLS_STORE_INVALID')
  return { id: record.id, name: record.name, description: record.description, triggers: [...record.triggers] as string[], body: record.body, createdAt: record.createdAt, updatedAt: record.updatedAt }
}

export function parseSkillsConfig(raw: string): SkillsDeviceConfig {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) throw Error('SKILLS_STORE_INVALID')
  const value: unknown = JSON.parse(raw)
  if (!fields(value, ['version', 'skills', 'vaults']) || value.version !== 1) throw Error('SKILLS_STORE_INVALID')
  const config = value as { skills: unknown; vaults: unknown }
  if (!Array.isArray(config.skills) || config.skills.length > STRUCTURAL_MAX_SKILLS) throw Error('SKILLS_STORE_INVALID')
  const skills = config.skills.map(structuralSkill)
  if (!config.vaults || typeof config.vaults !== 'object' || Array.isArray(config.vaults)) throw Error('SKILLS_STORE_INVALID')
  const vaults: Record<string, VaultSkills> = {}
  for (const [key, entry] of Object.entries(config.vaults as Record<string, unknown>)) {
    requireVaultKey(key)
    if (!fields(entry, ['enabled']) || !Array.isArray(entry.enabled) || entry.enabled.length > STRUCTURAL_MAX_SKILLS || !entry.enabled.every(id => skillId(id))) throw Error('SKILLS_STORE_INVALID')
    const enabled = entry.enabled as string[]
    if (new Set(enabled).size !== enabled.length) throw Error('SKILLS_STORE_INVALID')
    vaults[key] = { enabled: [...enabled] }
  }
  return { version: 1, skills, vaults }
}

/** 独立设备文件；损坏是诊断，不是「用默认值覆盖」。读取不写盘，显式写入才落盘。 */
export function createSkillsStore(userData: string) {
  const target = path.join(userData, FILE)
  const disk = (): string | null => {
    try {
      const bytes = readFileSync(target)
      const raw = bytes.toString('utf8')
      // 与账本同一处做法：解码后再编码必须逐字节相同，否则文件不是合法 UTF-8。
      if (!Buffer.from(raw, 'utf8').equals(bytes)) throw Error('SKILLS_STORE_INVALID')
      return raw
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  let raw: string | null = null
  let current = emptySkillsConfig()
  let invalid = false
  try {
    raw = disk()
    if (raw !== null) current = parseSkillsConfig(raw)
  } catch {
    invalid = true
  }
  const revisionOf = (text: string | null): string | null => (text === null ? null : createHash('sha256').update(text).digest('hex'))
  const get = (): SkillsDeviceConfig => {
    if (invalid) throw Error('SKILLS_STORE_INVALID')
    if (disk() !== raw) throw Error('SKILLS_STORE_CONFLICT')
    return structuredClone(current)
  }
  /** 损坏时也如实报出：界面与快照据此显示「技能库损坏」，且不许改写原文件。 */
  const diagnosis = () => {
    let bytes: string | null = null
    let broken = invalid
    try {
      bytes = disk()
    } catch {
      broken = true
    }
    return { revision: bytes === null ? null : revisionOf(bytes), bytes: Buffer.byteLength(bytes ?? ''), invalid: broken }
  }
  const replace = (next: SkillsDeviceConfig, expected: string | null): void => {
    const serialized = JSON.stringify(next)
    parseSkillsConfig(serialized)
    if (revisionOf(disk()) !== expected) throw Error('SKILLS_STORE_CONFLICT')
    const temporary = path.join(userData, `.skills-${randomUUID()}.tmp`)
    let fd: number | null = null
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, serialized)
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      if (revisionOf(disk()) !== expected) throw Error('SKILLS_STORE_CONFLICT')
      renameSync(temporary, target)
      raw = serialized
      current = structuredClone(next)
      invalid = false
    } finally {
      if (fd !== null) closeSync(fd)
      try { unlinkSync(temporary) } catch { /* 已提交或临时文件从未创建 */ }
    }
  }
  return {
    get,
    diagnosis,
    write(next: SkillsDeviceConfig, expectedRevision: string | null): void {
      if (!invalid) get()
      replace(next, expectedRevision)
    },
    setEnabled(vaultKey: string, ids: readonly string[], expectedRevision: string | null): SkillsDeviceConfig {
      requireVaultKey(vaultKey)
      const base = invalid ? emptySkillsConfig() : get()
      const known = new Set(base.skills.map(skill => skill.id))
      const enabled = [...new Set(ids)]
      if (enabled.some(id => !known.has(id))) throw Error('SKILLS_UNKNOWN_ID')
      const next: SkillsDeviceConfig = { ...base, vaults: { ...base.vaults, [vaultKey]: { enabled } } }
      replace(next, expectedRevision)
      return structuredClone(next)
    }
  }
}
