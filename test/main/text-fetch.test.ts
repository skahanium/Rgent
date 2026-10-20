import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEXT_LIMITS, decodeBody, fetchText, htmlToMarkdown, sanitizeText } from '../../src/main/text-fetch.ts'
import type { ImageAddress } from '../../src/main/remote-image-transport.ts'

const PUBLIC: ImageAddress = { address: '93.184.216.34', family: 4 }
const SIGNAL = (): AbortSignal => new AbortController().signal
const bytesOf = (value: string | Uint8Array): Uint8Array => typeof value === 'string' ? new TextEncoder().encode(value) : value
const reply = (value: string | Uint8Array, headers: Record<string, string> = {}): Response =>
  new Response(bytesOf(value) as unknown as BodyInit, { status: 200, headers })
type Deps = {
  signal?: AbortSignal
  resolve?: (hostname: string) => Promise<ImageAddress[]>
  request?: (url: URL, address: ImageAddress, signal: AbortSignal, headers?: Record<string, string>) => Promise<Response>
}
const run = (url: string, response: Response | undefined, extra: Deps = {}) => fetchText(url, {
  signal: extra.signal ?? SIGNAL(),
  resolve: extra.resolve ?? (async () => [PUBLIC]),
  request: extra.request ?? (async () => response!)
})
afterEach(() => vi.useRealTimers())

describe('text fetch', () => {
  it('turns HTML into readable Markdown with a title, absolute links, lists, quotes, code and entities', async () => {
    const html = [
      '<!doctype html><html><head><title>示例 &amp; 页面</title>',
      '<style>body{color:red}</style><script>alert("坏")</script></head><body>',
      '<h1>标题</h1>',
      '<p>正文 <a href="/rel?x=1">链接</a> &amp; 实体&nbsp;空白</p>',
      '<ul><li>第一</li><li>第二</li></ul>',
      '<blockquote>引用一句</blockquote>',
      '<pre><code>const a = 1</code></pre>',
      '<iframe src="https://x.example/"></iframe><svg><text>坏</text></svg><object data="x"></object>',
      '</body></html>'
    ].join('')
    const result = await run('https://example.com/page', reply(html, { 'content-type': 'text/html; charset=utf-8' }))
    expect(result.title).toBe('示例 & 页面')
    expect(result.text).toContain('# 标题')
    expect(result.text).toContain('正文 链接 (https://example.com/rel?x=1) & 实体 空白')
    expect(result.text).toContain('- 第一\n- 第二')
    expect(result.text).toContain('> 引用一句')
    expect(result.text).toContain('```\nconst a = 1\n```')
    expect(result.text).not.toContain('alert')
    expect(result.text).not.toContain('color:red')
    expect(result.text).not.toContain('坏')
    expect(result.finalUrl).toBe('https://example.com/page')
    expect(result.bytes).toBe(Buffer.byteLength(html))
    expect(result.truncated).toBe(false)
    expect(result.contentType).toBe('text/html')
    expect(result.charsetFallback).toBe(false)
  })

  it('keeps plain text as written and accepts JSON', async () => {
    const plain = await run('https://example.com/a.txt', reply('第一行\r\n\r\n  保留空格  \r\n\t制表符', { 'content-type': 'text/plain; charset=utf-8' }))
    expect(plain.text).toBe('第一行\n\n  保留空格  \n\t制表符')
    expect(plain.title).toBeUndefined()
    expect(plain.contentType).toBe('text/plain')
    const json = await run('https://example.com/a.json', reply('{"a":1,"b":[true,null]}', { 'content-type': 'application/json' }))
    expect(json.text).toBe('{"a":1,"b":[true,null]}')
    expect(json.contentType).toBe('application/json')
  })

  it('sniffs an HTML body without content-type only when the bytes start with "<"', async () => {
    const html = await run('https://example.com/a', reply('<p>只有段落</p>'))
    expect(html.contentType).toBe('text/html')
    expect(html.text).toBe('只有段落')
    await expect(run('https://example.com/a', reply('没有尖括号'))).rejects.toThrow('EGRESS_UNSUPPORTED_TYPE')
    await expect(run('https://example.com/a', reply(Uint8Array.from([0xff, 0x00, 0x41])))).rejects.toThrow('EGRESS_UNSUPPORTED_TYPE')
  })

  it('refuses a declared non-text content type', async () => {
    await expect(run('https://example.com/a.png', reply(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), { 'content-type': 'image/png' })))
      .rejects.toThrow('EGRESS_UNSUPPORTED_TYPE')
  })

  it('prefers the declared charset and falls back to UTF-8 when it cannot decode', async () => {
    const valid = await run('https://example.com/a', reply('正常文字', { 'content-type': 'text/plain; charset=utf-8' }))
    expect(valid.text).toBe('正常文字')
    expect(valid.charsetFallback).toBe(false)
    const unknownLabel = await run('https://example.com/a', reply('回退后仍是文字', { 'content-type': 'text/plain; charset=x-not-a-real-charset' }))
    expect(unknownLabel.text).toBe('回退后仍是文字')
    expect(unknownLabel.charsetFallback).toBe(true)
    const invalidBytes = await run('https://example.com/a', reply(Uint8Array.from([0xff, 0x41]), { 'content-type': 'text/plain; charset=utf-8' }))
    expect(invalidBytes.text).toContain('\ufffd')
    expect(invalidBytes.charsetFallback).toBe(true)
    expect(decodeBody(new TextEncoder().encode('x'), 'utf-8')).toEqual({ text: 'x', fallback: false })
  })

  it('removes control characters, caps one line at 2000 characters and marks the cut', async () => {
    const result = await run('https://example.com/a', reply(`第一\u0000行\u0007\n${'长'.repeat(2500)}`, { 'content-type': 'text/plain; charset=utf-8' }))
    expect(result.text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/)
    expect(result.text.split('\n')[0]).toBe('第一行')
    expect(result.text.split('\n')[1]!.length).toBe(TEXT_LIMITS.maxLine)
    expect(result.truncated).toBe(true)
  })

  it('caps the extracted text at 1 MiB without splitting a multibyte character', () => {
    const clean = sanitizeText(`${'a'.repeat(999)}\n`.repeat(2000))
    expect(Buffer.byteLength(clean.text)).toBe(TEXT_LIMITS.maxBytes)
    expect(clean.truncated).toBe(true)
    const chinese = sanitizeText(`${'汉'.repeat(999)}\n`.repeat(2000))
    expect(Buffer.byteLength(chinese.text)).toBeLessThanOrEqual(TEXT_LIMITS.maxBytes)
    expect(chinese.text.endsWith('汉')).toBe(true)
    expect(chinese.truncated).toBe(true)
    expect(htmlToMarkdown('<p>短</p>', 'https://example.com/').text).toBe('短')
  })

  it('refuses non-HTTPS, userinfo, a non-443 port and an over-long URL before any request', async () => {
    const request = vi.fn(async () => reply('x', { 'content-type': 'text/plain' }))
    const resolve = vi.fn(async () => [PUBLIC])
    for (const raw of ['http://example.com/a', 'file:///tmp/a']) {
      await expect(run(raw, undefined, { request, resolve })).rejects.toThrow('EGRESS_HTTP_REFUSED')
    }
    for (const raw of ['https://user:pass@example.com/a', 'https://example.com:8443/a', `https://example.com/${'a'.repeat(TEXT_LIMITS.maxUrl)}`, 'not a url']) {
      await expect(run(raw, undefined, { request, resolve })).rejects.toThrow('EGRESS_INVALID_URL')
    }
    expect(request).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('maps an egress timeout to EGRESS_TIMEOUT', async () => {
    vi.useFakeTimers()
    const resolve = vi.fn(() => new Promise<ImageAddress[]>(() => {}))
    const pending = run('https://example.com/a', undefined, { resolve })
    const assertion = expect(pending).rejects.toThrow('EGRESS_TIMEOUT')
    await vi.advanceTimersByTimeAsync(TEXT_LIMITS.timeoutMs)
    await assertion
  })

  it('refuses a non-identity content-encoding', async () => {
    await expect(run('https://example.com/a', reply(Uint8Array.from([1, 2, 3]), { 'content-type': 'text/plain', 'content-encoding': 'gzip' })))
      .rejects.toThrow('EGRESS_ENCODING_REFUSED')
  })

  it('aborts an in-flight read and reports EGRESS_ABORTED', async () => {
    const controller = new AbortController()
    let started!: () => void
    const reached = new Promise<void>(resolve => { started = resolve })
    const request = (_url: URL, _address: ImageAddress, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      started()
      signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })
    })
    const pending = run('https://example.com/a', undefined, { request, signal: controller.signal })
    const assertion = expect(pending).rejects.toThrow('EGRESS_ABORTED')
    await reached
    controller.abort()
    await assertion
  })
})
