/** 技能：库内 Markdown 说明文，由人显式加载。
 *  合同见 decisions.md「2026-10-12 技能局部授权」：模型不能写技能、不能上架、不能自行加载；
 *  技能不得扩大授权；本场快照冻结；失败关闭；不进记忆存储。 */

/** 限额。数量与单篇容量都是产品取舍：宁可如实报「不可用」，也不截断正文假装可用。 */
export const SKILL_LIMITS = { maxCount: 32, maxBytes: 16 * 1024, maxTitleChars: 80 } as const

export type SkillRegistration = { id: string; relPath: string }

export type SkillUnavailableReason =
  | 'hidden-path'
  | 'not-a-note'
  | 'outside-vault'
  | 'missing'
  | 'not-ordinary-file'
  | 'empty'
  | 'too-large'
  | 'not-utf8'

/** 逐项结果：不可用时必须带原因，界面与快照都不得把它当成「没有这个技能」。 */
export type SkillView =
  | { id: string; relPath: string; state: 'available'; title: string; bytes: number; objectVersion: string; content: string }
  | { id: string; relPath: string; state: 'unavailable'; reason: SkillUnavailableReason }

export type SkillsView = {
  skills: SkillView[]
  /** 超过数量上限时被忽略的注册项数：如实报数，不静默丢弃。 */
  ignored: number
}
