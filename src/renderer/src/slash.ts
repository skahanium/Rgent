/** Slash is only a command at the start of an empty Markdown paragraph. */
export function canStartSlash(source: string, position: number): boolean {
  if (!Number.isInteger(position) || position < 0 || position > source.length) return false
  const prefix = source.startsWith('\ufeff') ? 1 : 0
  const lineStart = Math.max(prefix, Math.max(source.lastIndexOf('\n', position - 1), source.lastIndexOf('\r', position - 1)) + 1)
  const nextBreak = source.slice(position).search(/[\r\n]/)
  const lineEnd = nextBreak < 0 ? source.length : position + nextBreak
  if (position !== lineStart || source.slice(lineStart, lineEnd).length !== 0) return false
  if (source[position] === '\n' && source[position - 1] === '\r') return false
  if (lineStart === prefix) return true
  const preceding = source.slice(0, lineStart).split(/\r\n|\r|\n/)
  return (preceding.at(-2) ?? '').trim().length === 0
}

export type SlashSubmission = { range: { start: number; end: number }; prompt: string }

export function submittedSlash(source: string, start: number, end: number): SlashSubmission | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length) return null
  const text = source.slice(start, end)
  if (!text.startsWith('/') || text.slice(1).trim().length === 0 || /\n[ \t]*\n/.test(text.replace(/\r\n|\r/g, '\n'))) return null
  return { range: { start, end }, prompt: text.slice(1) }
}

/** A pending command occupies one top-level paragraph ending at the caret. */
export function slashAtCaret(source: string, caret: number): SlashSubmission | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > source.length) return null
  const before = source.slice(0, caret)
  let start = source.startsWith('\ufeff') ? 1 : 0, lineStart = start
  for (const newline of before.matchAll(/\r\n|\r|\n/g)) {
    const after = newline.index + newline[0].length
    if (before.slice(lineStart, newline.index).trim().length === 0) start = after
    lineStart = after
  }
  if (!source.startsWith('/', start)) return null
  const after = source.slice(caret)
  if (after && !/^[\r\n]/.test(after)) return null
  return submittedSlash(source, start, caret)
}
