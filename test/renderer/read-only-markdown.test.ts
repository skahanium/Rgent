// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderReadOnlyMarkdown } from '../../src/renderer/src/view/read-only.ts'

describe('read-only ledger presentation', () => {
  it('renders headings, emphasis and lists without exposing Markdown delimiters', () => {
    const host = document.createElement('div')
    renderReadOnlyMarkdown(host, '## 第一场\n\n**结论**\n\n- A\n- B\n')
    expect(host.querySelector('h2')?.textContent).toBe('第一场')
    expect(host.querySelector('strong')?.textContent).toBe('结论')
    expect([...host.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['A', 'B'])
    expect(host.textContent).not.toContain('**')
  })

  it('keeps unsafe HTML inert', () => {
    const host = document.createElement('div')
    renderReadOnlyMarkdown(host, '文字\n\n<iframe src="https://example.com"></iframe>\n')
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.textContent).toContain('<iframe')
  })

  it('renders paired safe inline HTML in a paragraph while preserving adjacent text', () => {
    const host = document.createElement('div')
    renderReadOnlyMarkdown(host, '前文 <strong>强调</strong> 后文。')
    expect(host.querySelector('p strong')?.textContent).toBe('强调')
    expect(host.textContent).toBe('前文 强调 后文。')
  })
})
