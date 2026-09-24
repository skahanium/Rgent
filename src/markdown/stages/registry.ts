import { STAGE_IDS, type StageFlags } from '../types.ts'
import { calloutStage } from './callout.ts'
import { frontmatterStage } from './frontmatter.ts'
import { gfmStage } from './gfm.ts'
import { mathStage } from './math.ts'
import { mermaidStage } from './mermaid.ts'
import type { MarkdownStage } from './stage.ts'
import { wikilinkStage } from './wikilink.ts'

export const ALL_STAGES: readonly MarkdownStage[] = [
  frontmatterStage,
  gfmStage,
  mathStage,
  calloutStage,
  wikilinkStage,
  mermaidStage
]

export const STUB_STAGE_IDS = ['math', 'callout', 'wikilink', 'mermaid'] as const

export function extensionsFor(stages: StageFlags): {
  micromark: unknown[]
  mdast: unknown[]
} {
  const micromark: unknown[] = []
  const mdast: unknown[] = []
  for (const stage of ALL_STAGES) {
    if (!stages[stage.id]) continue
    if (stage.micromark) micromark.push(stage.micromark())
    if (stage.mdast) mdast.push(stage.mdast())
  }
  return { micromark, mdast }
}

export function listedStages(): readonly string[] {
  return STAGE_IDS
}
