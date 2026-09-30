import { describe, expect, it } from 'vitest'
import { AgentHost } from '../../src/main/agent-host.ts'
import { partitionSource } from '../../src/markdown/partition.ts'

function harness(stream: (signal: AbortSignal, prompt: string) => AsyncIterable<string>, initial = '前言\n\n/写个回答\n\n后文\n') {
  let content = initial
  let revision = 1
  let policy: 'reference' | 'forbidden' = 'reference'
  let failLedgerOnce = false
  let lifecycleLocked = false
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
      if (lifecycleLocked) throw new Error('LIFECYCLE_RECOVERY_REQUIRED')
      if (policy === 'forbidden') throw new Error('FORBIDDEN')
      return 'reference'
    },
    credential: () => ({ provider: 'custom', baseURL: 'http://127.0.0.1:1234/v1', modelId: 'test', contextTokens: 10000, apiKey: 'secret' }),
    limits: () => ({ seconds: 30, steps: 4, tools: 0 }),
    stream: (input, signal) => stream(signal, input.prompt),
    emit: (event) => { events.push(event) }
  })
  return { host, source: () => content, events, setPolicy: (value: typeof policy) => { policy = value }, setLifecycleLock: (value: boolean) => { lifecycleLocked = value }, failLedgerOnce: () => { failLedgerOnce = true }, externalEdit: (change: (source: string) => string) => { content = change(content); revision += 1 } }
}

describe('Host minimal loop', () => {
  it('keeps generated output pending behind a lifecycle lock and saves one ledger after recovery', async () => {
    let lock = () => {}
    const app = harness(async function* () {
      yield '锁前已生成'
      yield '与待保存续段'
      lock()
      yield '锁后不得读取'
    })
    lock = () => app.setLifecycleLock(true)
    const source = app.source()
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await expect(task.done).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
    expect(app.host.pendingPaths('/vault')).toEqual(['a.md'])
    expect(app.host.pendingPaths('/other-vault')).toEqual([])
    expect(partitionSource(app.source()).body).toContain('锁前已生成')
    expect(partitionSource(app.source()).body).not.toContain('与待保存续段')
    expect(JSON.stringify(app.events)).toContain('与待保存续段')
    expect(partitionSource(app.source()).ledger).toBeNull()
    expect(JSON.stringify(app.events)).not.toContain('锁后不得读取')
    const beforeRetry = app.source()
    await app.host.retryPending('/other-vault')
    expect(app.source()).toBe(beforeRetry)
    expect(app.host.pendingPaths('/vault')).toEqual(['a.md'])
    await expect(app.host.retryPending('/vault')).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
    expect(app.host.pendingPaths('/vault')).toEqual(['a.md'])
    app.setLifecycleLock(false)
    await app.host.retryPending('/vault')
    expect(app.host.pendingPaths('/vault')).toEqual([])
    expect(app.host.hasPending('/vault')).toBe(false)
    const saved = app.source()
    expect(partitionSource(saved).body).toContain('锁前已生成与待保存续段')
    expect(partitionSource(saved).ledger).toContain('锁前已生成与待保存续段')
    expect(saved.match(/<!-- rgent:ledger-task:v1/g)).toHaveLength(1)
    await app.host.retryPending('/vault')
    expect(app.source()).toBe(saved)
  })
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

  it('retains an unwritten final chapter for retry and appends it only once', async () => {
    const app = harness(async function* () { yield '回答' })
    app.failLedgerOnce()
    const source = app.source()
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    await expect(task.done).rejects.toThrow('IO_ERROR')
    expect(app.host.hasPending()).toBe(true)
    await app.host.retryPending()
    expect(app.host.hasPending()).toBe(false)
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
