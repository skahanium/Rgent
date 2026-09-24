import { frontmatter } from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import type { MarkdownStage } from './stage.ts'

export const frontmatterStage: MarkdownStage = {
  id: 'frontmatter',
  micromark: () => frontmatter(['yaml']),
  mdast: () => frontmatterFromMarkdown(['yaml'])
}
