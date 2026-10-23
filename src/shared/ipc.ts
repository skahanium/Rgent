export const IPC = {
  vaultGet: 'vault:get',
  vaultPick: 'vault:pick',
  vaultCatalog: 'vault:catalog',
  vaultCatalogChange: 'vault:catalog-change',
  vaultOpen: 'vault:open',
  vaultTransition: 'vault:transition',
  vaultWorkspaceGet: 'vault:workspace-get',
  vaultWorkspaceSave: 'vault:workspace-save',
  treeList: 'tree:list',
  treeChanged: 'tree:changed',
  noteRead: 'note:read',
  ledgerGet:'ledger:get',
  ledgerReasoning:'ledger:reasoning',
  memoryMaintenancePreview:'memory:maintenance-preview',
  ledgerMaintenance:'ledger:maintenance',
  ledgerRepair:'ledger:repair',
  ledgerMigrate:'ledger:migrate',
  noteInspect: 'note:inspect',
  noteAbandon: 'note:abandon',
  noteWrite: 'note:write',
  noteCreate: 'note:create',
  noteSaveCopyPreview: 'note:save-copy-preview',
  noteSaveCopyCommit: 'note:save-copy-commit',
  folderCreate: 'folder:create',
  relocationPreview: 'note:relocation-preview',
  relocationCommit: 'note:relocation-commit',
  noteTrashPreview: 'note:trash-preview',
  noteTrashCommit: 'note:trash-commit',
  noteRelocated: 'note:relocated',
  lifecycleFlushRequest: 'lifecycle:flush-request',
  lifecycleFlushDone: 'lifecycle:flush-done',
  lifecycleStatus: 'lifecycle:status',
  lifecycleRetry: 'lifecycle:retry',
  recoveryScan: 'lifecycle:recovery-scan',
  recoveryConfirm: 'lifecycle:recovery-confirm',
  recoveryAbandon: 'lifecycle:recovery-abandon',
  noteExternalChange: 'note:external-change',
  vaultLost: 'vault:lost',
  menuOpenVault: 'menu:open-vault',
  menuNewNote: 'menu:new-note',
  menuSave: 'menu:save',
  menuFetchWeb: 'menu:fetch-web',
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
  chromeTextGet: 'chrome-text:get',
  chromeTextSet: 'chrome-text:set',
  windowChromeSet: 'window:chrome',
  remoteImageGet: 'image:get',
  assistantGet: 'assistant:get',
  agentWriteConfirm: 'agent:write-confirm',
  agentWriteRequest: 'agent:write-request',
  skillsGet: 'skills:get',
  skillsSave: 'skills:save',
  skillsSetEnabled: 'skills:set-enabled',
  assistantSet: 'assistant:set',
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
  agentEvent: 'agent:event',
  networkStop: 'network:stop',
  networkPreview: 'network:preview',
  networkConfig: 'network:config',
  networkProviderSave: 'network:provider-save',
  networkProviderClear: 'network:provider-clear',
  networkHumanFetch: 'network:human-fetch',
  networkHumanSearch: 'network:human-search',
  networkHumanAbort: 'network:human-abort',
  networkEgressLog: 'network:egress-log',
  networkStats: 'network:stats',
  networkStatsClear: 'network:stats-clear',
  mcpConfig: 'mcp:config',
  mcpServerSave: 'mcp:server-save',
  mcpServerRemove: 'mcp:server-remove',
  mcpDiscover: 'mcp:discover',
  memoryChanged: 'memory:changed',
  memoryGet: 'memory:get',
  memoryConfigSave: 'memory:config-save',
  memoryManualPreview: 'memory:manual-preview',
  memoryPreviewCommit: 'memory:preview-commit',
  memoryItemEdit: 'memory:item-edit',
  memoryItemDisable: 'memory:item-disable',
  memoryItemForget: 'memory:item-forget',
  memoryRestorePreview: 'memory:restore-preview',
  memoryJobRetryPreview: 'memory:job-retry-preview',
  memoryJobCancel: 'memory:job-cancel'
} as const

export type { AssistantHabits } from './assistant.ts'
export type AssistantResult = { ok: true; habits: import('./assistant.ts').AssistantHabits } | { ok: false; error: string }
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
  /** 设备默认模型；在助手设置保存。null 表示尚未选择。 */
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
  /** 本场最终模型的内部记录 ID，不是供应商自报 modelId。 */
  modelRecordId: string
  expectedRevision: string
  relPath: string
  range: { start: number; end: number }
  expectedText: string
  promptText: string
}
/** 本场联网只读：默认不勾；勾选结果随预览摘要与 start 请求一起校验，防重放。
 *  远端只读 MCP 是同一张口令卡上的另一个独立勾选：`mcp` 默认不勾，与 `network` 互不影响。 */
export type AgentAuthorizationRequest = AgentCommandRequest & { references: string[]; network?: boolean; mcp?: boolean }
export type AuthorizedSource = ObjectBinding & { sourceId: string; relPath: string; title: string; revision: string; fingerprint: string; tier: 'reference' | 'follow' }
/** 一台可用的远端只读 MCP 服务器：只有名字、主机与白名单工具名。
 *  token、密文、schema 与服务器正文都不在这里。 */
export type AgentMcpServerView = { name: string; host: string; tools: string[] }
/** 本场 MCP 可用性：`available` 为假时不可勾选。
 *  `reason`：`off`＝有服务器但都没启用；`not-configured`＝启用了却缺 token／白名单；
 *  `too-many-tools`＝系统提示里的工具清单超过 4 KiB（本场不做截断，直接不可用）。 */
export type AgentMcpAvailability = {
  available: boolean
  servers: AgentMcpServerView[]
  reason?: 'off' | 'not-configured' | 'too-many-tools'
}
export type AgentAuthorizationPreview = {
  id: string; sessionId: string; origin: string; sources: AuthorizedSource[]
  recipient: { modelId: string; host: string; provider: ModelProvider }
  summaryGenerators?: {modelId:string;host:string;time:string}[]
  memory?: { use: boolean; consolidate: boolean; recipient: { modelId: string; host: string } | null; limits: import('./memory.ts').MemoryLimits;search?:{available:boolean;calls:number;sharedTools:number} }
  /** 本场技能只显示名称：正文、字数与展开都不给（合同取舍，可审证据在账本）。 */
  skills?: { id: string; name: string }[]
  /** 已启用但没加载的技能：名称与人话原因，便于人当场决定是否重来。 */
  skillsUnavailable?: { name: string | null; reason: import('./skills.ts').SkillUnavailableReason }[]
  /** 本场联网只读的可用性：`available` 管抓页（只依赖总闸与本场勾选），`search` 另要求
   *  预设搜索服务与密钥都可用；`reason` 只解释搜索为什么不可用，不含服务密钥。 */
  network?: { available: boolean; search: boolean; providerHost: string | null; reason?: 'off' | 'not-configured' }
  /** 本场远端只读 MCP：只有主进程判定可用时才给勾选；服务器与工具名只是白名单摘要。 */
  mcp?: AgentMcpAvailability
  /** 本场是否可能宣告删笔记：主进程已有删除实现时为 true（macOS）；Windows 仍关。渲染层不猜平台。 */
  deleteEnabled?: boolean
}
/** 写类工具的人确认：主进程发起请求，渲染层只回一个是否同意。
 *  建给「落点＋正文」；改名／挪给「旧路径 → 新路径＋影响面（引用与权限条数）」；删给路径。 */
export type AgentWritePreview =
  | { requestId: string; kind: 'create'; relPath: string; body: string }
  | { requestId: string; kind: 'rename' | 'move'; source: string; target: string; moves: number; linkChanges: number; permissionChanges: number }
  | { requestId: string; kind: 'delete'; relPath: string; hasAttachments: boolean }
export type AgentWriteDecision = { requestId: string; approved: boolean }

export type AgentAuthorizationResult = { ok: true; preview: AgentAuthorizationPreview } | { ok: false; error: string }
export type AgentStartRequest = AgentCommandRequest & { previewId: string; network?: boolean; mcp?: boolean }
export type AgentStartResult = { ok: true; id: string } | { ok: false; error: string }
export type AgentTaskView = { id: string; relPath: string; startedAt: number; activity?: string }
/** 预设搜索服务；同一时间只接一家，端点与主机写死在主进程。 */
export type NetworkProvider = 'brave' | 'tavily'
/** 渲染层只能看到「开没开、用哪家、有没有密钥」；密文与明文密钥都不出主进程。 */
export type NetworkConfigView = { enabled: boolean; provider: NetworkProvider | null; hasKey: boolean }
/** 总开关的写入请求（`network:config` 不带参数时只读）。 */
export type NetworkConfigSetRequest = { enabled: boolean }
export type NetworkProviderSaveRequest = { provider: NetworkProvider; key: string }
export type NetworkConfigResult = { ok: true; config: NetworkConfigView } | { ok: false; error: string }

/** 人发起抓页：只发人输入的 URL；渲染层拿不到凭据，也不带笔记正文。 */
export type HumanFetchRequest = { url: string; requestId?: string }
/** 人发起搜索：只发人输入的查询；maxResults 由主进程夹在 1–10。 */
export type HumanSearchRequest = { query: string; maxResults?: number; requestId?: string }
/** 停止一次人发起的在途抓页／搜索（requestId 由渲染层生成并随请求带上）。 */
export type HumanAbortRequest = { requestId: string }
/** 抓页结果：正文只回渲染层显示／插入，不进日志；审计写盘失败时如实标 `degraded`。 */
export type HumanFetchResult =
  | {
    ok: true
    url: string
    host: string
    title?: string
    text: string
    bytes: number
    truncated: boolean
    fetchedAt: string
    degraded?: 'log-failed'
  }
  | { ok: false; error: string }
export type HumanSearchResult =
  | {
    ok: true
    provider: NetworkProvider
    host: string
    results: { title: string; url: string; snippet: string }[]
    truncated?: boolean
    degraded?: 'log-failed'
  }
  | { ok: false; error: string }

/** 人发起外发日志的一条：只有时间／类型／主机／字节／条数／结果码，永不含 URL、查询、正文或凭据。 */
export type EgressLogEntry = {
  at: string
  action: 'fetch' | 'search'
  host: string
  bytes?: number
  count?: number
  outcome: 'ok' | 'refused'
  code?: string
}
export type EgressLogRequest = { limit?: number }
export type EgressLogView = { entries: EgressLogEntry[]; skipped: number }
export type EgressLogResult = { ok: true; view: EgressLogView } | { ok: false; error: string }

/** 设备级外发统计的五个口子；MCP 尚未启用，但形状先留位（计数恒为 0）。 */
export type NetworkStatKind = 'fetch' | 'search' | 'mcp' | 'humanFetch' | 'humanSearch'
/** 每个口子只存成功／拒绝次数与抓页字节数；不存 URL、查询、正文或凭据。 */
export type NetworkStatsCounts = { ok: number; refused: number; bytes: number }
/** 设置卡只读快照：`corrupt` 为真表示磁盘文件读不出来，已按「保留原文件」处理。 */
export type NetworkStatsView = {
  version: 1
  kinds: Record<NetworkStatKind, NetworkStatsCounts>
  lastOkAt?: string
  lastCodes: { code: string; at: string }[]
  corrupt?: true
}
export type NetworkStatsResult = { ok: true; stats: NetworkStatsView } | { ok: false; error: string }
/** 清空统计同时清外发日志；两步都成功后才是 `{ ok: true }`。 */
export type NetworkStatsClearResult = { ok: true } | { ok: false; error: string }

/** 远端只读 MCP 的工具摘要：只回名字、标题与说明，schema 与服务器文本不出主进程。 */
export type McpPublicTool = { name: string; title?: string; description?: string }
/** 渲染层可见的一台服务器：永不含 token 或密文，只告诉人「有没有 token」。 */
export type McpPublicServer = {
  id: string
  name: string
  url: string
  host: string
  enabled: boolean
  hasToken: boolean
  tools: McpPublicTool[]
  whitelist: string[]
}
export type McpConfigView = { servers: McpPublicServer[] }
export type McpConfigResult = { ok: true; config: McpConfigView } | { ok: false; error: string }
/** 保存一台服务器；省略 id 是新增，省略 token 是保留原 token。
 *  `whitelist` 只由设置卡在已发现工具上勾选后回传（白名单必须 ⊆ 已发现工具）。 */
export type McpServerSaveRequest = {
  id?: string
  name: string
  url: string
  token?: string
  enabled: boolean
  whitelist?: string[]
}
export type McpServerRemoveRequest = { id: string }
export type McpDiscoverRequest = { id: string }
/** 发现结果只含 name／title／description；`config` 是保存后的新摘要（白名单可能被收窄）。 */
export type McpDiscoverResult =
  | { ok: true; id: string; tools: McpPublicTool[]; config: McpConfigView }
  | { ok: false; error: string }
/** 网络事件只带主机与去查询串的路径，不带正文、密钥或查询参数。
 *  MCP 事件另带服务器名与工具名（都来自本场白名单），不带参数与结果。 */
export type AgentNetworkEvent = {
  taskId: string
  /** 成功抓页或成功的 MCP 调用且存了预览时才有；搜索不存预览，因此没有 id。 */
  id?: string
  kind: 'fetch' | 'search' | 'mcp'
  /** 仅抓页：本任务已有同一 URL 的成功结果，本次直接返回缓存、没有再次外发。 */
  reused?: true
  host: string
  path: string
  provider?: NetworkProvider
  bytes?: number
  truncated?: boolean
  /** 仅搜索成功：本次结果条数（1–10）。 */
  count?: number
  /** 仅 MCP：服务器名与工具名。 */
  server?: string
  tool?: string
  /** 仅 MCP：工具层返回了错误结果（调用本身成功，账本仍记 ok）。 */
  toolError?: true
  /** 本次尝试的结局；旧事件没有该字段时按成功处理。 */
  outcome?: 'ok' | 'refused'
  /** 拒绝码（如 `EGRESS_INVALID_URL`／`NETWORK_NOT_AUTHORIZED`／`MCP_*`）；成功时没有。 */
  code?: string
  at: string
}
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
  network?: AgentNetworkEvent
}

/** 只读预览：按任务与预览 id 取回抓到或 MCP 拿到的纯文本（包裹前的原文）。
 *  `kind` 缺省按抓页处理（旧条目）；MCP 条目带 `server`／`tool`，`url` 是占位来源。 */
export type NetworkPreviewRequest = { taskId: string; id: string }
export type NetworkPreviewView = {
  id: string
  url: string
  host: string
  title?: string
  text: string
  bytes: number
  truncated: boolean
  fetchedAt: string
  lowTrust: true
  /** 预览来源：缺省按抓页（`fetch`）处理，`mcp` 时标题与提示按工具结果调整。 */
  kind?: 'fetch' | 'mcp'
  /** 仅 MCP：服务器名与工具名（都来自本场白名单）。 */
  server?: string
  tool?: string
}
export type NetworkPreviewResult = { ok: true; preview: NetworkPreviewView } | { ok: false; error: string }

export type ImageContext = {
  noteRelPath: string
  region: 'body' | 'ledger'
  ledgerTaskId?:string
  ledgerRevision?:number
  ledgerField?:'prompt'|'answer'
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
export type { ChromeTextPreference } from './reading-preference.ts'
export type ChromeTextSetResult = { ok: true; preference: import('./reading-preference.ts').ChromeTextPreference } | { ok: false; error: 'BAD_CHROME_TEXT' | 'IO_ERROR' }

export type VaultState = (
  | { status: 'needs-pick'; reason: 'first-run' | 'missing'; sessionId?: string | null; cancelled?: boolean; diagnostic?: string }
  | { status: 'ready'; rootName: string; vaultChanged?: boolean; sessionId?: string; navigationKey?: string; legacyNavigationKey?:string; diagnostic?: string; vaultId?: string; cancelled?: boolean }
) & { restoreId?: string; protectedSessionId?:string }

export type TreeEntry = {
  name: string
  relPath: string
  kind: 'dir' | 'note' | 'file'
  tier?: 'follow' | 'forbidden'
  /** Companion owner resolved by the native library service; display metadata only. */
  attachmentOf?: string
  /** 外部消失但尚未核验恢复；显示标记，不是授权。 */
  recovery?: boolean
  children?: TreeEntry[]
}

export type PermissionTier = 'reference' | 'follow' | 'forbidden'
export type PermissionEntry = { relPath: string; tier: PermissionTier }
export type PermissionState =
  | { status: 'ready'; entries: PermissionEntry[] }
  | { status: 'invalid'; error: string }
export type SetPermissionRequest = { relPath: string; tier: PermissionTier }

export type NoteSnapshot = { content: string; revision: string; objectVersion: string; sessionId: string; ledger?:{status:'verified'|'unregistered'|'unmigrated'|'invalid';reason?:string;next:'none'|'migrate'|'repair'} }
export type SaveCopyPreviewRequest = ObjectBinding & {
  sourceSessionId?: string
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
export type EntryCreateRequest = { name: string; parent: string; sessionId?: string }
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
export type TrashPreviewRequest = { relPath: string }
export type TrashCommitRequest = { id: string; allow: boolean }
export type TrashPreviewView = {
  id: string
  sessionId: string
  relPath: string
  title: string
  hasAttachments: boolean
}
export type TrashPreviewResult = { ok: true; preview: TrashPreviewView } | { ok: false; error: string }
/** 落点核验：`unverified` 只表示系统没给可核对的收据，不是删除失败。 */
export type TrashLandingVerdict = 'verified' | 'unverified'
/** 附件夹第二步失败的两类：预览后已不在（missing）／其它失败（failed）。 */
export type TrashOrphanReason = 'attachment-missing' | 'attachment-failed'
/** 删除已发生但记录没写全时如实带出，不把降级说成完整成功。 */
export type TrashDegradedReason = 'record-limit' | 'record-failed' | 'ledger-failed'
export type TrashCommitResult =
  | { ok: true; cancelled: true }
  | {
    ok: true
    cancelled: false
    relPath: string
    landing: string
    landingVerified: TrashLandingVerdict
    attachmentLanding: string | null
    orphan: boolean
    orphanReason?: TrashOrphanReason
    degraded: TrashDegradedReason[]
  }
  /** 落点核验失败时带出系统实际给出的落点（可能不是原对象），供人找回或核对。 */
  | { ok: false; error: string; landing?: string }
export type RelocationEvent = { moved: { from: string; to: string }[]; sessionId?: string }
export type LifecycleReason = 'journal-invalid' | 'journal-unreadable' | 'object-changed' | 'policy-changed' | 'recovery-required'
export type LifecycleStatus = {
  sessionId: string
  status: 'ready' | 'pending' | 'invalid'
  revision: string | null
  operation?: { kind: 'note' | 'folder' | 'ledger-repair'; source: string; target: string }
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

export type NoteInspectRequest = ObjectBinding & { relPath: string; sourceSessionId?:string }
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
  error: 'CONFLICT' | 'BAD_PATH' | 'NO_VAULT' | 'NOTE_BUSY' | 'IO_ERROR' | 'NOTE_MISSING' | 'NOTE_REPLACED' | 'NOTE_UNREADABLE' | 'VAULT_CHANGED' | 'LEDGER_BOUNDARY_INVALID' | 'LIFECYCLE_RECOVERY_REQUIRED'
}

/** 外部消失与恢复核验：只有全部分支判据通过才 `restored`；其余分支如实上报并保持失效。 */
export type RecoveryVerdict =
  | 'restored' | 'still-missing' | 'object-replaced' | 'content-changed'
  | 'attachments-missing' | 'attachments-changed' | 'permission-denied' | 'permission-changed'
  | 'permission-unreadable' | 'ledger-unverified'
export type RecoveryRow = { relPath: string; verdict: RecoveryVerdict; message: string; canRestore: boolean; canAbandon: boolean }
export type RecoveryScanView = { sessionId: string; rows: RecoveryRow[] }
export type RecoveryScanRequest = { sessionId: string }
export type RecoveryScanResult = { ok: true; value: RecoveryScanView } | { ok: false; error: string }
export type RecoveryConfirmRequest = { sessionId: string; relPath: string }
export type RecoveryConfirmResult = { ok: true; verdict: RecoveryVerdict; restored: boolean; message: string } | { ok: false; error: string }
/** 「放弃恢复」是确认结果，不是扫描行：`abandoned` 不进 `RecoveryVerdict`。 */
export type RecoveryAbandonRequest = { sessionId: string; relPath: string }
export type RecoveryAbandonResult =
  | { ok: true; verdict: 'abandoned'; cleared: true; degraded?: 'ledger-failed' }
  | { ok: false; error: string }

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
