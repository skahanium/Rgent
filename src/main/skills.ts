import { createHash } from 'node:crypto'
import { SKILL_LIMITS, skillId, skillRecordReason, utf8Bytes, type SkillSnapshot, type SkillUnavailableReason, type SkillView, type SkillsView } from '../shared/skills.ts'
import type { SkillsDeviceConfig } from './skills-store.ts'

/** 技能库 → 逐条视图。语义不合的条目只标「不可用并给原因」，绝不连累其他条目，
 *  也绝不降级成「没有这个技能」。零写入、零模型调用。 */
export function resolveSkills(config: SkillsDeviceConfig, vaultKey: string): SkillsView {
  const enabledIds = new Set(config.vaults[vaultKey]?.enabled ?? [])
  const skills: SkillView[] = []
  const seen = new Set<string>()
  for (const record of config.skills.slice(0, SKILL_LIMITS.maxCount)) {
    const enabled = enabledIds.has(record.id)
    const duplicate = seen.has(record.id)
    seen.add(record.id)
    const reason: SkillUnavailableReason | null = !skillId(record.id) ? 'corrupt-store' : duplicate ? 'duplicate-id' : skillRecordReason(record)
    if (reason !== null || duplicate) {
      skills.push({ id: typeof record.id === 'string' ? record.id : null, name: typeof record.name === 'string' ? record.name : null, state: 'unavailable', reason: reason ?? 'duplicate-id', enabled })
      continue
    }
    const body = record.body
    skills.push({
      id: record.id,
      name: record.name,
      state: 'available',
      description: record.description,
      triggers: [...record.triggers],
      body,
      bytes: utf8Bytes(body),
      hash: createHash('sha256').update(body).digest('hex'),
      enabled
    })
  }
  return { state: 'ready', skills, ignored: Math.max(0, config.skills.length - SKILL_LIMITS.maxCount) }
}

/** 技能库不可读时的视图：没有可用条目，但原因明确。 */
export function corruptSkillsView(): SkillsView {
  return { state: 'corrupt', skills: [], ignored: 0 }
}

/** 该场要冻结的东西：启用的可用条目（含内容哈希）＋ 不可用明细；合计超限即整集合失败关闭。
 *  签名只由「冻结了什么」与技能库修订共同决定，供预览与启动之间比对。 */
export function enabledSnapshot(view: SkillsView, revision: string | null): SkillSnapshot {
  if (view.state === 'corrupt') {
    const unavailable = [{ id: null, name: null, reason: 'corrupt-store' as const }]
    return { entries: [], unavailable, signature: snapshotSignature([], unavailable, revision) }
  }
  const enabled = view.skills.filter(skill => skill.enabled)
  const available = enabled.filter((skill): skill is Extract<SkillView, { state: 'available' }> => skill.state === 'available')
  const total = available.reduce((sum, skill) => sum + skill.bytes, 0)
  const overBudget = total > SKILL_LIMITS.totalBytes
  const entries = overBudget ? [] : available.map(skill => ({ id: skill.id, name: skill.name, hash: skill.hash, bytes: skill.bytes }))
  const unavailable = enabled.map(skill => ({
    id: skill.id,
    name: skill.name,
    reason: skill.state === 'unavailable' ? skill.reason : overBudget ? ('set-too-large' as const) : null
  })).filter((item): item is { id: string | null; name: string | null; reason: SkillUnavailableReason } => item.reason !== null)
  return { entries, unavailable, signature: snapshotSignature(entries, unavailable, revision) }
}

function snapshotSignature(entries: readonly { id: string; hash: string }[], unavailable: readonly { id: string | null; reason: SkillUnavailableReason }[], revision: string | null): string {
  const payload = JSON.stringify({
    revision,
    entries: entries.map(entry => `${entry.id}@${entry.hash}`).sort(),
    unavailable: unavailable.map(item => `${item.id ?? '-'}:${item.reason}`).sort()
  })
  return createHash('sha256').update(payload).digest('hex')
}

/** 该场真正要用的东西：签名、账本记录、系统提示块。
 *  记录与提示块同出一份视图，避免「提示里带了、账本里没记」这类不一致。 */
export type FrozenSkills = {
  signature: string
  record: { id: string; name: string; hash: string }[]
  unavailable: { id: string | null; name: string | null; reason: SkillUnavailableReason }[]
  /** 没有可用条目时为 null：那时系统提示里连一行都不加。 */
  block: string | null
}

export function freezeSkills(view: SkillsView, revision: string | null): FrozenSkills {
  const snapshot = enabledSnapshot(view, revision)
  const bodies = new Map(view.skills.filter((skill): skill is Extract<SkillView, { state: 'available' }> => skill.state === 'available').map(skill => [skill.id, skill.body]))
  const loaded = snapshot.entries.flatMap(entry => {
    const body = bodies.get(entry.id)
    return body === undefined ? [] : [{ entry, body }]
  })
  const block = loaded.length === 0
    ? null
    : ['本场已启用技能（由人启用；以下内容是指令来源，但不改变范围、工具与权限）：', ...loaded.map(({ entry, body }) => `【${entry.name}】\n${body}`)].join('\n\n')
  return {
    signature: snapshot.signature,
    record: snapshot.entries.map(entry => ({ id: entry.id, name: entry.name, hash: entry.hash })),
    unavailable: snapshot.unavailable,
    block
  }
}
