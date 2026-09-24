import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Root } from 'mdast'
import { DEFAULT_STAGES, type CompileOptions, type CompileResult, type StageFlags } from './types.ts'
import { partitionSource } from './partition.ts'
import { extensionsFor } from './stages/registry.ts'
import { buildIndex, emptyIndex } from './doc-index.ts'

function mergeStages(overrides?: Partial<StageFlags>): StageFlags {
  return { ...DEFAULT_STAGES, ...overrides }
}

function fallback(source: string, stages: StageFlags, error: string, prev?: CompileResult): CompileResult {
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

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const stages = mergeStages(options.stages)
  const partition = partitionSource(source)
  try {
    const { micromark, mdast } = extensionsFor(stages)
    const tree = fromMarkdown(partition.body, {
      extensions: micromark as never,
      mdastExtensions: mdast as never
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
    return fallback(source, stages, err instanceof Error ? err.message : String(err), options.prev)
  }
}
