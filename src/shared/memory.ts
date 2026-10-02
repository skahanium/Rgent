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
  /** Textless identity of whole classified units; excludes offsets, paths and task IDs. */
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
  sources: MemorySource[]
  status: 'active' | 'paused' | 'pending' | 'disabled'
  reason: string | null
  updatedAt: string
  updateBasis: { kind: 'manual' | 'consolidation'; id: string; version: number }
  pendingTarget?: MemoryDependency
}
export type MemoryForget = { id: string; throughVersion: number; basisHashes: string[]; contentHash: string; forgottenAt: string }
export type MemoryJobMaterial = {
  sources: MemorySource[]
  related: MemoryDependency[]
  result: string
  status: 'completed' | 'cancelled' | 'failed' | 'limit'
  reason: string | null
  omitted: boolean
}
export type MemoryJobReceipt = {
  taskId: string; materialVersion: string
  outcome: 'queued' | 'running' | 'applied' | 'rejected' | 'interrupted'
  entryIds: string[]
  reason?: string
  material?: MemoryJobMaterial
}
export type MemoryProposal = {
  action: 'add' | 'update'; content: string; layer: MemoryEntry['layer']; scope: string
  category: 'lasting' | 'confirmed' | 'correction' | 'ambiguous'
  citations: string[]; target: MemoryDependency | null
}
export type MemoryRecord = { version: 1; entries: MemoryEntry[]; forgotten: MemoryForget[]; jobs: MemoryJobReceipt[]; relocations: string[] }
export type MemoryContext = { sessionId: string; vaultKey: string }
export type MemoryStoragePin = { objectVersion: string; revision: string }
/** Main process only. No root, path argument or generic disk access. */
export type MemoryStorePinPort = {
  get(vaultKey: string): MemoryStoragePin | null
  set(vaultKey: string, pin: MemoryStoragePin): void
}
export type MemorySnapshot = MemoryContext & { revision: string | null; objectVersion: string | null; record: MemoryRecord }
export type MemoryStatus = { status: 'ready'; count: number } | { status: 'invalid'; reason: string }

/** Only these bounded, human management views cross IPC. No hidden record or authority. */
export type MemorySourceView = Pick<MemorySource, 'relPath' | 'kind' | 'taskId' | 'text' | 'classification'>
export type MemoryEntryView = Pick<MemoryEntry, 'id' | 'version' | 'content' | 'layer' | 'scope' | 'status' | 'reason' | 'updatedAt' | 'pendingTarget'> & { sources: MemorySourceView[] }
export type MemoryJobView = { taskId: string; materialVersion: string | null; outcome: MemoryJobReceipt['outcome'] | 'unavailable' | 'handed-off'; reason?: string; retryable: boolean }
export type MemoryView = {
  sessionId: string; revision: string | null; objectVersion: string | null
  config: PublicMemoryConfig
  recipient: { modelId: string; host: string } | null
  status: 'ready' | 'invalid'; reason?: string
  entries: MemoryEntryView[]; jobs: MemoryJobView[]
  running: { permits: number; pending: number; active: number }
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
  id: string; sessionId: string; kind: 'manual' | 'restore' | 'confirm' | 'retry'
  content: string; layer: MemoryEntry['layer']; scope: string
  sources: MemorySourceView[]; warning: string
  previousContent?: string
  recipient?: { modelId: string; host: string } | null
  limits?: MemoryLimits
}
export type MemoryCommitRequest = MemorySessionRequest & {
  id: string; content?: string; layer?: MemoryEntry['layer']; scope?: string
}
