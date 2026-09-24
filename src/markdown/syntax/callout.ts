import type { Blockquote, Paragraph, Root } from 'mdast'
import { SKIP, visit } from 'unist-util-visit'
import type { CalloutKind } from '../types.ts'
import type { CalloutNode } from './nodes.ts'

const KINDS = new Set<CalloutKind>(['note', 'tip', 'warning', 'important', 'caution'])

export const CALLOUT_TITLES: Record<CalloutKind, string> = {
  note: '笔记',
  tip: '提示',
  warning: '警告',
  important: '重要',
  caution: '注意'
}

const MARK = /^\[!(note|tip|warning|important|caution)\](?:[ \t]+(.*))?$/i

export function transformCallouts(tree: Root): Root {
  visit(tree, 'blockquote', (node, index, parent) => {
    if (index == null || parent == null) return
    const parsed = matchCallout(node)
    if (!parsed) return
    const next: CalloutNode = {
      type: 'callout',
      kind: parsed.kind,
      title: parsed.title,
      children: parsed.children,
      position: node.position
    }
    parent.children[index] = next
    return SKIP
  })
  return tree
}

function matchCallout(node: Blockquote): {
  kind: CalloutKind
  title: string
  children: Blockquote['children']
} | null {
  const first = node.children[0]
  if (!first || first.type !== 'paragraph') return null
  const full = textOf(first)
  const nl = full.indexOf('\n')
  const firstLine = (nl === -1 ? full : full.slice(0, nl)).trim()
  const match = firstLine.match(MARK)
  if (!match) return null
  const kind = match[1].toLowerCase() as CalloutKind
  if (!KINDS.has(kind)) return null
  const title = (match[2] ?? '').trim() || CALLOUT_TITLES[kind]
  const restLine = nl === -1 ? '' : full.slice(nl + 1)
  const children = [...node.children]
  if (restLine.trim().length === 0) {
    children.shift()
  } else {
    const rest: Paragraph = {
      type: 'paragraph',
      children: [{ type: 'text', value: restLine }],
      position: first.position
    }
    children[0] = rest
  }
  return { kind, title, children }
}

export function textOf(node: { value?: string; children?: unknown[] }): string {
  if (typeof node.value === 'string') return node.value
  if (!node.children) return ''
  return node.children.map((child) => textOf(child as { value?: string; children?: unknown[] })).join('')
}
