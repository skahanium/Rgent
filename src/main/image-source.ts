import { createHash } from 'node:crypto'
import { compile, compileFragment } from '../markdown/index.ts'
import type { NoteSnapshot, RemoteImageGetRequest } from '../shared/ipc.ts'
import { composeSource } from '../markdown/partition.ts'

/** Caller trust, source proof, and network destination checks are separate gates. */
export function verifyImageSource(snapshot: NoteSnapshot, request: RemoteImageGetRequest): {ok:true;binding:string}|{ok:false} {
  const c=request.context
  if (!c || c.sessionId!==snapshot.sessionId || c.objectVersion!==snapshot.objectVersion || c.revision!==snapshot.revision ||
      !Number.isSafeInteger(c.start) || !Number.isSafeInteger(c.end) || c.start<0 || c.end<=c.start ||
      !['body','ledger'].includes(c.region) || !['auto','explicit'].includes(request.mode)) return {ok:false}
  try {
    let parsed=compile(snapshot.content)
    if(parsed.stale) return {ok:false}
    const draft= c.draftBody!==undefined && c.draftBody!==parsed.partition.body
    if(draft && request.mode!=='explicit') return {ok:false}
    if(draft) parsed=compile(composeSource(c.draftBody!,parsed.partition.ledger))
    if(parsed.stale) return {ok:false}
    const start=parsed.partition.body.length
    const ledger=c.region==='ledger'
    if (ledger ? c.start<start || !parsed.partition.ledger : c.end>start) return {ok:false}
    const index=ledger ? compileFragment(parsed.partition.ledger!).index : parsed.index
    const offset=ledger ? start : 0
    const image=index.images.find(i=>i.range.start+offset===c.start && i.range.end+offset===c.end && i.url===request.url)
    if(!image) return {ok:false}
    if(request.mode==='auto' && (ledger || !['human','adopted'].includes(image.source ?? '') || !request.url.startsWith('https:'))) return {ok:false}
    // Full source revision + draft prevents an old redirect confirmation applying to another image.
    return {ok:true,binding:createHash('sha256').update(JSON.stringify([c.noteRelPath,c.sessionId,c.objectVersion,c.revision,c.region,c.start,c.end,c.draftBody??null])).digest('hex')}
  }catch { return {ok:false} }
}
