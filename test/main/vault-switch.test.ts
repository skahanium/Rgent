import { describe, it, expect, vi } from 'vitest'
import { VaultSwitch } from '../../src/main/vault-switch.ts'

describe('single active vault switching', () => {
  it('serializes switching and leaves the old binding on a failed flush', async () => {
    const commit = vi.fn(), release = vi.fn()
    const flow = new VaultSwitch({ check: vi.fn(), prepare: async()=>{}, flush: async()=>false, commit, release })
    await expect(flow.run('B')).rejects.toThrow('UNSAVED_DRAFT')
    expect(commit).not.toHaveBeenCalled(); expect(release).toHaveBeenCalled(); expect(flow.busy).toBe(false)
  })
  it('checks the target before stopping the old task and immediately before commit', async () => {
    const order:string[]=[]
    const flow=new VaultSwitch({check:()=>{order.push('check')},prepare:async()=>{order.push('stop')},flush:async()=>{order.push('save');return true},commit:async()=>{order.push('commit');return 'ready'},release:()=>{order.push('release')}})
    expect(await flow.run('B')).toBe('ready')
    expect(order).toEqual(['check','stop','save','check','commit','release'])
  })
  it('rejects another switch while one is saving without releasing the first gate', async () => {
    let finish!:()=>void
    const release=vi.fn()
    const flow=new VaultSwitch({check:()=>{},prepare:()=>new Promise<void>(r=>{finish=r}),flush:async()=>true,commit:async()=>{},release})
    const first=flow.run('B');await Promise.resolve()
    await expect(flow.run('C')).rejects.toThrow('VAULT_SWITCH_BUSY');expect(release).not.toHaveBeenCalled()
    finish();await first;expect(release).toHaveBeenCalledTimes(1)
  })
  it('does not commit a replaced target after saving the old vault', async()=>{
    let checks=0;const commit=vi.fn()
    const flow=new VaultSwitch({check:()=>{if(++checks===2)throw Error('VAULT_TARGET_CHANGED')},prepare:async()=>{},flush:async()=>true,commit,release:()=>{}})
    await expect(flow.run('B')).rejects.toThrow('VAULT_TARGET_CHANGED');expect(commit).not.toHaveBeenCalled()
  })
})

function restoreFlow(overrides: Record<string,unknown> = {}) {
  const release=vi.fn(),close=vi.fn(),stalled=vi.fn(),handoffs: Array<{id:string;owner:string;sessionId:string|null}>=[]
  const flow=new VaultSwitch<string,string>({check:()=>{},prepare:async()=>{},flush:async()=>true,commit:async()=> 'new',release,close,stalled,
    handoff:(result:string,id:string,owner:string)=>{handoffs.push({id,owner,sessionId:result});return {result,sessionId:result}},deadlineMs:20,...overrides} as never)
  return {flow,release,close,stalled,handoffs}
}
it('native close cancels preparation and waits for its protected draft work before closing the old vault',async()=>{
 let finish!:()=>void;const commit=vi.fn(async()=> 'new'),{flow,close,release}=restoreFlow({prepare:()=>new Promise<void>(r=>{finish=r}),commit})
 const work=flow.run('B','frame');expect(flow.requestClose()).toBe(true);expect(flow.requestClose()).toBe(true)
 expect(close).not.toHaveBeenCalled();finish();await expect(work).rejects.toThrow('VAULT_SWITCH_CANCELLED')
 expect(commit).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1)
})
it('native commit close is single and waits for the same frame, transition and current restored session',async()=>{
 let finish!:()=>void;const {flow,close,release,handoffs}=restoreFlow({commit:()=>new Promise<string>(r=>{finish=()=>r('new')})})
 const work=flow.run('B','frame');await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
 expect(flow.requestClose()).toBe(true);expect(flow.requestClose()).toBe(true);finish();expect(await work).toBe('new')
 expect(flow.busy).toBe(true);expect(release).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
 const ack={id:handoffs[0].id,sessionId:'new',outcome:'ready' as const}
 expect(flow.restored('other',ack,'new')).toBe(false);expect(flow.restored('frame',{...ack,id:'old'},'new')).toBe(false)
 expect(flow.restored('frame',ack,'old')).toBe(false);expect(flow.busy).toBe(true)
 expect(flow.restored('frame',ack,'new')).toBe(true);expect(close).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1)
 expect(flow.restored('frame',ack,'new')).toBe(false)
})
it('an explicit new-vault diagnosis releases deferred close without claiming restoration success',async()=>{
 const {flow,close,handoffs}=restoreFlow();await flow.run('B','frame');flow.requestClose()
 expect(flow.restored('frame',{id:handoffs[0].id,sessionId:'new',outcome:'diagnosed'},'new')).toBe(true)
 expect(close).toHaveBeenCalledTimes(1);expect(flow.busy).toBe(false)
})
it('bounded preparation invalidates late work and retains the original binding',async()=>{
 vi.useFakeTimers();try{
 let current!:()=>void;const commit=vi.fn(),{flow,release}=restoreFlow({prepare:(_target:string,assert:()=>void)=>{current=assert;return new Promise(()=>{})},commit})
 const work=flow.run('B','frame');const rejected=expect(work).rejects.toThrow('VAULT_SWITCH_TIMEOUT');await vi.advanceTimersByTimeAsync(21);await rejected
 expect(commit).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);expect(()=>current()).toThrow('VAULT_SWITCH_CANCELLED')
 }finally{vi.useRealTimers()}
})
it('lost restoration acknowledgement reports a bounded stall, retries with a new token and ignores the old receipt',async()=>{
 vi.useFakeTimers();try{
 const {flow,release,handoffs,stalled}=restoreFlow();await flow.run('B','frame');flow.requestClose();const old=handoffs[0]
 await vi.advanceTimersByTimeAsync(21);expect(stalled).toHaveBeenCalledTimes(1);expect(release).not.toHaveBeenCalled();expect(flow.busy).toBe(true)
 expect(flow.retryRestore()).toBe(true);expect(handoffs[1].id).not.toBe(old.id)
 expect(flow.restored('frame',{id:old.id,sessionId:'new',outcome:'ready'},'new')).toBe(false)
 flow.cancelClose();expect(flow.restored('frame',{id:handoffs[1].id,sessionId:'new',outcome:'ready'},'new')).toBe(true)
 }finally{vi.useRealTimers()}
})
it('commit reply alone cannot release the main gate before renderer restoration',async()=>{
 const {flow,release}=restoreFlow();await flow.run('B','frame');expect(flow.busy).toBe(true);expect(release).not.toHaveBeenCalled()
})
it('a stale native timeout decision cannot change a newer restoration gate',async()=>{
 vi.useFakeTimers();try{
 let ticket=0;const {flow,handoffs}=restoreFlow({stalled:(_phase:string,id:number)=>{ticket=id}})
 await flow.run('B','frame');await vi.advanceTimersByTimeAsync(21);expect(flow.isCurrentStall(ticket)).toBe(true)
 flow.retryRestore();expect(flow.isCurrentStall(ticket)).toBe(false)
 flow.restored('frame',{id:handoffs[1].id,sessionId:'new',outcome:'ready'},'new')
 }finally{vi.useRealTimers()}
})
