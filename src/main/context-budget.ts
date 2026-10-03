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
