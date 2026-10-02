import { afterEach, expect, it } from 'vitest'
import { AgentHost, type HostEvent } from '../../src/main/agent-host.ts'
import { createModelConfigStore, memoryAuthorizationState } from '../../src/main/model-config.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function boundHost(memoryState?: () => { signature: string }) {
  const approvedMemorySignature = memoryState?.().signature ?? 'approved'
  const state = { content: '/问\n', revision: 1, objectVersion: 'original', sessionId: 'session-1', allowed: true,
    reads: 0, writes: 0, network: 0, failLedger: false, afterRead: () => {}, afterTier: () => {}, memorySignature: 'approved', changeWhileRecalling: false }
  const events: HostEvent[] = []
  const successors = new Map<string, string>()
  let generate: () => AsyncIterable<string> = async function* () { yield 'answer' }
  const host = new AgentHost({
    assertMemoryAuthorization: input => { if (input.memoryAuthorizationSignature !== (memoryState?.().signature ?? state.memorySignature)) throw Error('STALE_PREVIEW') },
    memory: { context: () => ({sessionId: state.sessionId,vaultKey:'key'}), config: () => ({enabled: true,epoch:0}), entries: async () => {if (state.changeWhileRecalling) state.memorySignature='changed'; return []} },
    root: () => '/vault', session: () => state.sessionId,
    acceptsObject: (_path, expected, current) => {
      while (expected !== current && successors.has(expected)) expected = successors.get(expected)!
      return expected === current
    },
    read: async () => {
      state.reads++; state.afterRead()
      return { content: state.content, revision: String(state.revision), sessionId: state.sessionId, objectVersion: state.objectVersion }
    },
    write: async (_path, content, revision, binding) => {
      if (binding?.sessionId !== state.sessionId) throw new Error('VAULT_CHANGED')
      if (binding?.objectVersion !== state.objectVersion) throw new Error('NOTE_REPLACED')
      if (revision !== String(state.revision)) throw new Error('CONFLICT')
      if (state.failLedger && content.includes('<!-- rgent:ledger-task:v1')) { state.failLedger = false; throw new Error('IO_ERROR') }
      const previous = state.objectVersion
      state.content = content; state.revision++; state.objectVersion = `saved-${state.revision}`; state.writes++
      successors.set(previous, state.objectVersion)
      return { revision: String(state.revision), objectVersion: state.objectVersion, sessionId: state.sessionId }
    },
    tier: async () => { if (!state.allowed) throw new Error('FORBIDDEN'); state.afterTier(); return 'reference' },
    credential: () => ({ provider: 'custom', baseURL: 'https://example.test/v1', modelId: 'test', contextTokens: 10000, apiKey: 'secret' }),
    limits: () => ({ seconds: 30, steps: 4, tools: 0 }),
    stream: async function* () { state.network++; yield* generate() }, emit: event => events.push(event)
  })
  const start = () => host.start({ relPath: 'a.md', range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问',
    memoryAuthorizationSignature: approvedMemorySignature, expectedRevision: String(state.revision), sessionId: state.sessionId, objectVersion: state.objectVersion })
  return { host, state, events, start, stream: (next: typeof generate) => { generate = next } }
}

it('allows a new bound task after a completed task and same-root reattachment', async () => {
  const app = boundHost()
  await (await app.start()).done
  app.state.sessionId = 'session-2'; app.state.content = '/问\n'; app.state.objectVersion = 'reopened'; app.state.revision++
  await expect((await app.start()).done).resolves.toMatchObject({ status: 'completed' })
  expect(app.events.at(-1)).toMatchObject({ sessionId: 'session-2', persisted: true })
})

const configDirectories: string[] = []
afterEach(() => { for (const dir of configDirectories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it.each(['unchanged', 'path', 'credential'] as const)('rechecks the actual independent memory connection before launch when %s', async change => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'rgent-memory-binding-')); configDirectories.push(directory)
  const config = createModelConfigStore(directory, { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: b => b.toString() })
  config.saveProvider({ provider: 'custom', baseURL: 'https://memory.test/first/v1', modelId: 'organize', contextTokens: 32000 }, 'memory-key')
  const model = config.getPublic().models.find(m => m.provider === 'custom')!, key = 'a'.repeat(64)
  config.setMemoryDefault(model.id); config.setVaultMemory(key, { enabled: true, override: { mode: 'inherit' } })
  const app = boundHost(() => memoryAuthorizationState(config, key))
  let changed = false
  app.state.afterRead = () => {
    if (changed || change === 'unchanged') return
    changed = true
    config.saveProvider({ provider: 'custom', baseURL: change === 'path' ? 'https://memory.test/second/v1' : 'https://memory.test/first/v1', modelId: 'organize', contextTokens: 32000 }, change === 'credential' ? 'changed-memory-key' : undefined)
  }
  if (change === 'unchanged') { await expect((await app.start()).done).resolves.toMatchObject({ status: 'completed' }); expect(app.state.network).toBe(1) }
  else { await expect(app.start()).rejects.toThrow('STALE_PREVIEW'); expect(app.state.writes).toBe(0); expect(app.state.network).toBe(0) }
})

it('retains generated chapters under their original object and session after identical-byte replacement', async () => {
  const app = boundHost(); let writesAtReplacement = 0
  app.stream(async function* () {
    yield 'first'
    app.state.objectVersion = 'external-replacement'; writesAtReplacement = app.state.writes
    yield ' second'
  })
  await expect((await app.start()).done).rejects.toThrow('NOTE_REPLACED')
  expect(app.state.writes).toBe(writesAtReplacement)
  expect(app.host.pendingChapters('/vault', 'a.md', 'session-1', 'original')[0]?.answer).toBe('first second')
  expect(app.host.pendingChapters('/vault', 'a.md', 'session-2', 'original')).toEqual([])
  expect(app.host.pendingChapters('/vault', 'a.md', 'session-1', 'external-replacement')).toEqual([])
})

it('emits current session and native-save object binding after a successful pending retry', async () => {
  const app = boundHost(); app.state.failLedger = true
  await expect((await app.start()).done).rejects.toThrow('IO_ERROR')
  expect(app.host.hasPending()).toBe(true)
  await app.host.retryPending('/vault')
  expect(app.host.hasPending()).toBe(false)
  expect(app.events.at(-1)).toMatchObject({ sessionId: app.state.sessionId, objectVersion: app.state.objectVersion, persisted: true })
})

it('does not send source when the same-root session changes during the final permission await', async () => {
  const app = boundHost()
  app.state.afterTier = () => { if (app.state.reads >= 3) app.state.sessionId = 'session-2' }
  await expect((await app.start()).done).rejects.toThrow('VAULT_CHANGED')
  expect(app.state.network).toBe(0)
  expect(app.host.hasPending()).toBe(true)
})

it('rechecks permission after reading a checkpoint before writing generated bytes', async () => {
  const app = boundHost()
  app.state.afterRead = () => { if (app.state.network > 0) app.state.allowed = false }
  await expect((await app.start()).done).rejects.toThrow('FORBIDDEN')
  expect(app.state.writes).toBe(1)
  expect(app.state.content).not.toContain('answer')
  expect(app.host.hasPending()).toBe(true)
})

it('does not start the model request if the object is replaced during the final permission await', async () => {
  const app = boundHost()
  app.state.afterTier = () => { if (app.state.reads >= 3) app.state.objectVersion = 'external-before-send' }
  await expect((await app.start()).done).rejects.toThrow('NOTE_REPLACED')
  expect(app.state.network).toBe(0)
})

it('does not change the displayed memory role while awaiting the origin read or recall', async () => {
  const reading = boundHost(); reading.state.afterRead = () => { reading.state.memorySignature = 'changed' }
  await expect(reading.start()).rejects.toThrow('STALE_PREVIEW')
  expect(reading.state.writes).toBe(0); expect(reading.state.network).toBe(0)
  const recalling = boundHost(); recalling.state.changeWhileRecalling = true
  await expect(recalling.start()).rejects.toThrow('STALE_PREVIEW')
  expect(recalling.state.writes).toBe(0); expect(recalling.state.network).toBe(0)
})
