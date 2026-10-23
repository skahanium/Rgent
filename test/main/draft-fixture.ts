import type { SourceRange } from '../../src/markdown/types.ts'

/** 提问块草稿 marker：紧贴提问段落，正文里不带 `/` 触发键。 */
export const DRAFT = '<!-- rgent:prompt:v1 state="draft" -->'

/** 草稿块正文（marker + 换行 + 段落），给需要拼进更大来源的夹具用。 */
export function draftBody(prompt = '问', newline = '\n'): string {
  return `${DRAFT}${newline}${prompt}`
}

/** 只含一个草稿块的来源与正文范围。 */
export function draftSource(prompt = '问', newline = '\n'): { source: string; range: SourceRange } {
  const source = `${draftBody(prompt, newline)}${newline}`
  const start = DRAFT.length + newline.length
  return { source, range: { start, end: start + prompt.length } }
}

/** 在来源里定位提问正文；同一正文出现多次时（先发后新草稿）传 last。 */
export function draftRange(source: string, prompt = '问', last = false): SourceRange {
  const start = last ? source.lastIndexOf(prompt) : source.indexOf(prompt)
  if (start < 0) throw new Error(`draft fixture missing prompt: ${prompt}`)
  return { start, end: start + prompt.length }
}

/** HostStart／预览请求的提问部分：范围与两个字面量都只指向正文。 */
export function draftRequest(source: string, prompt = '问', last = false): { range: SourceRange; expectedText: string; promptText: string } {
  return { range: draftRange(source, prompt, last), expectedText: prompt, promptText: prompt }
}

/** 把旧夹具里的 `/prompt` 段替换成草稿块，返回新来源与正文范围。 */
export function withDraft(source: string, prompt = '问', last = false): { source: string; range: SourceRange } {
  const old = `/${prompt}`
  const at = last ? source.lastIndexOf(old) : source.indexOf(old)
  if (at < 0) throw new Error(`draft fixture missing old prompt: ${old}`)
  const next = `${source.slice(0, at)}${DRAFT}\n${prompt}${source.slice(at + old.length)}`
  const start = at + DRAFT.length + 1
  return { source: next, range: { start, end: start + prompt.length } }
}

/** 在来源末尾追加一枚草稿块（保持空行分隔），返回新来源与正文范围。 */
export function appendDraft(source: string, prompt: string, newline = '\n'): { source: string; range: SourceRange } {
  const pad = source.length === 0 ? '' : source.endsWith(`${newline}${newline}`) ? '' : source.endsWith(newline) ? newline : `${newline}${newline}`
  const body = draftBody(prompt, newline)
  const start = source.length + pad.length + DRAFT.length + newline.length
  return { source: `${source}${pad}${body}${newline}`, range: { start, end: start + prompt.length } }
}
