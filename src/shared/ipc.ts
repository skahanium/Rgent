export const IPC = {
  vaultGet: 'vault:get',
  vaultPick: 'vault:pick',
  treeList: 'tree:list',
  treeChanged: 'tree:changed',
  noteRead: 'note:read',
  noteWrite: 'note:write',
  noteCreate: 'note:create',
  noteExternalChange: 'note:external-change',
  vaultLost: 'vault:lost',
  menuOpenVault: 'menu:open-vault',
  menuNewNote: 'menu:new-note',
  menuSave: 'menu:save'
} as const

export type VaultState =
  | { status: 'needs-pick'; reason: 'first-run' | 'missing' }
  | { status: 'ready'; rootName: string; vaultChanged?: boolean }

export type TreeEntry = {
  name: string
  relPath: string
  kind: 'dir' | 'note' | 'file'
  children?: TreeEntry[]
}

export type NotePayload = {
  relPath: string
  content: string
}

export type NoteWriteResult = {
  ok: true
} | {
  ok: false
  error: string
}
