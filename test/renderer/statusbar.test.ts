// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { compile } from '../../src/markdown/index.ts'
import { modelModuleGroups, renderStatusbar, statusModel, wordsOf } from '../../src/renderer/src/statusbar.ts'

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
        { label: 'MiniMax', items: [{ id: 'm3', label: 'MiniMax-M3' }] }
      ],
      value: 'm3' as string | null,
      onChange: () => {},
      onConfigure: () => {}
    }
    const merged = { ...base, ...overrides } as typeof base
    return { ...merged, signature: JSON.stringify({ groups: merged.groups, value: merged.value }) }
  }
  const input = { line: 1, column: 1, words: 0, vaultName: '库', noteOpen: true }

  const config = (overrides: Record<string, unknown> = {}) => ({
    providers: [
      { provider: 'deepseek' as const, configured: true, baseURL: 'https://api.deepseek.com', hasKey: true, modelCount: 2 },
      { provider: 'minimax' as const, configured: true, baseURL: 'https://api.minimaxi.com/v1', hasKey: false, modelCount: 1 },
      { provider: 'custom' as const, configured: false, baseURL: '', hasKey: false, modelCount: 0 }
    ],
    models: [
      { id: 'm1', provider: 'deepseek' as const, modelId: 'deepseek-flash', contextTokens: 1048576 },
      { id: 'm2', provider: 'deepseek' as const, modelId: 'deepseek-reasoner', contextTokens: 65536 },
      { id: 'm3', provider: 'minimax' as const, modelId: 'MiniMax-M3', contextTokens: 204800 }
    ],
    defaultModelId: 'm3',
    limits: { none: { seconds: 180, steps: 4, tools: 0 }, local: { seconds: 300, steps: 12, tools: 24 }, network: { seconds: 600, steps: 20, tools: 40 } },
    ...overrides
  })

  it('only offers providers that actually have a key', () => {
    expect(modelModuleGroups(config())).toEqual([
      { label: 'DeepSeek', items: [{ id: 'm1', label: 'deepseek-flash' }, { id: 'm2', label: 'deepseek-reasoner' }] }
    ])
    // 一个都没配好时不产生任何分组，交由「未配置模型」引导态处理
    expect(modelModuleGroups(config({ providers: config().providers.map((item) => ({ ...item, hasKey: false })) }))).toEqual([])
  })

  it('groups configured models by provider and marks the current one', () => {
    const host = document.createElement('div')
    renderStatusbar(host, statusModel(input, module() as never))
    const select = host.querySelector<HTMLSelectElement>('.status-model')!
    expect([...select.querySelectorAll('optgroup')].map((group) => group.label)).toEqual(['DeepSeek', 'MiniMax'])
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
    expect(host.querySelector('.status-model')).toBe(first)
    expect(document.activeElement).toBe(first)
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

it('updates the active note change callback even when model options are unchanged', () => {
  const host = document.createElement('div'), selected: string[] = []
  const base = { groups: [{ label: '供应商', items: [{ id: 'm', label: 'model' }] }], value: 'm', signature: 'same', onConfigure: () => {} }
  renderStatusbar(host, statusModel({ line: 1, column: 1, words: 0, vaultName: '库', noteOpen: true }, { ...base, onChange: () => selected.push('A') }))
  const select = host.querySelector<HTMLSelectElement>('.status-model')!
  renderStatusbar(host, statusModel({ line: 1, column: 1, words: 0, vaultName: '库', noteOpen: true }, { ...base, onChange: () => selected.push('B') }))
  select.dispatchEvent(new Event('change'))
  expect(selected).toEqual(['B'])
})
