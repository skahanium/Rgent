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
 * 身份标记只能挂在**块容器**上。段落里的 HTML 注释是行内节点，也是 `type: 'html'`，
 * 若不分容器地一律当标记处理，就会把用户段落里的一句注释连同它的下文结构摘掉。
 */
const BLOCK_CONTAINERS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition', 'callout'])

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

function walk(parent: Nodes, hits: MarkerHit[]): void {
  const children = (parent as Nodes & { children?: Nodes[] }).children
  if (!children || children.length === 0) return
  if (BLOCK_CONTAINERS.has(parent.type)) {
    const kept: Nodes[] = []
    let pending: NodeIdentity | null = null
    for (const child of children) {
      if (child.type === 'html') {
        const parsed = parseMarker((child as Nodes & { value: string }).value)
        if (parsed) {
          const range = nodeRange(child)
          if (range) hits.push({ ...range, identity: parsed.identity })
          // 标记是被标块的旁注，不是块：从树上摘掉，它就不会进块清单、也不产生装饰。
          // 连着两枚标记时，离块最近的那枚说了算。
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
    children.length = 0
    children.push(...kept)
  }
  for (const child of children) walk(child, hits)
}

/**
 * 一枚标记只标它下面紧接着的那一个块。多块 AI 输出就多枚标记——每块各自采纳、
 * 各自拖动，与围栏「段是块」一致。标记落在文件末尾（后面没有块）时只记录范围，
 * 不标任何块。
 */
export function transformIdentity(tree: Root): Root {
  const hits: MarkerHit[] = []
  walk(tree, hits)
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
