import type { Nodes, Root } from 'mdast'
import { visit } from 'unist-util-visit'
import type {
  BlockRef,
  CalloutRef,
  DocIndex,
  HeadingRef,
  ImageRef,
  MarkRef,
  MathRef,
  MermaidRef,
  SourceRange,
  StageFlags,
  TableRef,
  WikiLinkRef
} from './types.ts'
import type { CalloutNode, WikiLinkNode } from './syntax/nodes.ts'
import { textOf } from './syntax/callout.ts'

export function emptyIndex(): DocIndex {
  return {
    blocks: [],
    tables: [],
    images: [],
    mermaid: [],
    maths: [],
    callouts: [],
    wikilinks: [],
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
    const image: ImageRef = {
      range: shift(range, bodyOffset),
      url: node.url,
      alt: node.alt ?? '',
      base: 'note'
    }
    index.images.push(image)
  })

  visit(tree, 'code', (node) => {
    if (!stages.mermaid) return
    if ((node.lang ?? '').toLowerCase() !== 'mermaid') return
    const range = rangeFromNode(source, node)
    if (!range) return
    const item: MermaidRef = { range: shift(range, bodyOffset), value: node.value }
    index.mermaid.push(item)
  })

  if (stages.math) {
    visit(tree, 'inlineMath', (node) => {
      const range = rangeFromNode(source, node)
      if (!range) return
      const item: MathRef = {
        range: shift(range, bodyOffset),
        value: typeof node.value === 'string' ? node.value : '',
        block: false
      }
      index.maths.push(item)
    })
    visit(tree, 'math', (node) => {
      const range = rangeFromNode(source, node)
      if (!range) return
      const item: MathRef = {
        range: shift(range, bodyOffset),
        value: typeof node.value === 'string' ? node.value : '',
        block: true
      }
      index.maths.push(item)
    })
  }

  if (stages.callout) {
    visit(tree, 'callout', (node) => {
      const callout = node as CalloutNode
      const range = rangeFromNode(source, callout)
      if (!range) return
      const item: CalloutRef = {
        range: shift(range, bodyOffset),
        kind: callout.kind,
        title: callout.title,
        body: textOf(callout)
      }
      index.callouts.push(item)
    })
  }

  if (stages.wikilink) {
    visit(tree, 'wikilink', (node) => {
      const link = node as WikiLinkNode
      const range = rangeFromNode(source, link)
      if (!range) return
      if (!link.target) return
      const item: WikiLinkRef = {
        range: shift(range, bodyOffset),
        target: link.target,
        display: link.display || link.target,
        embed: link.embed
      }
      index.wikilinks.push(item)
    })
  }

  visit(tree, 'heading', (node) => {
    const range = rangeFromNode(source, node)
    if (!range) return
    index.headings.push({
      depth: node.depth,
      range: shift(range, bodyOffset),
      text: textOf(node)
    } satisfies HeadingRef)
  })

  const markType = (type: MarkRef['type']) => (node: Nodes) => {
    const range = rangeFromNode(source, node)
    if (!range) return
    index.marks.push({ type, range: shift(range, bodyOffset) })
  }
  visit(tree, 'strong', markType('strong'))
  visit(tree, 'emphasis', markType('emphasis'))
  visit(tree, 'inlineCode', markType('inlineCode'))

  return index
}
