import { fromMarkdown, type Options } from 'mdast-util-from-markdown'
import type { Root } from 'mdast'
import { visit } from 'unist-util-visit'

/** micromark 会吞掉开头 BOM；所有节点仍须指回未改写的原文字节。 */
export function parseSource(source: string, options: Options): Root {
  const bom = source.startsWith('\ufeff')
  const tree = fromMarkdown(bom ? source.slice(1) : source, options)
  if (!bom) return tree
  const adjusted = new Set<object>()
  visit(tree, (node) => {
    if (!node.position) return
    for (const point of [node.position.start, node.position.end]) {
      if (adjusted.has(point)) continue
      adjusted.add(point)
      if (point.offset != null) point.offset += 1
      if (point.line === 1) point.column += 1
    }
  })
  return tree
}
