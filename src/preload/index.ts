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
  type TreeEntry,
  type VaultState,
  type ModelConfigResult,
  type ModelProfileSetRequest,
  type ModelLimitsSetRequest,
  type ModelProvider,
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

const menuChannels = [IPC.menuOpenVault, IPC.menuNewNote, IPC.menuSave] as const

const api = {
  vaultGet: (): Promise<VaultState> => ipcRenderer.invoke(IPC.vaultGet),
  vaultPick: (): Promise<VaultState> => ipcRenderer.invoke(IPC.vaultPick),
  treeList: (): Promise<TreeEntry[]> => ipcRenderer.invoke(IPC.treeList),
  noteRead: (relPath: string): Promise<NoteSnapshot> => ipcRenderer.invoke(IPC.noteRead, relPath),
  noteInspect: (request: NoteInspectRequest): Promise<NoteInspectResult> => ipcRenderer.invoke(IPC.noteInspect, request),
  noteAbandon: (request: NoteInspectRequest): Promise<boolean> => ipcRenderer.invoke(IPC.noteAbandon, request),
  noteWrite: (request: NoteWriteRequest): Promise<NoteWriteResult> =>
    ipcRenderer.invoke(IPC.noteWrite, request),
  noteSaveCopyPreview: (request: SaveCopyPreviewRequest): Promise<SaveCopyPreviewResult> => ipcRenderer.invoke(IPC.noteSaveCopyPreview, request),
  noteSaveCopyCommit: (request: SaveCopyCommitRequest): Promise<SaveCopyCommitResult> => ipcRenderer.invoke(IPC.noteSaveCopyCommit, request),
  permissionsGet: (): Promise<PermissionState> => ipcRenderer.invoke(IPC.permissionsGet),
  permissionsSet: (request: SetPermissionRequest): Promise<PermissionState> => ipcRenderer.invoke(IPC.permissionsSet, request),
  noteCreate: (name: string): Promise<string> => ipcRenderer.invoke(IPC.noteCreate, name),
  noteCreateAt: (request: EntryCreateRequest): Promise<string> => ipcRenderer.invoke(IPC.noteCreate, request),
  folderCreate: (request: EntryCreateRequest): Promise<string> => ipcRenderer.invoke(IPC.folderCreate, request),
  relocationPreview: (request: RelocationPreviewRequest): Promise<RelocationPreviewResult> =>
    ipcRenderer.invoke(IPC.relocationPreview, request),
  relocationCommit: (request: RelocationCommitRequest): Promise<RelocationCommitResult> =>
    ipcRenderer.invoke(IPC.relocationCommit, request),
  lifecycleStatus: (): Promise<LifecycleStatus> => ipcRenderer.invoke(IPC.lifecycleStatus),
  lifecycleRetry: (request: LifecycleRetryRequest): Promise<LifecycleRetryResult> =>
    ipcRenderer.invoke(IPC.lifecycleRetry, request),
  backlinks: (relPath: string): Promise<BacklinkGroup[]> => ipcRenderer.invoke(IPC.backlinks, relPath),
  search: (query: string): Promise<SearchHit[]> => ipcRenderer.invoke(IPC.search, query),
  themeGet: (): Promise<ThemeMode> => ipcRenderer.invoke(IPC.themeGet),
  themeSet: (mode: ThemeMode): Promise<ThemeSetResult> => ipcRenderer.invoke(IPC.themeSet, mode),
  readingGet: (): Promise<ReadingPreference> => ipcRenderer.invoke(IPC.readingGet),
  readingSet: (reading: ReadingPreference): Promise<ReadingSetResult> => ipcRenderer.invoke(IPC.readingSet, reading),
  remoteImageGet: (request: RemoteImageGetRequest): Promise<RemoteImageGetResult> =>
    ipcRenderer.invoke(IPC.remoteImageGet, request),
  modelConfigGet: (): Promise<ModelConfigResult> => ipcRenderer.invoke(IPC.modelConfigGet),
  modelProfileSet: (request: ModelProfileSetRequest): Promise<ModelConfigResult> => ipcRenderer.invoke(IPC.modelProfileSet, request),
  modelSelect: (provider: ModelProvider): Promise<ModelConfigResult> => ipcRenderer.invoke(IPC.modelSelect, provider),
  modelKeyDelete: (provider: ModelProvider): Promise<ModelConfigResult> => ipcRenderer.invoke(IPC.modelKeyDelete, provider),
  modelLimitsSet: (request: ModelLimitsSetRequest): Promise<ModelConfigResult> => ipcRenderer.invoke(IPC.modelLimitsSet, request),
  agentAuthorizationPreview: (request: import('../shared/ipc.ts').AgentAuthorizationRequest): Promise<import('../shared/ipc.ts').AgentAuthorizationResult> => ipcRenderer.invoke(IPC.agentAuthorizationPreview, request),
  agentAuthorizationDiscard: (id:string): Promise<void> => ipcRenderer.invoke(IPC.agentAuthorizationDiscard,id),
  agentStart: (request: AgentStartRequest): Promise<AgentStartResult> => ipcRenderer.invoke(IPC.agentStart, request),
  agentCancel: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.agentCancel, id),
  agentTasks: (): Promise<AgentTaskView[]> => ipcRenderer.invoke(IPC.agentTasks),
  onAgentEvent: (handler: (payload: AgentEvent) => void): (() => void) =>
    subscribe(IPC.agentEvent, (payload) => handler(payload as AgentEvent)),
  onTreeChanged: (handler: () => void): (() => void) =>
    subscribe(IPC.treeChanged, () => handler()),
  onNoteRelocated: (handler: (payload: RelocationEvent) => void): (() => void) =>
    subscribe(IPC.noteRelocated, (payload) => handler(payload as RelocationEvent)),
  onLifecycleFlushRequest: (handler: (id: string, cleanUnavailablePaths: readonly string[]) => void): (() => void) =>
    subscribe(IPC.lifecycleFlushRequest, (id, paths) => {
      if (typeof id === 'string' && Array.isArray(paths) && paths.every(path => typeof path === 'string')) handler(id, paths)
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
    listener(...args)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('rgent', api)

export type RgentApi = typeof api
