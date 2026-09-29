import { describe, expect, it } from 'vitest'
import { VaultMutationQueue } from '../../src/main/vault-mutation-queue.ts'

describe('VaultMutationQueue', () => {
  it('serializes writes and structural work in submission order', async () => {
    const queue = new VaultMutationQueue()
    const sequence: string[] = []
    let release = (): void => {}
    const hold = new Promise<void>((resolve) => { release = resolve })
    const first = queue.run(async () => {
      sequence.push('write-start')
      await hold
      sequence.push('write-end')
    })
    const second = queue.run(async () => { sequence.push('move') })
    await Promise.resolve()
    expect(sequence).toEqual(['write-start'])
    release()
    await Promise.all([first, second])
    expect(sequence).toEqual(['write-start', 'write-end', 'move'])
  })

  it('continues after a rejected operation', async () => {
    const queue = new VaultMutationQueue()
    await expect(queue.run(() => { throw new Error('CONFLICT') })).rejects.toThrow('CONFLICT')
    await expect(queue.run(() => 'saved')).resolves.toBe('saved')
  })
})

describe('VaultStructureGate', () => {
  it('lets existing model and draft writes drain, then blocks affected writes before the move', async () => {
    const module = await import('../../src/main/vault-mutation-queue.ts') as Record<string, unknown>
    expect(module.VaultStructureGate).toBeDefined()
    const Gate = module.VaultStructureGate as new () => {
      begin: (scope: { root: string; exact: string[]; prefixes: string[] }) => void
      affects: (root: string, relPath: string) => boolean
      blocksWrite: (root: string, relPath: string) => boolean
      seal: () => void
      finish: () => void
    }
    const gate = new Gate()
    gate.begin({ root: '/vault', exact: ['引用.md'], prefixes: ['资料'] })
    expect(gate.affects('/vault', '资料/原篇.md')).toBe(true)
    expect(gate.blocksWrite('/vault', '资料/原篇.md')).toBe(false)
    gate.seal()
    expect(gate.blocksWrite('/vault', '资料/原篇.md')).toBe(true)
    expect(gate.blocksWrite('/vault', '引用.md')).toBe(true)
    expect(gate.blocksWrite('/vault', '其他.md')).toBe(false)
    expect(gate.blocksWrite('/another-vault', '资料/原篇.md')).toBe(false)
    gate.finish()
    expect(gate.blocksWrite('/vault', '资料/原篇.md')).toBe(false)
  })
})
