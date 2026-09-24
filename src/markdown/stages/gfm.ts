import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import type { MarkdownStage } from './stage.ts'

export const gfmStage: MarkdownStage = {
  id: 'gfm',
  micromark: () => gfm(),
  mdast: () => gfmFromMarkdown()
}
