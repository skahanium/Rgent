// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { compile } from '../../src/markdown/index.ts'
import { renderStatusbar, statusModel, wordsOf } from '../../src/renderer/src/statusbar.ts'

describe('status bar word count', () => {
  it('counts CJK characters and Latin or numeric runs in the note body', () => {
    expect(wordsOf('你好 world v0', [])).toBe(4)
  })

  it('does not count identity marker syntax while keeping the marked prose', () => {
    const body = '甲。\n\n<!-- rgent:prompt:v1 -->\n你好 world\n'
    expect(wordsOf(body, compile(body).index.markers)).toBe(4)
  })

  it('does not count punctuation or whitespace', () => {
    expect(wordsOf(' \n\t。，！ ', [])).toBe(0)
  })
})


describe('status bar model module', () => {
  /** 与外壳一致：模块自带签名，底栏只在签名变化时重建下拉。 */
  const module = (overrides: Record<string, unknown> = {}) => {
    const base = {
      groups: [
        { label: 'DeepSeek', items: [{ id: 'm1', label: 'deepseek-flash' }, { id: 'm2', label: 'deepseek-reasoner' }] },
        { label: 'MiniMax（缺密钥）', items: [{ id: 'm3', label: 'MiniMax-M3' }] }
      ],
      value: 'm3' as string | null,
      onChange: () => {},
      onConfigure: () => {}
    }
    const merged = { ...base, ...overrides } as typeof base
    return { ...merged, signature: JSON.stringify({ groups: merged.groups, value: merged.value }) }
  }
  const input = { line: 1, column: 1, words: 0, vaultName: '库', noteOpen: true }

  it('groups configured models by provider and marks the current one', () => {
    const host = document.createElement('div')
    renderStatusbar(host, statusModel(input, module() as never))
    const select = host.querySelector<HTMLSelectElement>('.status-model')!
    expect([...select.querySelectorAll('optgroup')].map((group) => group.label)).toEqual(['DeepSeek', 'MiniMax（缺密钥）'])
    expect([...select.options].map((option) => option.value)).toEqual(['m1', 'm2', 'm3'])
    expect(select.value).toBe('m3')
  })

  it('keeps the same select node and values across status re-renders', () => {
    const host = document.createElement('div')
    document.body.append(host)
    renderStatusbar(host, statusModel(input, module() as never))
    const first = host.querySelector<HTMLSelectElement>('.status-model')!
    first.focus()
    renderStatusbar(host, statusModel({ ...input, line: 2 }, module() as never))
    const second = host.querySelector('.status-model')
    expect(second).toBe(first)
    expect(document.activeElement).toBe(first)
    expect((second as HTMLSelectElement).value).toBe('m3')
    renderStatusbar(host, statusModel({ ...input, line: 3 }, module({ value: 'm1' }) as never))
    expect((host.querySelector('.status-model') as HTMLSelectElement).value).toBe('m1')
    host.remove()
  })

  it('offers a way to open settings instead of a dead control when nothing is configured', () => {
    const host = document.createElement('div')
    let configured = 0
    renderStatusbar(host, statusModel(input, module({ groups: [], value: null, onConfigure: () => { configured += 1 } }) as never))
    expect(host.querySelector('.status-model')).toBeNull()
    expect(host.querySelector('.status-model-empty')?.textContent).toBe('未配置模型')
    host.querySelector<HTMLButtonElement>('.status-model-config')!.click()
    expect(configured).toBe(1)
  })

  it('reports the chosen model through the change handler', () => {
    const host = document.createElement('div')
    const picked: string[] = []
    renderStatusbar(host, statusModel(input, module({ onChange: (id: string) => picked.push(id) }) as never))
    const select = host.querySelector<HTMLSelectElement>('.status-model')!
    select.value = 'm1'
    select.dispatchEvent(new Event('change'))
    expect(picked).toEqual(['m1'])
  })
})
