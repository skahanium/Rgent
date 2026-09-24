import type { StageId } from '../types.ts'

export type MarkdownStage = {
  id: StageId
  micromark?: () => unknown
  mdast?: () => unknown
}
