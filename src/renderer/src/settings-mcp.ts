import type {
  McpConfigResult,
  McpConfigView,
  McpDiscoverRequest,
  McpDiscoverResult,
  McpPublicServer,
  McpServerRemoveRequest,
  McpServerSaveRequest
} from '../../shared/ipc.ts'
import { hostErrorMessage } from './host-errors.ts'
import { confirmAction } from './settings-model.ts'

/**
 * 「联网」页里的「远端只读 MCP」卡片：服务器列表、添加表单、启用开关、
 * 「连接并列出工具」与白名单勾选。
 *
 * 只写设备配置：保存不发测试请求；**只有人点「连接并列出工具」才会外发一次**，
 * 点击前就在这一行写明目标主机。token 只进本机加密存储，保存后输入框清空、
 * 列表不显示 token 或密文，要更换 token 只能删除后重新添加。
 *
 * 只读由人工白名单保证（不信任服务器自报的只读标注）；白名单只能勾选已发现的工具。
 * 「用途：联网搜索/抓取」是每台服务器的设备级标记：勾选后受底栏搜索总闸管，不勾选则不受该闸；
 * 发现工具后若名字像搜索/抓取，只在界面上建议勾选，真正落盘仍要等人保存。
 * 围栏见 docs/decisions.md 的 2026-10-21 远端只读 MCP 合同
 * 与 2026-10-23 联网搜索与抓取整合。
 */
export type McpCardHandlers = {
  get: () => Promise<McpConfigResult>
  save: (request: McpServerSaveRequest) => Promise<McpConfigResult>
  remove: (request: McpServerRemoveRequest) => Promise<McpConfigResult>
  discover: (request: McpDiscoverRequest) => Promise<McpDiscoverResult>
}
export type McpCardHost = {
  body: HTMLElement
  isCurrent: () => boolean
}

/** 供 B6 窗口专项使用的选择器：`[data-mcp="…"]`，每一行另带 `data-mcp-id`。
 *  - 列表：`[data-mcp="list"]`、行 `[data-mcp="row"]`、名称／主机／计数 `name`／`host`／`counts`
 *  - 启用：`[data-mcp="enabled"]`；用途标记：`[data-mcp="search-channel"]`
 *  - 删除：`[data-mcp="remove"]`；连接：`[data-mcp="discover"]`
 *  - 添加表单：`[data-mcp="new-name"]`／`"new-url"`／`"new-token"`／`"save"`
 *  - 结果：工具容器 `[data-mcp="tools"]`、单个工具 `[data-mcp="tool"]`（带 `data-tool-name`）
 *  - 文案：`[data-mcp="status"]`、`[data-mcp="error"]`
 */
export const MCP_SELECTORS = {
  list: '[data-mcp="list"]',
  row: '[data-mcp="row"]',
  enabled: '[data-mcp="enabled"]',
  searchChannel: '[data-mcp="search-channel"]',
  discover: '[data-mcp="discover"]',
  remove: '[data-mcp="remove"]',
  tool: '[data-mcp="tool"]',
  save: '[data-mcp="save"]',
  gateHint: '[data-mcp="gate-hint"]'
} as const

const FALLBACK_ERROR = '操作未完成，请重试；仍然失败时请检查 MCP 配置。'
/** 发现工具后的用途建议只按名字判断；匹配也仅预勾，不替人保存。 */
const SEARCH_TOOL_NAME = /search|fetch|web|browse|crawl/i
/** 设置卡的通用码用「未保存」口径；MCP_* 的文案仍以 host-errors.ts 为准。 */
const SETTINGS_PHRASES: Record<string, string> = {
  BAD_REQUEST: '请求不合法，未保存。',
  BAD_SENDER: '请求来源不受信任，未保存。',
  IO_ERROR: '写入本机配置失败，原配置保持不变。'
}
/** MCP_BAD_TOKEN 现在只表示「填了 token 但非法」；host-errors 里「启用前必须先保存 token」的
 *  旧口径已不成立（公共只读服务器可以留空），卡片这里只解释 token 本身的形状。 */
const MCP_PHRASES: Record<string, string> = {
  MCP_BAD_TOKEN: 'token 须 1–4096 字且不含控制字符；公共只读服务器可以留空。'
}
/** 错误只翻译已登记码；未登记也不回显内部字符串。 */
export const mcpErrorText = (error: string): string =>
  (Object.hasOwn(MCP_PHRASES, error) ? MCP_PHRASES[error]!
    : Object.hasOwn(SETTINGS_PHRASES, error) ? SETTINGS_PHRASES[error]!
      : hostErrorMessage(error) ?? FALLBACK_ERROR)

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

export function mountMcpCard(host: McpCardHost, handlers: McpCardHandlers): () => void {
  const body = host.body
  let config: McpConfigView | null = null
  let busy = false
  let disposed = false
  let errorText = ''
  let notice = ''
  /** 只在界面层的用途建议：发现工具后名字像搜索/抓取，且人没手动改过，才预勾。 */
  const suggested = new Set<string>()
  /** 人在本卡里手动改过用途标记的服务器：不再用发现结果覆盖他的选择。 */
  const touched = new Set<string>()

  const heading = element('h3', 'settings-section-title')
  heading.textContent = '远端只读 MCP'
  const intro = element('p', 'settings-hint')
  intro.textContent = '连接远端 HTTPS 服务器，把已发现并勾选的只读工具提供给 AI 任务。'
  // 顶部先写清闸的边界：只有标为搜索/抓取的服务器受搜索闸管。
  const gateHint = element('p', 'settings-hint')
  gateHint.dataset.mcp = 'gate-hint'
  gateHint.textContent = '非搜索类 MCP 不受搜索闸管；勾选『用于联网搜索/抓取』的服务器才受闸。'
  const guarantee = element('p', 'settings-hint')
  guarantee.textContent = '只读由你勾选的工具保证。Rgent 只按名字与参数转发；token 可选，公共只读服务器可留空，有 token 时只存本机加密、不显示。'

  const list = element('div', 'settings-mcp-list')
  list.dataset.mcp = 'list'
  const empty = element('p', 'settings-hint')
  empty.dataset.mcp = 'empty'

  // ---- 添加服务器 ----
  const addForm = element('div', 'settings-mcp-add')
  const addTitle = element('h4', 'settings-mcp-add-title')
  addTitle.textContent = '添加服务器'
  const nameField = element('label', 'settings-field')
  const nameLabel = element('span')
  nameLabel.textContent = '名称'
  const nameInput = element('input')
  nameInput.type = 'text'
  nameInput.maxLength = 80
  nameInput.autocomplete = 'off'
  nameInput.dataset.mcp = 'new-name'
  nameField.append(nameLabel, nameInput)
  const urlField = element('label', 'settings-field')
  const urlLabel = element('span')
  urlLabel.textContent = '服务器地址（必须 https、443、不带用户名密码）'
  const urlInput = element('input')
  urlInput.type = 'url'
  urlInput.inputMode = 'url'
  urlInput.maxLength = 2048
  urlInput.autocomplete = 'off'
  urlInput.placeholder = 'https://example.com/mcp'
  urlInput.dataset.mcp = 'new-url'
  urlField.append(urlLabel, urlInput)
  const tokenField = element('label', 'settings-field')
  const tokenLabel = element('span')
  tokenLabel.textContent = 'token（公共只读服务器可留空；保存后清空，不再显示）'
  const tokenInput = element('input')
  tokenInput.type = 'password'
  tokenInput.autocomplete = 'new-password'
  tokenInput.maxLength = 4096
  tokenInput.dataset.mcp = 'new-token'
  tokenField.append(tokenLabel, tokenInput)
  const addHint = element('p', 'settings-hint')
  addHint.textContent = '保存不会发测试请求，添加后在列表里打开启用开关。公共只读服务器可以留空 token；要更换 token，删除后重新添加。'
  const addActions = element('div', 'settings-actions')
  const save = element('button', 'settings-action')
  save.type = 'button'
  save.textContent = '添加服务器'
  save.dataset.mcp = 'save'
  addActions.append(save)
  addForm.append(addTitle, nameField, urlField, tokenField, addHint, addActions)

  const noticeEl = element('p', 'settings-hint')
  noticeEl.dataset.mcp = 'status'
  noticeEl.setAttribute('role', 'status')
  noticeEl.hidden = true
  const errorEl = element('p', 'settings-mcp-error')
  errorEl.dataset.mcp = 'error'
  errorEl.setAttribute('role', 'alert')
  errorEl.hidden = true

  body.append(heading, intro, gateHint, guarantee, list, empty, addForm, noticeEl, errorEl)

  const paintMessages = (): void => {
    errorEl.textContent = errorText
    errorEl.hidden = !errorText
    noticeEl.textContent = notice
    noticeEl.hidden = !notice
  }

  const readWhitelist = (toolsBox: HTMLElement): string[] => {
    const names: string[] = []
    for (const input of toolsBox.querySelectorAll<HTMLInputElement>('[data-mcp="tool"]')) {
      if (input.checked && input.dataset.toolName) names.push(input.dataset.toolName)
    }
    return names
  }

  const operate = (run: () => Promise<void>): void => {
    if (busy || disposed) return
    busy = true
    errorText = ''
    notice = ''
    paint()
    void run().catch(() => {
      if (disposed || !host.isCurrent()) return
      errorText = FALLBACK_ERROR
    }).finally(() => {
      if (disposed) return
      busy = false
      if (host.isCurrent()) paint()
    })
  }

  const rowOf = (server: McpPublicServer): HTMLElement => {
    const row = element('article', 'settings-mcp-server')
    row.dataset.mcp = 'row'
    row.dataset.mcpId = server.id

    const head = element('div', 'settings-mcp-head')
    const name = element('span', 'settings-mcp-name')
    name.dataset.mcp = 'name'
    name.textContent = server.name
    const hostEl = element('span', 'settings-mcp-host')
    hostEl.dataset.mcp = 'host'
    hostEl.textContent = server.host
    head.append(name, hostEl)

    const counts = element('p', 'settings-mcp-counts')
    counts.dataset.mcp = 'counts'
    const state = server.enabled ? '已启用' : '未启用'
    counts.textContent = `工具 ${server.tools.length} · 白名单 ${server.whitelist.length} · ${state}${server.hasToken ? '' : ' · 无 token'}`

    const toggle = element('label', 'settings-network-toggle')
    const enabled = element('input')
    enabled.type = 'checkbox'
    enabled.dataset.mcp = 'enabled'
    enabled.checked = server.enabled
    enabled.disabled = busy
    toggle.append(enabled, document.createTextNode('启用（保存即生效；启用后任务才可能用到）'))

    // 用途标记：只决定这台服务器归不归底栏「联网搜索与抓取」总闸管，不是每场勾选。
    const searchToggle = element('label', 'settings-network-toggle')
    const searchChannel = element('input')
    searchChannel.type = 'checkbox'
    searchChannel.dataset.mcp = 'search-channel'
    searchChannel.checked = server.searchChannel || suggested.has(server.id)
    searchChannel.disabled = busy
    searchChannel.title = '勾选后这台服务器受底栏「联网搜索与抓取」总闸管；不勾选则只受启用与白名单约束。'
    searchToggle.append(searchChannel, document.createTextNode('用于联网搜索/抓取（受搜索闸管）'))

    const discoverHint = element('p', 'settings-hint')
    discoverHint.dataset.mcp = 'discover-hint'
    discoverHint.textContent = `「连接并列出工具」会向 ${server.host} 发送一次请求。返回内容只作展示。`

    const actions = element('div', 'settings-actions')
    const discover = element('button', 'settings-action')
    discover.type = 'button'
    discover.textContent = '连接并列出工具'
    discover.dataset.mcp = 'discover'
    // token 可选：公共只读服务器没有 token 也要能发现工具（连接时不发 authorization 头）。
    discover.disabled = busy
    discover.title = server.hasToken ? `将向 ${server.host} 发送一次请求` : `将向 ${server.host} 发送一次请求（这台没有 token，连接不带认证头）`
    const remove = element('button', 'settings-action')
    remove.type = 'button'
    remove.textContent = '删除'
    remove.dataset.mcp = 'remove'
    remove.disabled = busy
    actions.append(discover, remove)

    const toolsBox = element('div', 'settings-mcp-tools')
    toolsBox.dataset.mcp = 'tools'
    if (!server.tools.length) {
      const hint = element('p', 'settings-hint')
      hint.dataset.mcp = 'tools-empty'
      hint.textContent = server.hasToken
        ? '还没有读取过工具。点「连接并列出工具」读取。'
        : '还没有读取过工具。公共只读服务器可以不带 token，直接点「连接并列出工具」读取。'
      toolsBox.append(hint)
    } else {
      const toolsHint = element('p', 'settings-hint')
      toolsHint.textContent = '勾选的工具才允许本场调用；勾选后保存即生效。'
      toolsBox.append(toolsHint)
      for (const tool of server.tools) {
        const label = element('label', 'settings-mcp-tool')
        const checkbox = element('input')
        checkbox.type = 'checkbox'
        checkbox.dataset.mcp = 'tool'
        checkbox.dataset.toolName = tool.name
        checkbox.checked = server.whitelist.includes(tool.name)
        checkbox.disabled = busy
        const text = element('span', 'settings-mcp-tool-name')
        text.textContent = tool.title ? `${tool.name} · ${tool.title}` : tool.name
        label.append(checkbox, text)
        toolsBox.append(label)
      }
    }

    row.append(head, counts, toggle, searchToggle, discoverHint, actions, toolsBox)

    enabled.addEventListener('change', () => {
      if (busy) return
      const next = enabled.checked
      // 启用不要求 token：公共只读服务器（没有密文）也可以直接开启。
      operate(async () => {
        const result = await handlers.save({
          id: server.id,
          name: server.name,
          url: server.url,
          enabled: next,
          searchChannel: searchChannel.checked
        })
        if (disposed || !host.isCurrent()) return
        if (!result.ok) { errorText = mcpErrorText(result.error); return }
        config = result.config
        // 这次保存已把界面上的用途值一起落盘，建议不再需要。
        suggested.delete(server.id)
        notice = next ? `已启用「${server.name}」。` : `已停用「${server.name}」。`
      })
    })

    searchChannel.addEventListener('change', () => {
      if (busy) return
      const next = searchChannel.checked
      // 人一改就记住：本卡挂载期间不再用发现结果覆盖这个选择。
      touched.add(server.id)
      suggested.delete(server.id)
      operate(async () => {
        const result = await handlers.save({
          id: server.id,
          name: server.name,
          url: server.url,
          enabled: server.enabled,
          searchChannel: next
        })
        if (disposed || !host.isCurrent()) return
        if (!result.ok) { errorText = mcpErrorText(result.error); return }
        config = result.config
        notice = next
          ? `已把「${server.name}」标为联网搜索/抓取渠道，受底栏总闸管。`
          : `已取消「${server.name}」的联网搜索/抓取标记，不再受底栏总闸管。`
      })
    })

    discover.addEventListener('click', () => {
      if (busy) return
      operate(async () => {
        const result = await handlers.discover({ id: server.id })
        if (disposed || !host.isCurrent()) return
        if (!result.ok) { errorText = mcpErrorText(result.error); return }
        const matched = result.tools.some(tool => SEARCH_TOOL_NAME.test(tool.name))
        // 只在界面预勾：人手动改过用途、或本来就已勾选，就不再动它。
        const suggest = matched && !server.searchChannel && !touched.has(server.id)
        if (suggest) suggested.add(server.id)
        else suggested.delete(server.id)
        config = result.config
        notice = suggest
          ? `已从 ${server.host} 读取 ${result.tools.length} 个工具；工具名像搜索/抓取，已建议勾上用途标记，保存后生效。`
          : `已从 ${server.host} 读取 ${result.tools.length} 个工具。勾选白名单后保存才生效。`
      })
    })

    confirmAction(remove, '删除', () => {
      if (busy) return
      operate(async () => {
        const result = await handlers.remove({ id: server.id })
        if (disposed || !host.isCurrent()) return
        if (!result.ok) { errorText = mcpErrorText(result.error); return }
        config = result.config
        notice = `已删除「${server.name}」。`
      })
    }, '确认删除？')

    toolsBox.addEventListener('change', event => {
      if (busy) return
      const target = event.target
      if (!(target instanceof HTMLInputElement) || target.dataset.mcp !== 'tool') return
      const whitelist = readWhitelist(toolsBox)
      operate(async () => {
        const result = await handlers.save({
          id: server.id,
          name: server.name,
          url: server.url,
          enabled: server.enabled,
          searchChannel: searchChannel.checked,
          whitelist
        })
        if (disposed || !host.isCurrent()) return
        if (!result.ok) { errorText = mcpErrorText(result.error); return }
        config = result.config
        // 白名单保存已把界面上的用途值一并落盘（包括发现后的建议）。
        suggested.delete(server.id)
        notice = `白名单已保存（${whitelist.length} 个工具）。未勾选的工具不会提供给任务。`
      })
    })

    return row
  }

  function paint (): void {
    list.replaceChildren()
    for (const server of config?.servers ?? []) list.append(rowOf(server))
    if (config === null) {
      empty.hidden = false
      empty.textContent = errorText ? '暂时无法读取 MCP 配置；仍可尝试添加服务器。' : '读取中…'
    } else if (!config.servers.length) {
      empty.hidden = false
      empty.textContent = '还没有服务器。先在上面添加一台。'
    } else {
      empty.hidden = true
      empty.textContent = ''
    }
    nameInput.disabled = busy
    urlInput.disabled = busy
    tokenInput.disabled = busy
    save.disabled = busy
    paintMessages()
  }

  save.addEventListener('click', () => {
    if (busy) return
    const name = nameInput.value.trim()
    const url = urlInput.value.trim()
    const token = tokenInput.value
    if (!name) { errorText = '请填写服务器名称（1–80 字）。'; paintMessages(); return }
    if (!/^https:\/\//iu.test(url)) { errorText = '服务器地址必须以 https:// 开头，且不带用户名密码。'; paintMessages(); return }
    // token 留空＝公共只读服务器：请求里不带 token 字段，主进程按「没有密文」保存。
    const supplied = token.trim().length > 0
    operate(async () => {
      const result = await handlers.save({ name, url, enabled: false, ...(supplied ? { token } : {}) })
      if (disposed || !host.isCurrent()) return
      if (!result.ok) { errorText = mcpErrorText(result.error); return }
      config = result.config
      // 主进程只回摘要；输入框清空，token 不在界面上留下副本。
      nameInput.value = ''
      urlInput.value = ''
      tokenInput.value = ''
      notice = `已保存「${name}」；打开启用开关后任务才可能用到它。`
    })
  })

  paint()
  void handlers.get().then(result => {
    if (disposed || !host.isCurrent()) return
    if (!result.ok) { errorText = mcpErrorText(result.error); paint(); return }
    config = result.config
    paint()
  }).catch(() => {
    if (disposed || !host.isCurrent()) return
    errorText = '暂时无法读取 MCP 配置。'
    paint()
  })

  return () => { disposed = true }
}
