export type NoteHost = {
  noteRelPath: string
  vaultHas: (relPath: string) => boolean
  openNote: (relPath: string) => void
}

export const emptyNoteHost: NoteHost = {
  noteRelPath: '',
  vaultHas: () => false,
  openNote: () => {}
}
