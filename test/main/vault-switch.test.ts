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
