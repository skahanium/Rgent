export const IPC = {
  vaultGet: 'vault:get',
  vaultPick: 'vault:pick',
  treeList: 'tree:list',
  treeChanged: 'tree:changed',
  noteRead: 'note:read',
  noteWrite: 'note:write',
  noteCreate: 'note:create',
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
  modelProfileSet: 'model-config:profile-set',
  modelSelect: 'model-config:select',
  modelKeyDelete: 'model-config:key-delete',
  modelLimitsSet: 'model-config:limits-set',
  agentStart: 'agent:start',
  agentCancel: 'agent:cancel',
  agentTasks: 'agent:tasks',
  agentEvent: 'agent:event'
} as const

export type ModelProvider = 'deepseek' | 'minimax' | 'custom'
export type LimitTier = 'none' | 'local' | 'network'
export type ModelProfileFields = { baseURL: string; modelId: string; contextTokens: number }
export type RunLimits = { seconds: number; steps: number; tools: number }
export type PublicModelConfig = {
  selected: ModelProvider
  profiles: Record<ModelProvider, ModelProfileFields & { hasKey: boolean }>
  limits: Record<LimitTier, RunLimits>
}
export type ModelConfigResult = { ok: true; config: PublicModelConfig } | { ok: false; error: string }
export type ModelProfileSetRequest = { provider: ModelProvider; fields: ModelProfileFields; newKey?: string }
export type ModelLimitsSetRequest = { tier: LimitTier; limits: RunLimits }
export type AgentStartRequest = {
  relPath: string
  range: { start: number; end: number }
  expectedText: string
  promptText: string
}
export type AgentStartResult = { ok: true; id: string } | { ok: false; error: string }
export type AgentTaskView = { id: string; relPath: string; startedAt: number }
export type AgentEvent = {
  id: string
  relPath: string
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  answer?: string
  reason?: string
  persisted?: boolean
  revision?: string
}

export type RemoteImageGetRequest = { url: string; allowHttp: boolean }
export type RemoteImageGetResult =
  | { ok: true; src: string }
  | { ok: false; error: 'INVALID_URL' | 'HTTP_CONFIRM' | 'NOT_IMAGE' | 'TOO_LARGE' | 'UNAVAILABLE' | 'BUSY' }

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

export type NoteSnapshot = { content: string; revision: string }
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
export type NoteWriteRequest = { relPath: string; content: string; expectedRevision: string }

export type NotePayload = {
  sessionId?: string
  relPath: string
  content: string
  revision: string
}

export type NoteWriteResult = {
  ok: true
  revision: string
} | {
  ok: false
  error: 'CONFLICT' | 'BAD_PATH' | 'NO_VAULT' | 'NOTE_BUSY' | 'IO_ERROR'
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
