import { createHash } from 'node:crypto'
import type { LifecycleFlushPhase, RecoveryFlushContext } from '../shared/flush.ts'
import { parseLedgerRepairRequest } from '../shared/ledger.ts'
import { listVaultTree, parseStoredVault } from './notes-fs.ts'
import { partitionSource } from '../markdown/partition.ts'
import { boundArguments, isVaultChannel, isVaultEvent } from '../shared/vault-binding.ts'
import { VaultCatalog, sameRootInode } from './vault-catalog.ts'
import { VaultSwitch } from './vault-switch.ts'
import { parseVaultRestoreReceipt, parseVaultCatalogChange, type VaultTarget } from '../shared/vault-management.ts'
import { readFileSync } from 'node:fs'
import {memoryDependency,sameMemoryDependency,memorySnapshotSignature} from './memory-use.ts'
import {historicalContextPolicy} from './ledger-provenance.ts'
import {WorkingMemoryService} from './working-memory-service.ts'
import {readQualityEvidence} from './memory-quality-status.ts'
import {WorkingMemoryConsolidation} from './working-memory-consolidation.ts'
import {MEMORY_PRODUCTION_STRATEGY} from '../shared/memory.ts'
import {memoryAuthorizationState as configuredMemoryAuthorizationState} from './model-config.ts'
import {ReasoningStore} from './reasoning-store.ts'
import {SummaryCache,summaryHash} from './summary-cache.ts'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, safeStorage, shell } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CloseFlow, timeoutAction, type CloseAction, type CloseDecision } from '../shared/flush.ts'
import { asString, parseEntryCreateRequest, parseFlushDone, parseLifecycleRetryRequest, parseNoteName, parseNoteWriteRequest, parseRelocationCommitRequest, parseRelocationPreviewRequest, parseSetPermissionRequest, parseTrashCommitRequest, parseTrashPreviewRequest } from '../shared/ipc-guard.ts'
import { applyWorkspaceWindowChrome } from './window-chrome.ts'
import { IPC, type VaultState } from '../shared/ipc.ts'
import type { ChromeTextSetResult } from '../shared/ipc.ts'
import { loadChromeTextPreference, saveChromeTextPreference } from './theme-preference.ts'
import { isChromeTextPreference } from '../shared/reading-preference.ts'
import type { AssistantResult, AgentStartRequest, AgentStartResult, LifecycleRetryResult, LimitTier, RelocationPreviewRequest, RelocationPreviewView, ModelAddRequest, ModelConfigResult, ModelDefaultSetRequest, ModelKeyDeleteRequest, ModelLimitsSetRequest, ModelListRequest, ModelListResult, ModelProviderRemoveRequest, ModelProviderSaveRequest, ModelRemoveRequest, ModelUpdateRequest, ReadingPreference, ReadingSetResult, RelocationCommitResult, RelocationPreviewResult, ThemeMode, ThemeSetResult, TrashCommitResult, TrashPreviewResult, TrashPreviewView } from '../shared/ipc.ts'
import type { RemoteImageGetResult } from '../shared/ipc.ts'
import type { NetworkPreviewRequest, NetworkPreviewResult } from '../shared/ipc.ts'
import type { DeepSeekKeySource, FetchService, NetworkConfigResult, NetworkConfigSetRequest, NetworkProvider, NetworkProviderClearRequest, NetworkProviderSaveRequest } from '../shared/ipc.ts'
import type { AgentMcpAvailability, AgentMcpServerView, McpConfigResult, McpConfigView, McpDiscoverResult, McpPublicTool, McpServerSaveRequest } from '../shared/ipc.ts'
import type { EgressLogResult, HumanFetchResult, HumanSearchResult, NativeSearchProbeResult, NetworkStatKind, NetworkStatsClearResult, NetworkStatsResult } from '../shared/ipc.ts'
import { createEgressLog, type EgressLog } from './egress-log.ts'
import { createHumanNetwork, applyHumanNetworkGate, type HumanNetwork } from './human-network.ts'
import { createNetworkStats, flushNetworkStats, networkErrorCode, networkFailureCode, type NetworkStatEvent, type NetworkStats } from './network-stats.ts'
import { isThemeMode, loadReadingPreference, loadThemePreference, saveReadingPreference, saveThemePreference } from './theme-preference.ts'
import { loadAssistantHabits, saveAssistantHabits } from './assistant-preference.ts'
import { createSkillsStore } from './skills-store.ts'
import { corruptSkillsView, freezeSkills, resolveSkills } from './skills.ts'
import { skillFieldsReason, skillId } from '../shared/skills.ts'
import { isReadingPreference } from '../shared/reading-preference.ts'
import { isAssistantHabits } from '../shared/assistant.ts'
import { attachVaultProtocol } from './vault-protocol.ts'
import { verifyImageSource } from './image-source.ts'
import { RemoteImageService, REMOTE_IMAGE_SCHEME, remoteImageUrl } from './remote-image.ts'
import { attachRemoteImageProtocol } from './remote-image-protocol.ts'
import { VAULT_MEDIA_SCHEME } from '../shared/vault-rel.ts'
import { VaultSession } from './vault.ts'
import { fetchModelList } from './model-list.ts'
import { createModelConfigStore, type ModelConfigStore } from './model-config.ts'
import { createNetworkConfigStore, type NetworkConfigStore, type NetworkCredential } from './network-config.ts'
import { createMcpConfigStore, type McpConfigStore, type McpRuntimeServer } from './mcp-config.ts'
import { createMcpClient, type McpClient } from './mcp-client.ts'
import { createSearchProvider, SEARCH_PROVIDERS } from './search.ts'
import { fetchText } from './text-fetch.ts'
import { fetchViaDeepSeek, resolveFetchRoute } from './deepseek-fetch.ts'
import { TaskAuthorizationRegistry, isAuthorizationCommand } from './task-authorization.ts'
import { HUMAN_TRASH_ON_THIS_PLATFORM } from '../shared/human-trash.ts'
import { createScopedAgentTools, mcpToolCatalog, MCP_CATALOG_BYTES } from './scoped-agent-tools.ts'
import { createMemoryIpc } from './memory-ipc.ts'

import { PreflightStore } from './diagnostic-store.ts'
import { makeTaskFailure } from '../shared/task-failure.ts'
import { AgentHost } from './agent-host.ts'
import { modelTierFor } from './permissions.ts'
import { streamModelText, streamModelStep } from './model-stream.ts'
import { probeNativeSearch, streamNativeSearchStep, supportsNativeSearch } from './native-search.ts'
import { VaultStructureGate } from './vault-mutation-queue.ts'
import { isTrustedIpcSender } from './ipc-sender.ts'

protocol.registerSchemesAsPrivileged([
  { scheme: VAULT_MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: REMOTE_IMAGE_SCHEME, privileges: { standard: true, secure: true } }
])

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererDevelopmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const rendererEntryUrl = rendererDevelopmentUrl ? new URL(rendererDevelopmentUrl).href
  : pathToFileURL(path.join(here, '../renderer/index.html')).href

/** 退出前给渲染进程留的写盘窗口。渲染进程没回应也不能把它卡死在这里。 */
const FLUSH_GRACE_MS = 1000

let vaultSwitch: import('./vault-switch.ts').VaultSwitch<import('../shared/vault-management.ts').VaultTarget, VaultState> | null = null
let vaultCatalog: VaultCatalog | null = null
let activeTarget: VaultTarget | null = null
let rootRecoveryIntent:{previewId:string;caller:string;sessionId:string|null;assertOwner:()=>void}|null=null
let rootRecoveryHold:RecoveryFlushContext|null=null
let protectedRootCaller:string|null=null
let startupVaultState: Extract<VaultState, {status:'needs-pick'}> | null = null
let mainWindow: BrowserWindow | null = null
let vault: VaultSession | null = null
let quitting = false
let flushed = false
let rendererGone = false
let closeFlow = new CloseFlow()
let flushTimer: NodeJS.Timeout | null = null
let themeMode: ThemeMode = 'system'
let remoteImages: RemoteImageService | null = null
let modelConfig: ModelConfigStore | null = null
let modelConfigError: string | null = null
let networkConfig: NetworkConfigStore | null = null
/** 远端只读 MCP 的设备级配置：token 只在这里解密，渲染层只拿摘要。 */
let mcpConfig: McpConfigStore | null = null
/** 人发起外发的两条设备级设施：审计日志与抓页／搜索门面。 */
let egressLog: EgressLog | null = null
let humanNetwork: HumanNetwork | null = null
/** 设备级外发统计：只记次数／字节／拒绝码，记录失败不影响外发本身。 */
let networkStats: NetworkStats | null = null
let agentHost: AgentHost | null = null
/** 联网搜索与抓取的可用性：抓页只依赖总闸；搜索另要求当前搜索服务与该家凭据可用；
 *  模型自带联网只要求总闸与「联网」页的选择（探测在启用时完成）。
 *  配置保存后立即生效：这里按需读文件、不缓存，下一次判定自然看到新值。 */
function networkAvailability(): { available: boolean; search: boolean; providerHost: string | null; native: boolean; reason?: 'off' | 'not-configured' } {
  try {
    const config = networkConfig?.getPublic()
    if (!config || !config.enabled) return { available: false, search: false, providerHost: null, native: false, reason: 'off' }
    const native = config.nativeSearch.minimax === true
    // 抓页不需要服务商：总闸开着就可抓。搜索服务或密钥没配好（含密文解不开）只关搜索。
    const provider = config.searchProvider
    if (!provider) return { available: true, search: false, providerHost: null, native, reason: 'not-configured' }
    const credential = networkSearchCredential()
    if (!credential) return { available: true, search: false, providerHost: null, native, reason: 'not-configured' }
    return { available: true, search: true, providerHost: SEARCH_PROVIDERS[provider].host, native }
  } catch { return { available: false, search: false, providerHost: null, native: false, reason: 'off' } }
}

/** 搜索凭据：DeepSeek 允许复用模型页的密钥；其余按联网配置里的独立密钥。 */
function networkSearchCredential(): NetworkCredential | null {
  try {
    const config = networkConfig?.getPublic()
    if (!config?.searchProvider) return null
    if (config.searchProvider === 'deepseek' && config.deepseekKeySource === 'model') {
      try {
        const secret = modelConfig?.providerSecret('deepseek')
        return secret?.apiKey ? { provider: 'deepseek', key: secret.apiKey } : null
      } catch { return null }
    }
    return networkConfig!.credential(config.searchProvider)
  } catch { return null }
}

/** 统计写失败不能影响外发：错误码规范化与写入都包在这里，模块自己也兜一层。 */
function recordNetworkStat(kind: NetworkStatKind, event: NetworkStatEvent): void {
  try { networkStats?.record(kind, event) } catch { /* stats are best effort */ }
}

/**
 * 远端只读 MCP 的可用性：只有「已启用 + 白名单非空 + 凭据能解密」的服务器才算可用
 * （`availability()` 只看有没有密文，解不开的不能算）。系统提示里的工具清单只含白名单工具，
 * 序列化超过 4 KiB 就整场不可用（`too-many-tools`），不截断清单。
 * 配置保存后立即生效：这里按需读文件、不缓存，下一次判定自然看到新值。
 */
function mcpAvailability(): AgentMcpAvailability & { catalog?: string } {
  const store = mcpConfig
  if (!store) return { available: false, servers: [], reason: 'not-configured' }
  let servers: McpRuntimeServer[]
  try { servers = store.servers() } catch { return { available: false, servers: [], reason: 'not-configured' } }
  // `availability()` 只按「有密文」判定；授权前必须再确认凭据真能解密，解不开的服务器不算可用。
  const decryptable = (id: string): boolean => {
    try { return store.credential(id) !== null } catch { return false }
  }
  // 搜索类 MCP 与内置搜索共用同一个设备闸；非搜索类只受启用＋白名单约束。
  const gateOpen = (() => { try { return networkConfig?.enabled() === true } catch { return false } })()
  const usable = servers.filter(server => server.enabled && server.whitelist.length > 0 && decryptable(server.id) && (!server.searchChannel || gateOpen))
  // 授权只带名字／主机／工具名，没有服务器 id：同名两台无法在调用时证明目标，
  // 所以一律不计入可用集合（fail closed），绝不按「第一台」猜。
  const nameCounts = new Map<string, number>()
  for (const server of usable) nameCounts.set(server.name, (nameCounts.get(server.name) ?? 0) + 1)
  const unambiguous = usable.filter(server => nameCounts.get(server.name) === 1)
  const views: AgentMcpServerView[] = unambiguous.map(server => ({ name: server.name, host: server.host, tools: [...server.whitelist], searchChannel: server.searchChannel }))
  if (!unambiguous.length) {
    // 一台都没配 → not-configured；配了但都没启用 → off；启用了却缺 token／白名单／重名 → not-configured。
    const anyEnabled = servers.some(server => server.enabled)
    return { available: false, servers: views, reason: servers.length === 0 || anyEnabled ? 'not-configured' : 'off' }
  }
  const catalog = mcpToolCatalog(unambiguous.map(server => ({
    name: server.name,
    host: server.host,
    // 清单只列白名单工具：服务器自报的只读标注不作数。
    tools: server.whitelist.map(name => {
      const tool = server.tools.find(item => item.name === name)
      return { name, ...(tool?.description ? { description: tool.description } : {}), ...(tool?.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}) }
    })
  })))
  if (Buffer.byteLength(catalog, 'utf8') > MCP_CATALOG_BYTES) return { available: false, servers: views, reason: 'too-many-tools' }
  return { available: true, servers: views, catalog }
}

/** 一台 MCP 服务器在一个任务里的连接：`ready` 是唯一一次 connect，失败即从缓存删除。 */
type McpClientSlot = { serverId: string; client: McpClient; ready: Promise<McpClient> }
/** 每任务每服务器一条连接（`<taskId>|<server>`），惰性建连、按任务关闭。 */
const mcpClients = new Map<string, McpClientSlot>()

/** 合同里的 MCP 运行期错误码：只有这些码交给宿主，其余异常折成连接失败。 */
const MCP_CALL_CODES: ReadonlySet<string> = new Set([
  'MCP_INVALID_URL', 'MCP_CONNECT_FAILED', 'MCP_UNAUTHORIZED', 'MCP_PROTOCOL',
  'MCP_TOOL_UNKNOWN', 'MCP_TOOL_FAILED', 'MCP_TIMEOUT', 'MCP_TOO_LARGE', 'MCP_CANCELLED'
])

/** 统计用的码：已知 MCP 码原样；其它异常沿用出口核心的归一（取消／不可用）。 */
function mcpFailureCode(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return 'MCP_CANCELLED'
  const message = error instanceof Error ? error.message : ''
  return MCP_CALL_CODES.has(message) ? message : networkFailureCode(error, signal)
}

/** 交给宿主的码只允许合同里的 `MCP_*`；统计可以更宽。 */
function mcpCallErrorCode(code: string): string {
  return code.startsWith('MCP_') ? code : 'MCP_CONNECT_FAILED'
}

/**
 * 调用本场白名单里的一个 MCP 工具：按 `${taskId}|${server}` 惰性建连（一次）并缓存，
 * 后续调用复用同一连接；任务结束／取消／切库由 `closeMcpTask` 关闭并删除。
 * 失败只回固定码，服务器错误文本与 token 都不出主进程。
 */
async function mcpCall(input: { taskId: string; server: string; tool: string; arguments: Record<string, unknown>; signal: AbortSignal }): Promise<{ text: string; bytes: number; isError: boolean; truncated?: boolean }> {
  const { taskId, server, tool, signal } = input
  try {
    if (!mcpConfig) throw Error('MCP_CONFIG_UNAVAILABLE')
    let servers: McpRuntimeServer[]
    try { servers = mcpConfig.servers() } catch { throw Error('MCP_CONFIG_UNAVAILABLE') }
    // 同名多台无法确定目标：fail closed，不猜要连哪一台。
    const targets = servers.filter(entry => entry.name === server && entry.enabled && entry.whitelist.includes(tool))
    if (targets.length !== 1) throw Error('MCP_TOOL_UNKNOWN')
    const target = targets[0]!
    const credential = mcpConfig.credential(target.id)
    if (!credential) throw Error('MCP_UNAUTHORIZED')
    const key = `${taskId}|${server}`
    let slot = mcpClients.get(key)
    // 换了端点（同一任务同名服务器被改）：旧连接不再适用，关掉重建。
    if (slot && slot.serverId !== target.id) {
      mcpClients.delete(key)
      try { slot.client.close() } catch { /* 旧连接关闭失败不影响新连接 */ }
      slot = undefined
    }
    if (!slot) {
      const client = createMcpClient({ url: credential.url, token: credential.token })
      const ready = (async () => { await client.connect(signal); return client })()
      const created: McpClientSlot = { serverId: target.id, client, ready }
      mcpClients.set(key, created)
      // 建连失败不留缓存：下一次调用重新连一次，而不是一直复用坏连接。
      ready.catch(() => { if (mcpClients.get(key) === created) mcpClients.delete(key) })
      slot = created
    }
    const client = await slot.ready
    const result = await client.call(tool, input.arguments, signal)
    if (signal.aborted) throw Error('MCP_CANCELLED')
    recordNetworkStat('mcp', { outcome: 'ok', bytes: result.bytes })
    return result
  } catch (error) {
    // 配置不可用不是合同里的 MCP 运行期码：按连接失败上报（配置坏了也连不上）。
    const code = error instanceof Error && error.message === 'MCP_CONFIG_UNAVAILABLE'
      ? 'MCP_CONNECT_FAILED'
      : mcpFailureCode(error, signal)
    recordNetworkStat('mcp', { outcome: 'refused', code })
    throw Error(mcpCallErrorCode(code))
  }
}

/** 关闭某个任务的全部 MCP 会话并删除缓存；未知任务 id 是空操作。 */
function closeMcpTask(taskId: string): void {
  const prefix = `${taskId}|`
  for (const [key, slot] of [...mcpClients]) {
    if (!key.startsWith(prefix)) continue
    mcpClients.delete(key)
    try { slot.client.close() } catch { /* 关闭失败不影响已保存的回答 */ }
  }
}
const HUMAN_LIMITS = { maxUrl: 2048, maxQuery: 256, maxResults: 10, maxLogLimit: 50 } as const
/** 人点「连接并列出工具」的单次外发预算；与 MCP 传输的单次 20s 上限一致。 */
const MCP_DISCOVER_TIMEOUT_MS = 20_000
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/u
/** 停止标识只接受字母数字与 `-`／`_`；缺省表示这次请求不提供单独停止入口。 */
function humanRequestId(value: unknown): string | undefined | 'BAD_REQUEST' {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) return 'BAD_REQUEST'
  return value
}
/** 入参只接受合同字段；多给、少给或越界都按 `BAD_REQUEST`，不猜调用方意图。 */
function humanFetchArguments(value: unknown): { url: string; requestId?: string } | 'BAD_REQUEST' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'BAD_REQUEST'
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'url' && key !== 'requestId')) return 'BAD_REQUEST'
  if (typeof record.url !== 'string') return 'BAD_REQUEST'
  const requestId = humanRequestId(record.requestId)
  if (requestId === 'BAD_REQUEST') return 'BAD_REQUEST'
  const url = record.url.trim()
  if (!url || url.length > HUMAN_LIMITS.maxUrl || CONTROL_CHARS.test(url)) return 'BAD_REQUEST'
  return { url, ...(requestId ? { requestId } : {}) }
}
function humanSearchArguments(value: unknown): { query: string; maxResults?: number; requestId?: string } | 'BAD_REQUEST' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'BAD_REQUEST'
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'query' && key !== 'maxResults' && key !== 'requestId')) return 'BAD_REQUEST'
  if (typeof record.query !== 'string') return 'BAD_REQUEST'
  const requestId = humanRequestId(record.requestId)
  if (requestId === 'BAD_REQUEST') return 'BAD_REQUEST'
  const query = record.query.trim()
  if (!query || query.length > HUMAN_LIMITS.maxQuery || CONTROL_CHARS.test(query)) return 'BAD_REQUEST'
  if (record.maxResults !== undefined) {
    const maxResults = record.maxResults
    if (!Number.isSafeInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > HUMAN_LIMITS.maxResults) return 'BAD_REQUEST'
    return { query, maxResults: maxResults as number, ...(requestId ? { requestId } : {}) }
  }
  return { query, ...(requestId ? { requestId } : {}) }
}
function egressLogLimit(value: unknown): number | undefined | 'BAD_REQUEST' {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'BAD_REQUEST'
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'limit')) return 'BAD_REQUEST'
  if (record.limit === undefined) return undefined
  const limit = record.limit
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > HUMAN_LIMITS.maxLogLimit) return 'BAD_REQUEST'
  return limit as number
}

let authorizations: TaskAuthorizationRegistry | null = null
let consolidation:WorkingMemoryConsolidation|null=null
let summaryCache:SummaryCache|null=null
let reasoningStore:ReasoningStore|null=null
function workingService(){return vault?new WorkingMemoryService(vault,()=>modelConfig,(binding)=>readQualityEvidence(app.getPath('userData'),binding)):null}
const memoryIpc = createMemoryIpc({
  vault: () => vault, config: () => modelConfig, service: () => workingService(),
  engine:()=>consolidation,
  invalidate:()=>{consolidation?.cancel();summaryCache?.invalidateAll()},
  recheck: async (current, session) => {
    current.assertSession(session)
    await Promise.all([current.root ? agentHost?.recheckSources(current.root, session) : undefined])
    current.assertSession(session)
  }
})
let cancellingForClose = false
/** 预览时冻结的那一份技能集合随预览一起留存：启动只许发这一份，不再回存储重算。
 *  只留签名不够——亚秒级 A→B→A 双编辑能让启动路径读到 B 的正文、而两端的签名都还是 A。 */
const memoryAuthorizationPreviews = new Map<string, { sessionId: string; signature: string;search:boolean;skills:import('./skills.ts').FrozenSkills }>()
const maintenancePreviews=new Map<string,{sessionId:string;objectVersion:string;relPath:string;action:'compress'|'clear';records:{taskId:string;revision:number}[];archive?:{revision:string;bytes:number}}>()
/** 本库启用的技能：每次从磁盘现读，读不出就按「技能库损坏」冻结——绝不当成「没有技能」。
 *  任务启动时取一次，运行中编辑只影响下一场。 */
function currentSkills(): import('./skills.ts').FrozenSkills {
  // 没有活动库时技能无从启用：按「本场无技能」冻结，而不是抛裸 TypeError 让预览报未知错误。
  if (!vault) return freezeSkills({ state: 'ready', skills: [], ignored: 0 }, null)
  const key = vault.memoryContext().vaultKey
  const store = createSkillsStore(app.getPath('userData'))
  try { return freezeSkills(resolveSkills(store.get(), key), store.diagnosis().revision) }
  catch { return freezeSkills(corruptSkillsView(), store.diagnosis().revision) }
}

function memoryAuthorizationState(sessionId: string) {
  vault?.assertSession(sessionId)
  if (!vault || !modelConfig) return { signature: 'unavailable', disclosure: undefined }
  try{if(!modelConfig)throw Error();return configuredMemoryAuthorizationState(modelConfig,vault!.memoryContext().vaultKey)}catch{return {signature:'memory-v2-unavailable',disclosure:undefined}}
}
const imageControllers = new Map<AbortController, {vault: VaultSession; binding: string; request: import('../shared/ipc.ts').RemoteImageGetRequest}>()
const lifecycleFlushes = new Map<string, (ok: boolean,heldObjects?:Array<{relPath:string;objectVersion:string}>) => void>()
let rootHeldObjects:Array<{relPath:string;objectVersion:string}>|null=null
const structureGate = new VaultStructureGate()
const lifecycleErrorCodes = new Set(['BAD_PATH', 'BAD_REQUEST', 'NO_VAULT', 'VAULT_CHANGED', 'STALE_PREVIEW',
  'STALE_RECOVERY', 'EEXIST', 'ENOENT', 'PATH_CHANGED', 'UNSAFE_PATH', 'PERMISSION_DOWNGRADE',
  'PERMISSION_COLLISION', 'PERMISSIONS_INVALID', 'UNSAVED_DRAFT', 'PREVIOUS_TASK_UNSAVED',
  'LIFECYCLE_RECOVERY_REQUIRED', 'STRUCTURE_BUSY', 'OTHER_TASK_RUNNING', 'ATTACHMENT_COLLISION', 'LINK_SCAN_FAILED',
  'PLATFORM_UNPROVEN', 'PATH_RESERVED', 'TRASH_INCOMPLETE', 'TRASH_CONFLICT', 'LANDING_MISMATCH'])

function visibleVaultState(): VaultState {
  const state = startupVaultState && !vault?.root ? {...startupVaultState} : vault?.currentState() ?? {status:'needs-pick' as const,reason:'first-run' as const}
  if (state.status === 'needs-pick' && !state.diagnostic && vaultCatalog?.view().diagnostic) state.diagnostic = '设备库目录记录无法读取。原记录已保留，请检查本机存储；仍可手动打开笔记库。'
  if (state.status === 'ready' && activeTarget && vault?.root === activeTarget.path) {
    const entry = vaultCatalog?.view().entries.find(e=>e.rootIdentity===activeTarget!.rootIdentity && e.path===activeTarget!.path)
    state.rootName = entry?.label ?? activeTarget.label
    state.vaultId = entry?.id
    if(entry){const keys=vaultCatalog!.displayKeys({...activeTarget,id:entry.id});state.navigationKey=keys.key;state.legacyNavigationKey=keys.legacy}
  }
  const held=vault?.protectedSession();if(held&&held!==vault?.sessionId())state.protectedSessionId=held
  // A temporarily inaccessible root retains its mount for draft recovery.
  // Availability must not be interpreted as an authoritative unmount.
  return state.status === 'needs-pick' ? {...state,sessionId:vault?.sessionId()??null} : state
}

function lifecycleError(error: unknown, fallback: string): string {
  return error instanceof Error && lifecycleErrorCodes.has(error.message) ? error.message : fallback
}

function blocksStructureWrite(relPath: string): boolean {
  return !!vault?.root && structureGate.blocksWrite(vault.root, relPath)
}

async function flushBeforeStructure(win: BrowserWindow, cleanUnavailablePaths: readonly string[] = [], phase?: LifecycleFlushPhase, context?: RecoveryFlushContext): Promise<boolean> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return false
  const id = randomUUID()
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      lifecycleFlushes.delete(id)
      resolve(false)
    }, 120_000)
    lifecycleFlushes.set(id,(ok,heldObjects)=>{clearTimeout(timer);lifecycleFlushes.delete(id);if(phase==='root-recovery-protect'){rootHeldObjects=heldObjects??null;resolve(ok&&!!heldObjects)}else resolve(ok)})
    win.webContents.send(IPC.lifecycleFlushRequest, id, cleanUnavailablePaths, phase, context)
  })
}

function clearFlushTimer(): void {
  if (!flushTimer) return
  clearTimeout(flushTimer)
  flushTimer = null
}

async function verifyVaultImage(current:VaultSession,snapshot:import('../shared/ipc.ts').NoteSnapshot,request:import('../shared/ipc.ts').RemoteImageGetRequest){
 const c=request.context;let text:string|undefined
 if(!c||typeof c.sessionId!=='string')return {ok:false as const}
 current.assertSession(c.sessionId)
 if(snapshot.sessionId!==c.sessionId)return {ok:false as const}
 if(c?.ledgerTaskId!==undefined){if(typeof c.ledgerTaskId!=='string'||!Number.isSafeInteger(c.ledgerRevision)||!['prompt','answer'].includes(c.ledgerField??''))return {ok:false as const};text=await current.ledgerImage(c.noteRelPath,c.ledgerTaskId,c.ledgerRevision!,c.ledgerField!)}
 current.assertSession(c.sessionId)
 return verifyImageSource(snapshot,request,text)
}
  /** 人与 AI 共用的一条迁移路径：结构门、停任务、冲稿、库层预览／提交只有调用者不同。
 *  人走 IPC，AI 走宿主的结构工具；两条路都不另造迁移实现，错误码也一致。 */
async function relocationPreviewShared(request: RelocationPreviewRequest, owner?: string): Promise<RelocationPreviewView> {
  const currentVault = vault
  if (!currentVault) throw new Error('NO_VAULT')
  const token = currentVault.captureSession()
  const root = currentVault.root!
  if (structureGate.isBusy()) throw new Error('STRUCTURE_BUSY')
  await agentHost?.whenLaunchesSettled()
  currentVault.assertSession(token)
  // 人从界面迁移要停掉受影响的任务；AI 自己请求的结构操作不能停掉它自己（owner），
  // 否则工具调用会被半路掐断、账本上只剩一次 cancelled。
  const affected = agentHost?.active().filter((task) => task.id !== owner && task.root === root &&
    (task.relPath === request.source ||
      (request.kind === 'folder' && task.relPath.startsWith(`${request.source}/`)) ||
      (request.kind === 'note' && task.relPath.startsWith(`${request.source.slice(0, -3)}/`)))) ?? []
  for (const task of affected) { await agentHost?.cancel(task.id, 'user'); currentVault.assertSession(token) }
  if (agentHost?.hasPending(root)) throw new Error('PREVIOUS_TASK_UNSAVED')
  if (!mainWindow || !(await flushBeforeStructure(mainWindow))) throw new Error('UNSAVED_DRAFT')
  currentVault.assertSession(token)
  const preview = await currentVault.previewRelocation(request, token)
  currentVault.assertSession(token)
  return {
    id: preview.id, sessionId: preview.sessionId, kind: preview.kind, source: preview.source, target: preview.target,
    moves: preview.moves,
    linkChanges: preview.linkChanges.map(({ relPath, newPath, changes }) => ({ relPath, newPath, count: changes.length })),
    permissionChanges: preview.permissionChanges
  }
}

async function relocationCommitShared(id: string, repairLinks: boolean, owner?: string): Promise<{ moved: { from: string; to: string }[]; unrepaired: string[] }> {
  const currentVault = vault
  const win = mainWindow
  if (!currentVault || !win || !currentVault.root) throw new Error('BAD_REQUEST')
  const token = currentVault.captureSession()
  const root = currentVault.root
  const preview = currentVault.relocationPreviewById(id)
  if (!preview) throw new Error('STALE_PREVIEW')
  if (structureGate.isBusy()) throw new Error('STRUCTURE_BUSY')
  structureGate.begin({
    root,
    exact: [preview.source, ...(repairLinks ? preview.linkChanges.map((item) => item.relPath) : [])],
    prefixes: preview.kind === 'folder' ? [preview.source] : [preview.source.slice(0, -3)]
  })
  try {
    await agentHost?.whenLaunchesSettled()
    currentVault.assertSession(token)
    const affected = agentHost?.active().filter((task) => task.id !== owner && task.root === root && agentHost!.scopePaths(task.id).some(path => structureGate.affects(root, path))) ?? []
    // 请求者自己不算「别的任务」：它正是发起方，收尾由宿主在工具返回之后负责。
    if (agentHost?.active().some((task) => task.id !== owner && task.root === root && !agentHost!.scopePaths(task.id).some(path => structureGate.affects(root, path)))) {
      throw new Error('OTHER_TASK_RUNNING')
    }
    for (const task of affected) { await agentHost?.cancel(task.id, 'user'); currentVault.assertSession(token) }
    if (agentHost?.hasPending(root)) throw new Error('PREVIOUS_TASK_UNSAVED')
    if (!(await flushBeforeStructure(win))) throw new Error('UNSAVED_DRAFT')
    currentVault.assertSession(token)
    structureGate.seal()
    const outcome = await currentVault.commitRelocation(id, repairLinks, token)
    currentVault.assertSession(token)
    return { moved: outcome.moved.map(({ from, to }) => ({ from, to })), unrepaired: outcome.unrepaired }
  } finally { structureGate.finish() }
}

async function trashPreviewShared(relPath: string, owner?: string): Promise<TrashPreviewView> {
  const currentVault = vault
  if (!currentVault) throw new Error('NO_VAULT')
  const token = currentVault.captureSession()
  const root = currentVault.root!
  if (structureGate.isBusy()) throw new Error('STRUCTURE_BUSY')
  await agentHost?.whenLaunchesSettled()
  currentVault.assertSession(token)
  const stem = relPath.replace(/\.md$/i, '')
  // 按任务授权范围停任务：只在读／引用这篇笔记的场也要先停，不能只看任务自己的 relPath。
  const affected = agentHost?.affectedBy(root, [relPath, stem], owner) ?? []
  for (const task of affected) { await agentHost?.cancel(task.id, 'user'); currentVault.assertSession(token) }
  if (agentHost?.hasPending(root)) throw new Error('PREVIOUS_TASK_UNSAVED')
  if (!mainWindow || !(await flushBeforeStructure(mainWindow))) throw new Error('UNSAVED_DRAFT')
  currentVault.assertSession(token)
  const preview = await currentVault.previewTrash(relPath, token)
  currentVault.assertSession(token)
  return {
    id: preview.id, sessionId: preview.sessionId, relPath: preview.relPath,
    title: preview.title, hasAttachments: preview.hasAttachments
  }
}

async function trashCommitShared(id: string, allow: boolean, owner?: string, attribution?: { taskId: string; prompt: string; source?: 'human' | 'ai' }): Promise<Exclude<TrashCommitResult, { ok: false }>> {
  const currentVault = vault
  const win = mainWindow
  if (!currentVault || !win || !currentVault.root) throw new Error('BAD_REQUEST')
  const token = currentVault.captureSession()
  const preview = currentVault.trashPreviewById(id)
  if (!preview) throw new Error('STALE_PREVIEW')
  if (!allow) {
    await currentVault.commitTrash(id, false, token)
    return { ok: true, cancelled: true }
  }
  const root = currentVault.root
  if (structureGate.isBusy()) throw new Error('STRUCTURE_BUSY')
  structureGate.begin({
    root,
    exact: [preview.relPath],
    prefixes: [preview.relPath.replace(/\.md$/i, '')]
  })
  try {
    await agentHost?.whenLaunchesSettled()
    currentVault.assertSession(token)
    const stem = preview.relPath.replace(/\.md$/i, '')
    // 预览之后、确认之前可能又起了任务：提交前按同一份授权范围再查一次。
    const affected = agentHost?.affectedBy(root, [preview.relPath, stem], owner) ?? []
    const affectedIds = new Set(affected.map((task) => task.id))
    const unrelated = agentHost?.active().filter((task) => task.id !== owner && task.root === root && !affectedIds.has(task.id)) ?? []
    if (unrelated.length) throw new Error('OTHER_TASK_RUNNING')
    for (const task of affected) { await agentHost?.cancel(task.id, 'user'); currentVault.assertSession(token) }
    if (agentHost?.hasPending(root)) throw new Error('PREVIOUS_TASK_UNSAVED')
    if (!(await flushBeforeStructure(win))) throw new Error('UNSAVED_DRAFT')
    currentVault.assertSession(token)
    structureGate.seal()
    // 零确认删除：预览只用于核对象与排队；真正落点改为库内 .rgent-trash。
    const outcome = await currentVault.trashDelete(preview.relPath, { source: attribution?.source ?? 'ai', ...(attribution?.taskId ? { taskId: attribution.taskId } : {}) })
    currentVault.assertSession(token)
    // trashDelete 用结果对象报业务失败；这里若当成成功返回，界面会关 tab 而笔记其实还在。
    if (!outcome.ok) {
      try { await currentVault.commitTrash(id, false) } catch { /* 预览清理失败不覆盖删除失败 */ }
      throw new Error(outcome.error)
    }
    return {
      ok: true, cancelled: false, relPath: outcome.relPath ?? preview.relPath, landing: '',
      landingVerified: 'unverified', attachmentLanding: null,
      orphan: false, degraded: []
    }
  } finally { structureGate.finish() }
}

function send(channel: string, payload?: unknown): void {
  if (channel === IPC.treeChanged || channel === IPC.noteExternalChange || channel === IPC.vaultLost) {
    for (const [controller, active] of imageControllers) {
      const c = active.request.context!
      const imageSession=c.sessionId
      if(typeof imageSession!=='string'){controller.abort();continue}
      try {
        active.vault.assertSession(imageSession)
        void active.vault.runBound(imageSession, async () => {
          const snapshot=await active.vault.read(c.noteRelPath);active.vault.assertSession(imageSession)
          const proof = await verifyVaultImage(active.vault,snapshot,active.request);active.vault.assertSession(imageSession)
          if (!proof.ok || proof.binding!==active.binding) controller.abort()
        }).catch(()=>controller.abort())
      } catch { controller.abort() }
    }
    const current = vault; const token = current?.sessionId()
    if (current?.root && token) {
      void agentHost?.recheckSources(current.root, token).catch(() => {})
    }
  }
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, isVaultEvent(channel) ? { session: vault?.sessionId() ?? null, args: [payload] } : payload)
}

async function settleHostBeforeClose(win: BrowserWindow): Promise<boolean> {
  consolidation?.cancel(undefined,'MEMORY_SESSION_CLOSED')
  memoryIpc.clear()
  memoryAuthorizationPreviews.clear()
  try {
    // 先等 launching 落地再 cancel：cancelAll 只覆盖 running，中途撕启动会丢授权与稿。
    await agentHost?.whenLaunchesSettled()
    try { await agentHost?.cancelAll('close') } catch { /* pending answer is retained for retry below */ }
    agentHost?.clearNetworkPreviews?.()
    await agentHost?.whenLaunchesSettled()
    if (agentHost?.active().length) {
      try { await agentHost.cancelAll('close') } catch { /* pending answer is retained for retry below */ }
    }
  } catch { /* pending answer is retained for retry below */ }
  while (agentHost?.hasPending()) {
    try { await agentHost.retryPending() } catch { /* ask the person before discarding generated bytes */ }
    if (!agentHost.hasPending()) break
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '生成内容尚未保存',
      message: '模型已停止，但部分回答或账本写入失败。',
      detail: '可以重试保存、继续编辑，或明确放弃尚未写盘的生成内容。',
      buttons: ['重试保存', '继续编辑', '明确放弃生成内容并关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (response === 1) { quitting = false; return false }
    if (response === 2) { agentHost.discardPending(); break }
  }
  return true
}

function requestWindowClose(win: BrowserWindow): void {
  if (cancellingForClose || win.isDestroyed()) return
  cancellingForClose = true
  void settleHostBeforeClose(win).then(proceed => {
    if (proceed && !win.isDestroyed()) runCloseAction(closeFlow.request(), win)
  }).finally(() => { cancellingForClose = false })
}

function runCloseAction(action: CloseAction, win: BrowserWindow, stalled = false): void {
  if (action === 'none') return
  if (action !== 'flush') clearFlushTimer()
  if (action === 'flush') {
    clearFlushTimer()
    if (win.webContents.isDestroyed()) {
      runCloseAction(closeFlow.rendererGone(), win)
      return
    }
    flushTimer = setTimeout(() => {
      const alive = !rendererGone && !win.isDestroyed() && !win.webContents.isDestroyed()
      // 渲染进程只是挂起（或计时器触发之后才崩）也要给出一条出路，
      // 否则流程停在 flushing，窗口关不掉、Cmd+Q 也被挡住。
      const next = timeoutAction(closeFlow, alive)
      runCloseAction(next, win, next === 'prompt')
    }, FLUSH_GRACE_MS)
    win.webContents.send(IPC.flushRequest)
  } else if (action === 'prompt') {
    const abandon = quitting || process.platform !== 'darwin'
      ? '放弃未保存修改并退出应用'
      : '放弃未保存修改并关闭窗口'
    void dialog.showMessageBox(win, {
      type: 'warning',
      title: stalled ? '保存没有回应' : '笔记尚未保存',
      message: stalled ? '窗口没有在时限内确认写盘结果。' : '写盘失败，仍有未保存的修改。',
      detail: stalled
        ? '可以重试保存、继续编辑，或明确放弃本次未保存的修改。若窗口已无响应，只有后两项可选。'
        : '可以重试保存、继续编辑，或明确放弃本次未保存的修改。',
      buttons: ['重试保存', '继续编辑', abandon],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }).then(({ response }) => {
      const choice: CloseDecision = response === 0 ? 'retry' : response === 2 ? 'discard' : 'continue'
      runCloseAction(closeFlow.decide(choice), win, stalled)
    }).catch(() => {
      runCloseAction(closeFlow.decide('continue'), win)
    })
  } else if (action === 'cancel') {
    quitting = false
  } else if (action === 'close') {
    flushed = true
    if (quitting) app.quit()
    else if (!win.isDestroyed()) win.close()
  }
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); return }
  flushed = false
  rendererGone = false
  flushTimer = null
  closeFlow = new CloseFlow()
  const dark = nativeTheme.shouldUseDarkColors
  // 主进程读不到渲染层的 CSS token，所以窗口外观这两个色值是第二份拷贝：
  // 必须与 src/renderer/src/styles.css 的 --surface-nav 同值（日 #f5f6f8 / 夜 #1d2933）。
  // 见 docs/architecture.md「颜色只有一个来源」那一行的已知例外。
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    title: 'Rgent',
    backgroundColor: dark ? '#1d2933' : '#f5f6f8',
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      // hiddenInset 默认交通灯偏上；将原生控件移到 46px tab 栏的中线。
      trafficLightPosition: { x: 13, y: 16 }
    } : {}),
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: {
        color: dark ? '#1d2933' : '#f5f6f8',
        symbolColor: dark ? '#dfe3e8' : '#1c1f23',
        height: 46
      }
    } : {}),
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // 同上的第二份拷贝：跟随系统切换时两处一起改，别只改上面创建时那一处。
  const updateWindowTheme = (): void => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    const isDark = nativeTheme.shouldUseDarkColors
    win.setBackgroundColor(isDark ? '#1d2933' : '#f5f6f8')
    if (process.platform === 'win32') win.setTitleBarOverlay({
      color: isDark ? '#1d2933' : '#f5f6f8',
      symbolColor: isDark ? '#dfe3e8' : '#1c1f23',
      height: 46
    })
  }
  nativeTheme.on('updated', updateWindowTheme)

  mainWindow.on('closed', () => {
    nativeTheme.off('updated', updateWindowTheme)
    mainWindow = null
  })
  mainWindow.webContents.on('render-process-gone', () => {
    rendererGone = true
    // 渲染进程没了本身就要推进关窗流程：只置标志的话，若它是在超时之后才崩的，
    // CloseFlow 会永远停在 flushing，窗口再也关不掉。空闲态这里返回 'none'，无副作用。
    const win = mainWindow
    if (win) runCloseAction(closeFlow.rendererGone(), win)
  })

  // 关窗前先写盘；失败时由主进程给出重试、继续编辑或明确放弃的选择。
  mainWindow.on('close', (event) => {
    if (flushed) return
    event.preventDefault()
    const win = mainWindow
    if (!win) return
    if (vaultSwitch?.requestClose()) return
    requestWindowClose(win)
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
  })

  const rendererUrl = rendererDevelopmentUrl
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(path.join(here, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开库…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send(IPC.menuOpenVault)
        },
        {
          label: '新建笔记',
          accelerator: 'CmdOrCtrl+N',
          click: () => send(IPC.menuNewNote)
        },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => send(IPC.menuSave)
        },
        {
          label: '抓取网页…',
          accelerator: 'CmdOrCtrl+Shift+U',
          click: () => send(IPC.menuFetchWeb)
        },
        {
          label: '问 AI',
          accelerator: 'CmdOrCtrl+Shift+Enter',
          // 键盘由渲染层统一处理：这里只显示快捷键，不再注册一次原生 accelerator，避免双发。
          registerAccelerator: false,
          click: () => send(IPC.menuAsk)
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const failureClearSeen = new Set<string>()

function registerIpc(): void {
  const preflightDiagnostics = new PreflightStore(app.getPath('userData'))
  const trusted = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    isTrustedIpcSender(event, mainWindow, rendererEntryUrl)
  const registerTrustedHandle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) throw new Error('BAD_SENDER')
      const current = vault,session = current?.sessionId() ?? null
      const actual = isVaultChannel(channel) ? boundArguments(args, session) : args
      if (vaultSwitch?.busy && [IPC.agentStart, IPC.agentAuthorizationPreview, IPC.noteCreate, IPC.folderCreate, IPC.relocationPreview, IPC.relocationCommit,   IPC.lifecycleRetry, IPC.recoveryScan, IPC.recoveryConfirm, IPC.recoveryAbandon, IPC.noteSaveCopyPreview, IPC.noteSaveCopyCommit, IPC.permissionsSet, IPC.memoryConfigSave, IPC.memoryPreviewCommit, IPC.memoryItemEdit, IPC.memoryItemDisable, IPC.memoryItemForget, IPC.memoryJobRetryPreview, IPC.skillsSave, IPC.skillsSetEnabled,  IPC.ledgerMaintenance, IPC.ledgerMigrate, IPC.ledgerRepair].includes(channel as never)) throw Error('VAULT_SWITCH_BUSY')
      const result = isVaultChannel(channel) && current ? await current.runBound(session, () => listener(event, ...actual)) : await listener(event, ...actual)
      if (isVaultChannel(channel) && session !== (vault?.sessionId() ?? null)) throw Error('VAULT_CHANGED')
      return result
    })
  }
  const registerTrustedOn = (channel: string, listener: Parameters<typeof ipcMain.on>[1]): void => {
    ipcMain.on(channel, (event, ...args) => {
      if (trusted(event)) listener(event, ...args)
    })
  }
  for (const [channel, operation] of [
    [IPC.memoryGet, 'get'], [IPC.memoryConfigSave, 'config'], [IPC.memoryManualPreview, 'manual'],
    [IPC.memoryPreviewCommit, 'commit'], [IPC.memoryItemEdit, 'edit'], [IPC.memoryItemDisable, 'disable'],
    [IPC.memoryItemForget, 'forget'], [IPC.memoryRestorePreview, 'restore'],
    [IPC.memoryMaintenancePreview,'maintenance'],
    [IPC.memoryJobRetryPreview, 'retry'], [IPC.memoryJobCancel, 'cancel']
  ] as const) registerTrustedHandle(channel, async (event, request) => {
    const currentVault=vault,session=currentVault?.sessionId()
    const result=await memoryIpc.handle(`${event.sender.id}:${event.senderFrame!.routingId}`, operation, request,()=>{if(!trusted(event))throw Error('MEMORY_SESSION_CLOSED')})
    if(currentVault&&session)currentVault.assertSession(session)
    if(result.ok&&!['get','manual','restore','retry','maintenance'].includes(operation)){
      send(IPC.memoryChanged,session)
    }
    return result
  })
  /** 技能库视图：列表即读取（正文一并返回），损坏时如实标 corrupt，不显示成「还没有技能」。 */
  const skillsLibraryView = (sessionId: string): import('../shared/skills.ts').SkillsLibraryView => {
    const store = createSkillsStore(app.getPath('userData'))
    const diagnosis = store.diagnosis()
    const empty = { sessionId, revision: diagnosis.revision, corrupt: true, ignored: 0, skills: [] }
    if (diagnosis.invalid) return empty
    let view
    try { view = resolveSkills(store.get(), vault!.memoryContext().vaultKey) } catch { return empty }
    return {
      sessionId, revision: diagnosis.revision, corrupt: false, ignored: view.ignored,
      skills: view.skills.map(skill => skill.state === 'available'
        ? { id: skill.id, name: skill.name, description: skill.description, triggers: skill.triggers, body: skill.body, bytes: skill.bytes, reason: null, enabled: skill.enabled }
        : { id: skill.id ?? '', name: skill.name ?? '', description: '', triggers: [], body: '', bytes: 0, reason: skill.reason, enabled: skill.enabled })
    }
  }
  const withSkillsVault = <T,>(event: Electron.IpcMainInvokeEvent, sessionId: string, run: () => T): T => {
    const currentVault = vault, session = currentVault?.sessionId()
    if (!currentVault || !session || session !== sessionId) throw Error('VAULT_CHANGED')
    const result = run()
    currentVault.assertSession(session)
    return result
  }
  registerTrustedHandle(IPC.skillsGet, async (event, value: unknown): Promise<import('../shared/skills.ts').SkillsResult> => {
    if (!trusted(event) || !value || typeof value !== 'object' || typeof (value as { sessionId?: unknown }).sessionId !== 'string') return { ok: false, error: 'BAD_REQUEST' }
    const request = value as import('../shared/skills.ts').SkillsGetRequest
    try { return { ok: true, view: withSkillsVault(event, request.sessionId, () => skillsLibraryView(request.sessionId)) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'SKILLS_FAILED' } }
  })
  registerTrustedHandle(IPC.skillsSave, async (event, value: unknown): Promise<import('../shared/skills.ts').SkillsResult> => {
    if (!trusted(event) || !value || typeof value !== 'object') return { ok: false, error: 'BAD_REQUEST' }
    const request = value as Partial<import('../shared/skills.ts').SkillsSaveRequest>
    const sessionId = request.sessionId
    if (typeof sessionId !== 'string' || (request.expectedRevision !== null && typeof request.expectedRevision !== 'string')) return { ok: false, error: 'BAD_REQUEST' }
    if (request.operation !== 'create' && request.operation !== 'update' && request.operation !== 'remove') return { ok: false, error: 'BAD_REQUEST' }
    try {
      return { ok: true, view: withSkillsVault(event, sessionId, () => {
        const store = createSkillsStore(app.getPath('userData'))
        const config = store.get()
        const now = new Date().toISOString()
        let next = config
        if (request.operation === 'remove') {
          const id = (request as { id?: unknown }).id
          if (!skillId(id)) throw Error('BAD_REQUEST')
          next = {
            ...config,
            skills: config.skills.filter(skill => skill.id !== id),
            vaults: Object.fromEntries(Object.entries(config.vaults).map(([key, entry]) => [key, { enabled: entry.enabled.filter(enabled => enabled !== id) }]))
          }
        } else {
          const draft = (request as { draft?: unknown }).draft
          const reason = skillFieldsReason(draft)
          // 校验不过就把原因当错误码回给界面：界面用同一份人话文案，不自己编。
          if (reason !== null) throw Error(reason)
          const clean = draft as import('../shared/skills.ts').SkillsDraft
          if (request.operation === 'create') {
            next = { ...config, skills: [...config.skills, { id: randomUUID(), ...clean, triggers: [...clean.triggers], createdAt: now, updatedAt: now }] }
          } else {
            const id = (request as { id?: unknown }).id
            if (!skillId(id) || !config.skills.some(skill => skill.id === id)) throw Error('SKILLS_UNKNOWN_ID')
            next = { ...config, skills: config.skills.map(skill => skill.id === id ? { ...skill, ...clean, triggers: [...clean.triggers], updatedAt: now } : skill) }
          }
        }
        store.write(next, request.expectedRevision ?? null)
        return skillsLibraryView(sessionId)
      }) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'SKILLS_FAILED' } }
  })
  registerTrustedHandle(IPC.skillsSetEnabled, async (event, value: unknown): Promise<import('../shared/skills.ts').SkillsResult> => {
    if (!trusted(event) || !value || typeof value !== 'object') return { ok: false, error: 'BAD_REQUEST' }
    const request = value as Partial<import('../shared/skills.ts').SkillsEnabledRequest>
    const sessionId = request.sessionId
    if (typeof sessionId !== 'string' || typeof request.enabled !== 'boolean' || !skillId(request.id) || (request.expectedRevision !== null && typeof request.expectedRevision !== 'string')) return { ok: false, error: 'BAD_REQUEST' }
    try {
      return { ok: true, view: withSkillsVault(event, sessionId, () => {
        const store = createSkillsStore(app.getPath('userData'))
        const config = store.get()
        const key = vault!.memoryContext().vaultKey
        const current = config.vaults[key]?.enabled ?? []
        const next = request.enabled ? [...new Set([...current, request.id!])] : current.filter(id => id !== request.id)
        store.setEnabled(key, next, request.expectedRevision ?? null)
        return skillsLibraryView(sessionId)
      }) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'SKILLS_FAILED' } }
  })
  const configResult = (): ModelConfigResult => modelConfig
    ? { ok: true, config: modelConfig.getPublic() }
    : { ok: false, error: modelConfigError ?? 'MODEL_CONFIG_UNAVAILABLE' }
  registerTrustedHandle(IPC.modelConfigGet, (event): ModelConfigResult =>
    trusted(event) ? configResult() : { ok: false, error: 'BAD_SENDER' })
  // 一个供应商一份凭据：保存即 upsert，界面不提供同厂商第二条。写操作一律返回最新公开配置。
  const modelWrite = (run: () => void): ModelConfigResult => {
    if (!modelConfig) return { ok: false, error: 'MODEL_CONFIG_UNAVAILABLE' }
    try { run(); return configResult() }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'IO_ERROR' } }
  }
  const modelFields = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' ? value as Record<string, unknown> : null
  registerTrustedHandle(IPC.modelProviderSave, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelProviderSaveRequest> | null
    if (!request || (request.newKey !== undefined && typeof request.newKey !== 'string')) return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.saveProvider({ provider: request.provider, baseURL: request.baseURL, modelId: request.modelId, contextTokens: request.contextTokens }, request.newKey))
  })
  registerTrustedHandle(IPC.modelProviderRemove, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelProviderRemoveRequest> | null
    if (!request) return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.removeProvider(request.provider))
  })
  registerTrustedHandle(IPC.modelKeyDelete, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelKeyDeleteRequest> | null
    if (!request) return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.deleteKey(request.provider))
  })
  registerTrustedHandle(IPC.modelAdd, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelAddRequest> | null
    if (!request) return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.addModel({ provider: request.provider, modelId: request.modelId, contextTokens: request.contextTokens }))
  })
  registerTrustedHandle(IPC.modelUpdate, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelUpdateRequest> | null
    if (!request || typeof request.modelId !== 'string') return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.updateModel(request.modelId as string, request.contextTokens))
  })
  registerTrustedHandle(IPC.modelRemove, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelRemoveRequest> | null
    if (!request || typeof request.modelId !== 'string') return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.removeModel(request.modelId as string))
  })
  registerTrustedHandle(IPC.modelDefaultSet, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelDefaultSetRequest> | null
    if (!request || (request.modelId !== null && typeof request.modelId !== 'string')) return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.setDefault(request.modelId as string | null))
  })
  // 「读取模型」：主进程发出，只取模型清单与端点自报的容量；渲染层不碰网络。
  registerTrustedHandle(IPC.modelList, async (event, value: unknown): Promise<ModelListResult> => {
    if (!trusted(event) || !modelConfig) return { ok: false, error: 'MODEL_CONFIG_UNAVAILABLE' }
    const request = modelFields(value) as Partial<ModelListRequest> | null
    if (!request) return { ok: false, error: 'BAD_REQUEST' }
    try {
      const secret = modelConfig.providerSecret(request.provider)
      const result = await fetchModelList(secret)
      return { ok: true, models: result.models, ...(result.truncated ? { truncated: true } : {}) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'MODEL_LIST_FAILED' } }
  })
  registerTrustedHandle(IPC.modelLimitsSet, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event) || !modelConfig || !value || typeof value !== 'object') return { ok: false, error: 'BAD_REQUEST' }
    const request = value as Partial<ModelLimitsSetRequest>
    return modelWrite(() => modelConfig!.updateLimits(request.tier as LimitTier, request.limits!))
  })
  /** 库内「已删除」：人删除、列表、还原、明确删除；AI 删除走同一条 vault 事务。 */
  const trashSession = (): { vault: VaultSession; session: string } | null => {
    const current = vault
    if (!current) return null
    try { return { vault: current, session: current.sessionId() ?? '' } } catch { return null }
  }
  registerTrustedHandle(IPC.vaultTrashDelete, async (event, value: unknown) => {
    if (!trusted(event) || !value || typeof value !== 'object') return { ok: false, error: 'BAD_REQUEST' }
    const relPath = (value as { relPath?: unknown }).relPath
    if (typeof relPath !== 'string' || !relPath || relPath.length > 4096 || relPath.startsWith('/') || relPath.includes('\\')) return { ok: false, error: 'BAD_REQUEST' }
    try {
      // 与人删除共用同一条协调：停受影响任务、排空窗口稿，再进库内已删除。
      const preview = await trashPreviewShared(relPath)
      const result = await trashCommitShared(preview.id, true, undefined, { taskId: 'human', prompt: '人删除，移入库内已删除', source: 'human' })
      if (!result.ok || result.cancelled) {
        try { await vault?.commitTrash(preview.id, false) } catch { /* 预览清理失败不改变拒绝结果 */ }
        return { ok: false, error: 'TRASH_CANCELLED' }
      }
      try { await vault?.commitTrash(preview.id, false) } catch { /* 旧预览清理失败不影响已完成的删除 */ }
      return { ok: true, relPath: result.relPath, trashId: '' }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.vaultTrashList, async (event) => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const state = trashSession()
    if (!state) return { ok: false, error: 'NO_VAULT' }
    try { return await state.vault.trashList() }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.vaultTrashRestore, async (event, value: unknown) => {
    if (!trusted(event) || !value || typeof value !== 'object') return { ok: false, error: 'BAD_REQUEST' }
    const id = (value as { id?: unknown }).id
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(id)) return { ok: false, error: 'BAD_REQUEST' }
    const state = trashSession()
    if (!state) return { ok: false, error: 'NO_VAULT' }
    try { return await state.vault.trashRestore(id) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.vaultTrashPurge, async (event, value: unknown) => {
    if (!trusted(event) || !value || typeof value !== 'object') return { ok: false, error: 'BAD_REQUEST' }
    const id = (value as { id?: unknown }).id
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(id)) return { ok: false, error: 'BAD_REQUEST' }
    const state = trashSession()
    if (!state) return { ok: false, error: 'NO_VAULT' }
    try { return await state.vault.trashPurge(id) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.agentAuthorizationPreview, async (event, value: unknown): Promise<import('../shared/ipc.ts').AgentAuthorizationResult> => {
    if(!authorizations || !isAuthorizationCommand(value))return {ok:false,error:'BAD_REQUEST'}
    const request=value as import('../shared/ipc.ts').AgentAuthorizationRequest
    if(structureGate.isBusy())return {ok:false,error:'NOTE_BUSY'}
    try {
      const owner = `${event.sender.id}:${event.senderFrame!.routingId}`
      const memory = memoryAuthorizationState(request.sessionId)
      const preview = await authorizations.preview(owner, request)
      const memorySearch=preview.memory?.search?.available===true
      if (memoryAuthorizationState(request.sessionId).signature !== memory.signature) throw Error('STALE_PREVIEW')
      if (memoryAuthorizationPreviews.size >= 128) memoryAuthorizationPreviews.delete(memoryAuthorizationPreviews.keys().next().value!)
      // 预览只带技能名称：正文、字数与展开都不给——合同把「可审」交给账本的名称与哈希。
      // 冻结的那一份正文随预览留存（人看不到，但启动时发出去的就是它）。
      const skills = currentSkills()
      memoryAuthorizationPreviews.set(`${owner}:${preview.id}`, { sessionId: request.sessionId, signature: memory.signature,search:memorySearch,skills })
      const chapters=await vault!.ledgerContexts(request.relPath),note=await vault!.read(request.relPath)
      const validMemories=memory.disclosure?.use?await workingService()!.entries():[]
      const scope=request.scope
      const parent=request.relPath.includes('/')?request.relPath.slice(0,request.relPath.lastIndexOf('/')):''
      const inScope=(path:string):boolean=>scope==='note'?path===request.relPath:scope==='folder'?(parent!==''&&(path===parent||path.startsWith(parent+'/'))):true
      const policy=await historicalContextPolicy(note.content,async dep=>{
        if(!inScope(dep.relPath))return false
        try{await modelTierFor(vault!.root!,dep.relPath)}catch{return false}
        try{const current=await vault!.read(dep.relPath);return current.objectVersion===dep.objectVersion&&createHash('sha256').update(partitionSource(current.content).body).digest('hex')===dep.bodyHash}catch{return false}
      },undefined,chapters,async dep=>validMemories.some(e=>e.status==='active'&&sameMemoryDependency(dep,memoryDependency(e))))
      const generators=summaryCache?.valid(summaryHash(await vault!.ledgerKey(request.relPath)),chapters.filter(c=>policy.allowedLedgerChapterIds.includes(c.sourceId))).map(b=>({modelId:b.generator.modelId,host:b.generator.host,time:b.generator.time}))??[]
      vault!.assertSession(request.sessionId)
      if(memoryAuthorizationState(request.sessionId).signature!==memory.signature)throw Error('STALE_PREVIEW')
      return {ok:true,preview:{...preview,summaryGenerators:generators.slice(0,64),...(skills.record.length||skills.unavailable.length?{skills:skills.record.map(skill=>({id:skill.id,name:skill.name})),skillsUnavailable:skills.unavailable.map(item=>({name:item.name,reason:item.reason}))}:{})}}
    }
    catch(error){return {ok:false,error:error instanceof Error?error.message:'AUTHORIZATION_FAILED'}}
  })
  registerTrustedHandle(IPC.agentAuthorizationDiscard, (event, id:unknown) => {
    if(typeof id==='string' && id.length<=128) { const owner = `${event.sender.id}:${event.senderFrame!.routingId}`; authorizations?.discard(owner,id); memoryAuthorizationPreviews.delete(`${owner}:${id}`) }
  })
  registerTrustedHandle(IPC.agentTasks, (event) => trusted(event)
    ? agentHost?.active().map(({ id, relPath, startedAt }) => ({ id, relPath, startedAt })) ?? [] : [])
  registerTrustedHandle(IPC.agentCancel, async (event, value: unknown) => {
    if (!trusted(event) || typeof value !== 'string' || value.length > 128) return false
    return Boolean(await agentHost?.cancel(value, 'user'))
  })
  registerTrustedHandle(IPC.agentStart, async (event, value: unknown): Promise<AgentStartResult> => {
    if (!trusted(event) || !agentHost || !value || typeof value !== 'object') return { ok: false, error: 'BAD_REQUEST' }
    const request = value as Partial<AgentStartRequest>
    if (typeof request.previewId !== 'string' || request.previewId.length > 128 || typeof request.relPath !== 'string' || typeof request.expectedText !== 'string' ||
        typeof request.promptText !== 'string' || request.promptText.length > 20000 ||
        typeof request.modelRecordId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(request.modelRecordId) ||
        typeof request.sessionId !== 'string' || typeof request.objectVersion !== 'string' || typeof request.expectedRevision !== 'string' ||
        (request.scope !== 'note' && request.scope !== 'folder' && request.scope !== 'vault') ||
        !request.range || !Number.isSafeInteger(request.range.start) || !Number.isSafeInteger(request.range.end)) {
      return { ok: false, error: 'BAD_REQUEST' }
    }
    if (structureGate.isBusy() || cancellingForClose) return { ok: false, error: 'NOTE_BUSY' }
    try {
      const owner = `${event.sender.id}:${event.senderFrame!.routingId}`
      const memory = memoryAuthorizationPreviews.get(`${owner}:${request.previewId}`)
      memoryAuthorizationPreviews.delete(`${owner}:${request.previewId}`)
      if (!memory || memory.sessionId !== request.sessionId || memory.signature !== memoryAuthorizationState(request.sessionId).signature) throw Error('STALE_PREVIEW')
      // 技能库在预览与启动之间变过（签名不同）就拒绝；没变则**发预览冻结的那一份正文**。
      if (memory.skills.signature !== currentSkills().signature) throw Error('STALE_PREVIEW')
      const task = await agentHost.start({...request as AgentStartRequest, authorizationOwner:`${event.sender.id}:${event.senderFrame!.routingId}`, memoryAuthorizationSignature: memory.signature,memorySearchAuthorized:memory.search,skillsSignature:memory.skills.signature,skillsSnapshot:memory.skills})
      void task.done.catch(() => {})
      return { ok: true, id: task.id }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'AGENT_START_FAILED' } }
  })
  /** 停止联网：只撤本场网络能力并 abort 在途抓取，不终止整场任务。 */
  registerTrustedHandle(IPC.networkStop, async (event, value: unknown): Promise<boolean> => {
    if (!trusted(event) || typeof value !== 'string' || value.length > 128 || !agentHost) return false
    const task = agentHost.active().find(item => item.id === value)
    if (!task) return false
    let root: string | null = null
    try { root = vault?.requireUsableRoot() ?? null } catch { root = null }
    if (!root || task.root !== root) return false
    return agentHost.stopNetwork(value)
  })
  /** 联网预览：只给本库当下任务、且只给包裹前的纯文本；未知 id 一律拒绝。 */
  registerTrustedHandle(IPC.networkPreview, async (event, value: unknown): Promise<NetworkPreviewResult> => {
    if (!trusted(event) || !value || typeof value !== 'object' || !agentHost) return { ok: false, error: 'BAD_REQUEST' }
    const request = value as Partial<NetworkPreviewRequest>
    if (typeof request.taskId !== 'string' || request.taskId.length > 128 || typeof request.id !== 'string' || request.id.length > 128) return { ok: false, error: 'BAD_REQUEST' }
    const task = agentHost.active().find(item => item.id === request.taskId)
    let root: string | null = null
    try { root = vault?.requireUsableRoot() ?? null } catch { root = null }
    if (!task || !root || task.root !== root) return { ok: false, error: 'STALE_PREVIEW' }
    const preview = agentHost.preview(request.taskId, request.id)
    return preview ? { ok: true, preview } : { ok: false, error: 'STALE_PREVIEW' }
  })
  const networkView = (): NetworkConfigResult => networkConfig
    ? { ok: true, config: networkConfig.getPublic() }
    : { ok: false, error: 'BAD_NETWORK_CONFIG' }
  const networkWrite = (run: () => import('../shared/ipc.ts').NetworkConfigView): NetworkConfigResult => {
    if (!networkConfig) return { ok: false, error: 'BAD_NETWORK_CONFIG' }
    try { return { ok: true, config: run() } }
    // 只把机读错误码回渲染层；文件系统原文（可能带路径）不外泄。
    catch (error) {
      const message = error instanceof Error ? error.message : ''
      return { ok: false, error: /^[A-Z][A-Z0-9_]{1,63}$/u.test(message) ? message : 'IO_ERROR' }
    }
  }
  /** 配置前后比对「用哪家、哪些家已有密钥、当前密钥、抓页路径、DeepSeek 密钥来源、
   *  模型自带联网开关」；密钥只留在主进程内存里。任一项变化都撤销活动任务的联网能力
   *  （在途请求随之中止），只关 native 也算。 */
  type NetworkCredentialSnapshot = {
    searchProvider: string | null
    keyedProviders: string
    key: string | null
    fetch: string
    deepseekKeySource: string
    nativeSearch: string
  }
  const networkCredentialSnapshot = (): NetworkCredentialSnapshot => {
    let searchProvider: string | null = null
    let keyedProviders = ''
    let fetch = ''
    let deepseekKeySource = ''
    let nativeSearch = ''
    let key: string | null = null
    try {
      const view = networkConfig?.getPublic()
      searchProvider = view?.searchProvider ?? null
      keyedProviders = (view?.keyedProviders ?? []).join(',')
      fetch = view?.fetch ?? ''
      deepseekKeySource = view?.deepseekKeySource ?? ''
      nativeSearch = view?.nativeSearch?.minimax === true ? '1' : '0'
    } catch { /* fail closed */ }
    try { key = networkConfig?.credential()?.key ?? null } catch { key = null }
    return { searchProvider, keyedProviders, key, fetch, deepseekKeySource, nativeSearch }
  }
  const networkCredentialChanged = (before: NetworkCredentialSnapshot): boolean => {
    const after = networkCredentialSnapshot()
    return before.searchProvider !== after.searchProvider || before.keyedProviders !== after.keyedProviders ||
      before.key !== after.key || before.fetch !== after.fetch || before.deepseekKeySource !== after.deepseekKeySource ||
      // 只关 native 也撤网：活动任务已经按 native 宣告过模型步，必须重新预览才能再用。
      before.nativeSearch !== after.nativeSearch
  }
  /** 设备级选项：不带参数只读，带 `{enabled?, fetch?, nativeSearch?, deepseekKeySource?}` 保存并立即生效。
   *  所有字段先校验再写，避免同一请求里前一项落盘、后一项被拒的半套状态。 */
  registerTrustedHandle(IPC.networkConfig, (event, value: unknown): NetworkConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    if (value === undefined) return networkView()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'BAD_REQUEST' }
    const record = value as Record<string, unknown>
    const fields = Object.keys(record)
    if (!fields.length || fields.some(key => !['enabled', 'fetch', 'nativeSearch', 'deepseekKeySource'].includes(key))) {
      return { ok: false, error: 'BAD_REQUEST' }
    }
    if ('enabled' in record && typeof record.enabled !== 'boolean') return { ok: false, error: 'BAD_REQUEST' }
    if ('fetch' in record && record.fetch !== 'direct' && record.fetch !== 'deepseek') return { ok: false, error: 'BAD_REQUEST' }
    if ('deepseekKeySource' in record && record.deepseekKeySource !== 'own' && record.deepseekKeySource !== 'model') {
      return { ok: false, error: 'BAD_REQUEST' }
    }
    const nativeSearch = record.nativeSearch
    if ('nativeSearch' in record && (!nativeSearch || typeof nativeSearch !== 'object' || Array.isArray(nativeSearch) ||
      Object.keys(nativeSearch).length !== 1 || typeof (nativeSearch as Record<string, unknown>).minimax !== 'boolean')) {
      return { ok: false, error: 'BAD_REQUEST' }
    }
    const request = record as NetworkConfigSetRequest
    const before = networkCredentialSnapshot()
    const result = networkWrite(() => {
      let view = networkConfig!.getPublic()
      if (request.enabled !== undefined) view = networkConfig!.setEnabled(request.enabled)
      if (request.fetch !== undefined) view = networkConfig!.setFetch(request.fetch)
      if (nativeSearch !== undefined) view = networkConfig!.setNativeSearch((nativeSearch as { minimax: boolean }).minimax)
      if (request.deepseekKeySource !== undefined) view = networkConfig!.setDeepSeekKeySource(request.deepseekKeySource)
      return view
    })
    // 任一项变化都让活动任务按旧凭据／旧路径宣告过的联网目标作废；关闭总闸同样撤销。
    if (result.ok && (networkCredentialChanged(before) || request.enabled === false)) agentHost?.revokeNetworkForAll?.()
    // 关闭总闸立即中止人发起的在途抓页／搜索（没有 requestId 的也由 abortAll 收掉）。
    if (result.ok && request.enabled === false) applyHumanNetworkGate(humanNetwork, false)
    return result
  })
  /** 保存服务商密钥并选中该家：**不发任何测试请求**；key 只进加密存储，不回渲染层。 */
  registerTrustedHandle(IPC.networkProviderSave, (event, value: unknown): NetworkConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'BAD_REQUEST' }
    const request = value as Partial<NetworkProviderSaveRequest>
    if (Object.keys(value).some(key => key !== 'provider' && key !== 'key')) return { ok: false, error: 'BAD_REQUEST' }
    if (typeof request.provider !== 'string' || typeof request.key !== 'string') return { ok: false, error: 'BAD_REQUEST' }
    const before = networkCredentialSnapshot()
    // provider 白名单与 key 形状都由存储层校验，避免 IPC 层与存储层两份清单走散。
    const result = networkWrite(() => networkConfig!.saveKey(request.provider as NetworkProvider, request.key as string))
    // 服务商或密钥变了：已宣告的搜索目标作废，所有活动任务撤网并 abort 在途请求。
    if (result.ok && networkCredentialChanged(before)) agentHost?.revokeNetworkForAll?.()
    return result
  })
  /** 清除某家密钥；不带参数时清当前搜索服务商（兼容旧渲染层调用）。 */
  registerTrustedHandle(IPC.networkProviderClear, (event, value: unknown): NetworkConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    let provider: NetworkProvider | undefined
    if (value !== undefined) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'BAD_REQUEST' }
      const request = value as NetworkProviderClearRequest
      if (Object.keys(value).some(key => key !== 'provider')) return { ok: false, error: 'BAD_REQUEST' }
      if (request.provider !== undefined && typeof request.provider !== 'string') return { ok: false, error: 'BAD_REQUEST' }
      provider = request.provider
    }
    const before = networkCredentialSnapshot()
    const result = networkWrite(() => networkConfig!.clearKey(provider))
    if (result.ok && networkCredentialChanged(before)) agentHost?.revokeNetworkForAll?.()
    return result
  })
  // 人发起：菜单／快捷键打开对话框，人点「抓取／搜索」即授权；总闸关闭时同样拒绝。
  // 只发人输入的 URL 或查询，不带笔记正文；异常一律收成已知机读码，原始消息不外泄。
  registerTrustedHandle(IPC.networkHumanFetch, async (event, value: unknown): Promise<HumanFetchResult> => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = humanFetchArguments(value)
    if (request === 'BAD_REQUEST') return { ok: false, error: 'BAD_REQUEST' }
    if (!humanNetwork) return { ok: false, error: 'NETWORK_NOT_AUTHORIZED' }
    try {
      const result = await humanNetwork.fetchPage(request.url, request.requestId ? { requestId: request.requestId } : undefined)
      // 返回的失败码也过白名单：出口模块未来多出的码不会顺带把新文案带进渲染层。
      return result.ok ? result : { ok: false, error: networkErrorCode(result.error) }
    } catch (error) { return { ok: false, error: networkErrorCode(error) } }
  })
  registerTrustedHandle(IPC.networkHumanSearch, async (event, value: unknown): Promise<HumanSearchResult> => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = humanSearchArguments(value)
    if (request === 'BAD_REQUEST') return { ok: false, error: 'BAD_REQUEST' }
    if (!humanNetwork) return { ok: false, error: 'NETWORK_NOT_AUTHORIZED' }
    try {
      const result = await humanNetwork.search(request.query, request.maxResults, request.requestId ? { requestId: request.requestId } : undefined)
      return result.ok ? result : { ok: false, error: networkErrorCode(result.error) }
    } catch (error) { return { ok: false, error: networkErrorCode(error) } }
  })
  /** 人主动停止：只停自己这次带上的 requestId；找不到或参数不合法都回 false，不泄露内部状态。 */
  registerTrustedHandle(IPC.networkHumanAbort, (event, value: unknown): boolean => {
    if (!trusted(event)) return false
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    if (Object.keys(record).some(key => key !== 'requestId')) return false
    if (typeof record.requestId !== 'string' || !REQUEST_ID.test(record.requestId)) return false
    return humanNetwork?.abort(record.requestId) === true
  })
  /** 外发日志只读：没有 URL、查询串、正文与凭据，坏行由日志模块自己跳过并计数。 */
  registerTrustedHandle(IPC.networkEgressLog, (event, value: unknown): EgressLogResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const limit = egressLogLimit(value)
    if (limit === 'BAD_REQUEST') return { ok: false, error: 'BAD_REQUEST' }
    if (!egressLog) return { ok: false, error: 'IO_ERROR' }
    try { return { ok: true, view: egressLog.recent(limit) } }
    catch { return { ok: false, error: 'IO_ERROR' } }
  })
  /** 外发统计只读：快照里只有计数／字节／拒绝码与时间，没有 URL、查询、正文或路径。 */
  registerTrustedHandle(IPC.networkStats, (event): NetworkStatsResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    if (!networkStats) return { ok: false, error: 'IO_ERROR' }
    try { return { ok: true, stats: networkStats.view() } }
    catch { return { ok: false, error: 'IO_ERROR' } }
  })
  /** 先清外发日志再清统计：日志失败就整体失败且统计不动，避免「只清一半」。 */
  registerTrustedHandle(IPC.networkStatsClear, (event): NetworkStatsClearResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    if (!egressLog || !networkStats) return { ok: false, error: 'IO_ERROR' }
    try { egressLog.clear() } catch { return { ok: false, error: 'IO_ERROR' } }
    try { networkStats.clear() } catch { return { ok: false, error: 'IO_ERROR' } }
    return { ok: true }
  })
  /** 模型自带联网探测：取 MiniMax 连接密钥与第一个 M3 系列模型，只发 ping；不写配置。
   *  找不到模型／没有密钥／探测失败都回同一个固定码，上游原文与密钥不进渲染层。 */
  registerTrustedHandle(IPC.networkNativeProbe, async (event): Promise<NativeSearchProbeResult> => {
    if (!trusted(event)) return { ok: false, error: 'NATIVE_SEARCH_UNAVAILABLE' }
    if (!modelConfig) return { ok: false, error: 'NATIVE_SEARCH_UNAVAILABLE' }
    try {
      const secret = modelConfig.providerSecret('minimax')
      const model = modelConfig.getPublic().models.find(item => item.provider === 'minimax' && supportsNativeSearch(item.provider, item.modelId))
      if (!model) return { ok: false, error: 'NATIVE_SEARCH_UNAVAILABLE' }
      const result = await probeNativeSearch({ baseURL: secret.baseURL, apiKey: secret.apiKey, modelId: model.modelId })
      return result.ok ? { ok: true } : { ok: false, error: 'NATIVE_SEARCH_UNAVAILABLE' }
    } catch { return { ok: false, error: 'NATIVE_SEARCH_UNAVAILABLE' } }
  })
  /** MCP 配置只回摘要；错误只过固定码白名单，store 抛出的文件系统原文不进渲染层。 */
  const MCP_STORE_CODES = new Set([
    'MCP_BAD_NAME', 'MCP_BAD_URL', 'MCP_BAD_TOKEN', 'MCP_DUPLICATE_URL', 'MCP_TOO_MANY',
    'MCP_BAD_WHITELIST', 'MCP_NOT_FOUND', 'MCP_CONFIG_UNAVAILABLE'
  ])
  const MCP_DISCOVER_CODES = new Set([
    ...MCP_STORE_CODES,
    'MCP_INVALID_URL', 'MCP_CONNECT_FAILED', 'MCP_UNAUTHORIZED', 'MCP_PROTOCOL',
    'MCP_TOOL_UNKNOWN', 'MCP_TOOL_FAILED', 'MCP_TIMEOUT', 'MCP_TOO_LARGE', 'MCP_CANCELLED'
  ])
  const mcpCode = (error: unknown, allowed: ReadonlySet<string>, fallback: string): string => {
    const message = error instanceof Error ? error.message : ''
    return allowed.has(message) ? message : fallback
  }
  const mcpView = (): McpConfigResult => {
    if (!mcpConfig) return { ok: false, error: 'MCP_CONFIG_UNAVAILABLE' }
    try { return { ok: true, config: mcpConfig.getPublic() } }
    catch { return { ok: false, error: 'MCP_CONFIG_UNAVAILABLE' } }
  }
  const mcpWrite = (run: (store: McpConfigStore) => McpConfigView): McpConfigResult => {
    if (!mcpConfig) return { ok: false, error: 'MCP_CONFIG_UNAVAILABLE' }
    try { return { ok: true, config: run(mcpConfig) } }
    catch (error) { return { ok: false, error: mcpCode(error, MCP_STORE_CODES, 'MCP_CONFIG_UNAVAILABLE') } }
  }
  registerTrustedHandle(IPC.mcpConfig, (event): McpConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    return mcpView()
  })
  registerTrustedHandle(IPC.mcpServerSave, (event, value: unknown): McpConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'BAD_REQUEST' }
    const record = value as Record<string, unknown>
    const KEYS = ['id', 'name', 'url', 'token', 'enabled', 'searchChannel', 'whitelist']
    if (Object.keys(record).some(key => !KEYS.includes(key))) return { ok: false, error: 'BAD_REQUEST' }
    if (typeof record.name !== 'string' || typeof record.url !== 'string' || typeof record.enabled !== 'boolean') return { ok: false, error: 'BAD_REQUEST' }
    if (record.searchChannel !== undefined && typeof record.searchChannel !== 'boolean') return { ok: false, error: 'BAD_REQUEST' }
    if (record.id !== undefined && (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 64)) return { ok: false, error: 'BAD_REQUEST' }
    if (record.token !== undefined && typeof record.token !== 'string') return { ok: false, error: 'BAD_REQUEST' }
    const whitelist = record.whitelist
    if (whitelist !== undefined && (!Array.isArray(whitelist) || whitelist.some(name => typeof name !== 'string'))) return { ok: false, error: 'BAD_REQUEST' }
    const request: McpServerSaveRequest = {
      name: record.name,
      url: record.url,
      enabled: record.enabled,
      ...(record.searchChannel !== undefined ? { searchChannel: record.searchChannel as boolean } : {}),
      ...(record.id !== undefined ? { id: record.id as string } : {}),
      ...(record.token !== undefined ? { token: record.token as string } : {}),
      ...(whitelist !== undefined ? { whitelist: whitelist as string[] } : {})
    }
    // 白名单只能落在已发现工具上；先按当前摘要预检，避免「服务器存了、白名单没存」的半截状态。
    if (request.whitelist !== undefined) {
      if (!request.id) return { ok: false, error: 'MCP_BAD_WHITELIST' }
      const since = mcpView()
      if (!since.ok) return since
      const target = since.config.servers.find(server => server.id === request.id)
      if (!target) return { ok: false, error: 'MCP_NOT_FOUND' }
      const known = new Set(target.tools.map(tool => tool.name))
      if (request.whitelist.some(name => !known.has(name))) return { ok: false, error: 'MCP_BAD_WHITELIST' }
    }
    const saved = mcpWrite(store => store.upsert(request))
    const result = !saved.ok || request.whitelist === undefined ? saved : mcpWrite(store => store.saveWhitelist(request.id!, request.whitelist!))
    // 配置／白名单变了：撤销所有活动任务的 MCP 授权（不取消任务），与网络配置变更同法。
    if (result.ok) agentHost?.revokeMcpForAll?.()
    return result
  })
  registerTrustedHandle(IPC.mcpServerRemove, (event, value: unknown): McpConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'BAD_REQUEST' }
    const record = value as Record<string, unknown>
    if (Object.keys(record).some(key => key !== 'id') || typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 64) {
      return { ok: false, error: 'BAD_REQUEST' }
    }
    const result = mcpWrite(store => store.remove(record.id as string))
    // 删掉一台服务器同样是配置变化：撤销活动任务的 MCP 授权，后续调用按 MCP_NOT_AUTHORIZED 拒。
    if (result.ok) agentHost?.revokeMcpForAll?.()
    return result
  })
  /**
   * 发现＝人点击触发的一次外发：只接受已存在的 id，只连配置里的 URL 与 token，
   * 带 20s AbortSignal；成功后把工具名／标题／说明存进配置并回渲染层，
   * 服务器文本、token、schema 都不回渲染层。
   */
  registerTrustedHandle(IPC.mcpDiscover, async (event, value: unknown): Promise<McpDiscoverResult> => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'BAD_REQUEST' }
    const record = value as Record<string, unknown>
    if (Object.keys(record).some(key => key !== 'id') || typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 64) {
      return { ok: false, error: 'BAD_REQUEST' }
    }
    if (!mcpConfig) return { ok: false, error: 'MCP_CONFIG_UNAVAILABLE' }
    const id = record.id
    let server: McpRuntimeServer | undefined
    try { server = mcpConfig.servers().find(entry => entry.id === id) }
    catch { return { ok: false, error: 'MCP_CONFIG_UNAVAILABLE' } }
    if (!server) return { ok: false, error: 'MCP_NOT_FOUND' }
    if (!server.credential) return { ok: false, error: 'MCP_BAD_TOKEN' }
    const client = createMcpClient({ url: server.credential.url, token: server.credential.token })
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, MCP_DISCOVER_TIMEOUT_MS)
    try {
      const discovered = await client.connect(controller.signal)
      const config = mcpWrite(store => store.saveDiscovered(id, discovered.tools))
      if (!config.ok) return config
      // 重新发现可能收窄白名单（白名单 ⊆ 已发现工具），所以也算配置变化：撤活动任务。
      agentHost?.revokeMcpForAll?.()
      const tools: McpPublicTool[] = config.config.servers.find(entry => entry.id === id)?.tools ?? []
      return { ok: true, id, tools, config: config.config }
    } catch (error) {
      // 我们自己的 20s 预算优先：transport 会把 abort 报成 MCP_CANCELLED，这里还原成超时。
      if (timedOut) return { ok: false, error: 'MCP_TIMEOUT' }
      return { ok: false, error: mcpCode(error, MCP_DISCOVER_CODES, 'MCP_CONNECT_FAILED') }
    } finally {
      clearTimeout(timer)
      client.close()
    }
  })
  registerTrustedHandle(IPC.remoteImageGet, async (_event, value: unknown): Promise<RemoteImageGetResult> => {
    if (!remoteImages || !vault || !value || typeof value !== 'object') return { ok: false, error: 'NOT_ALLOWED' }
    const request = value as import('../shared/ipc.ts').RemoteImageGetRequest
    const c = request.context
    if (typeof request.url !== 'string' || !c || typeof c.noteRelPath !== 'string' ||
        typeof c.sessionId !== 'string' || typeof c.objectVersion !== 'string' || typeof c.revision !== 'string' ||
        (c.draftBody !== undefined && (typeof c.draftBody !== 'string' || c.draftBody.length > 16 * 1024 * 1024)) ||
        (request.continuation !== undefined && typeof request.continuation !== 'string')) return { ok: false, error: 'NOT_ALLOWED' }
    try {
      const token = vault.captureSession()
      if (c.sessionId !== token) return { ok: false, error: 'NOT_ALLOWED' }
      const snapshot = await vault.read(c.noteRelPath)
      const proof = await verifyVaultImage(vault,snapshot,request)
      if (!proof.ok) return { ok: false, error: 'NOT_ALLOWED' }
      const controller = new AbortController()
      const currentVault = vault
      imageControllers.set(controller,{vault:currentVault,binding:proof.binding,request})
      let result: Awaited<ReturnType<RemoteImageService['load']>>
      try {
        result = await remoteImages.load(request.url, { mode: request.mode, allowHttp: request.allowHttp === true,
          continuation: request.continuation, binding: proof.binding, signal: controller.signal,
          validate: async () => {
            try {
              currentVault.assertSession(token)
              const checked = await verifyVaultImage(currentVault,await currentVault.read(c.noteRelPath),request)
              return checked.ok && checked.binding===proof.binding
            } catch { return false }
          } })
      } finally { imageControllers.delete(controller) }
      currentVault.assertSession(token)
      const current = await currentVault.read(c.noteRelPath)
      if (!(await verifyVaultImage(currentVault,current,request)).ok) return { ok: false, error: 'NOT_ALLOWED' }
      return result.ok ? { ok: true, src: remoteImageUrl(result.token) } : result
    } catch { return { ok: false, error: 'NOT_ALLOWED' } }
  })
  registerTrustedHandle(IPC.assistantGet, (event): AssistantResult =>
    trusted(event) ? { ok: true, habits: loadAssistantHabits(app.getPath('userData')) } : { ok: false, error: 'BAD_SENDER' })
  registerTrustedHandle(IPC.assistantSet, (event, value: unknown): AssistantResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    if (!isAssistantHabits(value)) return { ok: false, error: 'BAD_ASSISTANT' }
    try {
      saveAssistantHabits(app.getPath('userData'), value)
      return { ok: true, habits: value }
    } catch { return { ok: false, error: 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.windowChromeSet, (event, value: unknown): boolean => {
    if (typeof value !== 'boolean') return false
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    applyWorkspaceWindowChrome(win, value)
    return true
  })
  registerTrustedHandle(IPC.themeGet, () => themeMode)
  registerTrustedHandle(IPC.readingGet, () => loadReadingPreference(app.getPath('userData')))
  registerTrustedHandle(IPC.chromeTextGet, () => loadChromeTextPreference(app.getPath('userData')))
  registerTrustedHandle(IPC.chromeTextSet, (_event, value: unknown): ChromeTextSetResult => {
    if (!isChromeTextPreference(value)) return { ok: false, error: 'BAD_CHROME_TEXT' }
    try {
      saveChromeTextPreference(app.getPath('userData'), value)
      return { ok: true, preference: { ...value } }
    } catch { return { ok: false, error: 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.readingSet, (_event, value: unknown): ReadingSetResult => {
    if (!isReadingPreference(value)) return { ok: false, error: 'BAD_READING' }
    try {
      saveReadingPreference(app.getPath('userData'), value)
      return { ok: true, reading: value as ReadingPreference }
    } catch { return { ok: false, error: 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.themeSet, (_event, value: unknown): ThemeSetResult => {
    if (!isThemeMode(value)) return { ok: false, error: 'BAD_MODE' }
    try {
      saveThemePreference(app.getPath('userData'), value)
      themeMode = value
      nativeTheme.themeSource = value === 'day' ? 'light' : value === 'night' ? 'dark' : 'system'
      return { ok: true, mode: value }
    } catch {
      return { ok: false, error: 'IO_ERROR' }
    }
  })
  registerTrustedHandle(IPC.vaultTransition, (event, value: unknown) => {
    const receipt = parseVaultRestoreReceipt(value)
    if (!receipt) throw Error('BAD_REQUEST')
    return vaultSwitch?.restored(event.senderFrame, receipt, vault?.sessionId() ?? null) ?? false
  })
  registerTrustedHandle(IPC.vaultGet, () => visibleVaultState())
  registerTrustedHandle(IPC.vaultCatalog, () => ({...vaultCatalog!.view(), activeId:activeTarget?.id ?? null,activeUnavailable:!!activeTarget&&vault?.currentState().status!=='ready'}))
  registerTrustedHandle(IPC.vaultCatalogChange, async (event, request: unknown) => {
    const r=parseVaultCatalogChange(request)
    if(!r)throw Error('BAD_REQUEST')
    if(vaultSwitch?.busy)throw Error('VAULT_SWITCH_BUSY')
    const owner={caller:`${event.sender.id}:${event.senderFrame!.routingId}`,sessionId:vault?.sessionId()??null}
    if(r.action==='root-cancel'){vaultCatalog!.cancelRoot(r.previewId,owner);return vaultCatalog!.view()}
    if(r.action==='root-preview'){
      const entry=vaultCatalog!.view().entries.find(e=>e.id===r.id);if(!entry)throw Error('VAULT_NOT_REGISTERED')
      let chosen=entry.path
      if(r.choose){
        if(activeTarget?.id===r.id&&vault?.currentState().status==='ready')throw Error('ACTIVE_VAULT_RELOCATE')
        const selection=await dialog.showOpenDialog(mainWindow!,{title:'选择待核对的笔记库位置',properties:['openDirectory']})
        if(selection.canceled||!selection.filePaths[0])return vaultCatalog!.view()
        if(!trusted(event)||(vault?.sessionId()??null)!==owner.sessionId||vaultSwitch?.busy)throw Error('VAULT_CHANGED')
        chosen=selection.filePaths[0]
      }
      const target=vaultCatalog!.inspect(chosen)
      if(target.path===entry.path&&target.rootIdentity===entry.rootIdentity&&!(activeTarget?.id===entry.id&&vault?.currentState().status!=='ready'))throw Error('SOURCE_AVAILABLE')
      return {...vaultCatalog!.view(),rootPreview:vaultCatalog!.previewRoot(r.id,target,r.revision,owner)}
    }
    if(r.action==='root-confirm'){
      const target=vaultCatalog!.rootTarget(r.previewId,owner)
      if(target.id!==r.id||vaultCatalog!.view().revision!==r.revision)throw Error('STALE_PREVIEW')
      rootRecoveryIntent={previewId:r.previewId,...owner,assertOwner:()=>{if(!trusted(event)||`${event.sender.id}:${event.senderFrame!.routingId}`!==owner.caller)throw Error('BAD_SENDER')}}
      try{const state=await vaultSwitch!.run(target,event.senderFrame);return {...vaultCatalog!.view(),state}}
      finally{rootRecoveryIntent=null}
    }
    vaultCatalog!.invalidateRootPreviews()
    if (r.action === 'remove') return vaultCatalog!.remove(r.id, r.revision)
    if (r.action === 'pin' && typeof r.pinned === 'boolean') return vaultCatalog!.update(r.id, {pinned:r.pinned}, r.revision)
    if (r.action === 'label' && typeof r.label === 'string') return vaultCatalog!.update(r.id, {label:r.label}, r.revision)
    if (r.action === 'relocate') {
      const id = r.id, revision = r.revision
      if(activeTarget?.id===r.id&&vault?.currentState().status==='ready')throw Error('ACTIVE_VAULT_RELOCATE')
      if (structureGate.isBusy()) throw Error('STRUCTURE_BUSY')
      return vaultSwitch!.select(async (_run, current) => {
        const session = vault?.sessionId()
        const chosen = await dialog.showOpenDialog(mainWindow!, {title:'重新定位笔记库',properties:['openDirectory']})
        current()
        if (chosen.canceled || !chosen.filePaths[0]) return vaultCatalog!.view()
        if (vault?.sessionId() !== session) throw Error('VAULT_CHANGED')
        if (structureGate.isBusy()) throw Error('STRUCTURE_BUSY')
        if(activeTarget?.id===id&&vault?.currentState().status==='ready')throw Error('ACTIVE_VAULT_RELOCATE')
        const target=vaultCatalog!.inspect(chosen.filePaths[0]),entry=vaultCatalog!.view().entries.find(e=>e.id===id)
        if(!entry)throw Error('VAULT_NOT_REGISTERED')
        if(target.rootIdentity!==entry.rootIdentity)return {...vaultCatalog!.view(),rootPreview:vaultCatalog!.previewRoot(id,target,revision,owner)}
        return vaultCatalog!.relocate(id,target,revision)
      }, event.senderFrame)
    }
    throw Error('BAD_REQUEST')
  })
  registerTrustedHandle(IPC.vaultOpen, async (event, id: unknown) => {
    if (typeof id !== 'string') throw Error('BAD_REQUEST')
    if (vaultSwitch?.busy) throw Error('VAULT_SWITCH_BUSY')
    const entry = vaultCatalog!.view().entries.find(item => item.id === id)
    if (!entry) throw Error('VAULT_TARGET_INVALID')
    let target = vaultCatalog!.inspect(entry.path)
    if(target.rootIdentity!==entry.rootIdentity)throw Error('VAULT_REPLACED')
    if(activeTarget?.id===id&&vault?.currentState().status!=='ready')throw Error('VAULT_REPLACED')
    vaultCatalog!.invalidateRootPreviews()
    if (activeTarget?.rootIdentity === target.rootIdentity && activeTarget.path === target.path) return visibleVaultState()
    return vaultSwitch!.run(target, event.senderFrame)
  })
  registerTrustedHandle(IPC.vaultWorkspaceGet, (_event, session: unknown) => {
    if (!vault || typeof session !== 'string') throw Error('VAULT_CHANGED')
    vault.assertSession(session)
    return activeTarget ? vaultCatalog!.workspace(activeTarget) : null
  })
  registerTrustedHandle(IPC.vaultWorkspaceSave, (_event, session: unknown, workspace: unknown) => {
    if (!vault || typeof session !== 'string') throw Error('VAULT_CHANGED')
    vault.assertSession(session)
    if (activeTarget) vaultCatalog!.saveWorkspace(activeTarget, workspace)
    return true
  })
  registerTrustedHandle(IPC.vaultPick, async (event, create: unknown) => {
    if (!vault || !vaultSwitch) return { status: 'needs-pick', reason: 'first-run' }
    if (vaultSwitch.busy || structureGate.isBusy()) throw Error('VAULT_SWITCH_BUSY')
    return vaultSwitch.select(async (run, current) => {
      const session = vault?.sessionId()
      let chosen: string | undefined
      if (create === true) {
        const result = await dialog.showSaveDialog(mainWindow!, {title:'创建空笔记库',buttonLabel:'创建笔记库',defaultPath:'新笔记库'})
        current()
        if (result.canceled) return {...visibleVaultState(),cancelled:true}
        chosen = result.filePath
      } else {
        const result = await dialog.showOpenDialog(mainWindow!, {title:'打开笔记库',properties:['openDirectory','createDirectory']})
        current()
        if (result.canceled || !result.filePaths[0]) return {...visibleVaultState(),cancelled:true}
        chosen = result.filePaths[0]
      }
      if (!chosen) return visibleVaultState()
      if (vault?.sessionId() !== session) throw Error('VAULT_CHANGED')
      if (structureGate.isBusy()) throw Error('STRUCTURE_BUSY')
      vaultCatalog!.invalidateRootPreviews()
      const target = create === true ? vaultCatalog!.create(chosen) : vaultCatalog!.inspect(chosen)
      if (!vaultCatalog!.view().diagnostic) vaultCatalog!.register(target)
      if (activeTarget?.rootIdentity === target.rootIdentity && activeTarget.path === target.path) return visibleVaultState()
      return run(target)
    }, event.senderFrame)
  })
  registerTrustedHandle(IPC.treeList, async () => vault?.tree() ?? [])
  registerTrustedHandle(IPC.ledgerMaintenance,async(event,value:unknown)=>{
    const current=vault
    try{if(!value||typeof value!=='object'||Array.isArray(value))throw Error();const r=value as Record<string,unknown>
      if(Object.keys(r).some(k=>!['sessionId','objectVersion','relPath','action','previewId'].includes(k))||typeof r.sessionId!=='string'||typeof r.objectVersion!=='string'||typeof r.relPath!=='string'||!['compress','clear'].includes(String(r.action))||r.previewId!==undefined&&typeof r.previewId!=='string')throw Error()
      if(!current)throw Error();current.assertSession(r.sessionId);if(structureGate.isBusy()||agentHost?.active().length||agentHost?.hasPending())throw Error('STRUCTURE_BUSY')
      const note=await current.read(r.relPath);current.assertSession(r.sessionId);if(!current.acceptsObject(r.relPath,r.objectVersion,note.objectVersion))throw Error('NOTE_REPLACED')
      const owner=`${event.sender.id}:${event.senderFrame!.routingId}`
      if(r.previewId){const key=owner+':'+r.previewId,preview=maintenancePreviews.get(key);maintenancePreviews.delete(key);if(!preview||preview.sessionId!==r.sessionId||preview.objectVersion!==r.objectVersion||preview.relPath!==r.relPath||preview.action!==r.action)throw Error('STALE_PREVIEW');return {ok:true,value:await current.ledgerMaintenanceCommit(preview.relPath,preview.action,preview.records,preview.archive)}}
      const preview=await current.ledgerMaintenancePreview(r.relPath,r.action as 'compress'|'clear');current.assertSession(r.sessionId);const id=randomUUID();if(maintenancePreviews.size>=128)maintenancePreviews.delete(maintenancePreviews.keys().next().value!);maintenancePreviews.set(owner+':'+id,{sessionId:r.sessionId,objectVersion:r.objectVersion,relPath:r.relPath,action:r.action as 'compress'|'clear',records:preview.records,archive:preview.archive});return {ok:true,value:{id,...preview}}
    }catch{return {ok:false,error:'LEDGER_UNAVAILABLE'}}
  })
  const recoveryPreviewOwners=new Map<string,{frame:string;sessionId:string}>()
  registerTrustedHandle(IPC.ledgerRepair,async(event,value:unknown):Promise<import('../shared/ledger.ts').LedgerRepairResult>=>{
    const request=parseLedgerRepairRequest(value),current=vault,win=mainWindow
    if(!request||!current||!win)return {ok:false,error:'BAD_REQUEST'}
    try{
      current.assertSession(request.sessionId)
      const frame=`${event.sender.id}:${event.senderFrame!.routingId}`
      if(request.action==='commit'||request.action==='cancel'){
        const owner=recoveryPreviewOwners.get(request.previewId);recoveryPreviewOwners.delete(request.previewId)
        if(owner?.frame!==frame||owner.sessionId!==request.sessionId)throw Error('STALE_PREVIEW')
        if(request.action==='cancel'){current.ledgerRecoveryCancel(request.previewId);return {ok:true}}
      }
      if(structureGate.isBusy())throw Error('STRUCTURE_BUSY')
      const context={sessionId:request.sessionId,operationId:randomUUID()}
      const root=current.requireUsableRoot()
      const result=await structureGate.recover(root,{
        host:agentHost??undefined,action:request.action,
        isComplete:result=>'status' in result&&result.status==='complete',
        assert:()=>{if(current!==vault||current.requireUsableRoot()!==root)throw Error('VAULT_CHANGED');current.assertSession(request.sessionId)},
        quiesce:async()=>{
          consolidation?.cancel(undefined,'MEMORY_SESSION_CLOSED');await consolidation?.idle()
        },
        prepare:()=>flushBeforeStructure(win,[],`recovery-${request.action}`,context),
        drain:()=>current.idle(),
        release:()=>{if(!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send(IPC.lifecycleFlushRequest,context.operationId,[],'recovery-release',context)}
      },async()=>{
        if(request.action==='preview'){
          const preview=await current.ledgerRecoveryPreview(request.mode)
          if(recoveryPreviewOwners.size>=16)recoveryPreviewOwners.clear()
          recoveryPreviewOwners.set(preview.id,{frame,sessionId:request.sessionId});return preview
        }
        // A recovery authorization never carries old sending or background permits.
        authorizations?.clear();memoryIpc.clear();memoryAuthorizationPreviews.clear()
        const result=request.action==='commit'?await current.ledgerRecoveryCommit(request.previewId):await current.ledgerRecoveryResume(request.revision)
        return result
      })
      return {ok:true,value:result}
    }catch(error){const code=error instanceof Error?error.message:'';return {ok:false,error:['BAD_REQUEST','STALE_PREVIEW','STALE_RECOVERY','VAULT_CHANGED','STRUCTURE_BUSY','UNSAVED_DRAFT','PERMISSIONS_INVALID','LEDGER_RECOVERY_AMBIGUOUS','LEDGER_REGISTRY_INVALID','LIFECYCLE_RECOVERY_REQUIRED'].includes(code)?code:'LEDGER_REGISTRY_INVALID'}}
  })
  // 外部消失的重扫与核验恢复：只有人能点，判据全在库层；这里不加任何删除或替代路径。
  registerTrustedHandle(IPC.recoveryScan,async(_event,value:unknown):Promise<import('../shared/ipc.ts').RecoveryScanResult>=>{
    const current=vault
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>
      if(Object.keys(r).sort().join()!=='sessionId'||typeof r.sessionId!=='string')throw Error('BAD_REQUEST')
      if(!current)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      return {ok:true,value:await current.recoveryScan()}
    }catch(error){const code=error instanceof Error?error.message:'';return {ok:false,error:['BAD_REQUEST','NO_VAULT','VAULT_CHANGED','LIFECYCLE_RECOVERY_REQUIRED','MISSING_RECORD_LIMIT'].includes(code)?code:'RECOVERY_UNAVAILABLE'}}
  })
  registerTrustedHandle(IPC.recoveryConfirm,async(_event,value:unknown):Promise<import('../shared/ipc.ts').RecoveryConfirmResult>=>{
    const current=vault
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>
      if(Object.keys(r).sort().join()!=='relPath,sessionId'||typeof r.sessionId!=='string'||typeof r.relPath!=='string'||r.relPath.length>4096)throw Error('BAD_REQUEST')
      if(!current)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      return {ok:true,...await current.recoveryConfirm(r.relPath)}
    }catch(error){const code=error instanceof Error?error.message:'';return {ok:false,error:['BAD_REQUEST','NO_VAULT','VAULT_CHANGED','STALE_PREVIEW','LIFECYCLE_RECOVERY_REQUIRED'].includes(code)?code:'RECOVERY_UNAVAILABLE'}}
  })
  // 放弃恢复：只清库内记录、释放路径；不提供删除或替代路径，也不动系统废纸篓。
  registerTrustedHandle(IPC.recoveryAbandon,async(_event,value:unknown):Promise<import('../shared/ipc.ts').RecoveryAbandonResult>=>{
    const current=vault
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>
      if(Object.keys(r).sort().join()!=='relPath,sessionId'||typeof r.sessionId!=='string'||typeof r.relPath!=='string'||r.relPath.length>4096)throw Error('BAD_REQUEST')
      if(!current)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      const result=await current.recoveryAbandon(r.relPath)
      current.assertSession(r.sessionId)
      return {ok:true,...result}
    }catch(error){const code=error instanceof Error?error.message:'';return {ok:false,error:['BAD_REQUEST','NO_VAULT','VAULT_CHANGED','STALE_PREVIEW','LIFECYCLE_RECOVERY_REQUIRED'].includes(code)?code:'RECOVERY_UNAVAILABLE'}}
  })
  registerTrustedHandle(IPC.ledgerReasoning,async(_event,value:unknown):Promise<import('../shared/ledger.ts').LedgerReasoningResult>=>{
    const current=vault
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>;if(Object.keys(r).sort().join()!=='objectVersion,relPath,sessionId,taskId'||typeof r.relPath!=='string'||typeof r.sessionId!=='string'||typeof r.objectVersion!=='string'||typeof r.taskId!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(r.taskId))throw Error('BAD_REQUEST')
      if(!current||!reasoningStore)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      const note=await current.read(r.relPath);current.assertSession(r.sessionId);if(!current.acceptsObject(r.relPath,r.objectVersion,note.objectVersion))throw Error('NOTE_REPLACED')
      const record=await current.ledgerRecord(r.relPath,r.taskId);current.assertSession(r.sessionId)
      return {ok:true,text:record.state==='cleared'?null:record.legacyReasoning??reasoningStore.read(current.memoryContext().vaultKey,r.taskId)}
    }catch{return {ok:false,error:'LEDGER_UNAVAILABLE'}}
  })
  registerTrustedHandle(IPC.diagnosticsGet,async(event,value:unknown)=>{
    const current=vault
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>
      if(Object.keys(r).sort().join()!=='relPath,sessionId'||typeof r.sessionId!=='string'||typeof r.relPath!=='string')throw Error('BAD_REQUEST')
      if(!current)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      return {ok:true,value:{failures:current.taskFailures(r.relPath),preflight:preflightDiagnostics.all()}}
    }catch(e){const code=e instanceof Error?e.message:'';return {ok:false,error:['BAD_REQUEST','NO_VAULT','VAULT_CHANGED'].includes(code)?code:'DIAGNOSTICS_UNAVAILABLE'}}
  })
  registerTrustedHandle(IPC.diagnosticsReport,async(event,value:unknown)=>{
    const current=vault
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>
      if(Object.keys(r).some(k=>!['sessionId','code','stage','detail'].includes(k))||typeof r.sessionId!=='string'||typeof r.code!=='string'||!r.code||r.code.length>128||typeof r.stage!=='string'||!['preflight','provider','stream','tool','finalize','ledger'].includes(r.stage))throw Error('BAD_REQUEST')
      if(!current)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      const failure=makeTaskFailure({code:r.code,diagnosticId:randomUUID(),stage:r.stage as never,detail:r.detail})
      preflightDiagnostics.record({code:failure.code,family:failure.family,stage:failure.stage,action:failure.action,retryable:failure.retryable,message:failure.message,...(failure.detail?{detail:failure.detail}:{})})
      return {ok:true}
    }catch(e){const code=e instanceof Error?e.message:'';return {ok:false,error:['BAD_REQUEST','NO_VAULT','VAULT_CHANGED'].includes(code)?code:'DIAGNOSTICS_UNAVAILABLE'}}
  })
  registerTrustedHandle(IPC.diagnosticsForget,async(event,value:unknown)=>{
    const current=vault
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>
      if(Object.keys(r).sort().join()!=='sessionId,taskId'||typeof r.sessionId!=='string'||typeof r.taskId!=='string')throw Error('BAD_REQUEST')
      if(!current)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      current.forgetTaskFailure(r.taskId)
      return {ok:true}
    }catch(e){const code=e instanceof Error?e.message:'';return {ok:false,error:['BAD_REQUEST','NO_VAULT','VAULT_CHANGED'].includes(code)?code:'DIAGNOSTICS_UNAVAILABLE'}}
  })
  registerTrustedHandle(IPC.ledgerGet,async(_event,value:unknown)=>{
    const current=vault,token=current?.sessionId()
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>;if(Object.keys(r).some(k=>!['relPath','sessionId','objectVersion','cursor'].includes(k))||typeof r.relPath!=='string'||typeof r.sessionId!=='string'||typeof r.objectVersion!=='string'||r.cursor!==undefined&&r.cursor!==null&&(typeof r.cursor!=='string'||r.cursor.length>512))throw Error('BAD_REQUEST')
      if(!current)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      const note=await current.read(r.relPath);current.assertSession(r.sessionId);if(!current.acceptsObject(r.relPath,r.objectVersion,note.objectVersion))throw Error('NOTE_REPLACED')
      return {ok:true,value:await current.ledgerPage(r.relPath,(r.cursor??null) as string|null)}
    }catch(e){const code=e instanceof Error?e.message:'';return {ok:false,error:['BAD_REQUEST','NO_VAULT','VAULT_CHANGED','NOTE_REPLACED','LEDGER_REGISTRY_INVALID','LEDGER_OWNERSHIP_UNVERIFIED','LEDGER_RECORD_INVALID','LEDGER_CONFLICT'].includes(code)?code:'LEDGER_UNAVAILABLE',...(code==='LEDGER_REGISTRY_INVALID'&&current?.sessionId()===token?{registryRevision:current?.ledgerRegistryRevision()}: {})}}
  })
  registerTrustedHandle(IPC.ledgerHistory,async(_event,value:unknown):Promise<import('../shared/ledger.ts').LedgerHistoryResult>=>{
    const current=vault
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>
      if(Object.keys(r).some(k=>!['sessionId','action','noteId'].includes(k))||typeof r.sessionId!=='string'||(r.action!=='list'&&r.action!=='purge')||r.action==='purge'&&typeof r.noteId!=='string'||r.action==='list'&&r.noteId!==undefined)throw Error('BAD_REQUEST')
      if(!current)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      if(r.action==='list'){const value=await current.ledgerHistoryList();return {ok:true,entries:value.entries,bytes:value.bytes}}
      const result=await current.ledgerHistoryPurge(r.noteId as string)
      return result.ok?{ok:true,purged:r.noteId as string}:result
    }catch(e){const code=e instanceof Error?e.message:'';return {ok:false,error:['BAD_REQUEST','NO_VAULT','VAULT_CHANGED','LEDGER_CONFLICT','HISTORY_NOT_FOUND','LEDGER_STORAGE_INVALID'].includes(code)?code:'LEDGER_UNAVAILABLE'}}
  })
  registerTrustedHandle(IPC.ledgerGetTrash,async(_event,value:unknown)=>{
    const current=vault
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>
      if(Object.keys(r).some(k=>!['trashId','sessionId','cursor'].includes(k))||typeof r.trashId!=='string'||typeof r.sessionId!=='string'||r.cursor!==undefined&&r.cursor!==null&&typeof r.cursor!=='string')throw Error('BAD_REQUEST')
      if(!current)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      return {ok:true,value:await current.ledgerTrashPage(r.trashId,(r.cursor??null) as string|null)}
    }catch(e){const code=e instanceof Error?e.message:'';return {ok:false,error:['BAD_REQUEST','NO_VAULT','VAULT_CHANGED','LEDGER_REGISTRY_INVALID','LEDGER_RECORD_INVALID','LEDGER_CONFLICT'].includes(code)?code:'LEDGER_UNAVAILABLE'}}
  })
  registerTrustedHandle(IPC.ledgerMigrate,async(_event,value:unknown)=>{
    try{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST');const r=value as Record<string,unknown>
      if(Object.keys(r).sort().join()!=='after,sessionId'||typeof r.sessionId!=='string'||r.after!==null&&(typeof r.after!=='string'||r.after.length>4096))throw Error('BAD_REQUEST')
      if(!vault)throw Error('NO_VAULT');vault.assertSession(r.sessionId);if(structureGate.isBusy()||agentHost?.active().length)throw Error('STRUCTURE_BUSY')
      return {ok:true,value:await vault.ledgerMigrateBatch(r.after as string|null)}
    }catch{return {ok:false,error:'LEDGER_MIGRATION_FAILED'}}
  })
  registerTrustedHandle(IPC.noteRead, async (_event, relPath: unknown) => {
    const pathInVault = asString(relPath)
    if (!pathInVault) throw new Error('BAD_PATH')
    if (!vault) throw new Error('NO_VAULT')
    return vault.readOpened(pathInVault)
  })
  registerTrustedHandle(IPC.noteWrite, async (_event, value: unknown) => {
    const request = parseNoteWriteRequest(value)
    if (!request) return { ok: false, error: 'BAD_PATH' }
    if (!vault) return { ok: false, error: 'NO_VAULT' }
    if (blocksStructureWrite(request.relPath)) return { ok: false, error: 'NOTE_BUSY' }
    const current=vault,root=current.root
    try {
      const result = await current.write(request.relPath, request.content, request.expectedRevision, request)
      current.assertSession(request.sessionId)
      // 人自己修好语法并成功保存后，给这篇之前写入失败的生成内容一次补存机会。
      if (root && agentHost?.pendingPaths(root).includes(request.relPath)) {
        void agentHost.retryPending(root, request.relPath).catch(() => { /* 仍未落盘：保留待保存内容 */ })
      }
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: err instanceof Error && ['CONFLICT', 'NOTE_MISSING', 'NOTE_REPLACED', 'NOTE_UNREADABLE', 'VAULT_CHANGED', 'LEDGER_BOUNDARY_INVALID', 'LIFECYCLE_RECOVERY_REQUIRED'].includes(err.message) ? err.message : 'IO_ERROR' }
    }
  })
  const parseBinding = (value: unknown): import('../shared/ipc.ts').NoteInspectRequest | null => {
    if (!value || typeof value !== 'object') return null
    const r = value as import('../shared/ipc.ts').NoteInspectRequest
    return typeof r.relPath === 'string' && typeof r.sessionId === 'string' && typeof r.objectVersion === 'string' ? r : null
  }
  registerTrustedHandle(IPC.noteInspect, async (_event, value: unknown) => {
    const r = parseBinding(value)
    if (!r || !vault) throw new Error('BAD_REQUEST')
    const current=vault,root=current.root
    const state = await current.noteStatus(r.relPath, r);current.assertSession(r.sessionId)
    if (state.status !== 'ready') {
      for (const task of agentHost?.active().filter(t => t.root === root && t.relPath === r.relPath) ?? []) {
        await agentHost?.cancel(task.id, 'user').catch(() => {})
        current.assertSession(r.sessionId)
      }
      vault.assertSession(r.sessionId)
    }
    return state
  })
  registerTrustedHandle(IPC.noteAbandon, async (_event, value: unknown) => {
    if(!value||typeof value!=='object'||Array.isArray(value))return false
    if(Object.keys(value).some(k=>!['relPath','sessionId','objectVersion','sourceSessionId'].includes(k)))return false
    const supplied=value as import('../shared/ipc.ts').NoteInspectRequest
    if(supplied.sourceSessionId!==undefined&&(typeof supplied.sourceSessionId!=='string'||!supplied.sourceSessionId||supplied.sourceSessionId.length>128))return false
    if(supplied?.sourceSessionId&&vault){
      if(![supplied.sessionId,supplied.objectVersion,supplied.relPath].every(v=>typeof v==='string'&&!!v))return false
      vault.assertSession(supplied.sessionId)
      const proof=vault.protectedRootSource(supplied.sourceSessionId,supplied.relPath,supplied.objectVersion)
      if(!proof||protectedRootCaller!==`${_event.sender.id}:${_event.senderFrame!.routingId}`)return false
      const chapters=agentHost?.pendingChapters(proof.root,supplied.relPath,supplied.sourceSessionId,supplied.objectVersion)??[]
      agentHost?.acknowledgeCopied(proof.root,supplied.relPath,chapters);vault.discardRootSource(supplied.sourceSessionId,supplied.relPath,supplied.objectVersion);return true
    }
    const r = parseBinding(value)
    if (!r || !vault) return false
    const current=vault,root=current.root!
    current.assertSession(r.sessionId)
    const status=await current.noteStatus(r.relPath, r);current.assertSession(r.sessionId)
    if (status.status === 'ready') return false
    for (const task of agentHost?.active().filter(t => t.root === root && t.relPath === r.relPath) ?? []) {await agentHost?.cancel(task.id, 'user').catch(() => {});current.assertSession(r.sessionId)}
    const chapters = agentHost?.pendingChapters(root, r.relPath, r.sessionId, r.objectVersion) ?? []
    agentHost?.acknowledgeCopied(root, r.relPath, chapters)
    return true
  })
  registerTrustedHandle(IPC.noteSaveCopyPreview, async (_event, value: unknown) => {
    if (!value || typeof value !== 'object' || !vault || structureGate.isBusy()) return { ok: false, error: 'BAD_REQUEST' }
    if(Array.isArray(value)||Object.keys(value).some(k=>!['sessionId','sourceSessionId','objectVersion','source','target','body','draftVersion'].includes(k)))return {ok:false,error:'BAD_REQUEST'}
    const r = value as import('../shared/ipc.ts').SaveCopyPreviewRequest
    if(r.sourceSessionId!==undefined&&(typeof r.sourceSessionId!=='string'||!r.sourceSessionId||r.sourceSessionId.length>128))return {ok:false,error:'BAD_REQUEST'}
    if (![r.source,r.target,r.body,r.draftVersion,r.sessionId,r.objectVersion].every(v => typeof v === 'string') || r.body.length > 16*1024*1024) return { ok:false,error:'BAD_REQUEST' }
    try {
      const current = vault; const root = current.root!
      current.assertSession(r.sessionId)
      if(r.sourceSessionId){
        if(protectedRootCaller!==`${_event.sender.id}:${_event.senderFrame!.routingId}`||!current.protectedRootSource(r.sourceSessionId,r.source,r.objectVersion))throw Error('STALE_PREVIEW')
        return {ok:true,preview:await current.previewSaveCopy(r,[])}
      }
      await agentHost?.whenLaunchesSettled()
      for (const task of agentHost?.active().filter(t=>t.root===root && t.relPath===r.source) ?? []) await agentHost?.cancel(task.id, 'user').catch(()=>{})
      current.assertSession(r.sessionId)
      const chapters = agentHost?.pendingChapters(root,r.source,r.sessionId,r.objectVersion) ?? []
      const preview = await current.previewSaveCopy(r,chapters)

      return {ok:true,preview}
    } catch(error) { return {ok:false,error:error instanceof Error ? error.message : 'IO_ERROR'} }
  })
  registerTrustedHandle(IPC.noteSaveCopyCommit, async (_event,value:unknown) => {
    if (!value || typeof value !== 'object' || !vault || structureGate.isBusy()) return {ok:false,error:'BAD_REQUEST'}
    const r = value as import('../shared/ipc.ts').SaveCopyCommitRequest
    if (![r.id,r.sessionId,r.draftVersion,r.body].every(v=>typeof v==='string') || r.body.length>16*1024*1024) return {ok:false,error:'BAD_REQUEST'}
    const prepared = vault.saveCopyRequestById(r.id)
    const c = prepared ? {relPath:prepared.source,sessionId:prepared.sessionId,objectVersion:prepared.objectVersion} : null
    if (!c || c.sessionId !== r.sessionId) return {ok:false,error:'STALE_PREVIEW'}
    try {
      const current=vault; const root=current.root!
      current.assertSession(r.sessionId)
      if(prepared?.sourceSessionId){if(protectedRootCaller!==`${_event.sender.id}:${_event.senderFrame!.routingId}`)throw Error('STALE_PREVIEW');return {ok:true,...await current.commitSaveCopy(r,[],()=>{if(!trusted(_event)||protectedRootCaller!==`${_event.sender.id}:${_event.senderFrame!.routingId}`)throw Error('BAD_SENDER')})}}
      const chapters=agentHost?.pendingChapters(root,c.relPath,c.sessionId,c.objectVersion) ?? []
      const result=await current.commitSaveCopy(r,chapters)
      current.assertSession(r.sessionId)
      agentHost?.acknowledgeCopied(root,c.relPath,chapters)
      return {ok:true,...result}
    } catch(error) { return {ok:false,error:error instanceof Error ? error.message : 'IO_ERROR'} }
  })
  registerTrustedHandle(IPC.permissionsGet, async () => vault?.permissions() ?? { status: 'invalid', error: '未选择库' })
  registerTrustedHandle(IPC.permissionsSet, async (_event, value: unknown) => {
    const request = parseSetPermissionRequest(value)
    if (!request) throw new Error('BAD_PERMISSION')
    if (!vault) throw new Error('NO_VAULT')
    return vault.setPermission(request.relPath, request.tier)
  })
  registerTrustedHandle(IPC.noteCreate, async (_event, name: unknown) => {
    const request = typeof name === 'string'
      ? { name: parseNoteName(name), parent: '', sessionId: undefined }
      : parseEntryCreateRequest(name)
    if (!request?.name) throw new Error('BAD_PATH')
    if (!vault) throw new Error('NO_VAULT')
    if (request.sessionId !== undefined) vault.assertSession(request.sessionId)
    return vault.create(request.name, request.parent, { humanInitiated: true })
  })
  registerTrustedHandle(IPC.folderCreate, async (_event, value: unknown) => {
    const request = parseEntryCreateRequest(value)
    if (!request || !vault) throw new Error('BAD_PATH')
    if (request.sessionId !== undefined) vault.assertSession(request.sessionId)
    return vault.createFolder(request.name, request.parent, { humanInitiated: true })
  })
  registerTrustedHandle(IPC.relocationPreview, async (event, value: unknown): Promise<RelocationPreviewResult> => {
    const request = parseRelocationPreviewRequest(value)
    if (!trusted(event) || !request || !vault) return { ok: false, error: 'BAD_PATH' }
    try {
      // 与 AI 结构工具同一条路径：抽取后的共用实现，行为与错误码完全一致。
      return { ok: true, preview: await relocationPreviewShared(request) }
    } catch (error) { return { ok: false, error: lifecycleError(error, 'PREVIEW_FAILED') } }
  })
  registerTrustedHandle(IPC.relocationCommit, async (event, value: unknown): Promise<RelocationCommitResult> => {
    const request = parseRelocationCommitRequest(value)
    if (!trusted(event) || !request || !vault) return { ok: false, error: 'BAD_REQUEST' }
    try {
      const outcome = await relocationCommitShared(request.id, request.repairLinks)
      return { ok: true, moved: outcome.moved, unrepaired: outcome.unrepaired }
    } catch (error) { return { ok: false, error: lifecycleError(error, 'COMMIT_FAILED') } }
  })
  registerTrustedHandle(IPC.lifecycleStatus, async (event) => {
    if (!trusted(event) || !vault) throw new Error('NO_VAULT')
    return vault.lifecycleStatus()
  })
  registerTrustedHandle(IPC.lifecycleRetry, async (event, value: unknown): Promise<LifecycleRetryResult> => {
    const request = parseLifecycleRetryRequest(value)
    const currentVault = vault
    const win = mainWindow
    if (!trusted(event) || !request || !currentVault || !win) return { ok: false, error: 'BAD_REQUEST' }
    if (structureGate.isBusy()) return { ok: false, error: 'STRUCTURE_BUSY' }
    let entered = false
    try {
      currentVault.assertSession(request.sessionId)
      const root = currentVault.root!
      const scope = currentVault.lifecycleRecoveryScope(request)
      structureGate.begin({ root, exact: scope.relPaths, prefixes: scope.moved.flatMap((move) => [move.from, move.to]) })
      entered = true
      await agentHost?.whenLaunchesSettled()
      currentVault.assertSession(request.sessionId)
      // An active recovery record already fails all model requests closed.
      memoryIpc.clear()
      consolidation?.cancel()
      memoryAuthorizationPreviews.clear()
      // Stop streams; keep unrelated unsaved output in Host memory until policy is stable again.
      try { await agentHost?.cancelAll('user', root) } catch { /* pending paths are checked below */ }
      currentVault.assertSession(request.sessionId)
      if (agentHost?.pendingPaths(root).some((relPath) => structureGate.affects(root, relPath))) {
        throw new Error('PREVIOUS_TASK_UNSAVED')
      }
      // A journal-bound clean tab may still point to an already moved object.
      // Only recovery can exempt these paths; dirty drafts never qualify.
      if (!(await flushBeforeStructure(win, scope.relPaths))) throw new Error('UNSAVED_DRAFT')
      currentVault.assertSession(request.sessionId)
      structureGate.seal()
      const outcome = await currentVault.lifecycleRetry(request)
      currentVault.assertSession(request.sessionId)
      try { await agentHost?.retryPending(root) } catch { /* retain output; structural recovery succeeded */ }
      currentVault.assertSession(request.sessionId)
      return { ok: true, moved: outcome.moved.map(({ from, to }) => ({ from, to })), unrepaired: outcome.unrepaired,
        hostPending: agentHost?.hasPending(root) ?? false }
    } catch (error) { return { ok: false, error: lifecycleError(error, 'LIFECYCLE_RECOVERY_REQUIRED') } }
    finally { if (entered) structureGate.finish() }
  })
  registerTrustedOn(IPC.lifecycleFlushDone, (event, value: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !value || typeof value !== 'object') return
    const response = value as {id?:unknown;ok?:unknown;heldObjects?:unknown}
    const held=response.heldObjects
    const valid=Array.isArray(held)&&held.length<=8192&&held.every(v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()==='objectVersion,relPath'&&typeof v.relPath==='string'&&typeof v.objectVersion==='string'&&v.relPath.length<=4096&&v.objectVersion.length<=256)
    if(typeof response.id==='string')lifecycleFlushes.get(response.id)?.(response.ok===true,valid?held:undefined)
  })
  registerTrustedHandle(IPC.backlinks, async (_event, relPath: unknown) => {
    const pathInVault = asString(relPath)
    if (!pathInVault) return []
    return vault?.backlinks(pathInVault) ?? []
  })
  registerTrustedHandle(IPC.search, async (_event, query: unknown) => {
    const text = asString(query)
    if (text == null) return []
    return vault?.search(text) ?? []
  })
  registerTrustedOn(IPC.flushDone, (event, payload: unknown) => {
    const win = mainWindow
    if (!win || event.sender !== win.webContents) return
    runCloseAction(closeFlow.flushed(parseFlushDone(payload).ok), win)
  })
}

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
else app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus() } })

if (ownsInstance) app.whenReady().then(() => {
  themeMode = loadThemePreference(app.getPath('userData'))
  nativeTheme.themeSource = themeMode === 'day' ? 'light' : themeMode === 'night' ? 'dark' : 'system'
  try { modelConfig = createModelConfigStore(app.getPath('userData'), safeStorage) }
  catch (error) { modelConfigError = error instanceof Error ? error.message : 'MODEL_CONFIG_UNAVAILABLE' }
  // Install the managed cache before any vault retirement callback can run.
  summaryCache=new SummaryCache(path.join(app.getPath('userData'),'context-cache-v2'))
  vaultCatalog = new VaultCatalog(app.getPath('userData'))
  vault = new VaultSession(app.getPath('userData'), send, undefined,(root,identity)=>vaultCatalog?.view().entries.find(e=>e.path===root&&e.rootIdentity===identity)?.id??null,()=>{consolidation?.cancel();summaryCache?.invalidateAll()})
  const catalog = vaultCatalog.view()
  if (catalog.diagnostic) startupVaultState = {status:'needs-pick',reason:'missing',diagnostic:'设备库目录记录无法读取。原记录已保留，请检查本机存储；仍可手动打开笔记库。'}
  try {
    const last = catalog.entries.find(item => item.id === catalog.lastVaultId)
    if (last) {
      const target = vaultCatalog.inspect(last.path)
      if (target.rootIdentity !== last.rootIdentity) throw Error(sameRootInode(target.rootIdentity, last.rootIdentity) ? 'VAULT_REMOUNTED' : 'VAULT_REPLACED')
      const state = vault.restoreVerified(target.path, target.rootIdentity)
      if (state.status !== 'ready') throw Error('VAULT_TARGET_CHANGED')
      activeTarget = target
    } else if (catalog.revision === 'missing') {
      let legacy: ReturnType<typeof parseStoredVault> = null
      try { legacy = parseStoredVault(readFileSync(path.join(app.getPath('userData'), 'vault.json'), 'utf8')) } catch {}
      if (legacy) {
        const target = vaultCatalog.inspect(legacy.path)
        vaultCatalog.committed(target)
        const state = vault.restoreVerified(target.path, target.rootIdentity)
        if (state.status !== 'ready') throw Error('VAULT_TARGET_CHANGED')
        activeTarget = target
      }
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    // 三种情况分开说：卷重新挂载（可一键确认）、同路径被替换、找不到。
    startupVaultState = {status:'needs-pick',reason:'missing',diagnostic: code === 'VAULT_REMOUNTED'
      ? '登记的目录身份发生变化，可能与卷重新挂载有关。请在「已登记的笔记库」预览并明确确认新关联。'
      : code === 'VAULT_REPLACED'
        ? '上次使用的笔记库可能已被同路径的其他目录替换。请手动选择并核对目标。'
        : '上次使用的笔记库无法打开，可能已移动、无法访问或被同路径的其他目录替换。请手动选择并核对目标。'}
  }
  vaultSwitch = new VaultSwitch({
    check: target => {
      const current = vaultCatalog!.inspect(target.path)
      if (current.rootIdentity !== target.rootIdentity) throw Error('VAULT_TARGET_CHANGED')
      if (structureGate.isBusy()) throw Error('STRUCTURE_BUSY')
    },
    prepare: async (_target, current) => {
      if(rootRecoveryIntent){
        const sessionId=vault?.sessionId()
        if(sessionId){
          const context={sessionId,operationId:vaultSwitch!.operationId}
          if(mainWindow&&!await flushBeforeStructure(mainWindow,[],'settings',context))throw Error('VAULT_SWITCH_CANCELLED')
          current();rootRecoveryHold=context
          if(mainWindow&&!await flushBeforeStructure(mainWindow,[],'root-recovery-protect',context))throw Error('UNSAVED_DRAFT')
          current();consolidation?.cancel(undefined,'MEMORY_SESSION_CLOSED');await consolidation?.idle();current()
          await agentHost?.whenLaunchesSettled();current()
          if(vault?.root)await agentHost?.cancelAll('vault-change',vault.root).catch(()=>{})
          agentHost?.clearNetworkPreviews?.()
          await agentHost?.whenLaunchesSettled();current();await vault!.idle();current()
          vault!.protectRootDrafts(sessionId,rootHeldObjects??[]);rootHeldObjects=null;protectedRootCaller=rootRecoveryIntent.caller
        }
        return
      }
      const context={sessionId:vault?.sessionId()??'',operationId:vaultSwitch!.operationId}
      if (mainWindow && !await flushBeforeStructure(mainWindow, [], 'settings', context)) throw Error('VAULT_SWITCH_CANCELLED')
      current()
      await agentHost?.whenLaunchesSettled(); current()
      if (agentHost?.active().length && mainWindow) {
        const choice = await dialog.showMessageBox(mainWindow, {type:'question', title:'切换笔记库', message:'停止当前任务并切换笔记库？', detail:'已经生成的回答会保存。切换后不会自动重新启动这些任务。', buttons:['留在当前库','停止任务并切换'], defaultId:0, cancelId:0})
        current()
        if (choice.response !== 1) throw Error('VAULT_SWITCH_CANCELLED')
      }
      if (mainWindow && !await flushBeforeStructure(mainWindow, [], 'freeze', context)) throw Error('VAULT_SWITCH_CANCELLED')
      current()
      const previous = vault?.root
      consolidation?.cancel(undefined,'MEMORY_SESSION_CLOSED')
      await consolidation?.idle(); current()
      if (previous) {
        try { await agentHost?.cancelAll('vault-change', previous) } catch {}
        // 切库是预览缓存的硬边界：不把上一库的抓页正文留给下一库。
        agentHost?.clearNetworkPreviews?.()
        current()
        await agentHost?.retryPending(previous); current()
        await agentHost?.whenLaunchesSettled(); current()
        consolidation?.cancel(undefined,'MEMORY_SESSION_CLOSED')
        await consolidation?.idle(); current()
        if (agentHost?.active().length) throw Error('OTHER_TASK_RUNNING')
        if (agentHost?.hasPending(previous)) throw Error('PREVIOUS_TASK_UNSAVED')
      }
    },
    flush: async () => !!rootRecoveryIntent || !vault?.root || !!mainWindow && await flushBeforeStructure(mainWindow,[],undefined,{sessionId:vault?.sessionId()??'',operationId:vaultSwitch!.operationId}),
    commit: async target => {
      const protectedSessionId=rootRecoveryIntent?.sessionId??undefined
      if(rootRecoveryIntent){rootRecoveryIntent.assertOwner();target=vaultCatalog!.confirmRoot(rootRecoveryIntent.previewId,{caller:rootRecoveryIntent.caller,sessionId:rootRecoveryIntent.sessionId})}
      const state = await vault!.openVerified(target.path, target.rootIdentity)
      activeTarget = target
      startupVaultState = null
      memoryIpc.clear(); memoryAuthorizationPreviews.clear(); maintenancePreviews.clear(); authorizations?.clear()
      for (const controller of imageControllers.keys()) controller.abort()
      try { const entry = vaultCatalog!.committed(target); activeTarget = {...target,id:entry.id,label:entry.label} }
      catch { if (state.status === 'ready') state.diagnostic = '库已打开，但设备库目录未保存。请检查本机存储后重试。' }
      return state.status === 'ready' ? {...visibleVaultState(), vaultChanged:state.vaultChanged,...(protectedSessionId?{protectedSessionId}:{}), ...(state.diagnostic?{diagnostic:state.diagnostic}:{})} as VaultState : state
    },
    changed: (phase, closePending, operationId) => send(IPC.vaultTransition, {busy:phase!=='idle',session:vault?.sessionId()??null,phase,closePending,operationId}),
    handoff: (state, id, _owner, retry) => {
      const sessionId=vault?.sessionId()??null
      const result:VaultState=state.status==='ready'?{...state,restoreId:id,sessionId:sessionId!}:{...state,restoreId:id,sessionId}
      if (retry) send(IPC.vaultTransition,{busy:true,session:sessionId,phase:'restoring',restoreId:id})
      return {result,sessionId}
    },
    close: () => { if(mainWindow)requestWindowClose(mainWindow) },
    stalled: (phase,ticket) => {
      const win=mainWindow
      if(!win||win.isDestroyed())return
      void dialog.showMessageBox(win,{type:'warning',title:'笔记库交接没有完成',
        message:phase==='restoring'?'新库已提交，但工作区恢复尚未确认。':'新库提交仍未完成，当前操作保持保护。',
        detail:'原库保存结果与库内恢复记录保留。可以重试核验，或取消关闭并保留窗口。明确放弃关闭不会续跑任务或恢复许可。',
        buttons:[phase==='restoring'?'重试恢复':'继续等待核验','取消关闭并保留窗口','明确放弃未保存修改并退出应用'],defaultId:0,cancelId:1,noLink:true
      }).then(({response})=>{
        if(win.isDestroyed()||!vaultSwitch?.isCurrentStall(ticket)||vaultSwitch.phase!==phase)return
        if(response===2){quitting=true;runCloseAction('close',win);return}
        if(response===1)vaultSwitch.cancelClose()
        if(phase==='restoring')vaultSwitch.retryRestore(win.webContents.mainFrame)
        else vaultSwitch.continueWaiting()
      }).catch(()=>{if(vaultSwitch?.isCurrentStall(ticket)){vaultSwitch.cancelClose();vaultSwitch.continueWaiting()}})
    },
    release: () => {if(rootRecoveryHold){mainWindow?.webContents.send(IPC.lifecycleFlushRequest,rootRecoveryHold.operationId,[],'recovery-release',rootRecoveryHold);rootRecoveryHold=null}send(IPC.vaultTransition,{busy:false,session:vault?.sessionId()??null,phase:'idle'})}
  })
  // 搜索密钥与模型密钥同一套保护：safeStorage 加密后进 network-config.json，明文只在主进程。
  networkConfig = createNetworkConfigStore(app.getPath('userData'), safeStorage)
  // MCP 服务器配置与 token 走同一套 safeStorage；坏文件按「没有服务器」，不覆盖证据。
  mcpConfig = createMcpConfigStore(app.getPath('userData'), safeStorage)
  // 人发起外发：设备级日志与门面。总闸每次现读，保存配置后立即生效；凭据只在主进程解密。
  egressLog = createEgressLog(app.getPath('userData'))
  networkStats = createNetworkStats(app.getPath('userData'))
  humanNetwork = createHumanNetwork({
    enabled: () => networkConfig?.enabled() === true,
    fetchText: (url, options) => fetchText(url, options),
    searchProvider: async () => {
      const credential = networkSearchCredential()
      if (!credential) throw Error('SEARCH_NOT_CONFIGURED')
      const provider = createSearchProvider(credential)
      return {
        provider: credential.provider,
        host: SEARCH_PROVIDERS[credential.provider].host,
        search: (query, options) => provider.search(query, options)
      }
    },
    log: egressLog,
    stats: { record: recordNetworkStat }
  })
  authorizations = new TaskAuthorizationRegistry({
    root:()=>{try{return vault?.requireUsableRoot()??null}catch{return null}},
    session:()=>vault?.sessionId()??null,
    tree:()=>vault!.tree(),read:relPath=>vault!.read(relPath),tier:modelTierFor,
    assertOrdinaryNotes: paths => vault!.requireOrdinaryNotes(paths),
    acceptsObject:(relPath,expected,current)=>vault?.acceptsObject(relPath,expected,current)??false,
    ownerValid:owner=>!!mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() &&
      mainWindow.webContents.getURL()===rendererEntryUrl && owner===`${mainWindow.webContents.id}:${mainWindow.webContents.mainFrame.routingId}`,
    memoryAuthorization:async request=>{
      const state=memoryAuthorizationState(request.sessionId)
      const entries=state.disclosure?.use?await workingService()!.entries().catch(()=>[]):[]
      const search=!!state.disclosure?.use&&!!modelConfig&&!!agentHost?.supportsMemorySearch(modelConfig.credential(request.modelRecordId))&&entries.some(e=>e.status==='active')
      if(memoryAuthorizationState(request.sessionId).signature!==state.signature)throw Error('STALE_PREVIEW')
      return {signature:state.signature+':'+memorySnapshotSignature(entries),snapshotSignature:memorySnapshotSignature(entries),search,disclosure:state.disclosure}
    },
    network: networkAvailability,
    mcp: mcpAvailability,
    deleteAvailable: () => HUMAN_TRASH_ON_THIS_PLATFORM,
    configuration:(_extraReferences, modelRecordId,_memorySearch)=>{
      if(!modelConfig)throw Error(modelConfigError??'MODEL_CONFIG_UNAVAILABLE')
      const config=modelConfig.getPublic()
      // 仅发起篇也要宣告补／建，额度用本地档；读搜结构仍按来源另有篇才宣告。
      return {credential:modelConfig.credential(modelRecordId),limits:config.limits.local}
    }
  })
  reasoningStore=new ReasoningStore(path.join(app.getPath('userData'),'reasoning-v2'))
  const contextCache=summaryCache!
  consolidation=new WorkingMemoryConsolidation({
    strategy:MEMORY_PRODUCTION_STRATEGY,
    service:workingService,
    configuration:context=>{
      if(!modelConfig)throw Error('MEMORY_CONFIG_UNAVAILABLE')
      const cfg=modelConfig.getMemoryConfig(context.vaultKey),credential=modelConfig.memoryCredential(context.vaultKey)
      return {enabled:cfg.vault.enabled,signature:JSON.stringify([cfg,credential,modelConfig.getVaultMemoryRevision(context.vaultKey)]),credential,limits:cfg.limits}
    },
    stream:streamModelStep,changed:context=>{if(vault?.sessionId()===context.sessionId)send(IPC.memoryChanged,context.sessionId)}
  })
  agentHost = new AgentHost({
    prepareSource:async (input,grant)=>{
      if(!input.sessionId||!input.objectVersion||!input.expectedRevision)throw Error('BAD_REQUEST')
      if(!grant)throw Error('INVALID_AUTHORIZATION')
      return vault!.prepareTaskSource({...input,sessionId:input.sessionId,objectVersion:input.objectVersion,expectedRevision:input.expectedRevision},grant)
    },
    onTaskStarted:id=>consolidation?.capture(id),
    onTaskStartFailed:id=>consolidation?.discard(id),
    onTaskMaterialDiscarded:id=>consolidation?.discard(id),
    onTaskMaterialSaved:material=>consolidation!.handoff(material),
    onTaskMaterialResult:result=>{void consolidation?.materialResult(result).catch(()=>{/* Saved output remains valid; the consumer owns its bounded failure result. */})},
    summaryAllowed:(relPath,taskIds)=>workingService()!.summaryAllowed(relPath,taskIds),
    memory:{context:()=>vault!.memoryContext(),config:key=>({enabled:modelConfig!.getMemoryConfig(key).vault.enabled,revision:modelConfig!.getVaultMemoryRevision(key)}),entries:ids=>workingService()!.entries(ids)},
    onReasoning:(id,text)=>reasoningStore!.write(vault!.memoryContext().vaultKey,id,text),
    summaries:{cache:contextCache,key:async relPath=>summaryHash(await vault!.ledgerKey(relPath))},
    ledger:{prepare:(relPath,chapter,version,binding)=>{if(!binding)throw Error('BAD_REQUEST');return vault!.ledgerPrepare(relPath,chapter,version,binding)},complete:(relPath,id,revision)=>vault!.ledgerComplete(relPath,id,revision),contexts:relPath=>vault!.ledgerContexts(relPath)},
    assertMemoryAuthorization: input => {
      if (!input.sessionId || input.memoryAuthorizationSignature !== memoryAuthorizationState(input.sessionId).signature) throw Error('STALE_PREVIEW')
    },
    // AI 的结构操作走同一条共用迁移路径（含引用修复与权限不放宽），不另造实现。
    relocationPreview: (request, owner) => relocationPreviewShared({ kind: request.kind, source: request.source, target: request.target }, owner),
    relocationCommit: (previewId, repairLinks, owner) => relocationCommitShared(previewId, repairLinks, owner),
    trashPreview: async (relPath, owner) => {
      const preview = await trashPreviewShared(relPath, owner)
      return { id: preview.id, relPath: preview.relPath, hasAttachments: preview.hasAttachments }
    },
    trashCommit: async (previewId, allow, attribution, owner) => {
      const result = await trashCommitShared(previewId, allow, owner, attribution)
      if (result.cancelled) return { cancelled: true }
      // 送篓之后的落点核验、孤儿附件夹与记录降级都要透到工具结果与账本，不能只留一句「已删除」。
      return {
        cancelled: false, relPath: result.relPath, orphan: result.orphan,
        ...(result.orphanReason ? { orphanReason: result.orphanReason } : {}),
        degraded: result.degraded, landingVerified: result.landingVerified
      }
    },
    // 「建」一次落盘：正文与文件原子出现，不先建空笔记再写（写失败会留下没法清理的半成品）。
    createNote: async (relPath, body) => {
      if (!vault) throw Error('NO_VAULT')
      const at = relPath.lastIndexOf('/')
      return vault.createWithContent(at < 0 ? relPath : relPath.slice(at + 1), at < 0 ? '' : relPath.slice(0, at), body)
    },
    attachmentFolder: async relPath => {
      const root = vault?.requireUsableRoot()
      if (!root) return null
      const tree = await listVaultTree(root)
      const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
      for (let probe = dir; ; probe = probe.includes('/') ? probe.slice(0, probe.lastIndexOf('/')) : '') {
        const hit = tree.find(entry => entry.kind === 'dir' && entry.relPath === probe && entry.attachmentOf !== undefined)
        if (hit) return hit.relPath
        if (!probe) return null
      }
    },
    skills: () => currentSkills(),
    assertSkillsAuthorization: input => {
      if (input.skillsSignature !== currentSkills().signature) throw Error('STALE_PREVIEW')
    },
    authorize:input=>{
      if(!authorizations || !input.authorizationOwner || !input.previewId || !isAuthorizationCommand(input))throw Error('INVALID_AUTHORIZATION')
      return authorizations.consume((input as import('./agent-host.ts').HostStart).authorizationOwner!,input as AgentStartRequest)
    },
    root: () => { try { return vault?.requireUsableRoot() ?? null } catch { return null } },
    session: () => vault?.sessionId() ?? null,
    acceptsObject: (relPath, expected, current) => vault?.acceptsObject(relPath, expected, current) ?? false,
    read: (relPath) => vault!.read(relPath),
    write: (relPath, content, revision, binding) => {
      if (blocksStructureWrite(relPath)) throw new Error('NOTE_BUSY')
      if (!binding) throw new Error('OBJECT_BINDING_REQUIRED')
      return vault!.write(relPath, content, revision, binding)
    },
    tier: modelTierFor,
    credential: () => {
      if (!modelConfig) throw new Error(modelConfigError ?? 'MODEL_CONFIG_UNAVAILABLE')
      return modelConfig.credential()
    },
    assistant: () => loadAssistantHabits(app.getPath('userData')),
    limits: () => {
      if (!modelConfig) throw new Error(modelConfigError ?? 'MODEL_CONFIG_UNAVAILABLE')
      return modelConfig.getPublic().limits.none
    },
    stream: (input, signal) => streamModelText({ ...input, signal }),
    indexSearch: async query => (await vault!.search(query)).map(hit => ({ relPath: hit.relPath, title: hit.title, folder: hit.folder })),
    streamStep: (input, signal) => streamModelStep({ ...input, signal }),
    // 模型自带联网：只有 Host 判定总闸与允许列表都成立时才会走到这里；记忆检索等其它步骤仍用上面一条。
    nativeStreamStep: (input, signal) => streamNativeSearchStep({ ...input, signal }, signal),
    // 唯一出口：两条路内部都走 EgressClient；错误码已是 EGRESS_*，Host 直接如实上报。
    // 任务内抓页按设备配置读：选了 DeepSeek 就必须有 DeepSeek 凭据，缺凭据不静默降级直连
    // （`resolveFetchRoute` 抛 SEARCH_NOT_CONFIGURED）。人发起抓页仍直连，不走这里。
    // 统计只旁听：成功记 ok＋字节，失败先按白名单规范化记 refused 再原样抛出。
    network: {
      fetch: async (url, signal) => {
        try {
          const route = resolveFetchRoute(networkConfig?.getPublic().fetch ?? 'direct', networkSearchCredential())
          const result = route.service === 'deepseek'
            ? await fetchViaDeepSeek(url, route.key, { signal })
            : await fetchText(url, { signal })
          recordNetworkStat('fetch', { outcome: 'ok', bytes: result.bytes })
          return {
            text: result.text,
            host: new URL(result.finalUrl).host,
            url: result.finalUrl,
            ...(result.title ? { title: result.title } : {}),
            bytes: result.bytes,
            truncated: result.truncated,
            lowTrust: true as const,
            service: route.service
          }
        } catch (error) {
          recordNetworkStat('fetch', { outcome: 'refused', code: networkFailureCode(error, signal) })
          throw error
        }
      },
      // 搜索走同一出口核心；服务商与密钥只在主进程解密，错误码不夹带 key。
      search: async (query, maxResults, signal) => {
        try {
          const credential = networkSearchCredential()
          if (!credential) throw Error('SEARCH_NOT_CONFIGURED')
          const provider = createSearchProvider(credential)
          const result = await provider.search(query, { maxResults, signal })
          recordNetworkStat('search', { outcome: 'ok' })
          return {
            provider: credential.provider,
            host: SEARCH_PROVIDERS[credential.provider].host,
            results: result.results,
            ...(result.truncated ? { truncated: true as const } : {})
          }
        } catch (error) {
          recordNetworkStat('search', { outcome: 'refused', code: networkFailureCode(error, signal) })
          throw error
        }
      },
      availability: networkAvailability
    },
    // 远端只读 MCP：可用性（含 4 KiB 工具清单）、按任务连接与调用、任务结束关闭都在这里。
    mcp: {
      availability: mcpAvailability,
      call: mcpCall,
      closeTask: closeMcpTask
    },
    // 第五个入参是写能力：必须原样转发，否则工具集看不到写工具，宿主也不会宣告它们。
    // 第六／七个入参是联网与 MCP 能力：必须原样转发，否则工具集看不到它们，宿主也不会宣告。
    createReadOnlyTools: (grant, taskId, memory, materials, write, network, mcp, indexSearch) => createScopedAgentTools(grant, taskId, {
      read: relPath => vault!.read(relPath), tier: modelTierFor,
      ...(indexSearch ? { indexSearch } : {}),
      validateMemory: dep => memory?.validateDependency(dep) ?? Promise.resolve(false),
      validateMemoryBatch: deps => memory?.validateDependencies(deps) ?? Promise.resolve(deps.map(() => false)), materials,
      acceptsObject: (relPath, expected, current) => vault?.acceptsObject(relPath, expected, current) ?? false,
      ...(write ? { write } : {}),
      ...(network ? { network } : {}),
      ...(mcp ? { mcp } : {})
    }),
    emit: ({ root, ...event }) => {
      if (vault?.root === root && event.sessionId === vault.sessionId()) {
        if (event.status === 'running' && !failureClearSeen.has(event.id)) {
          failureClearSeen.add(event.id)
          if (failureClearSeen.size > 1000) failureClearSeen.clear()
          try { vault.clearTaskFailures(event.relPath) } catch { /* diagnostics best effort */ }
        }
        if (event.status === 'failed' && event.failure) {
          try { vault.recordTaskFailure(event.id, event.relPath, event.failure, !event.answer) } catch { /* ledger/event must not fail because diagnostics did */ }
        }
        send(IPC.agentEvent, event)
      }
    }
  })
  attachVaultProtocol(() => vault)
  remoteImages = new RemoteImageService()
  attachRemoteImageProtocol(remoteImages)
  registerIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
})

// 必须等渲染进程写完盘再拆库：退出前那次 flush 还要经 noteWrite 落盘。
app.on('will-quit', () => {
  // 统计去抖 500ms：退出前同步落盘最后几条；写失败不能让退出卡住。
  flushNetworkStats(networkStats)
  consolidation?.close()
  vault?.dispose()
})
