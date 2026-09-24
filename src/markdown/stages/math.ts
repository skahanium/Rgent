import { math } from 'micromark-extension-math'
import { mathFromMarkdown } from 'mdast-util-math'
import type { MarkdownStage } from './stage.ts'

export const mathStage: MarkdownStage = {
  id: 'math',
  micromark: () => math(),
  mdast: () => mathFromMarkdown()
}
