import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type BacklinkGroup,
  type FlushDonePayload,
  type NotePayload,
  type NoteWriteResult,
  type SearchHit,
  type TreeEntry,
  type VaultState
} from '../shared/ipc.ts'

const menuChannels = [IPC.menuOpenVault, IPC.menuNewNote, IPC.menuSave] as const

const api = {
  vaultGet: (): Promise<VaultState> => ipcRenderer.invoke(IPC.vaultGet),
  vaultPick: (): Promise<VaultState> => ipcRenderer.invoke(IPC.vaultPick),
  treeList: (): Promise<TreeEntry[]> => ipcRenderer.invoke(IPC.treeList),
  noteRead: (relPath: string): Promise<string> => ipcRenderer.invoke(IPC.noteRead, relPath),
  noteWrite: (relPath: string, content: string): Promise<NoteWriteResult> =>
    ipcRenderer.invoke(IPC.noteWrite, relPath, content),
  noteCreate: (name: string): Promise<string> => ipcRenderer.invoke(IPC.noteCreate, name),
  backlinks: (relPath: string): Promise<BacklinkGroup[]> => ipcRenderer.invoke(IPC.backlinks, relPath),
  search: (query: string): Promise<SearchHit[]> => ipcRenderer.invoke(IPC.search, query),
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
