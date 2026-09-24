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
  math: false,
  callout: false,
  wikilink: false,
  mermaid: false
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

export interface DocIndex {
  blocks: BlockRef[]
  tables: TableRef[]
  images: ImageRef[]
  mermaid: BlockRef[]
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
