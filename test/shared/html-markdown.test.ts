import { describe, expect, it } from 'vitest'
import {
  convertPaste,
  decodeEntities,
  htmlToMarkdown,
  looksLikeMarkdownPlain,
  parseClipboardHtml,
  tidyPastedPlain
} from '../../src/shared/html-markdown.ts'

const WECHAT_URL = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuvwxyz012345'

describe('htmlToMarkdown', () => {
  it('turns WeChat-like spans, nbsp gaps and long links into GFM without CJK gaps', () => {
    const html = [
      `<p><span>一方面，</span>&nbsp;<span>初核是开展调查、</span>`,
      `<a href="${WECHAT_URL}">说明</a></p>`,
      `<img src="data:image/gif;base64,R0lGODlh" data-src="https://mmbiz.qpic.cn/mmbiz_png/abc/0" alt="附图">`
    ].join('')
    const { text } = htmlToMarkdown(html, 'https://mp.weixin.qq.com/s/abc')
    expect(text).toContain('一方面，初核是开展调查、')
    expect(text).not.toMatch(/一方面，\s+初核/)
    expect(text).toContain(`[说明](${WECHAT_URL})`)
    expect(text).not.toContain(`说明 (${WECHAT_URL})`)
    expect(text).toContain('![附图](https://mmbiz.qpic.cn/mmbiz_png/abc/0)')
    expect(text).not.toContain('data:image/gif')
  })

  it('prefers Zhihu data-actualsrc and keeps http(s) links as GFM', () => {
    const html = [
      '<p class="ztext">正文 <a href="https://zhuanlan.zhihu.com/p/1">知乎</a></p>',
      '<figure><img src="https://picx.zhimg.com/v2-x.jpg" data-actualsrc="https://picx.zhimg.com/v2-real.jpg" alt="图"></figure>'
    ].join('')
    const { text } = htmlToMarkdown(html, 'https://zhuanlan.zhihu.com/p/1')
    expect(text).toContain('[知乎](https://zhuanlan.zhihu.com/p/1)')
    expect(text).toContain('![图](https://picx.zhimg.com/v2-real.jpg)')
    expect(text).not.toContain('v2-x.jpg')
  })

  it('turns a table into a GFM table with a separator row', () => {
    const html = '<table><tr><th>项</th><th>值</th></tr><tr><td>甲</td><td>1</td></tr></table>'
    const { text } = htmlToMarkdown(html, 'https://example.com/')
    expect(text).toContain('| 项 | 值 |')
    expect(text).toContain('| --- | --- |')
    expect(text).toContain('| 甲 | 1 |')
  })

  it('drops script, style and non-http(s) links or images', () => {
    const html = [
      '<style>body{color:red}</style><script>alert("坏")</script>',
      '<p><a href="javascript:alert(1)">点我</a> <a href="file:///tmp/a">本地</a></p>',
      '<img src="data:image/png;base64,xxxx" alt="隐">'
    ].join('')
    const { text } = htmlToMarkdown(html, 'https://example.com/')
    expect(text).toContain('点我')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('javascript:')
    expect(text).not.toContain('file:')
    expect(text).not.toContain('![](')
    expect(text).not.toContain('![隐]')
  })

  it('keeps spaces inside a pre block and between CJK and Latin', () => {
    const html = '<p>用 Python 做初核</p><pre><code>hello   world</code></pre>'
    const { text } = htmlToMarkdown(html, 'https://example.com/')
    expect(text).toContain('用 Python 做初核')
    expect(text).toContain('```\nhello   world\n```')
  })

  it('still extracts a title and headings for the fetch fallback path', () => {
    const html = '<html><head><title>示例 &amp; 页面</title></head><body><h1>标题</h1><p>短</p></body></html>'
    const result = htmlToMarkdown(html, 'https://example.com/')
    expect(result.title).toBe('示例 & 页面')
    expect(result.text).toContain('# 标题')
    expect(result.text).toContain('短')
  })
})

describe('parseClipboardHtml and convertPaste', () => {
  it('reads CF_HTML SourceURL and only converts the fragment', () => {
    const html = [
      'Version:0.9',
      'StartHTML:0000000173',
      'EndHTML:0000000500',
      'StartFragment:0000000210',
      'EndFragment:0000000480',
      `SourceURL:${WECHAT_URL}`,
      '<html><body><!--StartFragment-->',
      '<p><span>一方面，</span>&nbsp;<span>初核</span> <a href="/s/abc">说明</a></p>',
      '<!--EndFragment--></body></html>'
    ].join('\n')
    const parsed = parseClipboardHtml(html)
    expect(parsed.baseUrl).toBe(WECHAT_URL)
    expect(parsed.fragment).toContain('一方面')
    expect(parsed.fragment).not.toContain('Version:0.9')
    const converted = convertPaste({ html, plain: '一方面， 初核' })
    expect(converted).toContain('一方面，初核')
    expect(converted).toContain('[说明](https://mp.weixin.qq.com/s/abc)')
  })

  it('leaves another editor’s Markdown plain text alone', () => {
    const plain = '## 标题\n\n见 [[工作/会议纪要]] 与 [站点](https://example.com)\n'
    expect(looksLikeMarkdownPlain(plain)).toBe(true)
    const converted = convertPaste({ html: '<p><b>标题</b></p>', plain })
    expect(converted).toContain('[[工作/会议纪要]]')
    expect(converted).toContain('[站点](https://example.com)')
    expect(converted).not.toContain('<p>')
  })

  it('does not let StartFragment HTML overwrite Markdown from another editor', () => {
    const plain = '见 [[工作/会议纪要]]\n\n```\nhello   world\n```\n'
    const html = '<!--StartFragment--><p><b>会议纪要</b></p><!--EndFragment-->'
    const converted = convertPaste({ html, plain })
    expect(converted).toContain('[[工作/会议纪要]]')
    expect(converted).toContain('```\nhello   world\n```')
    expect(converted).not.toContain('**会议纪要**')
  })

  it('tidies plain text: CJK gaps and escaped Markdown links', () => {
    expect(tidyPastedPlain('一方面， 初核')).toBe('一方面，初核')
    expect(tidyPastedPlain('用 Python 3')).toBe('用 Python 3')
    expect(tidyPastedPlain('\\[说明\\](https://example.com/a)')).toBe('[说明](https://example.com/a)')
    expect(tidyPastedPlain('```\nhello   world\n\\[x\\](https://example.com)\n```')).toBe('```\nhello   world\n\\[x\\](https://example.com)\n```')
  })

  it('decodes entities in link hrefs before making a GFM URL', () => {
    const { text } = htmlToMarkdown(
      '<p><a href="https://example.com/a?x=1&amp;y=2">链</a></p>',
      'https://example.com/'
    )
    expect(text).toContain('[链](https://example.com/a?x=1&y=2)')
    expect(text).not.toContain('&amp;')
  })

  it('falls back to tidied plain when HTML is over the byte cap', () => {
    const html = `<p>${'汉'.repeat(200)}</p>`
    const converted = convertPaste({ html, plain: '一方面， 初核', maxHtmlBytes: 8 })
    expect(converted).toBe('一方面，初核')
  })
})

describe('decodeEntities', () => {
  it('decodes named and numeric entities and keeps unknown ones', () => {
    expect(decodeEntities('&nbsp;&amp;&#x4e2d;&#20013;&unknown;')).toBe('\u00a0&中中&unknown;')
  })
})
