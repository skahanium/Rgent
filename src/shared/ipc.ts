export const IPC = {
  vaultGet: 'vault:get',
  vaultPick: 'vault:pick',
  treeList: 'tree:list',
  treeChanged: 'tree:changed',
  noteRead: 'note:read',
  noteInspect: 'note:inspect',
  noteAbandon: 'note:abandon',
  noteWrite: 'note:write',
  noteCreate: 'note:create',
  noteSaveCopyPreview: 'note:save-copy-preview',
  noteSaveCopyCommit: 'note:save-copy-commit',
  folderCreate: 'folder:create',
  relocationPreview: 'note:relocation-preview',
  relocationCommit: 'note:relocation-commit',
  noteRelocated: 'note:relocated',
  lifecycleFlushRequest: 'lifecycle:flush-request',
  lifecycleFlushDone: 'lifecycle:flush-done',
  lifecycleStatus: 'lifecycle:status',
  lifecycleRetry: 'lifecycle:retry',
  noteExternalChange: 'note:external-change',
  vaultLost: 'vault:lost',
  menuOpenVault: 'menu:open-vault',
  menuNewNote: 'menu:new-note',
  menuSave: 'menu:save',
  flushRequest: 'app:flush-request',
  flushDone: 'app:flush-done',
  backlinks: 'note:backlinks',
  search: 'vault:search',
  permissionsGet: 'permissions:get',
  permissionsSet: 'permissions:set',
  themeGet: 'theme:get',
  themeSet: 'theme:set',
  readingGet: 'reading:get',
  readingSet: 'reading:set',
  remoteImageGet: 'image:get',
  modelConfigGet: 'model-config:get',
  modelProviderSave: 'model-config:provider-save',
  modelProviderRemove: 'model-config:provider-remove',
  modelKeyDelete: 'model-config:key-delete',
  modelAdd: 'model-config:model-add',
  modelUpdate: 'model-config:model-update',
  modelRemove: 'model-config:model-remove',
  modelDefaultSet: 'model-config:default-set',
  modelList: 'model-config:model-list',
  modelLimitsSet: 'model-config:limits-set',
  agentAuthorizationPreview: 'agent:authorization-preview',
  agentAuthorizationDiscard: 'agent:authorization-discard',
  agentStart: 'agent:start',
  agentCancel: 'agent:cancel',
  agentTasks: 'agent:tasks',
  agentEvent: 'agent:event'
} as const

export type ModelProvider = 'deepseek' | 'minimax' | 'custom'
export type LimitTier = 'none' | 'local' | 'network'
export type RunLimits = { seconds: number; steps: number; tools: number }
/** 一个供应商的配置：至多一条连接 = 一个端点 + 一套独立密钥。 */
export type PublicProvider = {
  provider: ModelProvider
  /** 已填过端点或存过密钥。 */
  configured: boolean
  baseURL: string
  hasKey: boolean
  modelCount: number
}
/** 一条连接下的一个模型。 */
export type PublicModel = {
  id: string
  provider: ModelProvider
  modelId: string
  contextTokens: number
}
export type PublicModelConfig = {
  /** 固定按 DeepSeek、MiniMax、自定义排序，未配置的也在列。 */
  providers: PublicProvider[]
  models: PublicModel[]
  /** 新任务使用的模型；由底栏模型模块选择。null 表示尚未选择。 */
  defaultModelId: string | null
  limits: Record<LimitTier, RunLimits>
}
export type ModelConfigResult = { ok: true; config: PublicModelConfig } | { ok: false; error: string }
/** 保存（或首次建立）该供应商的配置；没有配置时用 modelId/contextTokens 建第一个模型。 */
export type ModelProviderSaveRequest = {
  provider: ModelProvider
  baseURL: string
  modelId: string
  contextTokens: number
  newKey?: string
}
export type ModelProviderRemoveRequest = { provider: ModelProvider }
export type ModelKeyDeleteRequest = { provider: ModelProvider }
export type ModelAddRequest = { provider: ModelProvider; modelId: string; contextTokens: number }
export type ModelUpdateRequest = { modelId: string; contextTokens: number }
export type ModelRemoveRequest = { modelId: string }
export type ModelDefaultSetRequest = { modelId: string | null }
export type ModelListRequest = { provider: ModelProvider }
/** 端点自报的上下文容量可能缺失；缺失时由人填写。 */
export type ModelListEntry = { id: string; contextTokens?: number }
export type ModelListResult = { ok: true; models: ModelListEntry[]; truncated?: boolean } | { ok: false; error: string }
export type ModelLimitsSetRequest = { tier: LimitTier; limits: RunLimits }
export type ObjectBinding = { sessionId: string; objectVersion: string }
export type AgentCommandRequest = ObjectBinding & {
  expectedRevision: string
  relPath: string
  range: { start: number; end: number }
  expectedText: string
  promptText: string
}
export type AgentAuthorizationRequest = AgentCommandRequest & { references: string[] }
export type AuthorizedSource = ObjectBinding & { sourceId: string; relPath: string; title: string; revision: string; fingerprint: string; tier: 'reference' | 'follow' }
export type AgentAuthorizationPreview = {
  id: string; sessionId: string; origin: string; sources: AuthorizedSource[]
  recipient: { modelId: string; host: string; provider: ModelProvider }
}
export type AgentAuthorizationResult = { ok: true; preview: AgentAuthorizationPreview } | { ok: false; error: string }
export type AgentStartRequest = AgentCommandRequest & { previewId: string }
export type AgentStartResult = { ok: true; id: string } | { ok: false; error: string }
export type AgentTaskView = { id: string; relPath: string; startedAt: number; activity?: string }
export type AgentEvent = {
  id: string
  relPath: string
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  answer?: string
  reason?: string
  persisted?: boolean
  revision?: string
  sessionId?: string
  objectVersion?: string
  activity?: string
}

export type ImageContext = {
  noteRelPath: string
  region: 'body' | 'ledger'
  start: number
  end: number
  sessionId?: string
  revision?: string
  objectVersion?: string
  /** Only explicit loads may use a changed window draft. */
  draftBody?: string
}
export type RemoteImageGetRequest = {
  url: string
  mode: 'auto' | 'explicit'
  allowHttp?: boolean
  continuation?: string
  context?: ImageContext
}
export type RemoteImageGetResult =
  | { ok: true; src: string }
  | { ok: false; error: 'HTTP_CONFIRM' | 'REDIRECT_CONFIRM'; url: string; continuation: string }
  | { ok: false; error: 'INVALID_URL' | 'NOT_ALLOWED' | 'NOT_IMAGE' | 'TOO_LARGE' | 'UNAVAILABLE' | 'BUSY' }

export type ThemeMode = 'day' | 'night' | 'system'
export type ThemeSetResult = { ok: true; mode: ThemeMode } | { ok: false; error: 'BAD_MODE' | 'IO_ERROR' }
export type { ReadingPreference } from './reading-preference.ts'
export type ReadingSetResult = { ok: true; reading: import('./reading-preference.ts').ReadingPreference } | { ok: false; error: 'BAD_READING' | 'IO_ERROR' }

export type VaultState =
  | { status: 'needs-pick'; reason: 'first-run' | 'missing' }
  | { status: 'ready'; rootName: string; vaultChanged?: boolean; sessionId?: string }

export type TreeEntry = {
  name: string
  relPath: string
  kind: 'dir' | 'note' | 'file'
  tier?: 'follow' | 'forbidden'
  children?: TreeEntry[]
}

export type PermissionTier = 'reference' | 'follow' | 'forbidden'
export type PermissionEntry = { relPath: string; tier: PermissionTier }
export type PermissionState =
  | { status: 'ready'; entries: PermissionEntry[] }
  | { status: 'invalid'; error: string }
export type SetPermissionRequest = { relPath: string; tier: PermissionTier }

export type NoteSnapshot = { content: string; revision: string; objectVersion: string; sessionId: string }
export type SaveCopyPreviewRequest = ObjectBinding & {
  source: string
  body: string
  draftVersion: string
  target: string
}
export type SaveCopyPreviewView = {
  id: string
  sessionId: string
  source: string
  target: string
  draftVersion: string
  pendingTaskIds: string[]
  warning: string
}
export type SaveCopyCommitRequest = { sessionId: string; id: string; draftVersion: string; body: string }
export type SaveCopyPreviewResult = { ok: true; preview: SaveCopyPreviewView } | { ok: false; error: string }
export type SaveCopyCommitResult = { ok: true; relPath: string; snapshot: NoteSnapshot; taskIds: string[] } | { ok: false; error: string }
export type EntryCreateRequest = { name: string; parent: string }
export type RelocationPreviewRequest = { kind: 'note' | 'folder'; source: string; target: string }
export type RelocationCommitRequest = { id: string; repairLinks: boolean }
export type RelocationPreviewView = {
  id: string
  sessionId: string
  kind: 'note' | 'folder'
  source: string
  target: string
  moves: { from: string; to: string; id: string }[]
  linkChanges: { relPath: string; newPath: string; count: number }[]
  permissionChanges: { from: string; to: string; tier: string }[]
}
export type RelocationPreviewResult = { ok: true; preview: RelocationPreviewView } | { ok: false; error: string }
export type RelocationCommitResult = { ok: true; moved: { from: string; to: string }[]; unrepaired: string[] } | { ok: false; error: string }
export type RelocationEvent = { moved: { from: string; to: string }[]; sessionId?: string }
export type LifecycleReason = 'journal-invalid' | 'journal-unreadable' | 'object-changed' | 'policy-changed' | 'recovery-required'
export type LifecycleStatus = {
  sessionId: string
  status: 'ready' | 'pending' | 'invalid'
  revision: string | null
  operation?: { kind: 'note' | 'folder'; source: string; target: string }
  items: { from: string; to: string; state: 'source' | 'moved' | 'blocked' }[]
  reason?: LifecycleReason
}
export type LifecycleRetryRequest = { sessionId: string; revision: string }
export type LifecycleRetryResult = {
  ok: true
  moved: { from: string; to: string }[]
  unrepaired: string[]
  /** 文件恢复已完成，但无关任务的生成内容仍待保存。 */
  hostPending: boolean
} | { ok: false; error: string }
export type NoteWriteRequest = ObjectBinding & { relPath: string; content: string; expectedRevision: string }

export type NoteInspectRequest = ObjectBinding & { relPath: string }
export type NoteInspectResult = { status: 'ready'; snapshot: NoteSnapshot } | { status: 'missing' | 'replaced' | 'unreadable'; sessionId: string; relPath: string; objectVersion: string }
export type NoteAvailability = 'missing' | 'replaced' | 'unavailable'
export type NotePayload = { sessionId: string; relPath: string } & (
  { state?: 'changed'; content: string; revision: string; objectVersion: string }
  | { state: NoteAvailability; reason?: string; objectVersion?: string }
)

export type NoteWriteResult = {
  ok: true
  revision: string
  objectVersion: string
  sessionId: string
} | {
  ok: false
  error: 'CONFLICT' | 'BAD_PATH' | 'NO_VAULT' | 'NOTE_BUSY' | 'IO_ERROR' | 'NOTE_MISSING' | 'NOTE_REPLACED' | 'NOTE_UNREADABLE' | 'VAULT_CHANGED' | 'LEDGER_BOUNDARY_INVALID'
}

export type FlushDonePayload = {
  ok: boolean
}

/** 反链：谁链到了这篇，按所在文件夹分组。 */
export type BacklinkRef = {
  relPath: string
  title: string
}

/** 库根那一层的分组名。 */
export const ROOT_GROUP = '库根'

export type BacklinkGroup = {
  folder: string
  notes: BacklinkRef[]
}

/** 一条搜索命中。matchStart / matchLength 是片段内的偏移，供画面上加标记。 */
export type SearchHit = {
  relPath: string
  title: string
  folder: string
  titleHit: boolean
  count: number
  snippet: string
  matchStart: number
  matchLength: number
}
