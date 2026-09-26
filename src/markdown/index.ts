export { compile, recoverCompile } from './pipeline.ts'
export { AI_MARKER, PROMPT_MARKER, markerLine, parseMarker } from './identity.ts'
export type { BlockIdentity, MarkerParse } from './identity.ts'
export { LEDGER_ANCHOR, composeSource, findLedgerStart, partitionSource, preferDiskLedger } from './partition.ts'
export { STAGE_IDS, DEFAULT_STAGES } from './types.ts'
export type {
  BlockRef,
  CalloutKind,
  CalloutRef,
  CompileOptions,
  CompileResult,
  DocIndex,
  ImageRef,
  MarkerRef,
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
