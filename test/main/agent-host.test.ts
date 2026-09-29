import { describe, expect, it } from 'vitest'
import { AgentHost } from '../../src/main/agent-host.ts'
import { partitionSource } from '../../src/markdown/partition.ts'

function harness(stream: (signal: AbortSignal, prompt: string) => AsyncIterable<string>, initial = '前言\n\n/写个回答\n\n后文\n') {
  let content = initial
  let revision = 1
  let policy: 'reference' | 'forbidden' | 'invalid' = 'reference'
  let failLedgerOnce = false
  const events: unknown[] = []
  const host = new AgentHost({
    root: () => '/vault',
    read: async () => ({ content, revision: String(revision) }),
    write: async (_relPath, next, expected) => {
      if (expected !== String(revision)) throw new Error('CONFLICT')
      if (failLedgerOnce && next.includes('<!-- rgent:ledger-task:v1')) {
        failLedgerOnce = false
        throw new Error('IO_ERROR')
      }
      content = next
      revision += 1
      return String(revision)
    },
    tier: async () => {
      if (policy === 'forbidden') throw new Error('FORBIDDEN')
      if (policy === 'invalid') throw new Error('PERMISSIONS_INVALID')
      return 'reference'
    },
    credential: () => ({ provider: 'custom', baseURL: 'http://127.0.0.1:1234/v1', modelId: 'test', contextTokens: 10000, apiKey: 'secret' }),
    limits: () => ({ seconds: 30, steps: 4, tools: 0 }),
    stream: (input, signal) => stream(signal, input.prompt),
    emit: (event) => { events.push(event) }
  })
  return { host, source: () => content, events, setPolicy: (value: typeof policy) => { policy = value }, failLedgerOnce: () => { failLedgerOnce = true }, externalEdit: (change: (source: string) => string) => { content = change(content); revision += 1 } }
}

describe('Host minimal loop', () => {
  it('writes the prompt and streamed answer into the original note, then appends one ledger chapter', async () => {
    const app = harness(async function* () { yield '第一段。\n\n'; yield '## 第二段' })
    const source = app.source()
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    const result = await task.done
    expect(result.status).toBe('completed')
    const part = partitionSource(app.source())
    expect(part.body).toContain('<!-- rgent:prompt:v1 task-id="')
    expect(part.body).not.toContain('/写个回答')
    expect(part.body.match(/<!-- rgent:ai:v1 task-id=/g)).toHaveLength(2)
    expect(part.body).toContain('后文')
    expect(part.ledger).toContain('第一段。')
    expect(part.ledger).toContain('写个回答')
  })

  it('refuses model access when the note is forbidden, without changing bytes', async () => {
    const app = harness(async function* () { yield 'secret' })
    app.setPolicy('forbidden')
    const before = app.source()
    const start = before.indexOf('/')
    await expect(app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })).rejects.toThrow('FORBIDDEN')
    expect(app.source()).toBe(before)
  })

  it('stops taking further chunks after permission changes during a stream', async () => {
    let revoke = () => {}
    const app = harness(async function* () {
      yield '第一段'
      revoke()
      yield '不得再出现'
    })
    revoke = () => app.setPolicy('forbidden')
    const source = app.source()
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await task.done.catch(() => {})
    expect(app.source()).not.toContain('不得再出现')
    expect(app.events.some((event) => JSON.stringify(event).includes('不得再出现'))).toBe(false)
  })

  it('does not send note text if permission changes while the model source is being read', async () => {
    let content = '/问\n'
    let revision = 1
    let allowed = true
    let sent = false
    const host = new AgentHost({
      root: () => '/vault',
      read: async () => {
        if (content.includes('<!-- rgent:prompt:v1')) allowed = false
        return { content, revision: String(revision) }
      },
      write: async (_path, next, expected) => {
        if (expected !== String(revision)) throw new Error('CONFLICT')
        content = next
        return String(++revision)
      },
      tier: async () => { if (!allowed) throw new Error('FORBIDDEN'); return 'reference' },
      credential: () => ({ provider: 'custom', baseURL: 'http://127.0.0.1:1234/v1', modelId: 'test', contextTokens: 10000, apiKey: 'secret' }),
      limits: () => ({ seconds: 30, steps: 4, tools: 0 }),
      stream: async function* () { sent = true; yield '不应发送' },
      emit: () => {}
    })
    const task = await host.start({ relPath: 'a.md', range: { start: 0, end: 2 }, expectedText: '/问', promptText: '问' })
    await task.done.catch(() => {})
    expect(sent).toBe(false)
  })

  it('finishes cancellation even if a provider does not settle its next stream chunk', async () => {
    let resume = () => {}
    let waiting = () => {}
    const blocked = new Promise<void>((resolve) => { resume = resolve })
    const reachedNext = new Promise<void>((resolve) => { waiting = resolve })
    const app = harness(async function* () {
      yield '已生成'
      waiting()
      await blocked
      yield '迟到内容'
    })
    const source = app.source()
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await reachedNext
    const stop = app.host.cancel(task.id, 'user')
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1000) })
    const timely = await Promise.race([stop.then(() => true), deadline])
    clearTimeout(timer)
    resume()
    await task.done
    expect(timely).toBe(true)
    expect(app.source()).toContain('已生成')
    expect(app.source()).not.toContain('迟到内容')
  })

  for (const reason of ['close', 'vault-change'] as const) {
    it(`persists generated bytes and one cancellation chapter before ${reason}`, async () => {
      let waiting = () => {}
      const reachedNext = new Promise<void>((resolve) => { waiting = resolve })
      const app = harness(async function* (signal) {
        yield '已生成'
        waiting()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        yield '迟到内容'
      })
      const source = app.source()
      const start = source.indexOf('/')
      const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
      await reachedNext
      await app.host.cancelAll(reason, '/vault')
      expect(await task.done).toEqual({ status: 'cancelled', reason })
      expect(app.source()).toContain('已生成')
      expect(app.source()).not.toContain('迟到内容')
      expect(partitionSource(app.source()).ledger).toContain(reason)
      expect(app.source().match(/<!-- rgent:ledger-task:v1/g)).toHaveLength(1)
    })
  }

  it('retains an unwritten final chapter for retry and appends it only once', async () => {
    const app = harness(async function* () { yield '回答' })
    app.failLedgerOnce()
    const source = app.source()
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await expect(task.done).rejects.toThrow('IO_ERROR')
    expect(app.host.hasPending()).toBe(true)
    const preview = await app.host.pendingPreview(task.id)
    expect(preview.answer).toBe('回答')
    expect(preview.modelBody).toContain('回答')
    await app.host.resolvePending({ id: task.id, decision: 'retry' })
    expect(app.host.hasPending()).toBe(false)
    expect(app.source().match(/<!-- rgent:ledger-task:v1/g)).toHaveLength(1)
  })

  it('requires a fresh preview revision before a person adopts the model answer', async () => {
    let edit = () => {}
    const app = harness(async function* () { yield '第一段'; edit(); yield '第二段' })
    edit = () => app.externalEdit((source) => source.replace('第一段', '外部修改'))
    const original = app.source()
    const start = original.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await expect(task.done).rejects.toThrow('AI_BLOCK_CHANGED')
    const preview = await app.host.pendingPreview(task.id)
    expect(preview.diskBody).toContain('外部修改')
    expect(preview.modelBody).toContain('第一段第二段')
    app.externalEdit((source) => source.replace('后文', '人改的后文'))
    await expect(app.host.resolvePending({ id: task.id, decision: 'model', expectedRevision: preview.revision })).rejects.toThrow('STALE_PREVIEW')
    expect(app.source()).toContain('外部修改')
    const fresh = await app.host.pendingPreview(task.id)
    await app.host.resolvePending({ id: task.id, decision: 'model', expectedRevision: fresh.revision })
    expect(app.source()).toContain('第一段第二段')
    expect(app.source()).toContain('人改的后文')
    expect(app.source()).not.toContain('外部修改')
    expect(app.source().match(/<!-- rgent:ledger-task:v1/g)).toHaveLength(1)
  })

  it('keeps the disk body when the task marker is missing and records the unwritten answer', async () => {
    const app = harness(async function* () { yield '回答' })
    app.failLedgerOnce()
    const original = app.source()
    const start = original.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await expect(task.done).rejects.toThrow('IO_ERROR')
    app.externalEdit((source) => source.replace(/<!-- rgent:prompt:v1[^\n]*\n/, ''))
    const preview = await app.host.pendingPreview(task.id)
    expect(preview.modelBody).toBeNull()
    await expect(app.host.resolvePending({ id: task.id, decision: 'model', expectedRevision: preview.revision })).rejects.toThrow()
    await app.host.resolvePending({ id: task.id, decision: 'disk', expectedRevision: preview.revision })
    expect(partitionSource(app.source()).body).not.toContain('rgent:prompt')
    expect(partitionSource(app.source()).ledger).toContain('回答')
    expect(app.host.hasPending()).toBe(false)
  })

  it('cannot adopt an answer after a previously written AI marker is removed', async () => {
    let edit = () => {}
    const app = harness(async function* () { yield '第一段'; edit(); yield '第二段' })
    edit = () => app.externalEdit((source) => source.replace(/<!-- rgent:ai:v1 task-id=[^>]*-->/, '<!-- 人修改了块标记 -->'))
    const original = app.source()
    const start = original.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await expect(task.done).rejects.toThrow('AI_BLOCK_CHANGED')
    const preview = await app.host.pendingPreview(task.id)
    expect(preview.modelBody).toBeNull()
    await expect(app.host.resolvePending({ id: task.id, decision: 'model', expectedRevision: preview.revision })).rejects.toThrow('TASK_BLOCK_MISSING')
    await app.host.resolvePending({ id: task.id, decision: 'disk', expectedRevision: preview.revision })
    expect(partitionSource(app.source()).body).toContain('人修改了块标记')
    expect(partitionSource(app.source()).ledger).toContain('第一段第二段')
    expect(app.source().match(/<!-- rgent:ledger-task:v1/g)).toHaveLength(1)
  })

  it('never rewrites a note after permission is revoked during pending recovery', async () => {
    const app = harness(async function* () { yield '回答' })
    app.failLedgerOnce()
    const original = app.source()
    const start = original.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await expect(task.done).rejects.toThrow('IO_ERROR')
    app.setPolicy('forbidden')
    const before = app.source()
    const preview = await app.host.pendingPreview(task.id)
    expect(preview.modelBody).toBeNull()
    await expect(app.host.resolvePending({ id: task.id, decision: 'retry' })).rejects.toThrow('FORBIDDEN')
    expect(app.source()).toBe(before)
    await app.host.resolvePending({ id: task.id, decision: 'disk', expectedRevision: preview.revision })
    expect(app.source()).toBe(before)
    expect(app.host.hasPending()).toBe(false)
  })

  it('keeps the unwritten answer when permission state cannot be verified', async () => {
    const app = harness(async function* () { yield '回答' })
    app.failLedgerOnce()
    const source = app.source()
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await expect(task.done).rejects.toThrow('IO_ERROR')
    app.setPolicy('invalid')
    const preview = await app.host.pendingPreview(task.id)
    const before = app.source()
    await expect(app.host.resolvePending({ id: task.id, decision: 'disk', expectedRevision: preview.revision })).rejects.toThrow('PERMISSIONS_INVALID')
    expect(app.source()).toBe(before)
    expect(app.host.pendingViews()).toEqual([{ id: task.id, relPath: 'a.md', answer: '回答', reason: 'IO_ERROR' }])
    app.setPolicy('reference')
    await app.host.resolvePending({ id: task.id, decision: 'retry' })
    expect(app.source().match(/<!-- rgent:ledger-task:v1/g)).toHaveLength(1)
  })

  it('does not start a later task in a note with an unsaved prior answer', async () => {
    const app = harness(async function* () { yield '回答' }, '前言\n\n/写个回答\n\n/第二问\n')
    app.failLedgerOnce()
    const source = app.source()
    const first = source.indexOf('/写个回答')
    const task = await app.host.start({ relPath: 'a.md', range: { start: first, end: first + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await expect(task.done).rejects.toThrow('IO_ERROR')
    expect(app.host.hasPending()).toBe(true)
    const secondSource = app.source()
    const second = secondSource.indexOf('/第二问')
    await expect(app.host.start({ relPath: 'a.md', range: { start: second, end: second + '/第二问'.length }, expectedText: '/第二问', promptText: '第二问' })).rejects.toThrow('PREVIOUS_TASK_UNSAVED')
  })

  it('does not place provider error text containing a key into events or the ledger', async () => {
    const app = harness(async function* () { throw new Error('remote echoed secret in failure') })
    const source = app.source()
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    expect(await task.done).toEqual({ status: 'failed', reason: 'MODEL_REQUEST_FAILED' })
    expect(app.source()).not.toContain('remote echoed secret')
    expect(JSON.stringify(app.events)).not.toContain('remote echoed secret')
  })

  it('redacts an API key echoed across model stream chunks before display or write', async () => {
    const app = harness(async function* () { yield '前缀 sec'; yield 'ret 后缀' })
    const source = app.source()
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    expect(await task.done).toEqual({ status: 'completed' })
    expect(app.source()).not.toContain('secret')
    expect(JSON.stringify(app.events)).not.toContain('secret')
    expect(app.source()).toContain('密钥已隐藏')
  })

  it('summarizes an oversized old ledger in bounded task-local calls before final generation', async () => {
    const prompts: string[] = []
    const source = '前言\n\n/写个回答\n\n后文\n<!-- rgent:ledger:v1 -->\n## 旧章\n' + '历史。'.repeat(700) + '\n## 最近章\n最近。\n'
    const app = harness(async function* (_signal, prompt) {
      prompts.push(prompt)
      yield prompt.startsWith('请仅摘要') ? '旧章摘要。' : '最终回答。'
    }, source)
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    expect(await task.done).toEqual({ status: 'completed' })
    expect(prompts.filter((prompt) => prompt.startsWith('请仅摘要')).length).toBeGreaterThan(1)
    expect(prompts.at(-1)).toContain('仅供本次任务使用')
    expect(partitionSource(app.source()).ledger).toContain('最终回答。')
    expect(partitionSource(app.source()).ledger).toContain('历史。')
  })

  it('keeps an externally changed AI block instead of silently overwriting it', async () => {
    let edit = () => {}
    const app = harness(async function* () {
      yield '第一段'
      edit()
      yield '第二段'
    })
    edit = () => app.externalEdit((source) => source.replace('第一段', '外部修改'))
    const source = app.source()
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await expect(task.done).rejects.toThrow('AI_BLOCK_CHANGED')
    expect(app.source()).toContain('外部修改')
    expect(app.source()).not.toContain('第二段')
  })
})
