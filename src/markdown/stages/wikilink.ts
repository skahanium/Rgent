import type { MarkdownStage } from './stage.ts'

/** `[[全路径]]` 下一刀加 micromark 扩展。 */
export const wikilinkStage: MarkdownStage = { id: 'wikilink' }
