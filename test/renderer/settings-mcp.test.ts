// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpErrorText, mountMcpCard, type McpCardHandlers } from '../../src/renderer/src/settings-mcp.ts'
import type {
  McpConfigResult,
  McpConfigView,
  McpDiscoverResult,
  McpPublicServer,
  McpServerSaveRequest
} from '../../src/shared/ipc.ts'

afterEach(() => document.body.replaceChildren())

const server = (over: Partial<McpPublicServer> = {}): McpPublicServer => ({
  id: 's1',
  name: '示例服务器',
  url: 'https://mcp.example.com/mcp',
  host: 'mcp.example.com',
  enabled: false,
  hasToken: true,
  searchChannel: false,
  tools: [],
  whitelist: [],
  ...over
})
const view = (...servers: McpPublicServer[]): McpConfigView => ({ servers })
const ok = (config: McpConfigView): McpConfigResult => ({ ok: true, config })
const fail = (error: string): McpConfigResult => ({ ok: false, error })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const node = <T extends HTMLElement>(body: HTMLElement, name: string): T => body.querySelector<T>(`[data-mcp="${name}"]`)!
const nodes = <T extends HTMLElement>(root: ParentNode, name: string): T[] => [...root.querySelectorAll<T>(`[data-mcp="${name}"]`)]

function mount(initial: McpConfigResult = ok(view()), overrides: Partial<McpCardHandlers> = {}) {
  const body = document.createElement('section')
  document.body.append(body)
  const handlers: McpCardHandlers = {
    get: vi.fn(async () => initial),
    save: vi.fn(async () => ok(view())),
    remove: vi.fn(async () => ok(view())),
    discover: vi.fn(async () => ({ ok: true, id: 's1', tools: [], config: view() }) as McpDiscoverResult),
    ...overrides
  }
  const dispose = mountMcpCard({ body, isCurrent: () => true }, handlers)
  return { body, handlers, dispose }
}

describe('远端只读 MCP 设置卡', () => {
  it('renders the server list with host, counts and the read-only/token explanation', async () => {
    const { body } = mount(ok(view(server({
      enabled: true,
      tools: [{ name: 'read_a' }, { name: 'read_b', title: '读 B' }],
      whitelist: ['read_a']
    }))))
    await tick()
    const row = node<HTMLElement>(body, 'row')
    expect(row).toBeTruthy()
    expect(node(row, 'name').textContent).toBe('示例服务器')
    expect(node(row, 'host').textContent).toBe('mcp.example.com')
    expect(node(row, 'counts').textContent).toContain('工具 2')
    expect(node(row, 'counts').textContent).toContain('白名单 1')
    expect(node(row, 'counts').textContent).toContain('已启用')
    expect((node<HTMLInputElement>(row, 'enabled')).checked).toBe(true)
    // 用途标记是每台服务器的设备级复选框，默认不勾。
    const searchChannel = node<HTMLInputElement>(row, 'search-channel')
    expect(searchChannel.checked).toBe(false)
    expect(searchChannel.closest('label')!.textContent).toBe('用于联网搜索/抓取（受搜索闸管）')
    expect(node(row, 'discover').textContent).toBe('连接并列出工具')
    expect(node(row, 'remove').textContent).toBe('删除')
    // 一次外发前先写明目标主机。
    expect(node(row, 'discover-hint').textContent).toContain('mcp.example.com')
    expect(node(body, 'gate-hint').textContent).toBe('非搜索类 MCP 不受搜索闸管；勾选『用于联网搜索/抓取』的服务器才受闸。')
    expect(body.textContent).toContain('只读由你勾选的工具保证。Rgent 只按名字与参数转发；token 可选，公共只读服务器可留空，有 token 时只存本机加密、不显示。')
    // 已发现工具按勾选状态列出。
    const tools = nodes<HTMLInputElement>(row, 'tool')
    expect(tools.map(input => input.dataset.toolName)).toEqual(['read_a', 'read_b'])
    expect(tools.map(input => input.checked)).toEqual([true, false])
  })

  it('saves a new server through IPC, clears the form and never echoes the token', async () => {
    const added = server({ id: 's2', name: '新服务器', url: 'https://new.example.com/mcp', host: 'new.example.com' })
    const { body, handlers } = mount(ok(view()), {
      save: vi.fn(async (_request: McpServerSaveRequest) => ok(view(added)))
    })
    await tick()
    expect(body.textContent).toContain('还没有服务器。')
    const name = node<HTMLInputElement>(body, 'new-name')
    const url = node<HTMLInputElement>(body, 'new-url')
    const token = node<HTMLInputElement>(body, 'new-token')
    expect(token.type).toBe('password')
    name.value = '新服务器'
    url.value = 'https://new.example.com/mcp'
    token.value = 'super-secret-token'
    node<HTMLButtonElement>(body, 'save').click()
    await tick()
    expect(handlers.save).toHaveBeenCalledWith({
      name: '新服务器',
      url: 'https://new.example.com/mcp',
      token: 'super-secret-token',
      enabled: false
    })
    expect(name.value).toBe('')
    expect(url.value).toBe('')
    expect(token.value).toBe('')
    expect(body.textContent).toContain('新服务器')
    expect(body.textContent).toContain('new.example.com')
    expect(body.textContent).not.toContain('super-secret-token')
    expect(node(body, 'status').textContent).toContain('已保存')
  })

  it('validates the add form locally and saves a public server without a token', async () => {
    const added = server({ id: 's2', name: 'x', url: 'https://plain.example.com/mcp', host: 'plain.example.com', hasToken: false })
    const { body, handlers } = mount(ok(view()), { save: vi.fn(async (_request: McpServerSaveRequest) => ok(view(added))) })
    await tick()
    node<HTMLButtonElement>(body, 'save').click()
    expect(node(body, 'error').textContent).toContain('名称')
    node<HTMLInputElement>(body, 'new-name').value = 'x'
    node<HTMLInputElement>(body, 'new-url').value = 'http://plain.example.com/mcp'
    node<HTMLButtonElement>(body, 'save').click()
    expect(node(body, 'error').textContent).toContain('https://')
    expect(handlers.save).not.toHaveBeenCalled()
    node<HTMLInputElement>(body, 'new-url').value = 'https://plain.example.com/mcp'
    // token 留空是合法的公共只读服务器：请求里不带 token 字段，表单照常提交。
    node<HTMLButtonElement>(body, 'save').click()
    await tick()
    expect(handlers.save).toHaveBeenCalledWith({ name: 'x', url: 'https://plain.example.com/mcp', enabled: false })
    expect(node(body, 'status').textContent).toContain('已保存')
    expect(body.textContent).toContain('公共只读服务器可以留空 token')
    expect(node(body, 'counts').textContent).toContain('无 token')
    expect(node(body, 'tools-empty').textContent).toContain('公共只读服务器')
  })

  it('discovers tools for one server, shows the host, and saves the whitelist from checkboxes', async () => {
    const initial = server({ tools: [], whitelist: [] })
    const discovered = server({
      tools: [{ name: 'read_a' }, { name: 'read_b' }],
      whitelist: []
    })
    const afterWhitelist = server({
      tools: [{ name: 'read_a' }, { name: 'read_b' }],
      whitelist: ['read_a']
    })
    const discover = vi.fn(async () => ({ ok: true, id: 's1', tools: discovered.tools, config: view(discovered) }) as McpDiscoverResult)
    const save = vi.fn(async (_request: McpServerSaveRequest) => ok(view(afterWhitelist)))
    const { body, handlers } = mount(ok(view(initial)), { discover, save })
    await tick()
    node<HTMLButtonElement>(body, 'discover').click()
    await tick()
    expect(discover).toHaveBeenCalledWith({ id: 's1' })
    const tools = nodes<HTMLInputElement>(body, 'tool')
    expect(tools.map(input => input.dataset.toolName)).toEqual(['read_a', 'read_b'])
    expect(tools.every(input => !input.checked)).toBe(true)
    // 名字不像搜索/抓取：不做用途建议。
    expect(node<HTMLInputElement>(body, 'search-channel').checked).toBe(false)
    expect(node(body, 'status').textContent).toContain('mcp.example.com')
    tools[0]!.click()
    await tick()
    expect(save).toHaveBeenCalledWith({
      id: 's1',
      name: '示例服务器',
      url: 'https://mcp.example.com/mcp',
      enabled: false,
      searchChannel: false,
      whitelist: ['read_a']
    })
    const request = (handlers.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as McpServerSaveRequest
    expect(request.token).toBeUndefined()
    expect(node(body, 'counts').textContent).toContain('白名单 1')
    expect((nodes<HTMLInputElement>(body, 'tool')[0]!).checked).toBe(true)
  })

  it('saves the enabled switch immediately for servers with or without a token', async () => {
    const save = vi.fn(async (_request: McpServerSaveRequest) => ok(view(server({ enabled: true }))))
    const { body } = mount(ok(view(server({ enabled: false }))), { save })
    await tick()
    node<HTMLInputElement>(body, 'enabled').click()
    await tick()
    expect(save).toHaveBeenCalledWith({ id: 's1', name: '示例服务器', url: 'https://mcp.example.com/mcp', enabled: true, searchChannel: false })

    // 公共只读服务器没有 token 也能直接启用，且「连接并列出工具」不再被禁用。
    const noTokenResult = server({ hasToken: false, enabled: true })
    const noToken = mount(ok(view(server({ hasToken: false }))), { save: vi.fn(async () => ok(view(noTokenResult))) })
    await tick()
    node<HTMLInputElement>(noToken.body, 'enabled').click()
    await tick()
    expect(noToken.handlers.save).toHaveBeenCalledWith({ id: 's1', name: '示例服务器', url: 'https://mcp.example.com/mcp', enabled: true, searchChannel: false })
    expect(node<HTMLInputElement>(noToken.body, 'enabled').checked).toBe(true)
    expect(node(noToken.body, 'error').hidden).toBe(true)
    expect(node<HTMLButtonElement>(noToken.body, 'discover').disabled).toBe(false)
    expect(node(noToken.body, 'counts').textContent).toContain('无 token')
    expect(node(noToken.body, 'tools-empty').textContent).toContain('公共只读服务器')
  })

  it('discovers tools for a server without a token', async () => {
    const discovered = server({ hasToken: false, tools: [{ name: 'read_a' }] })
    const discover = vi.fn(async () => ({ ok: true, id: 's1', tools: discovered.tools, config: view(discovered) }) as McpDiscoverResult)
    const { body } = mount(ok(view(server({ hasToken: false }))), { discover })
    await tick()
    const button = node<HTMLButtonElement>(body, 'discover')
    expect(button.disabled).toBe(false)
    button.click()
    await tick()
    expect(discover).toHaveBeenCalledWith({ id: 's1' })
    expect(node(body, 'status').textContent).toContain('读取 1 个工具')
    expect(nodes<HTMLInputElement>(body, 'tool').map(input => input.dataset.toolName)).toEqual(['read_a'])
  })

  it('marks a server as a search/fetch channel from its row and saves the flag', async () => {
    const save = vi.fn(async (_request: McpServerSaveRequest) => ok(view(server({ searchChannel: false }))))
    const { body } = mount(ok(view(server({ searchChannel: true }))), { save })
    await tick()
    const checkbox = node<HTMLInputElement>(body, 'search-channel')
    expect(checkbox.checked).toBe(true)
    checkbox.click()
    await tick()
    expect(save).toHaveBeenCalledWith({
      id: 's1',
      name: '示例服务器',
      url: 'https://mcp.example.com/mcp',
      enabled: false,
      searchChannel: false
    })
    expect(node(body, 'status').textContent).toContain('联网搜索/抓取')
    expect(node<HTMLInputElement>(body, 'search-channel').checked).toBe(false)
  })

  it('suggests the flag after discovering search-like tools, without saving until a later save', async () => {
    const initial = server({ tools: [], whitelist: [], searchChannel: false })
    const discovered = server({
      tools: [{ name: 'web_search' }, { name: 'read_a' }],
      whitelist: [],
      searchChannel: false
    })
    const saved = server({ tools: discovered.tools, whitelist: ['read_a'], searchChannel: true })
    const save = vi.fn(async (_request: McpServerSaveRequest) => ok(view(saved)))
    const discover = vi.fn(async () => ({ ok: true, id: 's1', tools: discovered.tools, config: view(discovered) }) as McpDiscoverResult)
    const { body } = mount(ok(view(initial)), { discover, save })
    await tick()
    node<HTMLButtonElement>(body, 'discover').click()
    await tick()
    expect(discover).toHaveBeenCalledWith({ id: 's1' })
    // 工具名命中搜索/抓取：只在界面上预勾，发现本身不写配置。
    expect(node<HTMLInputElement>(body, 'search-channel').checked).toBe(true)
    expect(node(body, 'status').textContent).toContain('建议')
    expect(save).not.toHaveBeenCalled()
    // 下一次保存（这里点白名单）把界面上的用途值一起回传，这时才落盘。
    nodes<HTMLInputElement>(body, 'tool')[1]!.click()
    await tick()
    expect(save).toHaveBeenCalledWith({
      id: 's1',
      name: '示例服务器',
      url: 'https://mcp.example.com/mcp',
      enabled: false,
      searchChannel: true,
      whitelist: ['read_a']
    })
  })

  it('does not re-suggest over a manual choice about the flag', async () => {
    const initial = server({ searchChannel: true })
    const unset = server({ searchChannel: false })
    const discovered = server({ tools: [{ name: 'fetch_url' }], whitelist: [], searchChannel: false })
    const save = vi.fn(async (_request: McpServerSaveRequest) => ok(view(unset)))
    const discover = vi.fn(async () => ({ ok: true, id: 's1', tools: discovered.tools, config: view(discovered) }) as McpDiscoverResult)
    const { body } = mount(ok(view(initial)), { discover, save })
    await tick()
    // 人手动取消用途标记：立即保存。
    node<HTMLInputElement>(body, 'search-channel').click()
    await tick()
    expect(save).toHaveBeenCalledWith({
      id: 's1',
      name: '示例服务器',
      url: 'https://mcp.example.com/mcp',
      enabled: false,
      searchChannel: false
    })
    expect(node<HTMLInputElement>(body, 'search-channel').checked).toBe(false)
    // 手动改过之后，即使发现命中名字，也不再给建议覆盖人的选择。
    node<HTMLButtonElement>(body, 'discover').click()
    await tick()
    expect(discover).toHaveBeenCalledWith({ id: 's1' })
    expect(node<HTMLInputElement>(body, 'search-channel').checked).toBe(false)
    expect(node(body, 'status').textContent).toContain('读取 1 个工具')
    expect(node(body, 'status').textContent).not.toContain('建议')
  })

  it('deletes a server only after the second click', async () => {
    const remove = vi.fn(async () => ok(view()))
    const { body } = mount(ok(view(server())), { remove })
    await tick()
    const button = node<HTMLButtonElement>(body, 'remove')
    button.click()
    expect(remove).not.toHaveBeenCalled()
    expect(button.textContent).toBe('确认删除？')
    button.click()
    await tick()
    expect(remove).toHaveBeenCalledWith({ id: 's1' })
    expect(nodes(body, 'row')).toHaveLength(0)
    expect(body.textContent).toContain('还没有服务器。')
    expect(node(body, 'status').textContent).toContain('已删除')
  })

  it('shows human text for config and discovery errors, never raw codes', async () => {
    const { body } = mount(fail('MCP_CONFIG_UNAVAILABLE'))
    await tick()
    const error = node(body, 'error')
    expect(error.textContent).toContain('MCP 配置不可用')
    expect(error.textContent).not.toContain('MCP_CONFIG_UNAVAILABLE')

    const discover = vi.fn(async () => ({ ok: false, error: 'MCP_UNAUTHORIZED' }) as McpDiscoverResult)
    const second = mount(ok(view(server())), { discover })
    await tick()
    node<HTMLButtonElement>(second.body, 'discover').click()
    await tick()
    const discoveryError = node(second.body, 'error').textContent
    expect(discoveryError).toContain('token')
    expect(discoveryError).not.toContain('MCP_UNAUTHORIZED')
    // 未登记的码也只剩人话兜底。
    expect(mcpErrorText('MCP_SOMETHING_NEW')).not.toContain('MCP_SOMETHING_NEW')
    expect(mcpErrorText('MCP_SOMETHING_NEW')).toMatch(/[\u4e00-\u9fff]/u)
    // 不能从对象原型上捡到「说明」（constructor 之类）。
    expect(mcpErrorText('constructor')).not.toContain('function')
    expect(mcpErrorText('constructor')).toMatch(/[\u4e00-\u9fff]/u)
    // token 已可选：卡片不再说「启用前必须先保存 token」。
    expect(mcpErrorText('MCP_BAD_TOKEN')).toContain('公共只读服务器可以留空')
    expect(mcpErrorText('MCP_BAD_TOKEN')).not.toContain('启用服务器前')
    expect(mcpErrorText('MCP_BAD_TOKEN')).not.toContain('MCP_BAD_TOKEN')
  })

  it('shows the empty state while reading and after a load failure, and disposes without further writes', async () => {
    let resolve: (result: McpConfigResult) => void = () => {}
    const pending = new Promise<McpConfigResult>(done => { resolve = done })
    const body = document.createElement('section')
    document.body.append(body)
    const handlers: McpCardHandlers = {
      get: vi.fn(async () => pending),
      save: vi.fn(async () => ok(view())),
      remove: vi.fn(async () => ok(view())),
      discover: vi.fn(async () => ({ ok: true, id: 's1', tools: [], config: view() }) as McpDiscoverResult)
    }
    const dispose = mountMcpCard({ body, isCurrent: () => true }, handlers)
    expect(node(body, 'empty').textContent).toBe('读取中…')
    resolve(ok(view(server())))
    await tick()
    expect(node(body, 'empty').hidden).toBe(true)
    dispose()
    expect(nodes(body, 'row')).toHaveLength(1)
  })
})
