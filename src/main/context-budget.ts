/** A conservative estimate, deliberately distinct from bytes and provider usage. */
export function conservativeTokens(text:string):number{
 let ascii=0,other=0
 for(const c of text){if(c.codePointAt(0)!<128)ascii++;else other+=c.length===2?4:2}
 return Math.ceil(ascii/2)+other
}
export function contextAllocations(b:number){
 if(!Number.isSafeInteger(b)||b<0)throw Error('MODEL_CONTEXT_LIMIT')
 return {body:Math.ceil(b*.5),history:Math.min(8192,Math.floor(b*.3)),memory:Math.min(4096,Math.floor(b*.2))}
}

// Byte storage and input tokens are independent. Existing provenance/material limits
// plus bounded prompt, trace and metrics fit this reserve; the record envelope gets 4 KiB.
export const TASK_RECORD_BYTES = 2 * 1024 * 1024
export const ANSWER_JSON_BYTES = 896 * 1024
export const TASK_METADATA_RESERVE = 896 * 1024
export const SUMMARY_AUDIT_BYTES = TASK_RECORD_BYTES - ANSWER_JSON_BYTES - TASK_METADATA_RESERVE - 4096
export function summaryAuditFits(summaries:readonly import('./host-source.ts').SentSummary[]):boolean {
 return Buffer.byteLength(JSON.stringify({sentSummaries:summaries})) <= SUMMARY_AUDIT_BYTES
}
/** Largest valid UTF-16 prefix whose JSON string fits the finite visible-output budget. */
export function encodedAnswerPrefix(answer:string):string {
 if(Buffer.byteLength(JSON.stringify(answer))<=ANSWER_JSON_BYTES)return answer
 let lo=0,hi=answer.length
 while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(Buffer.byteLength(JSON.stringify(answer.slice(0,mid)))<=ANSWER_JSON_BYTES)lo=mid;else hi=mid-1}
 if(lo>0&&/[\uD800-\uDBFF]/u.test(answer[lo-1]!)&&/[\uDC00-\uDFFF]/u.test(answer[lo]??''))lo--
 return answer.slice(0,lo)
}
