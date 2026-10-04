import {hostLedgerFixture} from './host-ledger-fixture.ts'
import {ledgerChapters,ledgerTaskFields} from '../../src/main/host-context.ts'
import {SUMMARY_SECTIONS} from '../../src/main/summary-cache.ts'
import { describe, expect, it } from 'vitest'
import {createScopedAgentTools} from '../../src/main/scoped-agent-tools.ts'
import { AgentHost } from '../../src/main/agent-host.ts'
import { assertLedgerPreserved, partitionSource } from '../../src/markdown/partition.ts'
import { appendLedgerChapter, markPrompt, upsertAiAnswer } from '../../src/main/host-source.ts'

/** 稳态正文：已有一章账本，正文尾部留一个新口令段。与真实落盘形状一致。 */
function withExistingLedger(): { source: string; range: { start: number; end: number } } {
  let source = markPrompt('/写个回答\n', { taskId: 't0', range: { start: 0, end: 5 }, expectedText: '/写个回答', promptText: '写个回答' })
  source = upsertAiAnswer(source, { taskId: 't0', answer: '旧回答' })
  source = appendLedgerChapter(source, { taskId: 't0', startedAt: 'prev', status: 'completed', prompt: '写个回答', answer: '旧回答' })
  const part = partitionSource(source)
  const prefix = part.body.endsWith('\n\n') ? part.body : part.body.endsWith('\n') ? `${part.body}\n` : `${part.body}\n\n`
  const body = `${prefix}/写个回答\n`
  const range = { start: prefix.length, end: prefix.length + '/写个回答'.length }
  return { source: body + (part.ledger ?? ''), range }
}

function harness(
  stream: (signal: AbortSignal, prompt: string) => AsyncIterable<string>,
  initial = '前言\n\n/写个回答\n\n后文\n',
  assistant?: () => import('../../src/shared/assistant.ts').AssistantHabits
) {
  let content = partitionSource(initial).body
  let revision = 1
  let policy: 'reference' | 'forbidden' = 'reference'
  let failLedgerOnce = false
  let lifecycleLocked = false
  const events: unknown[] = []
  const systems: string[] = []
  const history=hostLedgerFixture(()=>{if(failLedgerOnce){failLedgerOnce=false;throw Error('IO_ERROR')}})
  for(const c of ledgerChapters(partitionSource(initial).ledger)){const f=ledgerTaskFields(c.text);if(f.status==='valid')history.seed('a.md',{taskId:c.taskId??c.sourceId,startedAt:new Date().toISOString(),status:'completed',prompt:f.prompt.text,answer:f.answer.text})}
  const host = new AgentHost({ledger:history.ledger,
    root: () => '/vault',
    read: async () => ({ content, revision: String(revision) }),
    write: async (_relPath, next, expected) => {
      if (expected !== String(revision)) throw new Error('CONFLICT')
      expect(partitionSource(next).ledger).toBeNull()
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
    stream: (input, signal) => { systems.push(input.system); return stream(signal, input.prompt) },
    ...(assistant ? { assistant } : {}),
    emit: (event) => { events.push(event) }
  })
  return { host, history, source: () => content, events, systems, setPolicy: (value: typeof policy) => { policy = value }, setLifecycleLock: (value: boolean) => { lifecycleLocked = value }, failLedgerOnce: () => { failLedgerOnce = true }, externalEdit: (change: (source: string) => string) => { content = change(content); revision += 1 } }
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
    expect(app.history.history()).toContain('锁前已生成与待保存续段')
    expect(app.history.records()).toHaveLength(1);expect(partitionSource(saved).ledger).toBeNull()
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
    expect(app.history.history()).toContain('第一段。');expect(part.ledger).toBeNull()
    expect(app.history.history()).toContain('写个回答')
  })

  it('completes and appends the ledger when the model answer ends in an open HTML block', async () => {
    const seeded = withExistingLedger()
    const app = harness(async function* () { yield '表格：\n\n<table>\n<tr><td>被截断的行' }, seeded.source)
    const before = partitionSource(seeded.source).ledger
    expect(before).not.toBeNull()
    const task = await app.host.start({ relPath: 'a.md', range: seeded.range, expectedText: '/写个回答', promptText: '写个回答' })
    expect(await task.done).toEqual({ status: 'completed' })
    expect(app.host.hasPending('/vault')).toBe(false)
    const part = partitionSource(app.source())
    // 原账本逐字节保留；题型回答落进正文而未吞掉边界。
    expect(part.ledger).toBeNull();expect(app.history.records()[0]?.answer).toBe('旧回答')
    expect(part.body).toContain('被截断的行')
    expect(app.history.history()).toContain('被截断的行')
    expect(app.history.records()).toHaveLength(2)
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
    const history=hostLedgerFixture(),reasoning:string[]=[]
    const host = new AgentHost({ledger:history.ledger,onReasoning:(_task,text)=>reasoning.push(text),
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
    expect(app.history.records()).toHaveLength(1)
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
    expect(app.history.history()).toContain('密钥已隐藏')
  })

  it('summarizes an oversized old ledger in bounded task-local calls before final generation', async () => {
    const prompts: string[] = []
    const source = '前言\n\n/写个回答\n\n后文\n'
    const app = harness(async function* (_signal, prompt) {
      prompts.push(prompt)
      yield prompt.startsWith('仅整理') ? SUMMARY_SECTIONS.map(h=>h+'\n旧章摘要。').join('\n\n') : '最终回答。'
    }, source)
    app.history.seed('a.md',{taskId:'old',startedAt:new Date().toISOString(),status:'completed',prompt:'旧任务',answer:'历史。'.repeat(300)})
    app.history.seed('a.md',{taskId:'recent',startedAt:new Date().toISOString(),status:'completed',prompt:'最近',answer:'最近。'})
    const start = source.indexOf('/')
    const task = await app.host.start({ relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    expect(await task.done).toEqual({ status: 'completed' })
    expect(prompts.filter((prompt) => prompt.startsWith('仅整理')).length).toBeGreaterThan(0)
    expect(prompts.at(-1)).toContain('须查原文')
    expect(app.history.history()).toContain('最终回答。')
    expect(app.history.history()).toContain('历史。')
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

  it('keeps model reasoning and process in the ledger, never in the body', async () => {
    const seeded = withExistingLedger()
    let content = partitionSource(seeded.source).body
    let revision = 1
    const history=hostLedgerFixture(),reasoning:string[]=[]
    const host = new AgentHost({ledger:history.ledger,onReasoning:(_task,text)=>reasoning.push(text),
      root: () => '/vault',
      read: async () => ({ content, revision: String(revision) }),
      write: async (_path, next, expected) => {
        if (expected !== String(revision)) throw new Error('CONFLICT')
        assertLedgerPreserved(next, partitionSource(content).ledger)
        content = next
        revision += 1
        return String(revision)
      },
      tier: async () => 'reference',
      credential: () => ({ provider: 'custom', baseURL: 'http://127.0.0.1:1234/v1', modelId: 'test', contextTokens: 10000, apiKey: 'secret' }),
      limits: () => ({ seconds: 30, steps: 4, tools: 0 }),
      stream: async function* () { throw new Error('LEGACY_FALLBACK') },
      streamStep: async function* () {
        yield { type: 'reasoning', text: '先想清楚依据：参考甲与参考乙。' }
        yield { type: 'text', text: '公开回答。' }
        yield { type: 'finish', reason: 'stop' }
      },
      emit: () => {}
    })
    const task = await host.start({ relPath: 'a.md', range: seeded.range, expectedText: '/写个回答', promptText: '写个回答' })
    expect(await task.done).toEqual({ status: 'completed' })
    const part = partitionSource(content)
    expect(part.body).toContain('公开回答。')
    expect(part.body).not.toContain('先想清楚依据')
    expect(part.ledger).toBeNull()
    expect(reasoning.join('')).toContain('先想清楚依据：参考甲与参考乙。')
    expect(history.history()).not.toContain('先想清楚依据')
    expect(history.records().at(-1)?.trace?.join('\n')).toContain('第 1 步：文本')
    expect(history.records().at(-1)?.status).toBe('completed')
  })

  it('retries every pending note even when one of them keeps failing', async () => {
    const seed = '前言\n\n/写个回答\n\n后文\n'
    const notes = new Map<string, { content: string; revision: number }>([
      ['a.md', { content: seed, revision: 1 }],
      ['b.md', { content: seed, revision: 1 }]
    ])
    const forbidden = new Set<string>()
    let failNextLedger = false
    const history=hostLedgerFixture(()=>{if(failNextLedger){failNextLedger=false;throw Error('IO_ERROR')}})
    const host = new AgentHost({ledger:history.ledger,
      root: () => '/vault',
      read: async (relPath) => ({ content: notes.get(relPath)!.content, revision: String(notes.get(relPath)!.revision) }),
      write: async (relPath, next, expected) => {
        const note = notes.get(relPath)!
        if (expected !== String(note.revision)) throw new Error('CONFLICT')
        expect(partitionSource(next).ledger).toBeNull()
        note.content = next
        note.revision += 1
        return String(note.revision)
      },
      tier: async (_root, relPath) => {
        if (forbidden.has(relPath)) throw new Error('FORBIDDEN')
        return 'reference'
      },
      credential: () => ({ provider: 'custom', baseURL: 'http://127.0.0.1:1234/v1', modelId: 'test', contextTokens: 10000, apiKey: 'secret' }),
      limits: () => ({ seconds: 30, steps: 4, tools: 0 }),
      stream: () => (async function* () { yield '最终答案' })(),
      emit: () => {}
    })
    const startFor = async (relPath: string) => {
      const content = notes.get(relPath)!.content
      const at = content.indexOf('/写个回答')
      return host.start({ relPath, range: { start: at, end: at + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' })
    }
    failNextLedger = true
    await expect((await startFor('a.md')).done).rejects.toThrow('IO_ERROR')
    failNextLedger = true
    await expect((await startFor('b.md')).done).rejects.toThrow('IO_ERROR')
    expect(host.pendingPaths('/vault').sort()).toEqual(['a.md', 'b.md'])

    // a.md 变成不可写：它失败，但不能挡住 b.md 的补存。
    forbidden.add('a.md')
    await expect(host.retryPending('/vault')).rejects.toThrow('FORBIDDEN')
    expect(host.pendingPaths('/vault')).toEqual(['a.md'])
    expect(notes.get('b.md')!.content).toContain('最终答案')
    expect(await history.ledger.contexts('b.md')).toHaveLength(1)
    expect(partitionSource(notes.get('a.md')!.content).ledger).toBeNull()

    // 按篇过滤只补指定篇；恢复权限后逐篇补完。
    forbidden.delete('a.md')
    await host.retryPending('/vault', 'a.md')
    expect(host.hasPending('/vault')).toBe(false)
    expect((await history.ledger.contexts('a.md'))[0]?.fields).toMatchObject({answer:{text:'最终答案'}})
  })
})

describe('assistant habits in a run', () => {
  it('appends the habit block to the system prompt and records one summary line', async () => {
    const app = harness(async function* () { yield '回答' }, undefined, () => ({ address: '老陈', tone: 'concise', note: '先给结论' }))
    const task = await app.host.start({ relPath: 'a.md', range: { start: 4, end: 9 }, expectedText: '/写个回答', promptText: '写个回答' })
    const full = await task.done
    expect(full.status).toBe('completed')
    expect(app.systems).toHaveLength(1)
    expect(app.systems[0]).toContain('不改变本场范围、工具与权限')
    expect(app.systems[0]).toContain('称呼用户为「老陈」')
    expect(app.history.history()).toContain('称呼=老陈；语气=简洁；补充说明 4 字')
  })

  it('changes nothing for tasks when the habits are untouched', async () => {
    const app = harness(async function* () { yield '回答' }, undefined, () => ({ address: '', tone: 'plain', note: '' }))
    const task = await app.host.start({ relPath: 'a.md', range: { start: 4, end: 9 }, expectedText: '/写个回答', promptText: '写个回答' })
    await task.done
    expect(app.systems[0]).not.toContain('助手习惯')
    expect(app.source()).not.toContain('助手习惯：已应用')
  })
})

import { TaskAuthorizationRegistry } from '../../src/main/task-authorization.ts'
import { createHash } from 'node:crypto'
it.each(['valid','revision','object','session'] as const)('continues only a verified migration receipt: %s',async changed=>{
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
 let content='/问\n<!-- rgent:ledger:v1 -->\n旧历史',objectVersion='old',revision=hash(content)
 const credential={provider:'custom' as const,baseURL:'https://model.example/v1',modelId:'m',contextTokens:16000,apiKey:'fixture'},limits={seconds:30,steps:4,tools:0}
 const read=async()=>({content,revision,sessionId:'s',objectVersion})
 const registry=new TaskAuthorizationRegistry({root:()=>'/v',session:()=>'s',tree:async()=>[{kind:'note',relPath:'a.md',name:'a.md'}],read,tier:async()=> 'reference',acceptsObject:(_path,previous,next)=>previous==='old'&&next==='new',configuration:()=>({credential,limits})})
 const request={modelRecordId:'m',relPath:'a.md',sessionId:'s',objectVersion,expectedRevision:revision,range:{start:0,end:2},expectedText:'/问',promptText:'问',references:[]}
 const preview=await registry.preview('owner',request);let writes=0,streams=0
 const host=new AgentHost({root:()=>'/v',session:()=>'s',acceptsObject:(_path,previous,next)=>previous==='old'&&next==='new',tier:async()=> 'reference',authorize:input=>registry.consume('owner',input as never),prepareSource:async()=>{
  const previousRevision=revision;content='/问\n';revision=hash(content);objectVersion='new'
  return {previousRevision,revision:changed==='revision'?'wrong':revision,sessionId:changed==='session'?'other':'s',previousObjectVersion:'old',objectVersion:changed==='object'?'other':'new',migrated:true}
 },read,write:async(_path,next)=>{writes++;content=next;revision=hash(next);return {revision,sessionId:'s',objectVersion}},credential:()=>credential,limits:()=>limits,stream:async function*(){streams++;yield '回答'},emit:()=>{},ledger:hostLedgerFixture().ledger})
 if(changed==='valid'){const started=await host.start({...request,previewId:preview.id});await started.done;expect(writes).toBeGreaterThan(0);expect(streams).toBe(1)}
 else{await expect(host.start({...request,previewId:preview.id})).rejects.toThrow();expect(writes).toBe(0);expect(streams).toBe(0)}
})

it('waits for launching to settle, rejects the now-active task, and never queues a new launch during recovery', async () => {
  const app = harness(async function* (signal) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) })
  const source = app.source(), start = source.indexOf('/'), input = { relPath: 'a.md', range: { start, end: start + '/写个回答'.length }, expectedText: '/写个回答', promptText: '写个回答' }
  const launching = app.host.start(input)
  let ran = false
  const recovery = app.host.withLedgerRecovery('resume', async () => { ran = true })
  await expect(app.host.start({ ...input, relPath: 'other.md' })).rejects.toThrow('STRUCTURE_BUSY')
  const task = await launching
  await expect(recovery).rejects.toThrow('STRUCTURE_BUSY')
  expect(ran).toBe(false)
  app.host.cancel(task.id)
  await task.done
  await app.host.withLedgerRecovery('resume', async () => { ran = true })
  expect(ran).toBe(true)
})

function memoryToolHarness(options:{calls?:{id:string;name:string;input:unknown}[];verified?:boolean;empty?:boolean;tools?:number;steps?:number;library?:boolean;proof?:()=>void|Promise<void>;change?:()=>void}={}){
 let content='单篇普通正文\n\n/问\n',revision=1,dispatches=0,proofReads=0,enabled=true,entriesVersion=1,paused=false
 const history=hostLedgerFixture(),requests:Parameters<NonNullable<import('../../src/main/agent-host.ts').HostDependencies['streamStep']>>[0][]=[]
 const credential={provider:'custom' as const,baseURL:'https://model.example/v1',modelId:'m',contextTokens:32000,apiKey:'fixture'}
 const source={id:'s',version:1,relPath:'outside.md',objectVersion:'outside',revision:'a'.repeat(64),permissionTier:'reference' as const,kind:'body' as const,taskId:null,taskMaterialHash:null,classification:'human' as const,start:0,end:2,text:'依据',hash:'b'.repeat(64),basisHash:'c'.repeat(64),sourceDeps:[],memoryDeps:[]}
 const memory={context:()=>({sessionId:'s',vaultKey:'v'}),config:()=>({enabled,revision:enabled?0:1}),entries:async(ids?:readonly string[])=>{const result=options.empty?[]:[{id:'m',version:entriesVersion,content:'火星计划约定',layer:'demand' as const,scope:'仅项目甲',attribution:'人的约定',status:paused?'paused' as const:'active' as const,reason:null,updatedAt:'2026-10-05',updateBasis:{kind:'manual' as const,id:'manual',version:1},sources:[source]}];if(ids){proofReads++;if(proofReads===1)await options.proof?.()}return result}}
 const grant={id:'g',root:'/v',sessionId:'s',origin:'a.md',sources:[{sourceId:'origin',relPath:'a.md',title:'a',sessionId:'s',objectVersion:'o',revision:'1',fingerprint:'f',tier:'reference' as const},...(options.library?[{sourceId:'external',relPath:'b.md',title:'b',sessionId:'s',objectVersion:'b',revision:'b',fingerprint:'b',tier:'reference' as const}]:[])],credential,limits:{seconds:30,steps:options.steps??12,tools:options.tools??20},assertActive(){},async assertLive(){},async validateSources(){},assertWriteTarget(){},acknowledgeOrigin(){},revoke(){}}
 const read=async(path:string)=>path==='b.md'?{content:'外篇普通正文',revision:'b',sessionId:'s',objectVersion:'b'}:{content,revision:String(revision),sessionId:'s',objectVersion:'o'}
 const host=new AgentHost({ledger:history.ledger,...(options.library?{createReadOnlyTools:(grant:import('../../src/main/task-authorization.ts').TaskGrant,id:string)=>createScopedAgentTools(grant,id,{read,tier:async()=> 'reference',acceptsObject:()=>false})}:{}),root:()=>'/v',session:()=> 's',read,write:async(_path,next,expected)=>{if(expected!==String(revision))throw Error('CONFLICT');content=next;return String(++revision)},tier:async()=> 'reference',credential:()=>credential,limits:()=>grant.limits,authorize:async()=>grant,memory,stream:async function*(){throw Error('OLD_STREAM')},streamStep:async function*(input){requests.push(structuredClone(input));dispatches++;if(dispatches===1){for(const c of options.calls??[{id:'one',name:'search_memory',input:{query:'火星'}}])yield {type:'tool-call',...c};yield {type:'finish',reason:'tool-calls'}}else {options.change?.();yield {type:'text',text:'已答'};yield {type:'finish',reason:'stop'}}},emit:()=>{}})
 if(options.verified!==false)host.supportsMemorySearch=()=>true
 const run=()=>host.start({relPath:'a.md',sessionId:'s',objectVersion:'o',expectedRevision:'1',range:{start:content.indexOf('/问'),end:content.indexOf('/问')+2},expectedText:'/问',promptText:'问',memorySearchAuthorized:true})
 return {host,history,requests,run,proofReads:()=>proofReads,content:()=>content,off:()=>{enabled=false},forget:()=>{entriesVersion++},pause:()=>{paused=true}}
}
it('registers only search_memory for a verified note-only task and records real sent dependencies',async()=>{
 const app=memoryToolHarness();const task=await app.run();expect(await task.done).toEqual({status:'completed'})
 expect(Object.keys(app.requests[0].tools!)).toEqual(['search_memory']);expect(JSON.stringify(app.requests[1].messages)).toContain('仅项目甲');expect(JSON.stringify(app.requests[1].messages)).toContain('sourceChecked')
 const provenance=app.history.records().at(-1)?.provenance;expect(provenance?.version).toBe(2);if(provenance?.version===2)expect(provenance.memoryDeps.map(d=>[d.id,d.version])).toEqual([['m',1]])
 expect(app.history.records().at(-1)?.trace?.join('\n')).toContain('检索记忆')
})
it('refuses invalid parameters and duplicate IDs before spending the four memory executions',async()=>{
 const calls=[{id:'bad',name:'search_memory',input:{query:''}},{id:'one',name:'search_memory',input:{query:'火星'}},{id:'one',name:'search_memory',input:{query:'火星'}},...['two','three','four','five'].map(id=>({id,name:'search_memory',input:{query:'火星'}}))]
 const app=memoryToolHarness({calls});const task=await app.run();expect(await task.done).toEqual({status:'completed'})
 const output=JSON.stringify(app.requests[1].messages);expect(output).toContain('DUPLICATE_TOOL_CALL');expect(output).toContain('INVALID_TOOL_ARGUMENTS');expect(output).toContain('MEMORY_SEARCH_LIMIT')
 expect(app.history.records().at(-1)?.provenance?.tools?.find(t=>t.name==='search_memory')?.outcome).toContain('执行 4 次')
})
it('stops a note-only memory task at the global attempt limit while preserving its ledger',async()=>{
 const app=memoryToolHarness({tools:1,calls:['one','two'].map(id=>({id,name:'search_memory',input:{query:'火星'}}))});const task=await app.run()
 expect(await task.done).toEqual({status:'failed',reason:'TOOL_CALL_LIMIT'});expect(app.requests).toHaveLength(1);expect(app.history.records().at(-1)?.status).toBe('failed')
})
it.each(['unverified','empty'] as const)('keeps %s note-only tasks in local recall without registering library tools',async mode=>{
 const app=memoryToolHarness({verified:mode!=='unverified',empty:mode==='empty'});const task=await app.run();expect((await task.done).status).toBe('failed');expect(app.requests[0].tools).toBeUndefined()
})
it.each(['off','forget','pause'] as const)('stops the actual continuation before its text when memory changes: %s',async change=>{
 let mutate=()=>{};const app=memoryToolHarness({change:()=>mutate()});mutate=()=>app[change]();const task=await app.run()
 expect((await task.done).status).toBe('failed');expect(app.content()).not.toContain('已答')
})

it('persists bounded memory result identities and excerpts in the ledger tool summary',async()=>{
 const app=memoryToolHarness();const task=await app.run();await task.done
 const tools=app.history.records().at(-1)?.provenance?.tools??[]
 expect(tools.some(t=>t.name==='search_memory'&&t.outcome.includes('m@1')&&t.outcome.includes('火星计划约定'))).toBe(true)
 expect(tools.every(t=>t.outcome.length<=1024)).toBe(true)
})

it.each(['off','forget','pause'] as const)('blocks the real next dispatch when a memory proof changes before continuation: %s',async change=>{
 let mutate=()=>{};const app=memoryToolHarness({proof:()=>mutate()});mutate=()=>app[change]();const task=await app.run()
 expect((await task.done).status).toBe('failed');expect(app.requests).toHaveLength(1);expect(app.content()).not.toContain('已答')
})
it('ignores a late memory result after cancellation without sending a continuation',async()=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
 const app=memoryToolHarness({proof:async()=>{entered();await gate}}),task=await app.run();await started
 await app.host.cancel(task.id,'user');expect((await task.done).status).toBe('cancelled');release();await new Promise(r=>setTimeout(r,0))
 expect(app.requests).toHaveLength(1);expect(app.content()).not.toContain('已答')
})
it('persists an executed memory search failure and stops later dispatches',async()=>{
 const app=memoryToolHarness({proof:()=>{throw Error('MEMORY_SOURCE_CHANGED')}}),task=await app.run()
 expect((await task.done).status).toBe('failed');expect(app.requests).toHaveLength(1)
 const tools=app.history.records().at(-1)?.provenance?.tools??[];expect(tools.some(t=>t.outcome.includes('失败 1 次'))).toBe(true);expect(tools.some(t=>t.outcome.includes('后续发送停止'))).toBe(true)
})
it('enforces the global model step limit after memory retrieval',async()=>{
 const app=memoryToolHarness({steps:1}),task=await app.run();expect(await task.done).toEqual({status:'failed',reason:'MODEL_STEP_LIMIT'});expect(app.requests).toHaveLength(1)
})

it('memory-only actual outgoing contains the ordinary note context without a library read requirement',async()=>{
 const app=memoryToolHarness(),task=await app.run();await task.done
 const outgoing=JSON.stringify(app.requests[0].messages);expect(Object.keys(app.requests[0].tools!)).toEqual(['search_memory'])
 expect(outgoing).not.toContain('本场工具来源清单');expect(outgoing).not.toContain('正文须经工具读取');expect(outgoing).toContain('单篇普通正文')
})

it('library plus memory outgoing retains only the authorized library metadata and schemas',async()=>{
 const app=memoryToolHarness({library:true}),task=await app.run();expect(await task.done).toEqual({status:'completed'})
 const outgoing=JSON.stringify(app.requests[0].messages);expect(Object.keys(app.requests[0].tools!).sort()).toEqual(['read_library','search_library','search_memory'])
 expect(outgoing).toContain('本场工具来源清单');expect(outgoing).toContain('正文须经工具读取');expect(outgoing).toContain('b.md');expect(outgoing).not.toContain('outside.md')
})
