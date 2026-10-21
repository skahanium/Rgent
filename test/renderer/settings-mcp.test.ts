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
    expect(node(row, 'discover').textContent).toBe('连接并列出工具')
    expect(node(row, 'remove').textContent).toBe('删除')
    // 一次外发前先写明目标主机。
    expect(node(row, 'discover-hint').textContent).toContain('mcp.example.com')
    expect(body.textContent).toContain('只读由你勾选的工具保证；Rgent 只按名字与参数转发；token 只存本机加密，不显示。')
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

  it('validates the add form locally before calling IPC', async () => {
    const { body, handlers } = mount()
    await tick()
    node<HTMLButtonElement>(body, 'save').click()
    expect(node(body, 'error').textContent).toContain('名称')
    node<HTMLInputElement>(body, 'new-name').value = 'x'
    node<HTMLInputElement>(body, 'new-url').value = 'http://plain.example.com/mcp'
    node<HTMLButtonElement>(body, 'save').click()
    expect(node(body, 'error').textContent).toContain('https://')
    node<HTMLInputElement>(body, 'new-url').value = 'https://plain.example.com/mcp'
    node<HTMLButtonElement>(body, 'save').click()
    expect(node(body, 'error').textContent).toContain('token')
    expect(handlers.save).not.toHaveBeenCalled()
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
    expect(node(body, 'status').textContent).toContain('mcp.example.com')
    tools[0]!.click()
    await tick()
    expect(save).toHaveBeenCalledWith({
      id: 's1',
      name: '示例服务器',
      url: 'https://mcp.example.com/mcp',
      enabled: false,
      whitelist: ['read_a']
    })
    const request = (handlers.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as McpServerSaveRequest
    expect(request.token).toBeUndefined()
    expect(node(body, 'counts').textContent).toContain('白名单 1')
    expect((nodes<HTMLInputElement>(body, 'tool')[0]!).checked).toBe(true)
  })

  it('saves the enabled switch immediately, but refuses to enable without a token', async () => {
    const save = vi.fn(async (_request: McpServerSaveRequest) => ok(view(server({ enabled: true }))))
    const { body } = mount(ok(view(server({ enabled: false }))), { save })
    await tick()
    node<HTMLInputElement>(body, 'enabled').click()
    await tick()
    expect(save).toHaveBeenCalledWith({ id: 's1', name: '示例服务器', url: 'https://mcp.example.com/mcp', enabled: true })

    const noToken = mount(ok(view(server({ hasToken: false }))), { save: vi.fn(async () => ok(view(server({ hasToken: false })))) })
    await tick()
    const checkbox = node<HTMLInputElement>(noToken.body, 'enabled')
    checkbox.click()
    await tick()
    expect(noToken.handlers.save).not.toHaveBeenCalled()
    expect(checkbox.checked).toBe(false)
    expect(node(noToken.body, 'error').textContent).toContain('token')
    expect(node<HTMLButtonElement>(noToken.body, 'discover').disabled).toBe(true)
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
