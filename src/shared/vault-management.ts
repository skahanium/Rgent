/** 本设备的展示与根核验记录，不是权限或任务授权证明。 */
export interface VaultCatalogEntry {
  id: string
  label: string
  path: string
  rootIdentity: string
  pinned: boolean
  lastUsed: number | null
}
export interface VaultCatalogView {
  entries: VaultCatalogEntry[]
  lastVaultId: string | null
  diagnostic: string | null
  revision: string
}
export interface VaultTarget {
  path: string
  rootIdentity: string
  label: string
  id: string | null
}
export interface VaultWorkspace {
  version: 1
  tabs: Array<{ relPath: string; selection?: { anchor: number; head: number }; scrollTop?: number }>
  active: string | null
  sidebarHidden: boolean
  treeScroll: number
  resourceScroll: number
}
