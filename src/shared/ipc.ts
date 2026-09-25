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
  menuSave: 'menu:save',
  flushRequest: 'app:flush-request',
  flushDone: 'app:flush-done',
  backlinks: 'note:backlinks',
  search: 'vault:search',
  permissionsGet: 'permissions:get',
  permissionsSet: 'permissions:set'
} as const

export type VaultState =
  | { status: 'needs-pick'; reason: 'first-run' | 'missing' }
  | { status: 'ready'; rootName: string; vaultChanged?: boolean }

export type TreeEntry = {
  name: string
  relPath: string
  kind: 'dir' | 'note' | 'file'
  tier?: 'follow' | 'forbidden'
  children?: TreeEntry[]
}

export type PermissionTier = 'reference' | 'follow' | 'forbidden'
export type PermissionEntry = { relPath: string; tier: PermissionTier }
export type PermissionState =
  | { status: 'ready'; entries: PermissionEntry[] }
  | { status: 'invalid'; error: string }
export type SetPermissionRequest = { relPath: string; tier: PermissionTier }

export type NoteSnapshot = { content: string; revision: string }
export type NoteWriteRequest = { relPath: string; content: string; expectedRevision: string }

export type NotePayload = {
  relPath: string
  content: string
  revision: string
}

export type NoteWriteResult = {
  ok: true
  revision: string
} | {
  ok: false
  error: 'CONFLICT' | 'BAD_PATH' | 'NO_VAULT' | 'IO_ERROR'
}

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
