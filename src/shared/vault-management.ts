/** 本设备的展示与根核验记录，不是权限或任务授权证明。 */
export interface VaultCatalogEntry {
  id: string
  label: string
  path: string
  rootIdentity: string
  pinned: boolean
  lastUsed: number | null
  displayVersion?: 2
  legacyDisplayKey?: string
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

export type VaultRestoreReceipt = { id: string; sessionId: string | null; outcome: 'ready' | 'diagnosed' }
export type VaultTransition = {
  busy: boolean; session: string | null
  phase?: 'preparing' | 'committing' | 'restoring' | 'idle'
  closePending?: boolean
  operationId?: string
  /** Retry carries a new receipt token on the existing transition event. */
  restoreId?: string
}
export function parseVaultRestoreReceipt(value: unknown): VaultRestoreReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string,unknown>
  if (Object.keys(r).sort().join() !== 'id,outcome,sessionId' || typeof r.id !== 'string' || !r.id || r.id.length > 128 ||
    !(r.sessionId === null || typeof r.sessionId === 'string' && !!r.sessionId && r.sessionId.length <= 128) ||
    !(r.outcome === 'ready' || r.outcome === 'diagnosed')) return null
  return r as VaultRestoreReceipt
}
export function parseVaultTransition(value: unknown): VaultTransition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string,unknown>
  if (Object.keys(r).some(key=>!['busy','session','phase','closePending','restoreId','operationId'].includes(key)) || typeof r.busy !== 'boolean' ||
    !(r.session===null || typeof r.session==='string' && !!r.session && r.session.length<=128) ||
    r.phase!==undefined && !['preparing','committing','restoring','idle'].includes(String(r.phase)) ||
    r.closePending!==undefined && typeof r.closePending!=='boolean' ||
    r.operationId!==undefined && (typeof r.operationId!=='string'||!r.operationId||r.operationId.length>128) ||
    r.restoreId!==undefined && (r.phase!=='restoring' || typeof r.restoreId!=='string' || !r.restoreId || r.restoreId.length>128)) return null
  return r as VaultTransition
}

export type VaultRootPreview = {id:string;entryId:string;path:string;previousPath:string;previousIdentity:string;rootIdentity:string;workspace:'restore'|'none'|'unavailable';warning:string}
export type VaultCatalogChangeRequest = {id:string;revision:string} & ({action:'pin';pinned:boolean}|{action:'label';label:string}|{action:'remove'|'relocate'}|{action:'root-preview';choose?:boolean}|{action:'root-confirm'|'root-cancel';previewId:string})
export type VaultCatalogChangeResult = VaultCatalogView & {rootPreview?:VaultRootPreview;state?:import('./ipc.ts').VaultState}
export function parseVaultCatalogChange(value:unknown):VaultCatalogChangeRequest|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const r=value as Record<string,unknown>,fields:Record<string,string[]>={pin:['pinned'],label:['label'],remove:[],relocate:[],'root-preview':['choose'],'root-confirm':['previewId'],'root-cancel':['previewId']}
 if(typeof r.id!=='string'||!r.id||r.id.length>128||typeof r.revision!=='string'||typeof r.action!=='string'||!Object.hasOwn(fields,r.action)||Object.keys(r).some(k=>!['id','revision','action',...fields[String(r.action)]!].includes(k)))return null
 if(r.action==='pin'&&typeof r.pinned!=='boolean'||r.action==='label'&&typeof r.label!=='string'||r.action==='root-preview'&&r.choose!==undefined&&typeof r.choose!=='boolean'||['root-confirm','root-cancel'].includes(r.action)&&(typeof r.previewId!=='string'||!r.previewId||r.previewId.length>128))return null
 return r as VaultCatalogChangeRequest
}
