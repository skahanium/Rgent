import type { MarkdownStage } from './stage.ts'
import { transformCallouts } from '../syntax/callout.ts'

export const calloutStage: MarkdownStage = {
  id: 'callout',
  transform: transformCallouts
}
