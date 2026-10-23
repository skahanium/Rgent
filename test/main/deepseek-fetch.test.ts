import { describe, expect, it, vi } from 'vitest'
import { DEEPSEEK_FETCH, fetchViaDeepSeek, resolveFetchRoute } from '../../src/main/deepseek-fetch.ts'
import type { ImageAddress } from '../../src/main/remote-image-transport.ts'

const PUBLIC: ImageAddress = { address: '93.184.216.34', family: 4 }
const KEY = 'DEEPSEEK-KEY-do-not-leak-1234567890'
const TARGET = 'https://example.com/page?q=1'
const signal = (): AbortSignal => new AbortController().signal

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
/** 假出口：不碰真 DNS／socket；`request` 收到的参数就是发给服务端的东西。 */
const fake = (response: () => Response | Promise<Response>) => ({
  request: vi.fn(async (_url: URL, _address: ImageAddress, _signal: AbortSignal, _headers?: Record<string, string>, _init?: unknown) => response()),
  resolve: vi.fn(async () => [PUBLIC])
})
const run = (url: string, deps: ReturnType<typeof fake>, extra: { key?: string; signal?: AbortSignal } = {}) =>
  fetchViaDeepSeek(url, extra.key ?? KEY, {
    signal: extra.signal ?? signal(),
    resolve: deps.resolve,
    request: deps.request
  })

describe('fetchViaDeepSeek 请求形状', () => {
  it('POST 到预设端点，Bearer 只进 Authorization 头，body 只有目标 URL', async () => {
    const content = '# 示例标题\n\n正文一段。'
    const deps = fake(() => json({ title: '示例页面', content }))
    const result = await run(TARGET, deps)
    expect(deps.resolve).toHaveBeenCalledWith(DEEPSEEK_FETCH.host)
    expect(deps.request).toHaveBeenCalledTimes(1)
    const [url, address, , headers, init] = deps.request.mock.calls[0]!
    expect(url.href).toBe('https://api.deepseek.com/v1/tools/fetch')
    expect(address).toEqual(PUBLIC)
    // 只发必要头：JSON 期望＋identity 编码＋凭据；不带 cookies／referrer。
    expect(headers).toEqual({ accept: 'application/json', 'accept-encoding': 'identity', authorization: `Bearer ${KEY}` })
    expect(init).toEqual({ method: 'POST', body: JSON.stringify({ url: TARGET }) })
    expect(url.href).not.toContain(KEY)
    expect(JSON.stringify(init)).not.toContain(KEY)
    expect(result).toEqual({
      text: content,
      title: '示例页面',
      finalUrl: TARGET,
      bytes: Buffer.byteLength(content, 'utf8'),
      truncated: false
    })
  })

  it('没给标题就不造一个，标题两侧空白去掉', async () => {
    const bare = fake(() => json({ content: '正文' }))
    expect(await run(TARGET, bare)).not.toHaveProperty('title')
    const padded = fake(() => json({ title: '  标题  ', content: '正文' }))
    expect((await run(TARGET, padded)).title).toBe('标题')
    const blank = fake(() => json({ title: '   ', content: '正文' }))
    expect(await run(TARGET, blank)).not.toHaveProperty('title')
  })
})

describe('fetchViaDeepSeek URL 校验', () => {
  it.each([
    ['明文 HTTP', 'http://example.com/page'],
    ['非 http(s) 协议', 'ftp://example.com/page'],
    ['带用户名密码', 'https://user:pass@example.com/page'],
    ['非 443 端口', 'https://example.com:8443/page'],
    ['超长 URL', `https://example.com/${'a'.repeat(2100)}`],
    ['回环地址', 'https://127.0.0.1/page'],
    ['IPv6 回环', 'https://[::1]/page'],
    ['localhost', 'https://localhost/page'],
    ['本地名', 'https://printer.local/page'],
    ['空串', '']
  ])('%s 一次外发都不发生', async (_label, url) => {
    const deps = fake(() => json({ content: '正文' }))
    await expect(run(url, deps)).rejects.toThrow(/^EGRESS_(INVALID_URL|HTTP_REFUSED)$/)
    expect(deps.request).not.toHaveBeenCalled()
    expect(deps.resolve).not.toHaveBeenCalled()
  })

  it('非字符串 URL 也按不合法拒绝', async () => {
    const deps = fake(() => json({ content: '正文' }))
    await expect(run(undefined as unknown as string, deps)).rejects.toThrow('EGRESS_INVALID_URL')
    expect(deps.request).not.toHaveBeenCalled()
  })

  it('服务端点自身仍过出口地址校验：解析出私网就拒，不发 socket', async () => {
    const deps = fake(() => json({ content: '正文' }))
    deps.resolve.mockResolvedValueOnce([{ address: '10.0.0.8', family: 4 }])
    await expect(run(TARGET, deps)).rejects.toThrow('EGRESS_INVALID_URL')
    expect(deps.request).not.toHaveBeenCalled()
  })
})

describe('fetchViaDeepSeek 响应解析', () => {
  it.each([
    ['不是 JSON', () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['顶层不是对象', () => json([{ content: '正文' }])],
    ['缺少 content', () => json({ title: '标题' })],
    ['content 不是字符串', () => json({ content: 42 })],
    ['title 不是字符串', () => json({ title: 7, content: '正文' })],
    ['content 为空串', () => json({ content: '' })],
    ['content 只有空白', () => json({ content: '  \n\t ' })],
    ['非法 UTF-8', () => new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 200, headers: { 'content-type': 'application/json' } })]
  ])('%s → EGRESS_UNAVAILABLE', async (_label, response) => {
    const deps = fake(response)
    await expect(run(TARGET, deps)).rejects.toThrow('EGRESS_UNAVAILABLE')
    expect(deps.request).toHaveBeenCalledTimes(1)
  })

  it('结构异常时响应原文（含疑似凭据）不进错误消息', async () => {
    const deps = fake(() => new Response(JSON.stringify({ echo: KEY }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const failure = (await run(TARGET, deps).catch((error: unknown) => error)) as Error
    expect(failure.message).toBe('EGRESS_UNAVAILABLE')
    expect(failure.message).not.toContain(KEY)
  })
})

describe('fetchViaDeepSeek 截断与卫生', () => {
  it('单行超 2000 字按既有卫生规则截断并如实标 truncated', async () => {
    const line = 'a'.repeat(3000)
    const deps = fake(() => json({ content: line }))
    const result = await run(TARGET, deps)
    expect(result.text).toBe('a'.repeat(2000))
    // bytes 记录服务返回正文的原始字节量，不因本地截断而变小。
    expect(result.bytes).toBe(3000)
    expect(result.truncated).toBe(true)
  })

  it('控制字符被去掉，正常换行与制表符保留，且不算截断', async () => {
    const deps = fake(() => json({ content: 'A\u0000B\r\nC\tD\u007f' }))
    const result = await run(TARGET, deps)
    expect(result.text).toBe('AB\nC\tD')
    expect(result.truncated).toBe(false)
  })

  it('响应体超过 1 MiB 即 EGRESS_TOO_LARGE，不读成半个 JSON', async () => {
    const huge = JSON.stringify({ content: 'a'.repeat(1_048_576) })
    const deps = fake(() => new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(run(TARGET, deps)).rejects.toThrow('EGRESS_TOO_LARGE')
  })
})

describe('fetchViaDeepSeek 非 2xx 映射', () => {
  it.each([
    [401, 'EGRESS_HTTP_REFUSED'],
    [403, 'EGRESS_HTTP_REFUSED'],
    [404, 'EGRESS_UNAVAILABLE'],
    [408, 'EGRESS_TIMEOUT'],
    [504, 'EGRESS_TIMEOUT'],
    [429, 'EGRESS_BUSY'],
    [500, 'EGRESS_UNAVAILABLE'],
    [503, 'EGRESS_UNAVAILABLE'],
    [400, 'EGRESS_UNAVAILABLE'],
    [402, 'EGRESS_UNAVAILABLE'],
    [302, 'EGRESS_UNAVAILABLE']
  ])('HTTP %i → %s，不跟随重定向也不带响应原文', async (status, code) => {
    const deps = fake(() => status === 302
      ? new Response(null, { status, headers: { location: 'https://other.example/fetch' } })
      : json({ error: 'upstream said something', key: KEY }, status))
    const failure = (await run(TARGET, deps).catch((error: unknown) => error)) as Error
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toBe(code)
    expect(failure.message).not.toContain(KEY)
    expect(failure.message).not.toContain('upstream')
    expect(deps.request).toHaveBeenCalledTimes(1)
    expect(deps.request.mock.calls[0]![0].href).toBe('https://api.deepseek.com/v1/tools/fetch')
  })
})

describe('fetchViaDeepSeek 取消', () => {
  it('调用前已取消：EGRESS_ABORTED 且不外发', async () => {
    const controller = new AbortController()
    controller.abort()
    const deps = fake(() => json({ content: '正文' }))
    await expect(fetchViaDeepSeek(TARGET, KEY, { signal: controller.signal, resolve: deps.resolve, request: deps.request }))
      .rejects.toThrow('EGRESS_ABORTED')
    expect(deps.request).not.toHaveBeenCalled()
  })

  it('在途取消：EGRESS_ABORTED，不把取消说成普通不可用', async () => {
    const controller = new AbortController()
    const deps = fake(() => new Promise<Response>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })
    }))
    const pending = fetchViaDeepSeek(TARGET, KEY, { signal: controller.signal, resolve: deps.resolve, request: deps.request })
    // 等请求真的发出去再取消：否则测到的是「调用前已取消」那条分支。
    await vi.waitFor(() => expect(deps.request).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(pending).rejects.toThrow('EGRESS_ABORTED')
    expect(deps.request).toHaveBeenCalledTimes(1)
  })
})

describe('resolveFetchRoute 任务内抓页路由', () => {
  it('选了直连就直连：即使设备上存着 DeepSeek 凭据也不用', () => {
    expect(resolveFetchRoute('direct', null)).toEqual({ service: 'direct' })
    expect(resolveFetchRoute('direct', { provider: 'deepseek', key: KEY })).toEqual({ service: 'direct' })
  })

  it('选了 DeepSeek 且有 DeepSeek 凭据才走服务', () => {
    expect(resolveFetchRoute('deepseek', { provider: 'deepseek', key: KEY })).toEqual({ service: 'deepseek', key: KEY })
  })

  it.each([
    ['没有凭据', null],
    ['凭据属于别家', { provider: 'brave' as const, key: KEY }],
    ['凭据是空串', { provider: 'deepseek' as const, key: '' }]
  ])('%s 时不静默降级直连，抛 SEARCH_NOT_CONFIGURED', (_label, credential) => {
    expect(() => resolveFetchRoute('deepseek', credential)).toThrow('SEARCH_NOT_CONFIGURED')
  })
})
