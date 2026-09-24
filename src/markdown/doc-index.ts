import type { Root, Nodes } from 'mdast'
import { visit } from 'unist-util-visit'
import type {
  BlockRef,
  DocIndex,
  HeadingRef,
  ImageRef,
  MarkRef,
  SourceRange,
  StageFlags,
  TableRef
} from './types.ts'

export function emptyIndex(): DocIndex {
  return {
    blocks: [],
    tables: [],
    images: [],
    mermaid: [],
    headings: [],
    marks: []
  }
}

export function rangeFromNode(source: string, node: Nodes): SourceRange | null {
  const pos = node.position
  if (!pos) return null
  const start = pos.start.offset ?? offsetAt(source, pos.start.line, pos.start.column)
  const end = pos.end.offset ?? offsetAt(source, pos.end.line, pos.end.column)
  if (start == null || end == null || end < start) return null
  return { start, end }
}

function offsetAt(source: string, line: number, column: number): number {
  let i = 0
  let current = 1
  while (current < line && i < source.length) {
    if (source.charCodeAt(i) === 10) current += 1
    i += 1
  }
  return i + Math.max(0, column - 1)
}

function textOf(node: { value?: string; children?: unknown[] }): string {
  if (typeof node.value === 'string') return node.value
  if (!node.children) return ''
  return node.children.map((child) => textOf(child as { value?: string; children?: unknown[] })).join('')
}

function shift(range: SourceRange, delta: number): SourceRange {
  if (delta === 0) return range
  return { start: range.start + delta, end: range.end + delta }
}

export function buildIndex(tree: Root, source: string, stages: StageFlags, bodyOffset = 0): DocIndex {
  const index = emptyIndex()

  for (const child of tree.children) {
    const range = rangeFromNode(source, child)
    if (!range) continue
    index.blocks.push({ type: child.type, range: shift(range, bodyOffset) })
  }

  visit(tree, 'table', (node) => {
    const range = rangeFromNode(source, node)
    if (!range) return
    const rows = node.children.map((row) =>
      row.children.map((cell) => textOf(cell))
    )
    const header = rows[0] ?? []
    const body = rows.slice(1)
    index.tables.push({ range: shift(range, bodyOffset), header, rows: body })
  })

  visit(tree, 'image', (node) => {
    const range = rangeFromNode(source, node)
    if (!range) return
    index.images.push({
      range: shift(range, bodyOffset),
      url: node.url,
      alt: node.alt ?? ''
    })
  })

  visit(tree, 'code', (node) => {
    if ((node.lang ?? '').toLowerCase() !== 'mermaid') return
    const range = rangeFromNode(source, node)
    if (!range) return
    index.mermaid.push({ type: 'mermaid', range: shift(range, bodyOffset) })
  })

  visit(tree, 'heading', (node) => {
    const range = rangeFromNode(source, node)
    if (!range) return
    index.headings.push({
      depth: node.depth,
      range: shift(range, bodyOffset),
      text: textOf(node)
    })
  })

  const markType = (type: MarkRef['type']) => (node: Nodes) => {
    const range = rangeFromNode(source, node)
    if (!range) return
    index.marks.push({ type, range: shift(range, bodyOffset) })
  }
  visit(tree, 'strong', markType('strong'))
  visit(tree, 'emphasis', markType('emphasis'))
  visit(tree, 'inlineCode', markType('inlineCode'))

  void stages
  return index
}
