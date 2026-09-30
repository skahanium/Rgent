import { describe, it, expect } from 'vitest'
import { AgentHost } from '../../src/main/agent-host.ts'

function app() {
  let content = '/问\n', revision = 'r0', objectVersion = 'o0', sessionId = 's0'
  const events: unknown[] = []
  let onChunk = () => {}
  const host = new AgentHost({
    root: () => '/vault', session: () => sessionId,
    read: async () => ({ content, revision, objectVersion, sessionId }),
    acceptsObject: (_path, expected, current) => expected === current,
    write: async (_path, next, expected, binding) => {
      if (binding?.sessionId !== sessionId || binding.objectVersion !== objectVersion) throw new Error('NOTE_REPLACED')
      if (expected !== revision) throw new Error('CONFLICT')
      content = next; revision += '1'; objectVersion += '1'
      return { revision, objectVersion, sessionId }
    },
    tier: async () => 'reference', credential: () => ({ provider: 'custom', baseURL: 'http://localhost', modelId: 'm', contextTokens: 10000, apiKey: 'k' }),
    limits: () => ({ seconds: 5, steps: 4, tools: 0 }),
    stream: async function* () { yield '第一段'; onChunk(); yield '不应写入替身' }, emit: e => events.push(e)
  })
  return { host, events, source: () => content, replace: () => { objectVersion = 'foreign'; content = '替身\n'; revision = 'foreign' }, remount: () => { sessionId = 's1' }, onChunk: (f:()=>void) => { onChunk=f } }
}
const input = { relPath: 'a.md', range: {start:0,end:2}, expectedText:'/问', promptText:'问', sessionId:'s0', objectVersion:'o0', expectedRevision:'r0' }
describe('Host object ownership', () => {
  it('refuses a stale launch before modifying a same-byte replacement', async () => {
    const a=app(); a.replace()
    await expect(a.host.start(input)).rejects.toThrow('NOTE_REPLACED')
    expect(a.source()).toBe('替身\n')
  })
  it('retains completed stream text after replacement without binding pending output to the new object', async () => {
    const a=app(); a.onChunk(a.replace)
    const task=await a.host.start(input)
    await expect(task.done).rejects.toThrow('NOTE_REPLACED')
    expect(a.source()).toBe('替身\n')
    expect(a.host.pendingChapters('/vault','a.md','s0','o0')[0]?.answer).toBe('第一段不应写入替身')
    await expect(a.host.retryPending()).rejects.toThrow('NOTE_REPLACED')
    expect(a.host.hasPending()).toBe(true)
  })
  it('does not continue a same-path task after same-root remount', async () => {
    const a=app(); a.onChunk(a.remount)
    const task=await a.host.start(input)
    await expect(task.done).rejects.toThrow('VAULT_CHANGED')
    expect(a.source()).not.toContain('不应写入替身')
    expect(a.host.hasPending()).toBe(true)
  })
})
