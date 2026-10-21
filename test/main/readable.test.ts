import { describe, expect, it } from 'vitest'
import { READABLE_MIN_CHARS, extractReadable } from '../../src/main/readable.ts'

/** 合成 fixture：不存第三方页面，全部本地拼。 */
const sentence = '这是一段用于测试正文提取的完整句子，信息密度足够，应该被 Readability 保留下来。'

/** 一段约 210 字（去空白）的正文，单独就超过 200 字阈值。 */
const paragraph = (prefix = ''): string => `<p>${prefix}${sentence.repeat(5)}</p>`

const page = (body: string, head = '<title>示例标题</title>'): string =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`

describe('extract readable', () => {
  it('keeps article paragraphs and drops navigation/footer chrome', async () => {
    const body = [
      '<nav><a href="/">首页</a><a href="/about">关于我们</a><a href="/contact">联系我们</a></nav>',
      '<header><a href="/login">登录</a><a href="/subscribe">订阅</a></header>',
      '<article><h1>真正的文章标题</h1>',
      paragraph('第一段：'),
      paragraph('第二段：'),
      '</article>',
      '<footer><p>版权所有 · 隐私政策 · 联系我们</p><a href="/rss">RSS 订阅</a></footer>'
    ].join('')
    const result = await extractReadable(page(body), 'https://example.com/post/1')
    expect(result.method).toBe('readability')
    expect(result.text).toContain('第一段：')
    expect(result.text).toContain('第二段：')
    for (const chrome of ['首页', '关于我们', '联系我们', '登录', '订阅', '版权所有', '隐私政策', 'RSS 订阅']) {
      expect(result.text).not.toContain(chrome)
    }
    expect(result.title).toBe('示例标题')
  })

  it('takes title, site name and published time from the article metadata', async () => {
    const head = [
      '<title>元数据标题</title>',
      '<meta property="og:site_name" content="示例站点">',
      '<meta property="article:published_time" content="2024-05-01T08:30:00Z">'
    ].join('')
    const result = await extractReadable(
      page(`<article>${paragraph()}${paragraph()}</article>`, head),
      'https://example.com/meta'
    )
    expect(result.method).toBe('readability')
    expect(result.title).toBe('元数据标题')
    expect(result.siteName).toBe('示例站点')
    expect(result.publishedAt).toBe('2024-05-01T08:30:00Z')
  })

  it('falls back on a page shorter than the 200-character threshold without losing text', async () => {
    const result = await extractReadable(
      page('<main><p>只有一句话，没有更多正文。</p></main>', '<title>短页</title>'),
      'https://example.com/short'
    )
    expect(result.method).toBe('fallback')
    expect(result.fallbackReason).toBe('short')
    expect(result.text).toContain('只有一句话')
    expect(result.text.replace(/\s+/g, '').length).toBeGreaterThan(0)
    expect(result.text.replace(/\s+/g, '').length).toBeLessThan(READABLE_MIN_CHARS)
    // 兜底仍是既有手写提取器：`<title>` 照旧给标题。
    expect(result.title).toBe('短页')
  })

  it('does not throw on malformed HTML or an empty body, and reports fallback', async () => {
    const malformed = await extractReadable(
      '<html><head><title>坏页</title></head><body><div><p>未闭合 <b>加粗 <table><tr><td>格子',
      'https://example.com/bad'
    )
    expect(malformed.method).toBe('fallback')
    expect(['short', 'empty']).toContain(malformed.fallbackReason)
    expect(typeof malformed.text).toBe('string')

    const empty = await extractReadable(page('', '<title>空页</title>'), 'https://example.com/empty')
    expect(empty.method).toBe('fallback')
    expect(empty.fallbackReason).toBe('empty')
    expect(empty.text).toBe('')
  })

  it('reports only the error name when parsing cannot start', async () => {
    const result = await extractReadable(page(`<article>${paragraph('第一段：')}</article>`), 'not a url')
    expect(result.method).toBe('fallback')
    // 只留 `error:<ErrorName>`：不带 message（这里本来会含 "not a url"）、不带堆栈。
    expect(result.fallbackReason).toBe('error:TypeError')
    expect(result.fallbackReason).not.toContain('not a url')
    expect(result.fallbackReason).not.toContain('\n')
    expect(result.fallbackReason!.length).toBeLessThanOrEqual(46)
    expect(result.text).toContain('第一段：')
  })

  it('never includes script source and never executes inline scripts', async () => {
    const script = '<script>window.__rgentPwned = 1; document.body.innerHTML = "<p>" + "脚本执行的标记".repeat(50) + "</p>"</script>'
    const result = await extractReadable(
      page(`<article>${script}${paragraph('甲：')}${paragraph('乙：')}</article>`),
      'https://example.com/script'
    )
    expect(result.method).toBe('readability')
    expect(result.text).toContain('甲：')
    expect(result.text).toContain('乙：')
    expect(result.text).not.toContain('脚本执行的标记')
    expect(result.text).not.toContain('window.__rgentPwned')
    expect((globalThis as { window?: unknown }).window).toBeUndefined()
    expect((globalThis as Record<string, unknown>).__rgentPwned).toBeUndefined()
  })

  it('truncates input over 1 MiB before parsing and still extracts the article', async () => {
    const filler = `<p>${'截断测试用的正文句子，'.repeat(20)}</p>`
    const big = `<!doctype html><html><head><title>大页面</title></head><body><article>${filler.repeat(2000)}<p>尾部标记-TAIL-MARKER</p></article></body></html>`
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(1_048_576)
    const result = await extractReadable(big, 'https://example.com/big')
    expect(result.method).toBe('readability')
    expect(result.title).toBe('大页面')
    expect(result.text.length).toBeGreaterThan(READABLE_MIN_CHARS)
    // 尾部标记在 1 MiB 之后，被截掉就不该出现在正文里。
    expect(result.text).not.toContain('TAIL-MARKER')
  }, 30_000)
})
