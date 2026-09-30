import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHost } from '../../src/main/agent-host.ts'
import { TaskAuthorizationRegistry } from '../../src/main/task-authorization.ts'
import { createScopedAgentTools } from '../../src/main/scoped-agent-tools.ts'
import { ledgerProvenance } from '../../src/main/ledger-provenance.ts'
import { partitionSource } from '../../src/markdown/partition.ts'
import type { NoteSnapshot, AgentStartRequest } from '../../src/shared/ipc.ts'
import { streamModelText, streamModelStep } from '../../src/main/model-stream.ts'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done())))) })

async function serverFor(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS')
  return `http://127.0.0.1:${address.port}/v1`
}

describe('model stream adapter', () => {
  it('streams text via the installed AI SDK without exposing the key in output', async () => {
    let authorization = ''
    let body = ''
    const baseURL = await serverFor((request, response) => {
      authorization = String(request.headers.authorization)
      request.on('data', (chunk) => { body += String(chunk) })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n')
      response.write('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"世界"},"finish_reason":null}]}\n\n')
      response.write('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
      response.end('data: [DONE]\n\n')
    })
    const chunks: string[] = []
    for await (const chunk of streamModelText({ baseURL, modelId: 'test', apiKey: 'secret', system: 'trusted rule', prompt: 'hi', signal: new AbortController().signal })) chunks.push(chunk)
    expect(chunks.join('')).toBe('你好世界')
    expect(authorization).toBe('Bearer secret')
    expect(JSON.parse(body).messages[0]).toEqual({ role: 'system', content: 'trusted rule' })
  })

  it('does not forward credentials through redirects', async () => {
    let redirected = false
    const target = await serverFor((_request, response) => { redirected = true; response.end('wrong') })
    const baseURL = await serverFor((_request, response) => { response.writeHead(302, { location: `${target}/chat/completions` }); response.end() })
    await expect(async () => {
      for await (const _chunk of streamModelText({ baseURL, modelId: 'test', apiKey: 'secret', prompt: 'hi', signal: new AbortController().signal })) { /* consume */ }
    }).rejects.toThrow()
    expect(redirected).toBe(false)
  })

  it('turns a provider HTTP failure into a failed stream', async () => {
    const baseURL = await serverFor((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'service unavailable' } }))
    })
    await expect(async () => {
      for await (const _chunk of streamModelText({ baseURL, modelId: 'test', apiKey: 'fixture-key', prompt: 'hi', signal: new AbortController().signal })) { /* consume */ }
    }).rejects.toThrow()
  })
})


describe('single model step', () => {
  it('assembles fragmented tool arguments and never executes or starts a second provider request', async () => {
    let requests = 0
    let sent: Record<string, unknown> = {}
    const baseURL = await serverFor((request, response) => {
      requests++
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        sent = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = (value: unknown, reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`)
        delta({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'search_library', arguments: '{"query":' } }] })
        delta({ tool_calls: [{ index: 0, function: { arguments: '"needle"}' } }] })
        delta({}, 'tool_calls')
        response.end('data: [DONE]\n\n')
      })
    })
    const events = []
    for await (const event of streamModelStep({ baseURL, modelId: 'test', apiKey: 'secret', messages: [{ role: 'user', content: 'find' }], tools: { search_library: { description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } }, signal: new AbortController().signal })) events.push(event)
    expect(events).toEqual([{ type: 'tool-call', id: 'call-1', name: 'search_library', input: { query: 'needle' } }, { type: 'finish', reason: 'tool-calls' }])
    expect(requests).toBe(1)
    expect(sent.tools).toHaveLength(1)
  })

  it('rejects unsolicited tool calls in the text-only wrapper', async () => {
    const baseURL = await serverFor((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: 'foreign', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await expect(async () => { for await (const _ of streamModelText({ baseURL, modelId: 'test', apiKey: 'secret', prompt: 'hi', signal: new AbortController().signal })) {} }).rejects.toThrow('MODEL_PROTOCOL_ERROR')
  })
})


it('drops reasoning from public events while charging it to the response byte ceiling', async () => {
  const baseURL = await serverFor((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    emit({ reasoning_content: '不应显示的思考' })
    emit({ content: '公开回答' })
    emit({}, 'stop'); response.end('data: [DONE]\n\n')
  })
  const events = []
  for await (const event of streamModelStep({ baseURL, modelId: 'test', apiKey: 'secret', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal })) events.push(event)
  expect(JSON.stringify(events)).not.toContain('不应显示')
  expect(events).toContainEqual({ type: 'text', text: '公开回答' })

  const largeURL = await serverFor((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { reasoning_content: 'x'.repeat(1048577) }, finish_reason: null }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await expect(async () => { for await (const _ of streamModelStep({ baseURL: largeURL, modelId: 'test', apiKey: 'secret', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal })) {} }).rejects.toThrow('MODEL_OUTPUT_LIMIT')
})

it('exposes an unknown tool attempt for finite Host refusal without SDK auto repair', async () => {
  const baseURL = await serverFor((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'u', type: 'function', function: { name: 'foreign', arguments: '{"path":"outside"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  const events = []
  for await (const event of streamModelStep({ baseURL, modelId: 'test', apiKey: 'secret', tools: { search_library: { description: 'search', inputSchema: { type: 'object' } } }, messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal })) events.push(event)
  expect(events[0]).toMatchObject({ type: 'tool-call', id: 'u', name: 'foreign', invalid: true })
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' })
})


it('runs a real approved three-note SSE search → read → answer loop with source provenance', async () => {
  const requests: Record<string, unknown>[] = []
  const source: Record<string, NoteSnapshot> = {
    'a.md': { content: '/查证 needle\n', revision: '1', sessionId: 'session', objectVersion: 'a' },
    'b.md': { content: '# 参考\n\nneedle：原文证据。', revision: 'b', sessionId: 'session', objectVersion: 'b' },
    'c.md': { content: '无关内容。', revision: 'c', sessionId: 'session', objectVersion: 'c' },
    'outside.md': { content: 'needle：未经本场授权内容。', revision: 'out', sessionId: 'session', objectVersion: 'out' }
  }
  const baseURL = await serverFor((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk }); request.on('end', () => {
      const body = JSON.parse(raw); requests.push(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'loop', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (requests.length === 1) {
        emit({ tool_calls: [{ index: 0, id: 'search', type: 'function', function: { name: 'search_library', arguments: '{"query":"nee' } }] })
        emit({ tool_calls: [{ index: 0, function: { arguments: 'dle"}' } }] }); emit({}, 'tool_calls')
      } else if (requests.length === 2) {
        const result = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'tool').content)
        const hit = result.items.find((item: { relPath: string }) => item.relPath === 'b.md')
        emit({ tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_library', arguments: JSON.stringify({ sourceId: hit.sourceId }) } }] }); emit({}, 'tool_calls')
      } else { emit({ reasoning_content: '隐藏推理' }); emit({ content: '已核对参考原文。' }); emit({}, 'stop') }
      response.end('data: [DONE]\n\n')
    })
  })
  const credential = { provider: 'custom' as const, baseURL, modelId: 'test', contextTokens: 24000, apiKey: 'secret' }
  const limits = { seconds: 30, steps: 8, tools: 8 }
  const read = async (path: string) => ({ ...source[path]! })
  const tier = async () => 'reference' as const
  const registry = new TaskAuthorizationRegistry({ root: () => '/vault', session: () => 'session', tree: async () => Object.keys(source).map(relPath => ({ name: relPath, relPath, kind: 'note' as const })), read, tier, acceptsObject: () => false, configuration: () => ({ credential, limits }) })
  let revision = 1
  const host = new AgentHost({ root: () => '/vault', session: () => 'session', authorize: input => registry.consume('owner', input as AgentStartRequest), read, tier,
    write: async (path, content, expected) => { if (expected !== source[path]!.revision) throw Error('CONFLICT'); source[path] = { ...source[path]!, content, revision: String(++revision) }; return { ...source[path]! } },
    credential: () => credential, limits: () => limits, stream: (input, signal) => streamModelText({ ...input, signal }), streamStep: (input, signal) => streamModelStep({ ...input, signal }), createReadOnlyTools: (grant, id) => createScopedAgentTools(grant, id, { read, tier, acceptsObject: () => false }), emit: () => {}
  })
  const command = { relPath: 'a.md', sessionId: 'session', objectVersion: 'a', expectedRevision: '1', range: { start: 0, end: '/查证 needle'.length }, expectedText: '/查证 needle', promptText: '查证 needle', references: ['b.md', 'c.md'] }
  const preview = await registry.preview('owner', command)
  const task = await host.start({ ...command, previewId: preview.id })
  expect(await task.done).toEqual({ status: 'completed' })
  expect(requests).toHaveLength(3)
  expect(JSON.stringify(requests)).not.toContain('未经本场授权')
  expect(JSON.stringify(requests)).not.toContain('outside.md')
  expect(JSON.stringify(requests[0])).not.toContain('原文证据')
  const part = partitionSource(source['a.md']!.content)
  expect(part.body).toContain('已核对参考原文。')
  expect(part.body).not.toContain('原文证据')
  expect(part.body).not.toContain('隐藏推理')
  const record = ledgerProvenance(part.ledger!)
  expect(record.status).toBe('valid')
  if (record.status === 'valid') {
    expect(record.record.tools.map(tool => tool.name)).toEqual(['search_library', 'read_library'])
    expect(record.record.sources.map(item => item.relPath)).toEqual(['b.md', 'c.md'])
    expect(record.record.sentSources).toEqual(['b.md'])
  }
})
