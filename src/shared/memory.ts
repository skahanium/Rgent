/** Device configuration only; none of these values is an authorization. */
export type MemoryLimits = { seconds: number; calls: number; tools: number }
export type VaultMemoryConfig = { enabled: boolean; override: { mode: 'inherit' } | { mode: 'model'; modelId: string } }
export type PublicMemoryConfig = {
  defaultModelId: string | null
  limits: MemoryLimits
  vault: VaultMemoryConfig
  effectiveModelId: string | null
  modelStatus: 'missing' | 'unavailable' | 'ready'
}

export type MemoryDependency = { id: string; version: number }
export type MemoryWholeSource = { relPath: string; objectVersion: string; bodyHash: string; permissionTier: 'reference' | 'follow' }
export type MemorySource = {
  id: string
  version: number
  relPath: string
  objectVersion: string
  revision: string
  permissionTier: 'reference' | 'follow'
  kind: 'body' | 'ledger'
  taskId: string | null
  taskMaterialHash: string | null
  classification: 'human' | 'command' | 'adopted-ai'
  start: number
  end: number
  text: string
  hash: string
  /** Stable across controlled saves, offsets and relocation. */
  basisHash: string
  /** Textless IDs of explicitly proven contained material units, at most 16; no semantic equivalence or send authorization. */
  basisGroups?: string[]
  sourceDeps: MemoryWholeSource[]
  memoryDeps: MemoryDependency[]
}
export type MemoryEntry = {
  id: string
  version: number
  content: string
  layer: 'core' | 'demand'
  scope: string
  semantic?: 'standing' | 'fact'
  attribution?: string
  reviewAt?: string | null
  sources: MemorySource[]
  /** 依据角色：authortiy 是人的 command 原话，supporting 只用于理解；缺字段的旧条目保持原貌。 */
  agreement?: AgreementBasis
  category?: 'long' | 'recent'
  recent?: {taskId:string;noteId:string;materialVersion:string;createdAt:string;outcome:'completed'|'cancelled'|'failed'|'limit';sections:{goal:string;completed:string;blocked:string;next:string};assistantDraft:boolean}
  tags?: string[]
  state?: MemoryEntryState
  status: 'active' | 'paused' | 'pending' | 'disabled' | 'review' | 'obsolete' | 'disputed' | 'deferred'
  reason: string | null
  updatedAt: string
  updateBasis: { kind: 'manual' | 'consolidation'; id: string; version: number }
  pendingTarget?: MemoryDependency
}
/** 权威依据必须来自人的明确口令，且引用原话逐字存在于该来源；辅助佐证仍参与依赖与遗忘闭包。 */
export type AgreementBasis = { authority: { sourceId: string; quote: string }[]; supporting: string[] }
export type MemoryEntryState = { source: 'verified' | 'unchecked' | 'revoked'; content: 'current' | 'review' | 'disputed' | 'obsolete'; enabled: boolean; capacity: 'ready' | 'deferred' }
/** 有界分组结果：一次整理里相关更正组共同成败，独立组分别记账。 */
export type MemoryJobGroupResult = { action: 'add' | 'correct' | 'conflict' | 'obsolete' | 'recent'; outcome: 'applied' | 'rejected' | 'unchanged'; code?: string }
export type MemoryJobReceipt = {
  taskId: string; materialVersion: string
  outcome: 'queued' | 'running' | 'applied' | 'rejected' | 'interrupted'
  entryIds: string[]
  reason?: string
  results?: MemoryJobGroupResult[]
}
/** 记忆整理管线标识：评测成绩与界面提示都绑定到这个版本；变化后旧成绩不再继承。 */
export const MEMORY_PIPELINE = 'continuity-m4'
/** 生产入口使用的整理口径。r9（`d5aca453…`，deepseek-flash 两轮 passed）之后固定为共同管线；
 *  旧提议解析路径（`memoryConsolidationSystem`／`parseMemorySuggestions`）只保留给历史评测臂，
 *  生产不再选择它。改这个常量等于改产品行为，必须重新冻结并复测。 */
export const MEMORY_PRODUCTION_STRATEGY = 'continuity' as const
/** 已发布的质量成绩：四种状态分开显示，stale 表示模型、主机或管线已变。 */
export type MemoryQualityEvidence = {
  state: 'unverified' | 'testing' | 'passed' | 'failed' | 'insufficient'
  verifiedAt?: string
  modelId?: string | null
  host?: string | null
  pipeline?: string | null
  commit?: string | null
  humanReviewed: boolean
  stale: boolean
  rounds?: number | null
}
export type MemoryContext = { sessionId: string; vaultKey: string }
export type MemoryStatus = { status: 'ready'; count: number } | { status: 'invalid'; reason: string }

/** Only these bounded, human management views cross IPC. No hidden record or authority. */
export type MemorySourceView = Pick<MemorySource, 'relPath' | 'kind' | 'taskId' | 'text' | 'classification'>
export type MemoryEntryView = Pick<MemoryEntry, 'id' | 'version' | 'content' | 'layer' | 'scope' | 'status' | 'reason' | 'updatedAt' | 'pendingTarget'> & { sources: MemorySourceView[];semantic?:'standing'|'fact';attribution?:string;reviewAt?:string|null;agreement?:AgreementBasis;category?:'long'|'recent';recent?:MemoryEntry['recent'];tags?:string[];state?:MemoryEntryState }
export type MemoryJobView = { taskId: string; materialVersion: string | null; outcome: MemoryJobReceipt['outcome'] | 'unavailable' | 'handed-off'; reason?: string; results?: MemoryJobGroupResult[]; retryable: boolean; entryIds?: string[]; undoable?:boolean }
export type MemoryView = {
  sessionId: string; revision: string | null; objectVersion: string | null
  config: PublicMemoryConfig
  recipient: { modelId: string; host: string } | null
  status: 'ready' | 'invalid'; reason?: string
  entries: MemoryEntryView[]; jobs: MemoryJobView[]
  running: { permits: number; pending: number; active: number }
  learning?:{watermark:number;nextSequence:number}
  materialStatus?:'verified'|'empty'|'invalid'
  retirementFailure?:string
  bindingFailure?:string
  /** 已提交后的运行维护诊断；会话内保留，成功维护后解除。 */
  maintenanceFailure?:string
  retirement?:{revision:string;objectVersion:string;bytes:number}
  configDiagnosis?: {revision:string|null;bytes:number}
  diagnosis?:{revision:string|null;objectVersion:string|null;bytes:number}
 /** 质量成绩与证据状态：未取得人工复核时如实标注，不显示为通过。 */
 quality?:MemoryQualityEvidence
}
export type MemoryResult<T> = { ok: true; value: T } | { ok: false; error: string }
export type MemorySessionRequest = { sessionId: string }
export type MemoryConfigChange = (
  { target: 'default'; modelId: string | null } |
  { target: 'vault'; vault: VaultMemoryConfig } |
  { target: 'limits'; limits: MemoryLimits }
)
export type MemoryConfigRequest = MemorySessionRequest & MemoryConfigChange
export type MemoryItemRequest = MemorySessionRequest & {
  revision: string | null; objectVersion: string | null; id: string; version: number
}
export type MemoryEditRequest = MemoryItemRequest & { content: string; layer: MemoryEntry['layer']; scope: string }
export type MemoryManualRequest = MemorySessionRequest & {
  relPath: string; objectVersion: string; revision: string; kind: 'body' | 'ledger'
  taskId?: string; start: number; end: number
}
export type MemoryJobRequest = MemorySessionRequest & { taskId: string; materialVersion: string }
export type MemoryPreview = {
  id: string; sessionId: string; kind: 'manual' | 'restore' | 'confirm' | 'retry'|'watermark'|'reset'|'reset-config'|'undo'|'retire'
  content: string; layer: MemoryEntry['layer']; scope: string
  sources: MemorySourceView[]; warning: string
  previousContent?: string
  recipient?: { modelId: string; host: string } | null
  limits?: MemoryLimits
}
export type MemoryCommitRequest = MemorySessionRequest & {
  id: string; content?: string; layer?: MemoryEntry['layer']; scope?: string
}
export type MemoryMaintenanceRequest=MemorySessionRequest&{action:'watermark'|'reset'|'reset-config'|'undo'|'retire';taskId?:string;materialVersion?:string;revision:string|null;objectVersion:string|null;watermark?:number}
