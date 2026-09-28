import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Root, RootContent } from 'mdast'
import { visit } from 'unist-util-visit'
import { DEFAULT_STAGES, type CompileOptions, type CompileResult, type Partition, type StageFlags } from './types.ts'
import { partitionSource } from './partition.ts'
import { extensionsFor } from './stages/registry.ts'
import { buildIndex, emptyIndex } from './doc-index.ts'

/**
 * Imported notes sometimes put a leading Markdown image and prose (or `##`)
 * on the same physical line. Project that figure into its own AST block, then
 * parse the remainder with the same Markdown parser. Positions still point at
 * the unmodified source; this never rewrites the note on disk.
 */
function splitLeadingFigures(
  tree: Root,
  source: string,
  parseTail: (tail: string) => Root
): Root {
  const output: RootContent[] = []
  for (const child of tree.children) {
    if (child.type !== 'paragraph' || child.children[0]?.type !== 'image') {
      output.push(child)
      continue
    }
    const image = child.children[0]
    const start = image.position?.start.offset
    const end = image.position?.end.offset
    const paragraphEnd = child.position?.end.offset
    if (start == null || end == null || paragraphEnd == null) {
      output.push(child)
      continue
    }
    const lineStart = source.lastIndexOf('\n', start - 1) + 1
    const lineEndIndex = source.indexOf('\n', end)
    const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex
    const tailStart = end + (source.slice(end, lineEnd).match(/^[ \t]*/)?.[0].length ?? 0)
    if (source.slice(lineStart, start).trim() || tailStart >= lineEnd) {
      output.push(child)
      continue
    }

    output.push({ type: 'paragraph', children: [image], position: image.position })
    const suffix = parseTail(source.slice(tailStart, paragraphEnd))
    const firstLine = source.slice(0, tailStart).split('\n').length
    const firstColumn = tailStart - source.lastIndexOf('\n', tailStart - 1)
    visit(suffix, (node) => {
      if (!node.position) return
      for (const point of [node.position.start, node.position.end]) {
        point.offset = (point.offset ?? 0) + tailStart
        point.column = point.line === 1 ? point.column + firstColumn - 1 : point.column
        point.line += firstLine - 1
      }
    })
    output.push(...suffix.children)
  }
  tree.children = output
  return tree
}

function mergeStages(overrides?: Partial<StageFlags>): StageFlags {
  return { ...DEFAULT_STAGES, ...overrides }
}

export function recoverCompile(
  source: string,
  stages: StageFlags,
  error: string,
  prev?: CompileResult
): CompileResult {
  if (prev && !prev.stale) {
    return { ...prev, source, stale: true, error }
  }
  return {
    source,
    partition: partitionSource(source),
    tree: { type: 'root', children: [] } satisfies Root,
    index: emptyIndex(),
    stages,
    stale: true,
    error
  }
}

function compilePart(source: string, partition: Partition, options: CompileOptions): CompileResult {
  const stages = mergeStages(options.stages)
  try {
    const { micromark, mdast, transforms } = extensionsFor(stages)
    let tree = fromMarkdown(partition.body, {
      extensions: micromark as never,
      mdastExtensions: mdast as never
    })
    for (const transform of transforms) {
      tree = transform(tree)
    }
    tree = splitLeadingFigures(tree, partition.body, (tail) => {
      let fragment = fromMarkdown(tail, {
        extensions: micromark as never,
        mdastExtensions: mdast as never
      })
      for (const transform of transforms) fragment = transform(fragment)
      return fragment
    })
    const index = buildIndex(tree, partition.body, stages, partition.bodyOffset)
    return {
      source,
      partition,
      tree,
      index,
      stages,
      stale: false
    }
  } catch (err) {
    return recoverCompile(source, stages, err instanceof Error ? err.message : String(err), options.prev)
  }
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  return compilePart(source, partitionSource(source), options)
}

/** Read-only fragments such as ledger text use the same parser without another partition. */
export function compileFragment(source: string, options: CompileOptions = {}): CompileResult {
  return compilePart(source, { body: source, ledger: null, bodyOffset: 0 }, options)
}
