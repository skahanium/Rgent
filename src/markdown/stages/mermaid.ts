import type { MarkdownStage } from './stage.ts'

/** mermaid 语法就是 code fence；本 stage 只决定要不要规划 widget。 */
export const mermaidStage: MarkdownStage = { id: 'mermaid' }
