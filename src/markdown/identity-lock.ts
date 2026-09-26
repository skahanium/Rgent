import type { DocIndex, SourceRange } from './types.ts'

/**
 * 「未采纳的 AI 块不能改字」的判定。围栏原话：先采纳再改，或删掉再问。
 * 所以：字面上的修改一律挡；把整个块或整枚标记删掉则放行（那正是采纳与丢弃）。
 *
 * 这里只算「准不准」，怎么挡由画布决定（CM6 的 transactionFilter 丢弃这次事务）。
 */

export type EditChange = {
  from: number
  to: number
  insert?: string
}

/**
 * 锁住的范围：标记本身 + 未采纳的 AI 块。
 * 口令块**不锁**——它就是给人改的字（围栏：你的口令不是 AI 块）。
 */
export function lockedRanges(index: DocIndex): SourceRange[] {
  const out: SourceRange[] = []
  for (const marker of index.markers) out.push(marker.range)
  for (const block of index.blocks) {
    if (block.identity === 'ai') out.push(block.range)
  }
  return out
}

function overlaps(change: EditChange, range: SourceRange): boolean {
  if (change.from === change.to) {
    // 插入：落在锁定范围内或贴住两端，都会变成那个块的字。
    return range.start <= change.from && change.from <= range.end
  }
  return change.from < range.end && range.start < change.to
}

function coversWhole(change: EditChange, range: SourceRange): boolean {
  return (change.insert ?? '') === '' && change.from <= range.start && change.to >= range.end
}

/**
 * 删除正好落在锁定范围的边界上：会把锁定内容并进相邻的块（人的字就被锁在里面了）。
 * 这是删除独有的风险，插入没有。
 */
function mergesAcross(change: EditChange, range: SourceRange): boolean {
  if ((change.insert ?? '') !== '') return false
  return change.to === range.start || change.from === range.end
}

export function editBlocked(changes: readonly EditChange[], locked: readonly SourceRange[]): boolean {
  for (const change of changes) {
    // 这次变更整段删掉了某个锁定范围（采纳 = 删标记行，丢弃 = 删标记加块），
    // 那它就是被允许的动作：此时不再对它施加「边界合并」这条限制——
    // 采纳本来就会删掉标记行自己的换行，那并不构成把人的字并进锁定块。
    const sanctioned = locked.some((range) => coversWhole(change, range))
    for (const range of locked) {
      if (coversWhole(change, range)) continue
      if (overlaps(change, range)) return true
      if (!sanctioned && mergesAcross(change, range)) return true
    }
  }
  return false
}
