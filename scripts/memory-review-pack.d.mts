/** 复核包生成器的对外形状；实现是 scripts/memory-review-pack.mjs（纯 JSON 读取，不依赖 TS 运行时）。 */
export type ReviewCard = {
  key: string
  caseId: string | null
  round: number | null
  model: string | null
  chineseMaterial: boolean
  gloss: string | null
  prompt: string
  context: string
  stored: { semantic: string; scope: string; content: string }[]
  recent: { goal: string; completed: string; blocked: string; next: string }[]
  storedNothing: boolean
  receipt: { outcome: string | null; reason: string | null }
  annotated: boolean
}
export type ReviewAnswer = { key: string; acceptable: string; missing?: string; shouldNot?: string; note?: string }
export type ReviewAnnotation = {
  key: string
  review: {
    correct: number; omitted: number; wrongNew: number
    hardViolations: string[]
    checks: { attributionAndScope: boolean; noUnsupportedContent: boolean; noForbiddenContent: boolean }
    evidenceComplete: boolean
    uncertainty: string[]
    annotator: { identity: string; kind: string; participatedInDesign: boolean; modelNameMasked: boolean; humanReviewed: boolean }
    rulesHash: string; resultHash: string; frozenHash: string; rubricVersion: number
    humanVerdict: { acceptable: string; missing: string; shouldNot: string; note: string }
  }
}
export const MAPPING_NOTE: string
export function latestRun(): string
export function cardOf(result: unknown, gloss?: Record<string, string>): Omit<ReviewCard, 'annotated'>
export function buildCards(runDir: string, gloss?: Record<string, string>): ReviewCard[]
export function annotationOf(card: ReviewCard, answer: ReviewAnswer, bindings: { rulesHash: string; resultHash: string; frozenHash: string }, rubricVersion: number, units?: number): ReviewAnnotation | null
export function convertAnswers(runDir: string, answers: { rows?: ReviewAnswer[] }, gloss?: Record<string, string>): { converted: ReviewAnnotation[]; skipped: { key: string; why: string }[]; rubricVersion: number }
export function renderPack(cards: ReviewCard[], meta: { run: string; frozenHash: string | null }): string
