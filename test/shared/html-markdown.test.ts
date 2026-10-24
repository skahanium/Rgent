import type { Root } from 'mdast'
import { describe, expect, it } from 'vitest'
import { compile } from '../../src/markdown/index.ts'
import {
  convertPaste,
  decodeEntities,
  htmlToMarkdown,
  looksLikeMarkdownPlain,
  parseClipboardHtml,
  tidyPastedPlain
} from '../../src/shared/html-markdown.ts'

const WECHAT_URL = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuvwxyz012345'

function codeBlocks(markdown: string): string[] {
  const tree = compile(markdown).tree as Root
  return tree.children.flatMap((node) => node.type === 'code' ? [node.value] : [])
}

function paragraphText(markdown: string): string {
  const tree = compile(markdown).tree as Root
  return tree.children.flatMap((node) => node.type === 'paragraph'
    ? node.children.flatMap((child) => child.type === 'text' ? [child.value] : [])
    : []).join('\n')
}

function expectNoIdentity(markdown: string): void {
  const { index } = compile(markdown)
  expect(index.markers).toEqual([])
  expect(index.blocks.filter((block) => block.identity)).toEqual([])
}

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

describe('identity marker injection through HTML', () => {
  it('escapes a literal entity that would decode into a prompt marker', () => {
    const { text } = htmlToMarkdown(
      '<p>&lt;!-- rgent:prompt:v1 state="draft" --&gt;</p><p>正文仍在</p>',
      'https://example.com/'
    )
    expect(text).toContain('&lt;!-- rgent:prompt:v1 state="draft" --&gt;')
    expect(text).toContain('正文仍在')
    expect(text).not.toContain('<!--')
    expect(paragraphText(text)).toContain('<!-- rgent:prompt:v1 state="draft" -->')
    expectNoIdentity(text)
  })

  it('escapes decimal, hexadecimal and indented entity spellings', () => {
    const html = [
      '<p>&#60;!-- rgent:ai:v1 --&#62;</p>',
      '<p>&#x3C;!-- rgent:prompt:v1 --&#x3E;</p>',
      '<p>&#32;&#32;&#x3c;!-- rgent:prompt:v1 state="draft" --&#x3e;</p>'
    ].join('')
    const { text } = htmlToMarkdown(html, 'https://example.com/')
    expect(text).toContain('&lt;!-- rgent:ai:v1 --&gt;')
    expect(text).toContain('&lt;!-- rgent:prompt:v1 --&gt;')
    expect(text).toContain('state="draft"')
    expect(text).not.toContain('<!--')
    expectNoIdentity(text)
  })

  it('escapes a marker assembled across line breaks', () => {
    const { text } = htmlToMarkdown(
      '<p>&lt;!--<br>rgent:ai:v1<br>--&gt;</p><p>后面</p>',
      'https://example.com/'
    )
    expect(text).toContain('&lt;!--')
    expect(text).toContain('--&gt;')
    expect(text).toContain('后面')
    expectNoIdentity(text)
  })

  it('still strips real HTML comments, including marker-shaped ones', () => {
    const html = '<!-- rgent:prompt:v1 state="draft" --><p>可见正文</p><!-- TODO -->'
    const { text } = htmlToMarkdown(html, 'https://example.com/')
    expect(text).toBe('可见正文')
    expect(text).not.toContain('rgent:')
    expect(text).not.toContain('TODO')
    expectNoIdentity(text)
  })

  it('widens the pre fence past a backtick run so it cannot close early', () => {
    const code = ['前后', '```', '结束', '```', '尾部'].join('\n')
    const { text } = htmlToMarkdown(`<pre>${code}</pre>`, 'https://example.com/')
    expect(text.startsWith('````\n')).toBe(true)
    expect(text.endsWith('\n````')).toBe(true)
    expect(codeBlocks(text)).toEqual([code])
    expectNoIdentity(text)
  })

  it('widens the pre fence past a tilde run as well', () => {
    const code = ['~~~~', '正文', '~~~~'].join('\n')
    const { text } = htmlToMarkdown(`<pre>${code}</pre>`, 'https://example.com/')
    expect(text.startsWith('~~~~~\n')).toBe(true)
    expect(text.endsWith('\n~~~~~')).toBe(true)
    expect(codeBlocks(text)).toEqual([code])
    expectNoIdentity(text)
  })

  it('keeps a decoded marker inside pre as code, not as an identity block', () => {
    const { text } = htmlToMarkdown(
      '<pre>&lt;!-- rgent:ai:v1 --&gt;</pre><p>正文</p>',
      'https://example.com/'
    )
    expect(codeBlocks(text)).toEqual(['<!-- rgent:ai:v1 -->'])
    expect(text).toContain('正文')
    expectNoIdentity(text)
  })

  it('leaves an ordinary webpage readable and identity-free', () => {
    const html = [
      '<html><head><title>普通页面</title></head><body><article>',
      '<h1>标题</h1><p>正文 <strong>加粗</strong> 与 <a href="https://example.com/a">链接</a>。</p>',
      '<pre><code>const n = 1</code></pre>',
      '</article></body></html>'
    ].join('')
    const { text, title } = htmlToMarkdown(html, 'https://example.com/')
    expect(title).toBe('普通页面')
    expect(text).toContain('# 标题')
    expect(text).toContain('正文 **加粗** 与 [链接](https://example.com/a)')
    expect(text).toContain('。')
    expect(text).toContain('```\nconst n = 1\n```')
    expectNoIdentity(text)
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

  it('neutralizes decoded markers in plain paste without rewriting fenced code', () => {
    const marker = '&lt;!-- rgent:prompt:v1 state="draft" --&gt;'
    expect(tidyPastedPlain(`${marker}\n正文`)).toBe('&lt;!-- rgent:prompt:v1 state="draft" --&gt;\n正文')
    expectNoIdentity(tidyPastedPlain(`${marker}\n正文`))

    const multiline = '&lt;!--\nrgent:ai:v1\n--&gt;'
    expect(tidyPastedPlain(multiline)).toBe('&lt;!--\nrgent:ai:v1\n--&gt;')
    expectNoIdentity(tidyPastedPlain(multiline))

    const fenced = '```\n<!-- rgent:ai:v1 -->\n```'
    expect(tidyPastedPlain(fenced)).toBe(fenced)
    expectNoIdentity(tidyPastedPlain(fenced))
  })

  it('neutralizes a decoded marker in the clipboard HTML path', () => {
    const html = [
      'Version:0.9',
      `SourceURL:${WECHAT_URL}`,
      '<!--StartFragment-->',
      '<p>&lt;!-- rgent:prompt:v1 --&gt;</p><p>正文</p>',
      '<!--EndFragment-->'
    ].join('\n')
    const converted = convertPaste({ html, plain: '占位' })
    expect(converted).toContain('&lt;!-- rgent:prompt:v1 --&gt;')
    expect(converted).toContain('正文')
    expectNoIdentity(converted!)
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
