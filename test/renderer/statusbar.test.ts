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
  const input = { line: 1, column: 1, words: 0, noteOpen: true }
  const network = (overrides: Record<string, unknown> = {}) => ({ enabled: false, onToggle: () => {}, ...overrides })

  const config = (overrides: Record<string, unknown> = {}) => ({
    providers: [
      { provider: 'deepseek' as const, configured: true, baseURL: 'https://api.deepseek.com', hasKey: true, modelCount: 2 },
      { provider: 'minimax' as const, configured: true, baseURL: 'https://api.minimax.com/v1', hasKey: false, modelCount: 1 },
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
    renderStatusbar(host, statusModel(input, network(), module() as never))
    const select = host.querySelector<HTMLSelectElement>('.status-model')!
    expect([...select.querySelectorAll('optgroup')].map((group) => group.label)).toEqual(['DeepSeek', 'MiniMax'])
    expect([...select.options].map((option) => option.value)).toEqual(['m1', 'm2', 'm3'])
    expect(select.value).toBe('m3')
  })

  it('keeps the same select node and values across status re-renders', () => {
    const host = document.createElement('div')
    document.body.append(host)
    renderStatusbar(host, statusModel(input, network(), module() as never))
    const first = host.querySelector<HTMLSelectElement>('.status-model')!
    first.focus()
    renderStatusbar(host, statusModel({ ...input, line: 2 }, network(), module() as never))
    const second = host.querySelector('.status-model')
    expect(second).toBe(first)
    expect(document.activeElement).toBe(first)
    expect((second as HTMLSelectElement).value).toBe('m3')
    renderStatusbar(host, statusModel({ ...input, line: 3 }, network(), module({ value: 'm1' }) as never))
    expect((host.querySelector('.status-model') as HTMLSelectElement).value).toBe('m1')
    expect(host.querySelector('.status-model')).toBe(first)
    expect(document.activeElement).toBe(first)
    host.remove()
  })

  it('uses a short 未选 placeholder when a note is open but no model is chosen', () => {
    const host = document.createElement('div')
    renderStatusbar(host, statusModel(input, network(), module({ value: null, unavailableLabel: '未选' }) as never))
    const select = host.querySelector<HTMLSelectElement>('.status-model')!
    expect(select.value).toBe('')
    expect(select.options[0]?.textContent).toBe('未选')
    expect(host.textContent).not.toContain('未选择模型')
    host.remove()
  })

  it('offers a way to open settings instead of a dead control when nothing is configured', () => {
    const host = document.createElement('div')
    let configured = 0
    renderStatusbar(host, statusModel(input, network(), module({ groups: [], value: null, onConfigure: () => { configured += 1 } }) as never))
    expect(host.querySelector('.status-model')).toBeNull()
    expect(host.querySelector('.status-model-empty')?.textContent).toBe('未配置模型')
    host.querySelector<HTMLButtonElement>('.status-model-config')!.click()
    expect(configured).toBe(1)
  })

  it('reports the chosen model through the change handler', () => {
    const host = document.createElement('div')
    const picked: string[] = []
    renderStatusbar(host, statusModel(input, network(), module({ onChange: (id: string) => picked.push(id) }) as never))
    const select = host.querySelector<HTMLSelectElement>('.status-model')!
    select.value = 'm1'
    select.dispatchEvent(new Event('change'))
    expect(picked).toEqual(['m1'])
  })
})

it('updates the active note change callback even when model options are unchanged', () => {
  const host = document.createElement('div'), selected: string[] = []
  const network = { enabled: false, onToggle: () => {} }
  const base = { groups: [{ label: '供应商', items: [{ id: 'm', label: 'model' }] }], value: 'm', signature: 'same', onConfigure: () => {} }
  renderStatusbar(host, statusModel({ line: 1, column: 1, words: 0, noteOpen: true }, network, { ...base, onChange: () => selected.push('A') }))
  const select = host.querySelector<HTMLSelectElement>('.status-model')!
  renderStatusbar(host, statusModel({ line: 1, column: 1, words: 0, noteOpen: true }, network, { ...base, onChange: () => selected.push('B') }))
  select.dispatchEvent(new Event('change'))
  expect(selected).toEqual(['B'])
})

describe('network gate button', () => {
  it('renders a clickable gate and no vault name', () => {
    const host = document.createElement('div')
    document.body.append(host)
    let toggled = 0
    renderStatusbar(host, statusModel({ line: 1, column: 1, words: 0, noteOpen: true }, { enabled: false, onToggle: () => { toggled += 1 } }))
    expect(host.querySelector('.status-vault')).toBeNull()
    const button = host.querySelector<HTMLButtonElement>('.status-dot')!
    expect(button.tagName).toBe('BUTTON')
    expect(button.dataset.state).toBe('offline')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('aria-label')).toBe('联网搜索与抓取：已关')
    button.click()
    expect(toggled).toBe(1)
    renderStatusbar(host, statusModel({ line: 2, column: 1, words: 0, noteOpen: true }, { enabled: true, onToggle: () => { toggled += 1 } }))
    expect(host.querySelector('.status-dot')).toBe(button)
    expect(button.dataset.state).toBe('online')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('aria-label')).toBe('联网搜索与抓取：已开')
    host.remove()
  })
})

describe('status bar scope module', () => {
  const input = { line: 1, column: 1, words: 0, noteOpen: true }
  const network = { enabled: false, onToggle: () => {} }
  const options = (root: boolean) => [
    { value: 'note' as const, label: '本篇', detail: '只读发起篇；回答与补写照常。' },
    {
      value: 'folder' as const, label: '同册',
      detail: root ? '根目录笔记没有同册。' : '可读发起篇所在的目录。',
      ...(root ? { disabled: true, title: '根目录笔记没有同册；请用本篇或整库。' } : {})
    },
    { value: 'vault' as const, label: '整库', detail: '可读整个笔记库。' }
  ]
  const scope = (value: 'note' | 'folder' | 'vault', overrides: Record<string, unknown> = {}) =>
    ({ value, options: options(false), onChange: () => {}, ...overrides })

  it('renders next to the model as a 3-level button and menu', () => {
    const host = document.createElement('div')
    document.body.append(host)
    renderStatusbar(host, statusModel(input, network, undefined, scope('vault') as never))
    const button = host.querySelector<HTMLButtonElement>('.status-scope-button')!
    expect(button.dataset.scope).toBe('vault')
    expect(button.textContent).toBe('整库 ▾')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    const menu = host.querySelector<HTMLElement>('.status-scope-menu')!
    expect(menu.getAttribute('role')).toBe('menu')
    expect(menu.hidden).toBe(true)
    expect([...menu.querySelectorAll<HTMLElement>('.status-scope-option-name')].map(node => node.textContent)).toEqual(['本篇', '同册', '整库'])
    host.remove()
  })

  it('disables 同册 for a root note and shows the fallback 本篇 as checked', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const picked: string[] = []
    renderStatusbar(host, statusModel(input, network, undefined, { value: 'note', options: options(true), onChange: (value: string) => picked.push(value) } as never))
    expect(host.querySelector<HTMLButtonElement>('.status-scope-button')!.textContent).toBe('本篇 ▾')
    host.querySelector<HTMLButtonElement>('.status-scope-button')!.click()
    const folder = [...host.querySelectorAll<HTMLButtonElement>('.status-scope-option')].find(item => item.dataset.scopeOption === 'folder')!
    expect(folder.disabled).toBe(true)
    expect(folder.getAttribute('aria-disabled')).toBe('true')
    expect(folder.title).toContain('根目录笔记没有同册')
    folder.click()
    expect(picked).toEqual([])
    expect(host.querySelector<HTMLButtonElement>('.status-scope-button')!.textContent).toBe('本篇 ▾')
    host.remove()
  })

  it('opens a non-modal menu with the current item checked and closes on Esc or outside click', () => {
    const host = document.createElement('div')
    document.body.append(host)
    renderStatusbar(host, statusModel(input, network, undefined, scope('folder') as never))
    const button = host.querySelector<HTMLButtonElement>('.status-scope-button')!
    button.focus()
    button.click()
    const menu = host.querySelector<HTMLElement>('.status-scope-menu')!
    expect(menu.hidden).toBe(false)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const folder = [...host.querySelectorAll<HTMLButtonElement>('.status-scope-option')].find(item => item.dataset.scopeOption === 'folder')!
    expect(folder.getAttribute('aria-checked')).toBe('true')
    expect(folder.querySelector('.status-scope-check')!.textContent).toBe('✓')
    expect(host.querySelector<HTMLDialogElement>('dialog')).toBeNull()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(menu.hidden).toBe(true)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(button)
    button.click()
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(menu.hidden).toBe(true)
    button.click()
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(menu.hidden).toBe(true)
    host.remove()
  })

  it('reports the chosen scope through the change handler', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const picked: string[] = []
    renderStatusbar(host, statusModel(input, network, undefined, scope('note', { onChange: (value: string) => picked.push(value) }) as never))
    host.querySelector<HTMLButtonElement>('.status-scope-button')!.click()
    const vault = [...host.querySelectorAll<HTMLButtonElement>('.status-scope-option')].find(item => item.dataset.scopeOption === 'vault')!
    vault.click()
    expect(picked).toEqual(['vault'])
    expect(host.querySelector<HTMLElement>('.status-scope-menu')!.hidden).toBe(true)
    host.remove()
  })

  it('keeps the same button, menu and focus across high-frequency status re-renders', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const module = () => scope('note', { options: options(false), onChange: () => {} })
    renderStatusbar(host, statusModel(input, network, undefined, module() as never))
    const button = host.querySelector<HTMLButtonElement>('.status-scope-button')!
    button.click()
    const menu = host.querySelector<HTMLElement>('.status-scope-menu')!
    const vault = [...host.querySelectorAll<HTMLButtonElement>('.status-scope-option')].find(item => item.dataset.scopeOption === 'vault')!
    vault.focus()
    renderStatusbar(host, statusModel({ ...input, line: 2 }, network, undefined, module() as never))
    renderStatusbar(host, statusModel({ ...input, line: 3 }, network, undefined, module() as never))
    expect(host.querySelector('.status-scope-button')).toBe(button)
    expect(host.querySelector('.status-scope-menu')).toBe(menu)
    expect(menu.hidden).toBe(false)
    expect(document.activeElement).toBe(vault)
    expect(button.textContent).toBe('本篇 ▾')
    host.remove()
  })
})
