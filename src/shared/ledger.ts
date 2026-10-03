import type {LedgerRecord} from '../main/ledger-store.ts'
export type LedgerRequest={sessionId:string;objectVersion:string;relPath:string;cursor?:string|null}
export type LedgerView={noteId:string;records:LedgerRecord[];cursor:string|null;ownership:'verified';gaps:string[];chunk?:{taskId:string;data:string;offset:number;total:number;hash:string}}
export type LedgerResult={ok:true;value:LedgerView}|{ok:false;error:string;registryRevision?:string|null}
export type LedgerMigrationRequest={sessionId:string;after:string|null}
export type LedgerMigrationResult={ok:true;value:{processed:string[];after:string|null;failures:{relPath:string;error:string}[]}}|{ok:false;error:string}

export type LedgerRepairRequest={sessionId:string;registryRevision:string|null}

export type LedgerMaintenanceRequest={sessionId:string;objectVersion:string;relPath:string;action:'compress'|'clear';previewId?:string}
export type LedgerMaintenanceResult={ok:true;value:{id:string;records:{taskId:string;revision:number;bytes:number}[];totalBytes:number;warning:string}|{success:string[];failed:string[];savedBytes:number}}|{ok:false;error:string}
