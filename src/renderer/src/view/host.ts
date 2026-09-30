import type { RemoteImageGetRequest, RemoteImageGetResult } from '../../../shared/ipc.ts'

export type NoteHost = {
  noteRelPath: string
  vaultHas: (relPath: string) => boolean
  openNote: (relPath: string) => void
  /** Static source version used when deciding whether an image DOM may be reused. */
  imageEpoch?: string
  imageContext?: (range: {start: number; end: number}, region?: 'body' | 'ledger') => RemoteImageGetRequest['context']
  remoteImageGet?: (request: RemoteImageGetRequest) => Promise<RemoteImageGetResult>
}

export const emptyNoteHost: NoteHost = {
  noteRelPath: '',
  vaultHas: () => false,
  openNote: () => {}
}
