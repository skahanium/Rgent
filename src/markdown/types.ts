import type { BlockIdentity } from './identity.ts'

export const STAGE_IDS = [
  'gfm',
  'frontmatter',
  'math',
  'callout',
  'wikilink',
  'mermaid',
  'identity'
] as const

export type StageId = (typeof STAGE_IDS)[number]

export type StageFlags = Record<StageId, boolean>

export const DEFAULT_STAGES: StageFlags = {
  gfm: true,
  frontmatter: true,
  math: true,
  callout: true,
  wikilink: true,
  mermaid: true,
  identity: true
}

export interface SourceRange {
  start: number
  end: number
}

export interface BlockRef {
  type: string
  range: SourceRange
  /** 缺省即人写的。只有未采纳的 AI 块与口令才带这个字段。 */
  identity?: BlockIdentity
}

/** 一枚身份标记在文件里的位置。它不是块，只给画布藏行与「采纳」删除用。 */
export interface MarkerRef {
  range: SourceRange
  identity: BlockIdentity
}

export interface TableRef {
  range: SourceRange
  header: string[]
  rows: string[][]
}

export interface ImageRef {
  range: SourceRange
  url: string
  alt: string
  base: 'note' | 'vault'
}

export interface HeadingRef {
  depth: number
  range: SourceRange
  text: string
}

export interface MarkRef {
  type: 'strong' | 'emphasis' | 'inlineCode'
  range: SourceRange
}

export type CalloutKind = 'note' | 'tip' | 'warning' | 'important' | 'caution'

export interface MathRef {
  range: SourceRange
  value: string
  block: boolean
}

export interface CalloutRef {
  range: SourceRange
  kind: CalloutKind
  title: string
  body: string
}

export interface WikiLinkRef {
  range: SourceRange
  target: string
  display: string
  embed: boolean
}

export interface MermaidRef {
  range: SourceRange
  value: string
}

export interface DocIndex {
  blocks: BlockRef[]
  /** 身份标记的位置。它们不在 `blocks` 里。 */
  markers: MarkerRef[]
  tables: TableRef[]
  images: ImageRef[]
  mermaid: MermaidRef[]
  maths: MathRef[]
  callouts: CalloutRef[]
  wikilinks: WikiLinkRef[]
  headings: HeadingRef[]
  marks: MarkRef[]
}

export interface Partition {
  body: string
  ledger: string | null
  bodyOffset: number
}

export interface CompileResult {
  source: string
  partition: Partition
  tree: unknown
  index: DocIndex
  stages: StageFlags
  stale: boolean
  error?: string
}

export interface CompileOptions {
  stages?: Partial<StageFlags>
  prev?: CompileResult
}
