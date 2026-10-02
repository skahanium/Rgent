/** 一个助手的设备级习惯：所有笔记库共用，只拼进系统提示，不改变权限与工具范围。 */
export const ASSISTANT_TONES = ['plain', 'concise', 'detailed'] as const
export type AssistantTone = (typeof ASSISTANT_TONES)[number]

export type AssistantHabits = {
  /** 怎么称呼用户；空表示不特别称呼。 */
  address: string
  tone: AssistantTone
  /** 人写的附加要求。 */
  note: string
}

export const ASSISTANT_LIMITS = { address: 40, note: 500 } as const

export const DEFAULT_ASSISTANT_HABITS: AssistantHabits = { address: '', tone: 'plain', note: '' }

export const ASSISTANT_TONE_LABELS: Record<AssistantTone, string> = {
  plain: '平实',
  concise: '简洁',
  detailed: '详尽'
}

const CONTROL = /[\u0000-\u001f\u007f]/u

const cleanText = (value: unknown, max: number, multiline = false): string | null => {
  if (typeof value !== 'string' || value !== value.trim() || value.length > max) return null
  // Preserve LF/CRLF verbatim in supplementary notes; lone CR and other controls stay invalid.
  if (CONTROL.test(multiline ? value.replace(/\r\n|\n/gu, '') : value)) return null
  return value
}

export function isAssistantHabits(value: unknown): value is AssistantHabits {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AssistantHabits>
  if (cleanText(candidate.address, ASSISTANT_LIMITS.address) === null) return false
  if (cleanText(candidate.note, ASSISTANT_LIMITS.note, true) === null) return false
  return ASSISTANT_TONES.includes(candidate.tone as AssistantTone)
}

export function isDefaultAssistantHabits(habits: AssistantHabits): boolean {
  return habits.address === '' && habits.note === '' && habits.tone === DEFAULT_ASSISTANT_HABITS.tone
}

/** 账本里的一行摘要；全默认时返回空串（既不进提示也不进账本）。 */
export function assistantSummary(habits: AssistantHabits): string {
  const parts: string[] = []
  if (habits.address) parts.push(`称呼=${habits.address}`)
  if (habits.tone !== DEFAULT_ASSISTANT_HABITS.tone) parts.push(`语气=${ASSISTANT_TONE_LABELS[habits.tone]}`)
  if (habits.note) parts.push(`补充说明 ${habits.note.length} 字`)
  return parts.join('；')
}

/** 拼进系统提示的段落；全默认时返回 null，保持未设置习惯的任务逐字不变。 */
export function assistantSystemBlock(habits: AssistantHabits): string | null {
  if (isDefaultAssistantHabits(habits)) return null
  const lines = ['助手习惯（人设定的称呼与语气；不改变本场范围、工具与权限）：']
  if (habits.address) lines.push(`- 称呼用户为「${habits.address}」。`)
  lines.push(`- 语气：${ASSISTANT_TONE_LABELS[habits.tone]}。`)
  if (habits.note) lines.push(`- 补充说明：${habits.note}`)
  return lines.join('\n')
}
