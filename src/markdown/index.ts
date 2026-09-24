export { compile, recoverCompile } from './pipeline.ts'
export { LEDGER_ANCHOR, findLedgerStart, partitionSource } from './partition.ts'
export { STAGE_IDS, DEFAULT_STAGES } from './types.ts'
export type {
  CalloutKind,
  CalloutRef,
  CompileOptions,
  CompileResult,
  DocIndex,
  ImageRef,
  MathRef,
  MermaidRef,
  StageFlags,
  StageId,
  SourceRange,
  TableRef,
  WikiLinkRef
} from './types.ts'
export { listedStages, ALL_STAGES } from './stages/registry.ts'
export { inViewport } from './viewport.ts'
export { expandToLineBlock, planWidgets, rangesOverlap, rangeInDoc } from './view-plan.ts'
export type { PlannedWidget } from './view-plan.ts'
