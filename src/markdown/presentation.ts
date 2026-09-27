import type { Nodes, Root } from 'mdast'
import { visit } from 'unist-util-visit'
import type { SourceRange } from './types.ts'

export type PresentationSyntax = { range: SourceRange; kind: 'hide' | 'bullet' | 'task' | 'number'; text?: string; checked?: boolean }
export type PresentationStyle = { range: SourceRange; className: string }
export type PresentationLine = { at: number; className: string }
export type PresentationLink = { range: SourceRange; url: string }
export type PresentationBlock = { range: SourceRange; kind: 'code' | 'frontmatter' | 'rule' | 'html'; value: string; language?: string; node?: Nodes; source?: string }
export type PresentationPlan = {
  syntax: PresentationSyntax[]
  styles: PresentationStyle[]
  lines: PresentationLine[]
  links: PresentationLink[]
  blocks: PresentationBlock[]
}

function range(node: Nodes): SourceRange | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return start == null || end == null || end < start ? null : { start, end }
}

function childBounds(node: { children: readonly Nodes[] }): SourceRange | null {
  const first = node.children[0]
  const last = node.children[node.children.length - 1]
  const a = first && range(first)
  const b = last && range(last)
  return a && b ? { start: a.start, end: b.end } : null
}

function pushSyntax(out: PresentationPlan, start: number, end: number, kind: PresentationSyntax['kind'], text?: string, checked?: boolean): void {
  if (end <= start) return
  out.syntax.push({ range: { start, end }, kind, ...(text == null ? {} : { text }), ...(checked == null ? {} : { checked }) })
}

/** A visual projection of one mdast tree. Every range still addresses the original Markdown. */
export function planPresentation(tree: unknown, source: string): PresentationPlan {
  const out: PresentationPlan = { syntax: [], styles: [], lines: [], links: [], blocks: [] }
  if (!tree || typeof tree !== 'object' || (tree as Root).type !== 'root') return out
  const root = tree as Root
  const addLine = (at: number, className: string): void => {
    if (at >= 0 && at <= source.length) out.lines.push({ at, className })
  }

  visit(root, 'heading', (node) => {
    const whole = range(node)
    const inner = childBounds(node)
    if (!whole) return
    addLine(whole.start, `md-heading md-h${node.depth}`)
    if (inner) {
      pushSyntax(out, whole.start, inner.start, 'hide')
      pushSyntax(out, inner.end, whole.end, 'hide')
    }
  })

  const inline = (type: 'strong' | 'emphasis' | 'delete' | 'link', className: string): void => {
    visit(root, type, (node) => {
      const whole = range(node)
      const inner = childBounds(node)
      if (!whole || !inner) return
      pushSyntax(out, whole.start, inner.start, 'hide')
      pushSyntax(out, inner.end, whole.end, 'hide')
      out.styles.push({ range: inner, className })
      if (node.type === 'link') out.links.push({ range: inner, url: node.url })
    })
  }
  inline('strong', 'md-strong')
  inline('emphasis', 'md-emphasis')
  inline('delete', 'md-delete')
  inline('link', 'md-link')

  visit(root, 'inlineCode', (node) => {
    const whole = range(node)
    if (!whole) return
    const raw = source.slice(whole.start, whole.end)
    const ticks = raw.match(/^`+/)?.[0].length ?? 0
    if (ticks === 0 || !raw.endsWith('`'.repeat(ticks))) return
    pushSyntax(out, whole.start, whole.start + ticks, 'hide')
    pushSyntax(out, whole.end - ticks, whole.end, 'hide')
    out.styles.push({ range: { start: whole.start + ticks, end: whole.end - ticks }, className: 'md-inlineCode' })
  })

  visit(root, 'list', (node) => {
    node.children.forEach((item, index) => {
      const whole = range(item)
      const first = item.children[0] && range(item.children[0])
      if (!whole || !first || first.start <= whole.start) return
      addLine(whole.start, `md-list-item md-list-${node.ordered ? 'ordered' : 'bullet'}`)
      const marker = source.slice(whole.start, first.start)
      if (item.checked != null) pushSyntax(out, whole.start, first.start, 'task', undefined, item.checked)
      else if (node.ordered) pushSyntax(out, whole.start, first.start, 'number', `${(node.start ?? 1) + index}.`)
      else if (marker.trim()) pushSyntax(out, whole.start, first.start, 'bullet', '•')
    })
  })

  visit(root, 'blockquote', (node) => {
    const whole = range(node)
    if (!whole) return
    let start = whole.start
    while (start < whole.end) {
      const end = Math.min(whole.end, source.indexOf('\n', start) < 0 ? whole.end : source.indexOf('\n', start))
      const raw = source.slice(start, end)
      const marker = raw.match(/^\s*> ?/)
      if (marker) {
        addLine(start, 'md-quote')
        pushSyntax(out, start, start + marker[0].length, 'hide')
      }
      start = end + 1
    }
  })

  visit(root, 'code', (node) => {
    const whole = range(node)
    if (whole) out.blocks.push({ kind: 'code', range: whole, value: node.value, ...(node.lang ? { language: node.lang } : {}) })
  })
  visit(root, 'yaml', (node) => {
    const whole = range(node)
    if (whole) out.blocks.push({ kind: 'frontmatter', range: whole, value: node.value })
  })
  visit(root, 'thematicBreak', (node) => {
    const whole = range(node)
    if (whole) out.blocks.push({ kind: 'rule', range: whole, value: '' })
  })
  visit(root, 'paragraph', (node) => {
    if (!node.children.some((child) => child.type === 'html')) return
    const whole = range(node)
    if (whole) out.blocks.push({ kind: 'html', range: whole, value: source.slice(whole.start, whole.end), node, source })
  })
  visit(root, 'html', (node, _index, parent) => {
    if (parent?.type !== 'root') return
    const whole = range(node)
    if (whole) out.blocks.push({ kind: 'html', range: whole, value: node.value, node, source })
  })

  return out
}
