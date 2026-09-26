/**
 * 身份标记的读写。围栏 §记录即正文 已拍板：被标记块**前一行**一枚整行 HTML 注释，
 * 没有闭合标记，注释里可以带属性（属性位留给技能阶段标技能名）。
 *
 * 选整行注释的实测依据：注释天然落成 mdast 的 `html` 节点，一条 mdast 变换就能消费，
 * 不新增 micromark 语法；AI 内容仍是普通 Markdown，标题、公式、`[[链接]]` 走同一条管线。
 * 围栏式（```rgent-ai）会把整段折成一个 `code` 块，里面的 Markdown 不再编译。
 */

export const AI_MARKER = '<!-- rgent:ai:v1 -->'
export const PROMPT_MARKER = '<!-- rgent:prompt:v1 -->'

/** 块的两种非人身份。**缺省即人写的**，所以只有例外才带这个字段。 */
export type BlockIdentity = 'ai' | 'command'

export type MarkerParse = {
  identity: BlockIdentity
  attrs: Record<string, string>
}

const MARKER = /^<!--\s*rgent:(ai|prompt):v1((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*-->$/
const ATTR = /([A-Za-z][\w-]*)="([^"]*)"/g

/**
 * 读一枚标记。只认整行、版本对得上的注释；别的 HTML 注释（包括 `<!-- TODO -->`）
 * 一律返回 null，让它们照旧落成普通块——不认识的标记要看得见，不能悄悄吞掉。
 */
export function parseMarker(value: string): MarkerParse | null {
  const match = MARKER.exec(value.trim())
  if (!match) return null
  const attrs: Record<string, string> = {}
  for (const found of match[2]!.matchAll(ATTR)) attrs[found[1]!] = found[2]!
  return { identity: match[1] === 'ai' ? 'ai' : 'command', attrs }
}

/** 写标记的唯一入口。键名与取值都要能原样读回来，否则不写。 */
export function markerLine(identity: BlockIdentity, attrs: Record<string, string> = {}): string {
  const name = identity === 'ai' ? 'ai' : 'prompt'
  const suffix = Object.entries(attrs)
    .filter(([key, value]) => /^[A-Za-z][\w-]*$/.test(key) && !value.includes('"'))
    .map(([key, value]) => ` ${key}="${value}"`)
    .join('')
  return `<!-- rgent:${name}:v1${suffix} -->`
}
