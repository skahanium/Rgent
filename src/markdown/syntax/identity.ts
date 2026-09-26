import type { Nodes, Root } from 'mdast'
import { parseMarker, type BlockIdentity } from '../identity.ts'

/** 挂在被标块 `data` 上的键。将来技能阶段要读这里的属性。 */
export const IDENTITY_DATA_KEY = 'rgentIdentity'
const MARKERS_DATA_KEY = 'rgentMarkers'

export type NodeIdentity = {
  identity: BlockIdentity
  attrs: Record<string, string>
}

/** 索引里的标记范围，供画布藏掉那一行、也供「采纳」删掉它。 */
export type MarkerHit = {
  start: number
  end: number
  identity: BlockIdentity
}

/**
 * 身份标记只在**顶层块之间**认。
 *
 * 段是块，AI 块接在口令段下面，标记都是顶层写的。容器内部的注释一律不认：
 * 索引只收顶层块，认了就会变成「管线标了、锁定与画布却管不着」的半实现——
 * 那比不实现更坏。不认的注释照旧留在正文里看得见（不静默吞掉）。
 */
function nodeRange(node: Nodes): { start: number; end: number } | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start == null || end == null || end < start) return null
  return { start, end }
}

function mark(node: Nodes, identity: NodeIdentity): void {
  const target = node as Nodes & { data?: Record<string, unknown> }
  target.data = { ...(target.data ?? {}), [IDENTITY_DATA_KEY]: identity }
}

/**
 * 一枚标记只标它下面紧接着的那一个块。多块 AI 输出就多枚标记——每块各自采纳、
 * 各自拖动，与围栏「段是块」一致。标记落在文件末尾（后面没有块）时只记录范围，
 * 不标任何块；连着两枚标记时，离块最近的那枚说了算。
 */
export function transformIdentity(tree: Root): Root {
  const hits: MarkerHit[] = []
  const kept: Root['children'] = []
  let pending: NodeIdentity | null = null
  for (const child of tree.children) {
    if (child.type === 'html') {
      const parsed = parseMarker((child as Nodes & { value: string }).value)
      if (parsed) {
        const range = nodeRange(child)
        if (range) hits.push({ ...range, identity: parsed.identity })
        // 标记是被标块的旁注，不是块：从树上摘掉，它就不会进块清单、也不产生装饰。
        pending = parsed
        continue
      }
    }
    if (pending) {
      mark(child, pending)
      pending = null
    }
    kept.push(child)
  }
  tree.children = kept
  tree.data = { ...(tree.data ?? {}), [MARKERS_DATA_KEY]: hits }
  return tree
}

/** 标记范围是相对正文的；`buildIndex` 会按 `bodyOffset` 平移成文件绝对位置。 */
export function markersOf(tree: unknown): MarkerHit[] {
  const data = (tree as { data?: Record<string, unknown> } | null)?.data
  const markers = data?.[MARKERS_DATA_KEY]
  return Array.isArray(markers) ? (markers as MarkerHit[]) : []
}

export function identityOf(node: unknown): NodeIdentity | null {
  const data = (node as { data?: Record<string, unknown> } | null)?.data
  const identity = data?.[IDENTITY_DATA_KEY]
  if (!identity || typeof identity !== 'object') return null
  const value = identity as Partial<NodeIdentity>
  if (value.identity !== 'ai' && value.identity !== 'command') return null
  return { identity: value.identity, attrs: value.attrs ?? {} }
}
