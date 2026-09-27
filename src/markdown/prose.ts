import type { MarkerRef } from './types.ts'

/**
 * 正文的取词与计数。索引侧（人搜语料）和底栏（字数）共用一份口径，
 * 免得两处各写一套、慢慢走散。
 */

/**
 * 把身份标记的位置换成等长空格：机器语法不是文章内容。
 * 等长是为了让偏移不变，片段位置照旧对得上。
 */
export function proseOf(body: string, markers: readonly MarkerRef[]): string {
  if (markers.length === 0) return body
  const parts: string[] = []
  let at = 0
  for (const marker of [...markers].sort((left, right) => left.range.start - right.range.start)) {
    const start = Math.max(at, Math.min(body.length, marker.range.start))
    const end = Math.max(start, Math.min(body.length, marker.range.end))
    if (end === start) continue
    parts.push(body.slice(at, start), ' '.repeat(end - start))
    at = end
  }
  parts.push(body.slice(at))
  return parts.join('')
}

/** CJK 与假名、谚文逐字计一；拉丁字母与数字的连续串计一。其它字符只断开连续串。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u
const WORDISH = /[\p{L}\p{N}_]/u

export function countWords(text: string): number {
  let count = 0
  let inRun = false
  for (const char of text) {
    if (CJK.test(char)) {
      count += 1
      inRun = false
      continue
    }
    if (WORDISH.test(char)) {
      if (!inRun) {
        count += 1
        inRun = true
      }
      continue
    }
    inRun = false
  }
  return count
}
