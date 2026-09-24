export { compile, recoverCompile } from './pipeline.ts'
export { partitionSource } from './partition.ts'
export { STAGE_IDS, DEFAULT_STAGES } from './types.ts'
export type {
  CompileOptions,
  CompileResult,
  DocIndex,
  ImageRef,
  StageFlags,
  StageId,
  SourceRange,
  TableRef
} from './types.ts'
export { listedStages, STUB_STAGE_IDS, ALL_STAGES } from './stages/registry.ts'
export { inViewport } from './viewport.ts'
export { expandToLineBlock, planWidgets, rangesOverlap } from './view-plan.ts'
