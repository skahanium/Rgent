import { frontmatter } from 'micromark-extension-frontmatter'
import { gfm } from 'micromark-extension-gfm'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { STAGE_IDS, type StageFlags } from '../types.ts'

export const STUB_STAGE_IDS = ['math', 'callout', 'wikilink'] as const

export function extensionsFor(stages: StageFlags): {
  micromark: unknown[]
  mdast: unknown[]
} {
  const micromark: unknown[] = []
  const mdast: unknown[] = []

  if (stages.frontmatter) {
    micromark.push(frontmatter(['yaml']))
    mdast.push(frontmatterFromMarkdown(['yaml']))
  }
  if (stages.gfm) {
    micromark.push(gfm())
    mdast.push(gfmFromMarkdown())
  }

  return { micromark, mdast }
}

export function listedStages(): readonly string[] {
  return STAGE_IDS
}
