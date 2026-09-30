import { describe, expect, it } from 'vitest'
import { AgentHost, type HostDependencies } from '../../src/main/agent-host.ts'
import type { ModelStepEvent } from '../../src/main/model-stream.ts'
import { TaskAuthorizationRegistry, type TaskGrant } from '../../src/main/task-authorization.ts'
import { createScopedAgentTools } from '../../src/main/scoped-agent-tools.ts'
import { ledgerProvenance } from '../../src/main/ledger-provenance.ts'
import type { AgentStartRequest } from '../../src/shared/ipc.ts'

function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function appFor(steps: ModelStepEvent[][], options: { tools?: number; modelSteps?: number } = {}) {
  let content = '/问\n'; let revision = 1; let live = true; let fault = ''; let calls = 0
  const messages: unknown[] = []; const executed: string[] = []; const events: unknown[] = []
  const credential = { provider: 'custom' as const, baseURL: 'http://127.0.0.1:1/v1', modelId: 'test', contextTokens: 20000, apiKey: 'secret' }
  const limits = { seconds: 30, steps: options.modelSteps ?? 8, tools: options.tools ?? 8 }
  const grant = {
    id: 'g', root: '/vault', sessionId: 's', origin: 'a.md', credential, limits,
    sources: [{ sourceId: 'a', relPath: 'a.md' }, { sourceId: 'b', relPath: 'b.md' }],
    assertLive: async () => { if (!live) throw Error('AUTHORIZATION_REVOKED'); if (fault) throw Error(fault) },
    validateSources: async () => { if (fault) throw Error(fault) }, assertWriteTarget: () => {}, acknowledgeOrigin: () => {}, revoke: () => { live = false }
  } as unknown as TaskGrant
  const tools = {
    contextPolicy: async () => ({ allowedLedgerChapterIds: [], excludedAiTaskIds: [] }),
    execute: async (name: string) => { executed.push(name); return { ok: true, text: '工具正文' } },
    assertCurrent: async () => { if (fault) throw Error(fault) }, dependencies: () => [], summary: (): { name: string; outcome: string }[] => [],
    recordContext: () => {}, markSent: () => {}, sentSources: () => []
  }
  const deps: HostDependencies = {
    root: () => '/vault', authorize: async () => grant,
    read: async () => ({ content, revision: String(revision) }),
    write: async (_path, next) => { content = next; return String(++revision) },
    tier: async () => 'reference', credential: () => credential, limits: () => limits,
    stream: async function* () { throw Error('LEGACY_FALLBACK') },
    streamStep: async function* (input) { messages.push(structuredClone(input.messages)); for (const part of steps[calls++] ?? []) yield part },
    createReadOnlyTools: () => tools,
    emit: e => { events.push(e) }
  }
  const host = new AgentHost(deps)
  return { host, deps, tools, content: () => content, messages, executed, events, calls: () => calls, setFault: (value: string) => { fault = value }, start: () => host.start({ relPath: 'a.md', range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' }) }
}
const call = (id: string, name = 'search_library', input: unknown = { query: 'needle' }): ModelStepEvent => ({ type: 'tool-call', id, name, input })
const finish = (reason = 'tool-calls'): ModelStepEvent => ({ type: 'finish', reason })

describe('Host loop over the real grant and tools', () => {
  it('never lets an out-of-scope note reach the model', async () => {
    const records = new Map<string, { content: string; revision: string; sessionId: string; objectVersion: string }>([
      ['a.md', { content: '/问\n', revision: 'ra', sessionId: 's', objectVersion: 'oa' }],
      ['b.md', { content: '# 参考\n\nneedle 正文\n', revision: 'rb', sessionId: 's', objectVersion: 'ob' }],
      ['outside.md', { content: 'needle OUTSIDE_SECRET\n', revision: 'rc', sessionId: 's', objectVersion: 'oc' }]
    ])
    const readNote = async (path: string) => { const item = records.get(path); if (!item) throw Error('ENOENT'); return { ...item } }
    const tier = async (_root: string, path: string) => (path === 'a.md' ? 'reference' as const : 'follow' as const)
    const registry = new TaskAuthorizationRegistry({
      root: () => '/vault', session: () => 's',
      tree: async () => [...records.keys()].map((relPath) => ({ name: relPath, relPath, kind: 'note' as const })),
      read: readNote, tier, acceptsObject: () => false,
      configuration: () => ({ credential: { provider: 'custom', baseURL: 'http://127.0.0.1:1/v1', modelId: 'm', contextTokens: 20000, apiKey: 'k' }, limits: { seconds: 30, steps: 4, tools: 6 } })
    })
    const request = { relPath: 'a.md', sessionId: 's', objectVersion: 'oa', expectedRevision: 'ra', range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问', references: ['b.md'] }
    const preview = await registry.preview('owner', request)
    let revision = 1
    const sent: unknown[][] = []
    const steps: ModelStepEvent[][] = [
      [{ type: 'tool-call', id: 'x', name: 'search_library', input: { query: 'needle' } }, { type: 'finish', reason: 'tool-calls' }],
      [{ type: 'text', text: '完成' }, { type: 'finish', reason: 'stop' }]
    ]
    let call = 0
    const host = new AgentHost({
      root: () => '/vault', session: () => 's',
      authorize: (input) => registry.consume(input.authorizationOwner!, input as unknown as AgentStartRequest),
      read: readNote,
      write: async (path, next) => {
        const nextRevision = `r${++revision}`
        records.set(path, { ...records.get(path)!, content: next, revision: nextRevision })
        return { sessionId: 's', objectVersion: 'oa', revision: nextRevision }
      },
      tier,
      credential: () => ({ provider: 'custom', baseURL: 'http://127.0.0.1:1/v1', modelId: 'm', contextTokens: 20000, apiKey: 'k' }),
      limits: () => ({ seconds: 30, steps: 4, tools: 6 }),
      stream: async function* () { throw Error('LEGACY_FALLBACK') },
      streamStep: async function* (input) { sent.push(structuredClone(input.messages)); for (const part of steps[call++] ?? []) yield part },
      createReadOnlyTools: (grant, taskId) => createScopedAgentTools(grant, taskId, { read: readNote, tier, acceptsObject: () => false }),
      emit: () => {}
    })
    const task = await host.start({ ...request, previewId: preview.id, authorizationOwner: 'owner' })
    expect(await task.done).toEqual({ status: 'completed' })
    const transcript = JSON.stringify(sent)
    expect(transcript).toContain('needle 正文')
    expect(transcript).not.toContain('OUTSIDE_SECRET')
    expect(records.get('a.md')!.content).toContain('完成')
  })
})

describe('Host manual read-only loop', () => {
  it('executes tools in order and sends results only in the next model request', async () => {
    const app = appFor([[call('s'), finish()], [call('r', 'read_library', { sourceId: 'b' }), finish()], [{ type: 'text', text: '回答' }, finish('stop')]])
    const task = await app.start()
    expect(await task.done).toEqual({ status: 'completed' })
    expect(app.executed).toEqual(['search_library', 'read_library'])
    expect(app.calls()).toBe(3)
    expect(JSON.stringify(app.messages[1])).toContain('tool-result')
    expect(app.content()).toContain('回答')
    expect(app.content()).not.toContain('工具正文')
  })
  it('refuses unknown and duplicate calls, while counting each attempt against the shared tool cap', async () => {
    const app = appFor([[call('x', 'foreign', { stolen: 'secret' }), call('x'), finish()], [call('y'), finish()]], { tools: 2 })
    const task = await app.start()
    expect(await task.done).toEqual({ status: 'failed', reason: 'TOOL_CALL_LIMIT' })
    expect(app.executed).toEqual([])
    expect(JSON.stringify(app.messages[1])).toContain('TOOL_NOT_ALLOWED')
    expect(JSON.stringify(app.messages[1])).not.toContain('stolen')
  })
  it('stops a source-invalid task while the provider next chunk is stalled', async () => {
    const app = appFor([])
    const reached = deferred(); const resume = deferred()
    app.deps.streamStep = async function* () { yield { type: 'text', text: '保留回答' }; reached.resolve(); await resume.promise; yield finish('stop') }
    const task = await app.start(); await reached.promise
    app.setFault('SOURCE_CHANGED')
    await app.host.recheckSources('/vault', 's')
    expect(await task.done).toEqual({ status: 'failed', reason: 'SOURCE_CHANGED' })
    expect(app.content()).toContain('保留回答')
    expect(app.calls()).toBe(0)
    resume.resolve()
  })
  it('cancels a stalled tool guard without waiting for a late read and does not issue another request', async () => {
    const app = appFor([[call('x'), finish()]])
    const reached = deferred(); const resume = deferred()
    app.tools.execute = async (name) => { app.executed.push(name); reached.resolve(); await resume.promise; return { ok: true, text: '迟到结果' } }
    const task = await app.start(); await reached.promise
    const stopped = await Promise.race([app.host.cancel(task.id, 'user'), new Promise(resolve => setTimeout(() => resolve('HUNG'), 1000))])
    expect(stopped).toEqual({ status: 'cancelled', reason: 'user' })
    expect(app.calls()).toBe(1)
    resume.resolve()
  })
  it('shares model step budget across tool continuations', async () => {
    const app = appFor([[call('a'), finish()], [call('b'), finish()]], { modelSteps: 1 })
    const task = await app.start()
    expect(await task.done).toEqual({ status: 'failed', reason: 'MODEL_STEP_LIMIT' })
    expect(app.calls()).toBe(1)
  })
  it('serializes an already-running watcher check before the next own checkpoint', async () => {
    const app = appFor([])
    const streaming = deferred(); const yieldText = deferred(); const checking = deferred(); const releaseCheck = deferred(); const blockedWrite = deferred(); const releaseWrite = deferred()
    let watchStarted = false; let writeStarted = false
    app.deps.streamStep = async function* () { streaming.resolve(); await yieldText.promise; yield { type: 'text', text: '自身保存' }; yield finish('stop') }
    const grant = await app.deps.authorize!({ relPath: 'a.md', range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
    const validate = grant.validateSources
    grant.validateSources = async () => { if (watchStarted) { checking.resolve(); await releaseCheck.promise; if (writeStarted) throw Error('SOURCE_CHANGED') }; await validate() }
    const originalWrite = app.deps.write
    const task = await app.start(); await streaming.promise
    app.deps.write = async (...args) => { writeStarted = true; blockedWrite.resolve(); await releaseWrite.promise; return originalWrite(...args) }
    watchStarted = true
    const recheck = app.host.recheckSources('/vault', 's'); await checking.promise
    yieldText.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    const overlapped = writeStarted
    watchStarted = false; releaseCheck.resolve(); releaseWrite.resolve()
    await recheck
    expect(await task.done).toEqual({ status: 'completed' })
    expect(overlapped).toBe(false)
  })

  it('keeps a watcher behind an in-flight own write until its success receipt is acknowledged', async () => {
    const app = appFor([])
    const reached = deferred(); const release = deferred(); const stalled = deferred(); const finishStream = deferred()
    let writing = false; let checks = 0
    app.deps.streamStep = async function* () { yield { type: 'text', text: '已生成' }; stalled.resolve(); await finishStream.promise; yield finish('stop') }
    const write = app.deps.write
    let marked = false
    app.deps.write = async (...args) => {
      if (!marked) { marked = true; return write(...args) }
      writing = true; reached.resolve(); await release.promise
      const result = await write(...args); writing = false; return result
    }
    const grant = await app.deps.authorize!({ relPath: 'a.md', range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
    grant.validateSources = async () => { checks++; if (writing) throw Error('SOURCE_CHANGED') }
    const task = await app.start(); await reached.promise
    const recheck = app.host.recheckSources('/vault', 's')
    await new Promise(resolve => setTimeout(resolve, 20)); expect(checks).toBe(0)
    release.resolve(); await recheck; await stalled.promise
    finishStream.resolve()
    expect(await task.done).toEqual({ status: 'completed' })
  })
  it('returns a bounded error result for invalid arguments and executes later independent valid calls', async () => {
    const app = appFor([[{ ...call('bad'), invalid: true } as ModelStepEvent, call('good'), finish()], [{ type: 'text', text: '完成' }, finish('stop')]])
    const task = await app.start()
    expect(await task.done).toEqual({ status: 'completed' })
    expect(app.executed).toEqual(['search_library'])
    expect(JSON.stringify(app.messages[1])).toContain('INVALID_TOOL_ARGUMENTS')
  })
  it('records an executor refusal exactly once while preserving adapter refusals', async () => {
    const app = appFor([[call('bad'), { ...call('adapter'), invalid: true } as ModelStepEvent, finish()], [{ type: 'text', text: '完成' }, finish('stop')]])
    app.tools.execute = async () => { throw Error('INVALID_TOOL_ARGUMENTS') }
    app.tools.summary = () => [{ name: 'search_library', outcome: 'INVALID_TOOL_ARGUMENTS (1)' }]
    const task = await app.start()
    expect(await task.done).toEqual({ status: 'completed' })
    const provenance = ledgerProvenance(app.content())
    expect(provenance.status).toBe('valid')
    if (provenance.status === 'valid') expect(provenance.record.tools).toEqual([
      { name: 'search_library', outcome: 'INVALID_TOOL_ARGUMENTS (1)' },
      { name: 'search_library', outcome: 'INVALID_TOOL_ARGUMENTS × 1' }
    ])
  })
  it('rejects a tool-calls finish with no calls and never falls back', async () => {
    const app = appFor([[finish()]])
    const task = await app.start()
    expect(await task.done).toEqual({ status: 'failed', reason: 'MODEL_PROTOCOL_ERROR' })
    expect(app.calls()).toBe(1)
  })
  it('does not mark sources sent when model step budget rejects the next request', async () => {
    const app = appFor([[call('a'), finish()]], { modelSteps: 1 })
    let sent = 0; app.tools.markSent = () => { sent++ }
    const task = await app.start()
    expect(await task.done).toEqual({ status: 'failed', reason: 'MODEL_STEP_LIMIT' })
    expect(sent).toBe(1)
  })
  it('bounds aggregate generated text even if the provider ignores maxOutputTokens', async () => {
    const app = appFor([[{ type: 'text', text: 'x'.repeat(1048577) }, finish('stop')]])
    const task = await app.start()
    expect(await task.done).toEqual({ status: 'failed', reason: 'MODEL_OUTPUT_LIMIT' })
    expect(app.content().length).toBeLessThan(10000)
  })

  it('aborts a stalled provider when the bound vault becomes unusable and retains pending output', async () => {
    const app = appFor([]); const reached = deferred(); const resume = deferred()
    app.deps.streamStep = async function* () { yield { type: 'text', text: '库失效前文本' }; reached.resolve(); await resume.promise; yield finish('stop') }
    const task = await app.start(); await reached.promise
    app.deps.root = () => null
    await app.host.recheckSources('/vault', 's')
    const stopped = await Promise.race([task.done.catch(error => error.message), new Promise(resolve => setTimeout(() => resolve('HUNG'), 100))])
    resume.resolve()
    expect(stopped).toBe('VAULT_CHANGED')
    expect(app.host.hasPending('/vault')).toBe(true)
    app.deps.root = () => '/vault'; await app.host.retryPending('/vault')
    expect(app.content()).toContain('库失效前文本')
    expect(app.content()).toContain('VAULT_CHANGED')
    expect(app.events.at(-1)).toMatchObject({ status: 'failed', reason: 'VAULT_CHANGED', persisted: true })
  })

  it('cancels without waiting for a stalled watcher that a pending checkpoint is queued behind', async () => {
    const app = appFor([]); const streaming = deferred(); const emitText = deferred(); const checking = deferred(); const release = deferred()
    app.deps.streamStep = async function* () { streaming.resolve(); await emitText.promise; yield { type: 'text', text: '等待保存的回答' }; yield finish('stop') }
    const grant = await app.deps.authorize!({ relPath: 'a.md', range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
    const task = await app.start(); await streaming.promise
    grant.validateSources = async () => { checking.resolve(); await release.promise }
    const watcher = app.host.recheckSources('/vault', 's'); await checking.promise
    emitText.resolve(); await new Promise(resolve => setTimeout(resolve, 20))
    const stopped = await Promise.race([app.host.cancel(task.id), new Promise(resolve => setTimeout(() => resolve('HUNG'), 100))])
    release.resolve(); await watcher
    expect(stopped).toEqual({ status: 'cancelled', reason: 'user' })
    expect(app.content()).toContain('等待保存的回答')
  })

})
