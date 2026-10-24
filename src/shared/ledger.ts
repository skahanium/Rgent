import type {LedgerRecord} from '../main/ledger-store.ts'
export type LedgerRequest={sessionId:string;objectVersion:string;relPath:string;cursor?:string|null}
export type LedgerTrashRequest={sessionId:string;trashId:string;cursor?:string|null}
export type LedgerHistoryRequest={sessionId:string;action:'list'|'purge';noteId?:string}
export type LedgerHistoryEntryView={noteId:string;relPath:string;state:'trashed'|'retired'|'orphaned'|'archived';trashId?:string;archivedAt:string}
export type LedgerHistoryResult={ok:true;entries?:LedgerHistoryEntryView[];bytes?:number;purged?:string}|{ok:false;error:string}
export type LedgerView={noteId:string;records:LedgerRecord[];cursor:string|null;ownership:'verified'|'unregistered';gaps:string[];maintenanceError?:string;chunk?:{taskId:string;data:string;offset:number;total:number;hash:string}}
export type LedgerResult={ok:true;value:LedgerView}|{ok:false;error:string;registryRevision?:string|null}
export type LedgerMigrationRequest={sessionId:string;after:string|null}
export type LedgerMigrationResult={ok:true;value:{processed:string[];after:string|null;failures:{relPath:string;error:string}[]}}|{ok:false;error:string}

export type LedgerRepairRequest={sessionId:string}&({action:'preview';mode:'rebuild'|'restore'}|{action:'commit';previewId:string}|{action:'resume';revision:string}|{action:'cancel';previewId:string})

export type LedgerMaintenanceRequest={sessionId:string;objectVersion:string;relPath:string;action:'compress'|'clear';previewId?:string}
export type LedgerMaintenanceResult={ok:true;value:{id:string;records:{taskId:string;revision:number;bytes:number}[];totalBytes:number;warning:string;archive?:{revision:string;bytes:number}}|{success:string[];failed:string[];savedBytes:number;archiveCleared?:boolean}}|{ok:false;error:string}

export type LedgerReasoningRequest={sessionId:string;objectVersion:string;relPath:string;taskId:string}
export type LedgerReasoningResult={ok:true;text:string|null}|{ok:false;error:string}
export type LedgerRecoveryRow={noteId:string;relPath:string;outcome:'associate'|'history-only'|'refused';reasons:string[];sources:{id:string;status:'paused'|'verified';reason:string}[]}
export type LedgerRecoveryView={id:string;sessionId:string;mode:'rebuild'|'restore';rows:LedgerRecoveryRow[];warning:string;canCommit:boolean}
export type LedgerRepairResult={ok:true;value?:LedgerRecoveryView|{status:'pending'|'complete';revision:string|null;processed:number;total:number}}|{ok:false;error:string}
export function parseLedgerRepairRequest(value:unknown):LedgerRepairRequest|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const r=value as Record<string,unknown>,keys=Object.keys(r).sort().join()
 if(typeof r.sessionId!=='string'||!r.sessionId||r.sessionId.length>128)return null
 if(r.action==='preview'&&keys==='action,mode,sessionId'&&(r.mode==='rebuild'||r.mode==='restore'))return r as LedgerRepairRequest
 if((r.action==='commit'||r.action==='cancel')&&keys==='action,previewId,sessionId'&&typeof r.previewId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(r.previewId))return r as LedgerRepairRequest
 if(r.action==='resume'&&keys==='action,revision,sessionId'&&typeof r.revision==='string'&&/^[a-f0-9]{64}$/.test(r.revision))return r as LedgerRepairRequest
 return null
}
