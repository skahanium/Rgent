// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderSafeHtmlFragment } from '../../src/renderer/src/view/safe-html.ts'

describe('safe Markdown HTML', () => {
  it('keeps basic typography but removes style and event attributes', () => {
    const host = document.createElement('div')
    host.append(renderSafeHtmlFragment('<p style="color:red" onclick="alert(1)">A <strong>B</strong><br><kbd>C</kbd></p>'))
    expect(host.querySelector('p strong')?.textContent).toBe('B')
    expect(host.querySelector('kbd')?.textContent).toBe('C')
    expect(host.querySelector('[style], [onclick]')).toBeNull()
  })

  it('shows unsupported active content as text rather than creating live elements', () => {
    const host = document.createElement('div')
    host.append(renderSafeHtmlFragment('<iframe src="https://example.com"></iframe><svg onload="alert(1)"></svg>'))
    expect(host.querySelector('iframe, svg, script')).toBeNull()
    expect(host.textContent).toContain('<iframe')
    expect(host.textContent).toContain('<svg')
  })
})
