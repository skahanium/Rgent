import type { Root } from 'mdast'
import type { StageId } from '../types.ts'

export type MarkdownStage = {
  id: StageId
  micromark?: () => unknown
  mdast?: () => unknown
  transform?: (tree: Root) => Root
}
