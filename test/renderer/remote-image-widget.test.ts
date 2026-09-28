// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createImageElement } from '../../src/renderer/src/view/widgets/image.ts'

describe('Markdown external image presentation', () => {
  it('loads HTTPS through the typed image entry and never displays the raw URL', async () => {
    const load = vi.fn(async () => ({ ok: true as const, src: 'rgent-image://media/?t=abc' }))
    const node = createImageElement('截图', 'https://images.example/p?token=secret', true, load)
    await vi.waitFor(() => expect(node.querySelector('img')?.getAttribute('src')).toBe('rgent-image://media/?t=abc'))
    expect(load).toHaveBeenCalledWith({ url: 'https://images.example/p?token=secret', allowHttp: false })
    expect(node.textContent).not.toContain('secret')
  })

  it('keeps HTTP inert until the image button is clicked', async () => {
    const load = vi.fn(async () => ({ ok: true as const, src: 'rgent-image://media/?t=abc' }))
    const node = createImageElement('旧图', 'http://images.example/p.png', true, load)
    expect(load).not.toHaveBeenCalled()
    ;(node.querySelector('button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith({ url: 'http://images.example/p.png', allowHttp: true }))
  })

  it('uses a concise inline failure instead of a large URL card', async () => {
    const load = vi.fn(async () => ({ ok: false as const, error: 'NOT_IMAGE' as const }))
    const node = createImageElement('', 'https://images.example/very-long-secret-address', false, load)
    await vi.waitFor(() => expect(node.textContent).toContain('地址没有返回图片'))
    expect(node.classList.contains('md-image-inline')).toBe(true)
    expect(node.textContent).not.toContain('very-long-secret-address')
  })
})
