import type { MarkdownStage } from './stage.ts'
import { wikilinkFromMarkdown, wikilinkSyntax } from '../syntax/wikilink.ts'

export const wikilinkStage: MarkdownStage = {
  id: 'wikilink',
  micromark: () => wikilinkSyntax(),
  mdast: () => wikilinkFromMarkdown()
}
