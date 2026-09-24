import type { MarkdownStage } from './stage.ts'

/** callout 下一刀做 blockquote 变换，不新造第二套解析。 */
export const calloutStage: MarkdownStage = { id: 'callout' }
