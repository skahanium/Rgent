/** 技能：应用管理的条目，由人显式启用。
 *  合同见 decisions.md「2026-10-12 技能局部授权」（同日修订版）：
 *  模型不能写技能、不能上架、不能自行加载；技能不得扩大授权；本场快照冻结；失败关闭；不进记忆存储。 */

export const SKILL_LIMITS = {
  /** 技能条数上限；超出的条目如实报数（ignored），不静默丢弃。 */
  maxCount: 32,
  name: 60,
  description: 200,
  triggers: 16,
  trigger: 40,
  /** 单条正文上限（字节）。 */
  bodyBytes: 16 * 1024,
  /** 一场启用集合的正文合计上限（字节）；超出即整集合失败关闭，逐条仍列出。 */
  totalBytes: 64 * 1024,
  id: 64
} as const

export type SkillRecord = {
  id: string
  name: string
  description: string
  triggers: string[]
  body: string
  createdAt: string
  updatedAt: string
}

export type SkillUnavailableReason =
  | 'duplicate-id'
  | 'invalid-name'
  | 'invalid-description'
  | 'invalid-triggers'
  | 'empty-body'
  | 'too-large'
  | 'not-utf8'
  | 'corrupt-store'
  | 'set-too-large'

/** 人话文案：界面、快照与账本共用一份，不许各处自己编。 */
export const SKILL_REASON_TEXT: Record<SkillUnavailableReason, string> = {
  'duplicate-id': '这条技能的标识与另一条重复，已停用；请删除或改名其中一条。',
  'invalid-name': `名称需为去空白后非空、不超过 ${SKILL_LIMITS.name} 字。`,
  'invalid-description': `说明需为去空白后非空、不超过 ${SKILL_LIMITS.description} 字。`,
  'invalid-triggers': `触发条件最多 ${SKILL_LIMITS.triggers} 条，每条不超过 ${SKILL_LIMITS.trigger} 字且不能为空。`,
  'empty-body': '正文不能为空。',
  'too-large': `正文超过 ${Math.round(SKILL_LIMITS.bodyBytes / 1024)} KiB。`,
  'not-utf8': '正文不是合法 UTF-8 文本。',
  'corrupt-store': '技能库文件损坏或无法读取；原文件未被改写。',
  'set-too-large': `本库启用的技能正文合计超过 ${Math.round(SKILL_LIMITS.totalBytes / 1024)} KiB，本场没有加载任何技能。`
}

export type SkillView =
  | { id: string; name: string; state: 'available'; description: string; triggers: string[]; body: string; bytes: number; hash: string; enabled: boolean }
  | { id: string | null; name: string | null; state: 'unavailable'; reason: SkillUnavailableReason; enabled: boolean }

export type SkillsView = {
  /** corrupt＝技能库不可读：没有任何可用条目，且不得当作「没有技能」。 */
  state: 'ready' | 'corrupt'
  skills: SkillView[]
  ignored: number
}

/** 该场冻结的技能集合。签名只由条目身份与内容决定，用于预览与启动之间的比对。 */
export type SkillSnapshot = {
  entries: { id: string; name: string; hash: string; bytes: number }[]
  unavailable: { id: string | null; name: string | null; reason: SkillUnavailableReason }[]
  signature: string
}

const CONTROL = /[\u0000-\u001f\u007f]/u

/** 去空白必须一致（存的就是修剪后的值），且不含控制字符；多行字段允许 LF/CRLF。 */
export function cleanSkillText(value: unknown, max: number, multiline = false): string | null {
  if (typeof value !== 'string' || value !== value.trim() || value.length > max) return null
  if (CONTROL.test(multiline ? value.replace(/\r\n|\n/gu, '') : value)) return null
  return value
}

export function skillId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SKILL_LIMITS.id && /^[A-Za-z0-9-]+$/u.test(value)
}

/** 孤立代理项不是合法 UTF-8：主进程与渲染层共用这一条，不依赖 Buffer。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

export function isUtf8Text(value: string): boolean {
  return !LONE_SURROGATE.test(value)
}

/** 正文按字节算上限：先看是不是合法 UTF-8 文本，再看长度。 */
export function skillBody(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0) return null
  if (CONTROL.test(value.replace(/\r\n|\n/gu, ''))) return null
  if (!isUtf8Text(value)) return null
  if (utf8Bytes(value) > SKILL_LIMITS.bodyBytes) return null
  return value
}

export function skillTriggers(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > SKILL_LIMITS.triggers) return null
  const out: string[] = []
  for (const item of value) {
    const text = cleanSkillText(item, SKILL_LIMITS.trigger)
    if (text === null || text.length === 0) return null
    out.push(text)
  }
  return out
}

/** 时间戳只作展示与排序，宽松校验：非空、不超过 40 字、无控制字符。 */
const stamp = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 40 && !CONTROL.test(value)

/** 逐条按固定顺序判定：第一条不满足的规则即原因，界面因此只有一种解释。 */
export function skillFieldsReason(value: unknown): SkillUnavailableReason | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'corrupt-store'
  const record = value as Partial<SkillRecord>
  const name = cleanSkillText(record.name, SKILL_LIMITS.name)
  if (name === null || name.length === 0) return 'invalid-name'
  const description = cleanSkillText(record.description, SKILL_LIMITS.description)
  if (description === null || description.length === 0) return 'invalid-description'
  if (skillTriggers(record.triggers) === null) return 'invalid-triggers'
  const body = record.body
  if (typeof body !== 'string' || !isUtf8Text(body)) return 'not-utf8'
  if (body.trim().length === 0) return 'empty-body'
  if (utf8Bytes(body) > SKILL_LIMITS.bodyBytes) return 'too-large'
  if (skillBody(body) === null) return 'empty-body'
  return null
}

export function skillRecordReason(value: unknown): SkillUnavailableReason | null {
  const fields = skillFieldsReason(value)
  if (fields !== null) return fields
  const record = value as Partial<SkillRecord>
  return skillId(record.id) && stamp(record.createdAt) && stamp(record.updatedAt) ? null : 'corrupt-store'
}

export function isSkillRecord(value: unknown): value is SkillRecord {
  return skillRecordReason(value) === null
}

/** 新建／编辑时人写的那四个字段。 */
export type SkillsDraft = { name: string; description: string; triggers: string[]; body: string }

/** 界面列表与 IPC 共用的库视图：正文一并返回（列表即读取，不另开通道）。 */
export type SkillsLibraryEntry = {
  id: string
  name: string
  description: string
  triggers: string[]
  body: string
  bytes: number
  /** null＝可用；否则是人话原因对应的码。 */
  reason: SkillUnavailableReason | null
  enabled: boolean
}

export type SkillsLibraryView = {
  sessionId: string
  revision: string | null
  /** 技能库不可读：列表为空但原因明确，界面不得显示成「还没有技能」。 */
  corrupt: boolean
  ignored: number
  skills: SkillsLibraryEntry[]
}

export type SkillsResult = { ok: true; view: SkillsLibraryView } | { ok: false; error: string }

export type SkillsGetRequest = { sessionId: string }

/** 三种写入操作；页面与主进程共用同一个联合，避免 Omit 把分支字段吃掉。 */
export type SkillsSaveOperation =
  | { operation: 'create'; draft: SkillsDraft }
  | { operation: 'update'; id: string; draft: SkillsDraft }
  | { operation: 'remove'; id: string }

export type SkillsSaveRequest = SkillsSaveOperation & { sessionId: string; expectedRevision: string | null }

export type SkillsEnabledRequest = { sessionId: string; id: string; enabled: boolean; expectedRevision: string | null }
