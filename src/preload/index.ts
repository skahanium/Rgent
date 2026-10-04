import { boundEvent, isVaultChannel, isVaultEvent } from '../shared/vault-binding.ts'
import type { MemorySessionRequest, MemoryConfigRequest, MemoryManualRequest, MemoryCommitRequest, MemoryItemRequest, MemoryEditRequest, MemoryJobRequest, MemoryResult, MemoryView, MemoryPreview } from '../shared/memory.ts'
import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type BacklinkGroup,
  type RemoteImageGetRequest,
  type RemoteImageGetResult,
  type FlushDonePayload,
  type NotePayload,
  type NoteSnapshot,
  type NoteWriteRequest,
  type NoteWriteResult,
  type PermissionState,
  type SetPermissionRequest,
  type SearchHit,
  type ThemeMode,
  type ThemeSetResult,
  type ReadingPreference,
  type ReadingSetResult,
  type ChromeTextPreference,
  type ChromeTextSetResult,
  type TreeEntry,
  type VaultState,
  type AssistantHabits,
  type AssistantResult,
  type ModelConfigResult,
  type ModelProviderSaveRequest,
  type ModelProviderRemoveRequest,
  type ModelKeyDeleteRequest,
  type ModelAddRequest,
  type ModelUpdateRequest,
  type ModelRemoveRequest,
  type ModelDefaultSetRequest,
  type ModelListRequest,
  type ModelListResult,
  type ModelLimitsSetRequest,
  type AgentStartRequest,
  type AgentStartResult,
  type AgentTaskView,
  type AgentEvent,
  type EntryCreateRequest,
  type RelocationPreviewRequest,
  type RelocationPreviewResult,
  type RelocationCommitRequest,
  type RelocationCommitResult,
  type RelocationEvent,
  type LifecycleStatus,
  type LifecycleRetryRequest,
  type NoteInspectRequest, type NoteInspectResult,
  type SaveCopyPreviewRequest, type SaveCopyCommitRequest, type SaveCopyPreviewResult, type SaveCopyCommitResult,
  type LifecycleRetryResult
} from '../shared/ipc.ts'

let mountedSession: string | null = null
async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const session = mountedSession
  const result = await ipcRenderer.invoke(channel, ...(isVaultChannel(channel) ? [{ session, args }] : args))
  if (isVaultChannel(channel) && session !== mountedSession) throw Error('VAULT_CHANGED')
  if (channel === IPC.vaultGet || channel === IPC.vaultPick || channel === IPC.vaultOpen) mountedSession = result?.sessionId ?? null
  return result
}

const menuChannels = [IPC.menuOpenVault, IPC.menuNewNote, IPC.menuSave] as const

const api = {
  ledgerRepair:(request:import('../shared/ledger.ts').LedgerRepairRequest):Promise<import('../shared/ledger.ts').LedgerRepairResult>=>invoke(IPC.ledgerRepair,request),
  ledgerMaintenance:(request:import('../shared/ledger.ts').LedgerMaintenanceRequest):Promise<import('../shared/ledger.ts').LedgerMaintenanceResult>=>invoke(IPC.ledgerMaintenance,request),
  ledgerReasoning:(request:import('../shared/ledger.ts').LedgerReasoningRequest):Promise<import('../shared/ledger.ts').LedgerReasoningResult>=>invoke(IPC.ledgerReasoning,request),
  ledgerGet:(request:import('../shared/ledger.ts').LedgerRequest):Promise<import('../shared/ledger.ts').LedgerResult>=>invoke(IPC.ledgerGet,request),
  ledgerMigrate:(request:import('../shared/ledger.ts').LedgerMigrationRequest):Promise<import('../shared/ledger.ts').LedgerMigrationResult>=>invoke(IPC.ledgerMigrate,request),
  onMemoryChanged: (fn: (sessionId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => { const args = boundEvent(value, mountedSession); if (typeof args?.[0] === 'string') fn(args[0]) }
    ipcRenderer.on(IPC.memoryChanged, listener)
    return () => ipcRenderer.removeListener(IPC.memoryChanged, listener)
  },
  memoryGet: (request: MemorySessionRequest): Promise<MemoryResult<MemoryView>> => invoke(IPC.memoryGet, request),
  memoryMaintenancePreview:(request:import('../shared/memory.ts').MemoryMaintenanceRequest):Promise<MemoryResult<MemoryPreview>>=>invoke(IPC.memoryMaintenancePreview,request),
  memoryConfigSave: (request: MemoryConfigRequest): Promise<MemoryResult<MemoryView>> => invoke(IPC.memoryConfigSave, request),
  memoryManualPreview: (request: MemoryManualRequest): Promise<MemoryResult<MemoryPreview>> => invoke(IPC.memoryManualPreview, request),
  memoryPreviewCommit: (request: MemoryCommitRequest): Promise<MemoryResult<MemoryView>> => invoke(IPC.memoryPreviewCommit, request),
  memoryItemEdit: (request: MemoryEditRequest): Promise<MemoryResult<MemoryView>> => invoke(IPC.memoryItemEdit, request),
  memoryItemDisable: (request: MemoryItemRequest): Promise<MemoryResult<MemoryView>> => invoke(IPC.memoryItemDisable, request),
  memoryItemForget: (request: MemoryItemRequest): Promise<MemoryResult<MemoryView>> => invoke(IPC.memoryItemForget, request),
  memoryRestorePreview: (request: MemoryItemRequest): Promise<MemoryResult<MemoryPreview>> => invoke(IPC.memoryRestorePreview, request),
  memoryJobRetryPreview: (request: MemoryJobRequest): Promise<MemoryResult<MemoryPreview>> => invoke(IPC.memoryJobRetryPreview, request),
  memoryJobCancel: (request: MemoryJobRequest): Promise<MemoryResult<MemoryView>> => invoke(IPC.memoryJobCancel, request),
  vaultGet: (): Promise<VaultState> => invoke(IPC.vaultGet),
  vaultPick: (create = false): Promise<VaultState> => invoke(IPC.vaultPick, create),
  onVaultTransition: (handler: (busy:boolean,session:string|null)=>void):(()=>void) => subscribe(IPC.vaultTransition, value=>{if(value && typeof value === 'object'){const v=value as {busy:unknown;session:unknown};if(typeof v.busy === 'boolean' && (v.session===null||typeof v.session==='string'))handler(v.busy,v.session)}}),
  vaultCatalog: (): Promise<import('../shared/vault-management.ts').VaultCatalogView & {activeId?:string|null}> => invoke(IPC.vaultCatalog),
  vaultCatalogChange: (request: {id:string;revision:string;action:'pin'|'label'|'remove'|'relocate';pinned?:boolean;label?:string}): Promise<import('../shared/vault-management.ts').VaultCatalogView> => invoke(IPC.vaultCatalogChange, request),
  vaultOpen: (id:string): Promise<VaultState> => invoke(IPC.vaultOpen, id),
  vaultWorkspaceGet: (session:string): Promise<import('../shared/vault-management.ts').VaultWorkspace|null> => invoke(IPC.vaultWorkspaceGet,session),
  vaultWorkspaceSave: (session:string,workspace:import('../shared/vault-management.ts').VaultWorkspace): Promise<boolean> => invoke(IPC.vaultWorkspaceSave,session,workspace),
  treeList: (): Promise<TreeEntry[]> => invoke(IPC.treeList),
  noteRead: (relPath: string): Promise<NoteSnapshot> => invoke(IPC.noteRead, relPath),
  noteInspect: (request: NoteInspectRequest): Promise<NoteInspectResult> => invoke(IPC.noteInspect, request),
  noteAbandon: (request: NoteInspectRequest): Promise<boolean> => invoke(IPC.noteAbandon, request),
  noteWrite: (request: NoteWriteRequest): Promise<NoteWriteResult> =>
    invoke(IPC.noteWrite, request),
  noteSaveCopyPreview: (request: SaveCopyPreviewRequest): Promise<SaveCopyPreviewResult> => invoke(IPC.noteSaveCopyPreview, request),
  noteSaveCopyCommit: (request: SaveCopyCommitRequest): Promise<SaveCopyCommitResult> => invoke(IPC.noteSaveCopyCommit, request),
  permissionsGet: (): Promise<PermissionState> => invoke(IPC.permissionsGet),
  permissionsSet: (request: SetPermissionRequest): Promise<PermissionState> => invoke(IPC.permissionsSet, request),
  noteCreate: (name: string): Promise<string> => invoke(IPC.noteCreate, name),
  noteCreateAt: (request: EntryCreateRequest): Promise<string> => invoke(IPC.noteCreate, request),
  folderCreate: (request: EntryCreateRequest): Promise<string> => invoke(IPC.folderCreate, request),
  relocationPreview: (request: RelocationPreviewRequest): Promise<RelocationPreviewResult> =>
    invoke(IPC.relocationPreview, request),
  relocationCommit: (request: RelocationCommitRequest): Promise<RelocationCommitResult> =>
    invoke(IPC.relocationCommit, request),
  lifecycleStatus: (): Promise<LifecycleStatus> => invoke(IPC.lifecycleStatus),
  lifecycleRetry: (request: LifecycleRetryRequest): Promise<LifecycleRetryResult> =>
    invoke(IPC.lifecycleRetry, request),
  backlinks: (relPath: string): Promise<BacklinkGroup[]> => invoke(IPC.backlinks, relPath),
  search: (query: string): Promise<SearchHit[]> => invoke(IPC.search, query),
  themeGet: (): Promise<ThemeMode> => invoke(IPC.themeGet),
  themeSet: (mode: ThemeMode): Promise<ThemeSetResult> => invoke(IPC.themeSet, mode),
  readingGet: (): Promise<ReadingPreference> => invoke(IPC.readingGet),
  readingSet: (reading: ReadingPreference): Promise<ReadingSetResult> => invoke(IPC.readingSet, reading),
  chromeTextGet: (): Promise<ChromeTextPreference> => invoke(IPC.chromeTextGet),
  chromeTextSet: (value: ChromeTextPreference): Promise<ChromeTextSetResult> => invoke(IPC.chromeTextSet, value),
  remoteImageGet: (request: RemoteImageGetRequest): Promise<RemoteImageGetResult> =>
    invoke(IPC.remoteImageGet, request),
  assistantGet: (): Promise<AssistantResult> => invoke(IPC.assistantGet),
  assistantSet: (habits: AssistantHabits): Promise<AssistantResult> => invoke(IPC.assistantSet, habits),
  modelConfigGet: (): Promise<ModelConfigResult> => invoke(IPC.modelConfigGet),
  modelProviderSave: (request: ModelProviderSaveRequest): Promise<ModelConfigResult> => invoke(IPC.modelProviderSave, request),
  modelProviderRemove: (request: ModelProviderRemoveRequest): Promise<ModelConfigResult> => invoke(IPC.modelProviderRemove, request),
  modelKeyDelete: (request: ModelKeyDeleteRequest): Promise<ModelConfigResult> => invoke(IPC.modelKeyDelete, request),
  modelAdd: (request: ModelAddRequest): Promise<ModelConfigResult> => invoke(IPC.modelAdd, request),
  modelUpdate: (request: ModelUpdateRequest): Promise<ModelConfigResult> => invoke(IPC.modelUpdate, request),
  modelRemove: (request: ModelRemoveRequest): Promise<ModelConfigResult> => invoke(IPC.modelRemove, request),
  modelDefaultSet: (request: ModelDefaultSetRequest): Promise<ModelConfigResult> => invoke(IPC.modelDefaultSet, request),
  modelList: (request: ModelListRequest): Promise<ModelListResult> => invoke(IPC.modelList, request),
  modelLimitsSet: (request: ModelLimitsSetRequest): Promise<ModelConfigResult> => invoke(IPC.modelLimitsSet, request),
  agentAuthorizationPreview: (request: import('../shared/ipc.ts').AgentAuthorizationRequest): Promise<import('../shared/ipc.ts').AgentAuthorizationResult> => invoke(IPC.agentAuthorizationPreview, request),
  agentAuthorizationDiscard: (id:string): Promise<void> => invoke(IPC.agentAuthorizationDiscard,id),
  agentStart: (request: AgentStartRequest): Promise<AgentStartResult> => invoke(IPC.agentStart, request),
  agentCancel: (id: string): Promise<boolean> => invoke(IPC.agentCancel, id),
  agentTasks: (): Promise<AgentTaskView[]> => invoke(IPC.agentTasks),
  onAgentEvent: (handler: (payload: AgentEvent) => void): (() => void) =>
    subscribe(IPC.agentEvent, (payload) => handler(payload as AgentEvent)),
  onTreeChanged: (handler: () => void): (() => void) =>
    subscribe(IPC.treeChanged, () => handler()),
  onNoteRelocated: (handler: (payload: RelocationEvent) => void): (() => void) =>
    subscribe(IPC.noteRelocated, (payload) => handler(payload as RelocationEvent)),
  onLifecycleFlushRequest: (handler: (id: string, cleanUnavailablePaths: readonly string[], phase?: 'settings' | 'freeze') => void): (() => void) =>
    subscribe(IPC.lifecycleFlushRequest, (id, paths, phase) => {
      if (typeof id === 'string' && Array.isArray(paths) && paths.every(path => typeof path === 'string')) handler(id, paths, phase === 'settings' || phase === 'freeze' ? phase : undefined)
    }),
  lifecycleFlushDone: (id: string, ok: boolean): void => { ipcRenderer.send(IPC.lifecycleFlushDone, { id, ok }) },
  onNoteExternalChange: (handler: (payload: NotePayload) => void): (() => void) =>
    subscribe(IPC.noteExternalChange, (payload) => handler(payload as NotePayload)),
  onVaultLost: (handler: () => void): (() => void) => subscribe(IPC.vaultLost, () => handler()),
  onFlushRequest: (handler: () => void): (() => void) => subscribe(IPC.flushRequest, () => handler()),
  flushDone: (payload: FlushDonePayload): void => {
    ipcRenderer.send(IPC.flushDone, payload)
  },
  onMenu: (channel: (typeof menuChannels)[number], handler: () => void): (() => void) => {
    if (!menuChannels.includes(channel)) return () => {}
    return subscribe(channel, handler)
  }
}

function subscribe(channel: string, listener: (...args: unknown[]) => void): (() => void) {
  const wrapped = (_event: unknown, ...args: unknown[]): void => {
    if (isVaultEvent(channel)) { const bound = boundEvent(args[0], mountedSession); if (bound) listener(...bound) }
    else listener(...args)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('rgent', api)

export type RgentApi = typeof api
