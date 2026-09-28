/** Slash is only a command at the start of an empty Markdown paragraph. */
export function canStartSlash(source: string, position: number): boolean {
  if (!Number.isInteger(position) || position < 0 || position > source.length) return false
  const lineStart = source.lastIndexOf('\n', position - 1) + 1
  const lineEndAt = source.indexOf('\n', position)
  const lineEnd = lineEndAt < 0 ? source.length : lineEndAt
  if (position !== lineStart || source.slice(lineStart, lineEnd).length !== 0) return false
  if (lineStart === 0) return true
  const previousEnd = lineStart - 1
  const previousStart = source.lastIndexOf('\n', previousEnd - 1) + 1
  return source.slice(previousStart, previousEnd).trim().length === 0
}

export type SlashSubmission = { range: { start: number; end: number }; prompt: string }

export function submittedSlash(source: string, start: number, end: number): SlashSubmission | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length) return null
  const text = source.slice(start, end)
  if (!text.startsWith('/') || text.slice(1).trim().length === 0 || /\r?\n[ \t]*\r?\n/.test(text)) return null
  return { range: { start, end }, prompt: text.slice(1) }
}

/** A pending command occupies one top-level paragraph ending at the caret. */
export function slashAtCaret(source: string, caret: number): SlashSubmission | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > source.length) return null
  const before = source.slice(0, caret)
  const blank = Math.max(before.lastIndexOf('\n\n'), before.lastIndexOf('\r\n\r\n'))
  const start = blank < 0 ? 0 : blank + (before.slice(blank).startsWith('\r\n\r\n') ? 4 : 2)
  if (!source.startsWith('/', start)) return null
  if (start > 0 && !/\r?\n\r?\n$/u.test(source.slice(0, start))) return null
  const after = source.slice(caret)
  if (after && !after.startsWith('\n') && !after.startsWith('\r\n')) return null
  return submittedSlash(source, start, caret)
}
