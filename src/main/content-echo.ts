import { createHash } from 'node:crypto'

/**
 * 偷渡检测用的词片（shingle）。
 *
 * 切法：Unicode NFKC 归一化 → 小写 → 词元序列。
 * - 拉丁文与其他非 CJK 文字按「连续字母／数字」成一个词元（`[a-z0-9]` 之外的文字也算在词元里）；
 * - 中日韩文字按**单字**成词元（Han／平假名／片假名／谚文各算一个词元）。
 * 理由：合同要求「8 词片」，英文天然按词；中文没有空格，若按整段切就只剩一个词元，
 * 8 词片永远建不出来。按单字切后，中文的 8 词片＝连续 8 个字，与英文 8 个词在长度上同一量级，
 * 既能盖住真实片段，也不会因为分词词典而漏判。标点与 URL 符号不参与词元，
 * 因此 `https://example.com/a-b` 与正文里的 `a b` 会被看成同一串词。
 *
 * 词片哈希取 sha1 的十六进制前 16 位（64 bit）；上限默认 5 万片，超出的部分直接丢弃。
 */
export const SHINGLE_WORDS = 8
export const SHINGLE_LIMIT = 50_000

const CJK = '\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Hangul}'
// 第二支是「非 CJK 的字母／数字」，逐字符负向断言，避免 `abc汉字` 被吞成一个词元。
const TOKEN = new RegExp(`(${CJK})|((?:(?!${CJK})[\\p{L}\\p{N}_])+)`, 'gu')

/** 把一段文字切成词元；标点、空白与符号只起分隔作用。 */
export function tokenize(text: string): string[] {
  if (typeof text !== 'string' || !text) return []
  const normalized = text.normalize('NFKC').toLowerCase()
  const output: string[] = []
  for (const match of normalized.matchAll(TOKEN)) output.push(match[1] ?? match[2]!)
  return output
}

const shingle = (words: readonly string[], start: number): string =>
  createHash('sha1').update(words.slice(start, start + SHINGLE_WORDS).join(' ')).digest('hex').slice(0, 16)

/** 授权来源正文 → 8 词片哈希集；去重、按 `limit` 截断。 */
export function buildShingles(texts: readonly string[], limit = SHINGLE_LIMIT): Set<string> {
  const output = new Set<string>()
  if (!Number.isSafeInteger(limit) || limit < 1) return output
  for (const text of texts) {
    if (output.size >= limit) break
    const words = tokenize(String(text ?? ''))
    for (let at = 0; at + SHINGLE_WORDS <= words.length; at += 1) {
      output.add(shingle(words, at))
      if (output.size >= limit) break
    }
  }
  return output
}

function matches(shingles: ReadonlySet<string>, value: string): boolean {
  const words = tokenize(value)
  for (let at = 0; at + SHINGLE_WORDS <= words.length; at += 1) if (shingles.has(shingle(words, at))) return true
  return false
}

/** 待外发的值（URL／查询）是否与授权正文有 8 词片重叠。解码形式也查一遍。 */
export function containsEcho(shingles: ReadonlySet<string>, value: string): boolean {
  if (!shingles.size || typeof value !== 'string' || !value) return false
  if (matches(shingles, value)) return true
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { return false }
  return decoded !== value && matches(shingles, decoded)
}
