import { identityUnits, markerLineBlock, type TextEdit } from './identity-edit.ts'
import type { BlockIdentity } from './identity.ts'
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

export type EditPlan = {
  /** 这次事务整不整批丢掉。 */
  blocked: boolean
  /**
   * 改写后的变更；`undefined` 表示照原样放行。
   * 两种改写：整块删掉 AI 块时补删它的标记行；在锁定块下方那行打字时先补一个断段符。
   */
  changes?: readonly EditChange[]
  /** 被补过断段符的插入点。调用方要把光标按它右移，否则下一键会插在断段符之前。 */
  prefixed: readonly number[]
}

/**
 * 在锁定块下方那行打字，会把新字并进那块。
 *
 * Markdown 里相邻两行属于同一个段落，所以「AI 回答」下面直接换行写感想，重编译后
 * 那一段的身份仍是 ai——用户刚打的字被锁住，还带一个会删掉它的「丢弃」。实测：
 * 块范围 [21,29)，在偏移 30 插入「我写的。」，编译后同一段变成 [21,42) 且身份 ai。
 * 风险点正好是「块所在行的行尾 + 1」这一个位置；在那里打字就先补一个断段符，
 * 让用户的字落进自己的段落。
 */
function boundaryInsertions(source: string, changes: readonly EditChange[], index: DocIndex): number[] {
  const risks = new Set<number>()
  for (const block of index.blocks) {
    if (block.identity !== 'ai') continue
    const lineEnd = source.indexOf('\n', block.range.end)
    if (lineEnd < 0) continue
    risks.add(lineEnd + 1)
  }
  if (risks.size === 0) return []
  const prefixed: number[] = []
  for (const change of changes) {
    if (change.from !== change.to) continue
    if ((change.insert ?? '') === '') continue
    if (change.insert!.startsWith('\n')) continue
    if (risks.has(change.from)) prefixed.push(change.from)
  }
  return prefixed
}

/**
 * 判定一次事务，并算出要不要改写它。
 *
 * 改写之一：整块删掉未采纳的 AI 块是允许的（围栏「删掉再问」），但标记行若留下，
 * 「就近标下面那一块」的规则会让它标到**下一段人写的字**上——那段于是被锁住，
 * 还带一个会删掉人字的「丢弃」。删块时把标记一起删掉，就没有这种错位。
 */
export function planIdentityEdit(
  source: string,
  changes: readonly EditChange[],
  index: DocIndex
): EditPlan {
  const locked = lockedRanges(index)
  if (locked.length === 0) return { blocked: false, prefixed: [] }
  const sanctioned: EditChange[] = []
  for (const change of changes) {
    const covers = locked.some((range) => coversWhole(change, range))
    for (const range of locked) {
      if (coversWhole(change, range)) continue
      if (overlaps(change, range)) return { blocked: true, prefixed: [] }
      if (!covers && mergesAcross(change, range)) return { blocked: true, prefixed: [] }
    }
    if (covers) sanctioned.push(change)
  }

  const prefixed = boundaryInsertions(source, changes, index)
  const rewritten: EditChange[] = prefixed.length
    ? changes.map((change) =>
        prefixed.includes(change.from) ? { ...change, insert: `\n${change.insert ?? ''}` } : change
      )
    : [...changes]

  if (sanctioned.length === 0) {
    return prefixed.length
      ? { blocked: false, changes: rewritten, prefixed }
      : { blocked: false, prefixed: [] }
  }

  const extra: TextEdit[] = []
  for (const unit of identityUnits(index)) {
    if (!unit.marker || unit.identity !== 'ai') continue
    const removedBlock = sanctioned.some((change) => coversWhole(change, unit.block))
    if (!removedBlock) continue
    const line = markerLineBlock(source, unit.marker.range)
    if (changes.some((change) => coversWhole(change, line))) continue
    extra.push({ from: line.start, to: line.end, insert: '' })
  }
  if (extra.length === 0 && prefixed.length === 0) return { blocked: false, prefixed: [] }
  return { blocked: false, changes: [...rewritten, ...extra], prefixed }
}
