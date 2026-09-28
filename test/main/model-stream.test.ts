import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { streamModelText } from '../../src/main/model-stream.ts'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done())))) })

async function serverFor(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
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
})
