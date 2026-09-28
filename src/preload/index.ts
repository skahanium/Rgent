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
  type TreeEntry,
  type VaultState,
  type ModelConfigResult,
  type ModelProfileSetRequest,
  type ModelLimitsSetRequest,
  type ModelProvider,
  type AgentStartRequest,
  type AgentStartResult,
  type AgentTaskView,
  type AgentEvent
} from '../shared/ipc.ts'

const menuChannels = [IPC.menuOpenVault, IPC.menuNewNote, IPC.menuSave] as const

const api = {
  vaultGet: (): Promise<VaultState> => ipcRenderer.invoke(IPC.vaultGet),
  vaultPick: (): Promise<VaultState> => ipcRenderer.invoke(IPC.vaultPick),
  treeList: (): Promise<TreeEntry[]> => ipcRenderer.invoke(IPC.treeList),
  noteRead: (relPath: string): Promise<NoteSnapshot> => ipcRenderer.invoke(IPC.noteRead, relPath),
  noteWrite: (request: NoteWriteRequest): Promise<NoteWriteResult> =>
    ipcRenderer.invoke(IPC.noteWrite, request),
  permissionsGet: (): Promise<PermissionState> => ipcRenderer.invoke(IPC.permissionsGet),
  permissionsSet: (request: SetPermissionRequest): Promise<PermissionState> => ipcRenderer.invoke(IPC.permissionsSet, request),
  noteCreate: (name: string): Promise<string> => ipcRenderer.invoke(IPC.noteCreate, name),
  backlinks: (relPath: string): Promise<BacklinkGroup[]> => ipcRenderer.invoke(IPC.backlinks, relPath),
  search: (query: string): Promise<SearchHit[]> => ipcRenderer.invoke(IPC.search, query),
  themeGet: (): Promise<ThemeMode> => ipcRenderer.invoke(IPC.themeGet),
  themeSet: (mode: ThemeMode): Promise<ThemeSetResult> => ipcRenderer.invoke(IPC.themeSet, mode),
  remoteImageGet: (request: RemoteImageGetRequest): Promise<RemoteImageGetResult> =>
    ipcRenderer.invoke(IPC.remoteImageGet, request),
  modelConfigGet: (): Promise<ModelConfigResult> => ipcRenderer.invoke(IPC.modelConfigGet),
  modelProfileSet: (request: ModelProfileSetRequest): Promise<ModelConfigResult> => ipcRenderer.invoke(IPC.modelProfileSet, request),
  modelSelect: (provider: ModelProvider): Promise<ModelConfigResult> => ipcRenderer.invoke(IPC.modelSelect, provider),
  modelKeyDelete: (provider: ModelProvider): Promise<ModelConfigResult> => ipcRenderer.invoke(IPC.modelKeyDelete, provider),
  modelLimitsSet: (request: ModelLimitsSetRequest): Promise<ModelConfigResult> => ipcRenderer.invoke(IPC.modelLimitsSet, request),
  agentStart: (request: AgentStartRequest): Promise<AgentStartResult> => ipcRenderer.invoke(IPC.agentStart, request),
  agentCancel: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.agentCancel, id),
  agentTasks: (): Promise<AgentTaskView[]> => ipcRenderer.invoke(IPC.agentTasks),
  onAgentEvent: (handler: (payload: AgentEvent) => void): (() => void) =>
    subscribe(IPC.agentEvent, (payload) => handler(payload as AgentEvent)),
  onTreeChanged: (handler: () => void): (() => void) =>
    subscribe(IPC.treeChanged, () => handler()),
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
