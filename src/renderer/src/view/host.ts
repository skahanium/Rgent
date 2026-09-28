import type { RemoteImageGetRequest, RemoteImageGetResult } from '../../../shared/ipc.ts'

export type NoteHost = {
  noteRelPath: string
  vaultHas: (relPath: string) => boolean
  openNote: (relPath: string) => void
  remoteImageGet?: (request: RemoteImageGetRequest) => Promise<RemoteImageGetResult>
}

export const emptyNoteHost: NoteHost = {
  noteRelPath: '',
  vaultHas: () => false,
  openNote: () => {}
}
