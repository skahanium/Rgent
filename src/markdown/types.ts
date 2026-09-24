export const STAGE_IDS = [
  'gfm',
  'frontmatter',
  'math',
  'callout',
  'wikilink',
  'mermaid'
] as const

export type StageId = (typeof STAGE_IDS)[number]

export type StageFlags = Record<StageId, boolean>

export const DEFAULT_STAGES: StageFlags = {
  gfm: true,
  frontmatter: true,
  math: true,
  callout: true,
  wikilink: true,
  mermaid: true
}

export interface SourceRange {
  start: number
  end: number
}

export interface BlockRef {
  type: string
  range: SourceRange
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
