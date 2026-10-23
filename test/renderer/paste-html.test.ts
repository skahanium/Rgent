// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { markdownField, mountEditor, type EditorHost } from '../../src/renderer/src/view/editor.ts'
import { handleEditorPaste, selectionInProtectedMarkup } from '../../src/renderer/src/view/paste.ts'

const mounted: EditorHost[] = []
function editor(): EditorHost {
  const host = mountEditor(document.createElement('div'), () => {})
  mounted.push(host)
  return host
}
afterEach(() => { for (const host of mounted.splice(0)) host.destroy() })

const WECHAT = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuvwxyz012345'

function paste(host: EditorHost, data: { html?: string; plain?: string }): boolean {
  return handleEditorPaste({
    preventDefault() {},
    clipboardData: {
      getData(type: string) {
        if (type === 'text/html') return data.html ?? ''
        if (type === 'text/plain') return data.plain ?? ''
        return ''
      }
    }
  }, host.view, host.view.state.field(markdownField).presentation)
}

describe('webpage paste into the editor', () => {
  it('writes Markdown, not raw HTML, for a WeChat-like clipboard', () => {
    const host = editor()
    host.setText('')
    const html = `<p><span>一方面，</span>&nbsp;<span>初核</span> <a href="${WECHAT}">说明</a></p>`
    expect(paste(host, { html, plain: '一方面， 初核 说明' })).toBe(true)
    const text = host.getText()
    expect(text).toContain('一方面，初核')
    expect(text).toContain(`[说明](${WECHAT})`)
    expect(text).not.toContain('<p>')
    expect(text).not.toContain('<a ')
  })

  it('refuses to paste into an unaccepted AI block', () => {
    const host = editor()
    const raw = '<!-- rgent:ai:v1 -->\n回答\n'
    host.setText(raw)
    const at = host.view.state.doc.toString().indexOf('回答')
    host.view.dispatch({ selection: { anchor: at } })
    expect(paste(host, { html: `<p><a href="${WECHAT}">说明</a></p>`, plain: '说明' })).toBe(false)
    expect(host.getText()).toBe(raw)
  })

  it('pastes the raw plain text inside inline code', () => {
    const host = editor()
    host.setText('前 `code` 后\n')
    const at = host.view.state.doc.toString().indexOf('code') + 2
    host.view.dispatch({ selection: { anchor: at } })
    expect(selectionInProtectedMarkup(host.view, host.view.state.field(markdownField).presentation)).toBe(true)
    expect(paste(host, { html: `<p><a href="${WECHAT}">说明</a></p>`, plain: 'raw' })).toBe(true)
    expect(host.getText()).toContain('`corawde`')
    expect(host.getText()).not.toContain(`[说明](${WECHAT})`)
  })

  it('pastes the raw plain text inside a fenced code block', () => {
    const host = editor()
    host.setText('```\ncode\n```\n')
    const at = host.view.state.doc.toString().indexOf('code') + 2
    host.view.dispatch({ selection: { anchor: at } })
    expect(selectionInProtectedMarkup(host.view, host.view.state.field(markdownField).presentation)).toBe(true)
    expect(paste(host, { html: `<p><a href="${WECHAT}">说明</a></p>`, plain: 'raw' })).toBe(true)
    expect(host.getText()).toContain('raw')
    expect(host.getText()).not.toContain(`[说明](${WECHAT})`)
  })

  it('collapses CJK gaps when only plain text is available', () => {
    const host = editor()
    host.setText('')
    expect(paste(host, { plain: '一方面， 初核是开展调查' })).toBe(true)
    expect(host.getText()).toContain('一方面，初核是开展调查')
  })

  it('keeps another editor’s Markdown when the clipboard also has StartFragment HTML', () => {
    const host = editor()
    host.setText('')
    const plain = '见 [[工作/会议纪要]]\n\n```\nhello   world\n```\n'
    expect(paste(host, {
      html: '<!--StartFragment--><p><b>会议纪要</b></p><!--EndFragment-->',
      plain
    })).toBe(true)
    expect(host.getText()).toContain('[[工作/会议纪要]]')
    expect(host.getText()).toContain('hello   world')
    expect(host.getText()).not.toContain('**会议纪要**')
  })
})
