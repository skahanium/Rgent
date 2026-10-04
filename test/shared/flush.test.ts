import { describe, expect, it } from 'vitest'
import { CloseFlow, reportFlush, timeoutAction } from '../../src/shared/flush.ts'

describe('timeoutAction', () => {
  it('never leaves a live renderer without an escape', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(timeoutAction(flow, true)).toBe('prompt')
    // 关键回归：不能返回 'none'，否则流程停在 flushing，窗口关不掉。
    expect(flow.request()).toBe('none')
    expect(timeoutAction(flow, true)).toBe('none')
  })

  it('closes when the renderer is gone so a hung flush cannot pin the window', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(timeoutAction(flow, false)).toBe('close')
  })
})

it('reports a failed flush even when the save operation throws', async () => {
  const results: Array<{ ok: boolean }> = []
  await reportFlush(async () => { throw new Error('disk unavailable') }, (payload) => results.push(payload))
  expect(results).toEqual([{ ok: false }])
})

describe('CloseFlow', () => {
  it('closes after a successful save', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.flushed(true)).toBe('close')
  })

  it('retries a failed save and closes only after the retry succeeds', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.flushed(false)).toBe('prompt')
    expect(flow.decide('retry')).toBe('flush')
    expect(flow.flushed(true)).toBe('close')
  })

  it('lets a person continue editing and start a later close afresh', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.flushed(false)).toBe('prompt')
    expect(flow.decide('continue')).toBe('cancel')
    expect(flow.request()).toBe('flush')
  })

  it('closes only after an explicit discard decision', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.flushed(false)).toBe('prompt')
    expect(flow.decide('discard')).toBe('close')
  })

  it('ignores repeated close requests while saving or awaiting a decision', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.request()).toBe('none')
    expect(flow.flushed(false)).toBe('prompt')
    expect(flow.request()).toBe('none')
    expect(flow.decide('retry')).toBe('flush')
    expect(flow.request()).toBe('none')
  })

  it('permits close when the renderer disappears during a pending save', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.rendererGone()).toBe('close')
  })

  it('turns a stall into a decision instead of doing nothing', () => {
    const idle = new CloseFlow()
    expect(idle.stalled()).toBe('none')
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.stalled()).toBe('prompt')
    expect(flow.stalled()).toBe('none')
    expect(flow.decide('continue')).toBe('cancel')
    expect(flow.request()).toBe('flush')
  })

  it('lets a late reply still drive the flow after the renderer died', () => {
    const flow = new CloseFlow()
    expect(flow.request()).toBe('flush')
    expect(flow.rendererGone()).toBe('close')
    expect(flow.flushed(true)).toBe('none')
  })
})
it('holds dirty drafts without a fake save on recovery resume, rejects dirty commit and drains preview',async()=>{
 const {RecoveryDraftGate}=await import('../../src/shared/flush.ts'),gate=new RecoveryDraftGate(),calls:string[]=[]
 let dirty=true;const context={sessionId:'session',operationId:'one'},deps={session:()=> 'session',composing:()=>false,changed:()=>calls.push('gate'),settled:async()=>{calls.push('settled')},save:async()=>{calls.push('save');dirty=false;return true},dirty:()=>dirty}
 expect(await gate.handle('recovery-resume',context,deps)).toBe(true);expect(gate.held('session')).toBe(true);expect(calls).not.toContain('save');expect(dirty).toBe(true)
 await gate.handle('recovery-release',context,deps);expect(gate.held('session')).toBe(false)
 expect(await gate.handle('recovery-commit',context,deps)).toBe(false);expect(dirty).toBe(true)
 await gate.handle('recovery-release',context,deps)
 expect(await gate.handle('recovery-preview',context,deps)).toBe(true);expect(dirty).toBe(false);expect(calls.indexOf('gate')).toBeLessThan(calls.indexOf('save'))
})
it('keeps the new session gate when old recovery completions and releases arrive late',async()=>{
 const {RecoveryDraftGate}=await import('../../src/shared/flush.ts'),gate=new RecoveryDraftGate();let session='old',release!:()=>void
 const pending=new Promise<void>(r=>{release=r}),deps={session:()=>session,composing:()=>false,changed:()=>{},settled:()=>pending,save:async()=>true,dirty:()=>true}
 const old=gate.handle('recovery-resume',{sessionId:'old',operationId:'one'},deps);session='new'
 expect(await gate.handle('recovery-resume',{sessionId:'new',operationId:'two'},{...deps,settled:async()=>{}})).toBe(true)
 release();expect(await old).toBe(false);await gate.handle('recovery-release',{sessionId:'old',operationId:'one'},deps)
 expect(gate.held('new')).toBe(true)
})
it('reports preview save failure and preserves held drafts until the matching release',async()=>{
 const {RecoveryDraftGate}=await import('../../src/shared/flush.ts'),gate=new RecoveryDraftGate(),context={sessionId:'s',operationId:'one'},deps={session:()=> 's',composing:()=>false,changed:()=>{},settled:async()=>{},save:async()=>false,dirty:()=>true}
 expect(await gate.handle('recovery-preview',context,deps)).toBe(false);expect(gate.held('s')).toBe(true)
 await gate.handle('recovery-release',{...context,operationId:'wrong'},deps);expect(gate.held('s')).toBe(true)
 await gate.handle('recovery-release',context,deps);expect(gate.held('s')).toBe(false)
})
it('allows only the preview owner to drain drafts while other flushes remain blocked',async()=>{
 const {RecoveryDraftGate}=await import('../../src/shared/flush.ts'),gate=new RecoveryDraftGate();let release!:()=>void
 const pending=new Promise<void>(r=>{release=r}),context={sessionId:'s',operationId:'one'},deps={session:()=> 's',composing:()=>false,changed:()=>{},settled:()=>pending,save:async()=>true,dirty:()=>true}
 const hold=gate.handle('recovery-preview',context,deps)
 expect(gate.maySave('s')).toBe(false);expect(gate.maySave('s',context.operationId)).toBe(true)
 release();await hold;await gate.handle('recovery-release',context,deps)
 await gate.handle('recovery-resume',context,deps);expect(gate.maySave('s',context.operationId)).toBe(false)
})

it('workspace saving reports false and thrown disk failures, preventing a successful draft flush',async()=>{
 const {saveWorkspacePosition}=await import('../../src/shared/flush.ts');const notice=()=>{},done:Array<{ok:boolean}>=[]
 for(const write of [async()=>false,async()=>{throw Error('disk')}]){
  await reportFlush(async()=>{const workspace=await saveWorkspacePosition(write,notice);const body=true;return workspace&&body},value=>done.push(value))
 }
 expect(done).toEqual([{ok:false},{ok:false}]);expect(await saveWorkspacePosition(async()=>true,notice)).toBe(true)
})
