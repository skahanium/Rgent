import {
  createMcpTransport,
  type McpTransport,
  type McpTransportError,
  type McpTransportResult
} from './mcp-transport.ts'

/**
 * 远端只读 MCP 客户端（B2）：`initialize` → `notifications/initialized` → `tools/list`
 * → `tools/call`。会话失效（`MCP_PROTOCOL` 且已有 session）只重连一次并重试原请求一次。
 *
 * token 只进 `authorization` 头；空 token（公共只读服务器）不发这个头。本模块的运行期失败
 * 一律是标准 `Error`，`message` 恰为固定 `MCP_*` 码（宿主按 `error instanceof Error ? error.message`
 * 取码），不会夹带 token、服务器 error.message 或响应正文。
 */

export type McpTool = {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
}

export type McpCallResult = {
  text: string
  bytes: number
  isError: boolean
  truncated?: boolean
}

export type McpClient = {
  readonly serverHost: string
  connect(signal: AbortSignal): Promise<{ protocolVersion: string; tools: McpTool[] }>
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>
  close(): void
}

export type McpClientInput = {
  url: string
  /** 空字符串＝不带认证（公共只读服务器）；非空时发 `Bearer <token>`。 */
  token: string
  /** 生产不传，内部建 `createMcpTransport()`；测试用假 transport 记录每次请求。 */
  transport?: McpTransport
}

export const MCP_PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'rgent', version: '0.1.0' }
const MAX_TOOL_NAME = 128
/** 回给模型的工具文本上限；按 UTF-8 字节截断，不切开多字节字符。 */
const MAX_TEXT_BYTES = 64 * 1024
const INITIALIZE_PARAMS = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }

export type McpClientError = McpTransportError | 'MCP_TOOL_FAILED'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protocolVersionOf(message: unknown): string {
  if (!isRecord(message) || typeof message.protocolVersion !== 'string' || message.protocolVersion.length === 0) {
    throw new Error('MCP_PROTOCOL')
  }
  return message.protocolVersion
}

/** 名字 1–128、按首次出现去重、非法条目跳过；`inputSchema` 原样保留。 */
function toolsOf(message: unknown): McpTool[] {
  if (!isRecord(message) || !Array.isArray(message.tools)) throw new Error('MCP_PROTOCOL')
  const tools: McpTool[] = []
  const seen = new Set<string>()
  for (const entry of message.tools as unknown[]) {
    if (!isRecord(entry)) continue
    const name = entry.name
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME || seen.has(name)) continue
    seen.add(name)
    const tool: McpTool = { name }
    if (typeof entry.title === 'string') tool.title = entry.title
    if (typeof entry.description === 'string') tool.description = entry.description
    if ('inputSchema' in entry) tool.inputSchema = entry.inputSchema
    tools.push(tool)
  }
  return tools
}

/** 按字节上限截断；`bytes[end]` 是 continuation 就回退，保证不产生替换字符。 */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  const bytes = Buffer.from(text, 'utf8')
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

type RequestSpec = { body: string; expectId: number | null; version: string }

export function createMcpClient(input: McpClientInput): McpClient {
  const transport: McpTransport = input.transport ?? createMcpTransport()
  const token = input.token
  let host = ''
  try { host = new URL(input.url).hostname.replace(/^\[|\]$/g, '') } catch { host = '' }

  let protocolVersion = MCP_PROTOCOL_VERSION
  let sessionId: string | undefined
  let nextId = 1
  let reconnects = 0
  let recovering = false
  let closed = false

  function headersFor(version: string): Record<string, string> {
    // 公共只读服务器没有 token：不能发一个空的 `Bearer ` 头。
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
    headers['mcp-protocol-version'] = version
    if (sessionId) headers['mcp-session-id'] = sessionId
    return headers
  }

  async function postOnce(spec: RequestSpec, signal: AbortSignal): Promise<McpTransportResult> {
    if (closed || signal.aborted) throw new Error('MCP_CANCELLED')
    let response: McpTransportResult
    try {
      response = await transport.post(input.url, spec.body, { signal, headers: headersFor(spec.version), expectId: spec.expectId })
    } catch {
      // 传输实现正常只返回错误码；异常路径也统一收敛，绝不把第三方异常文本带出去。
      // 取消仍然优先：已 abort 时不能把这次失败报成连接错误。
      if (signal.aborted) throw new Error('MCP_CANCELLED')
      throw new Error('MCP_CONNECT_FAILED')
    }
    // 取消优先：即使 transport 同时给出了别的失败码，调用方已 abort 就报 MCP_CANCELLED。
    if (!response.ok && signal.aborted) throw new Error('MCP_CANCELLED')
    if (!closed && response.ok && response.sessionId) sessionId = response.sessionId
    return response
  }

  function requestSpec(method: string, params: Record<string, unknown>, version: string): RequestSpec {
    const id = nextId
    nextId += 1
    return { body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), expectId: id, version }
  }

  function notificationSpec(method: string, version: string): RequestSpec {
    return { body: JSON.stringify({ jsonrpc: '2.0', method }), expectId: null, version }
  }

  /** 自动重连 = 重跑一次完整 `connect`（initialize → initialized → tools/list）；失败不上抛。 */
  async function reconnect(signal: AbortSignal): Promise<boolean | 'MCP_CANCELLED'> {
    recovering = true
    try {
      await connect(signal)
      return true
    } catch (error) {
      // 取消不是「会话仍失效」：原样交给调用方，不折回最初的 MCP_PROTOCOL。
      return error instanceof Error && error.message === 'MCP_CANCELLED' ? 'MCP_CANCELLED' : false
    } finally {
      recovering = false
    }
  }

  /** 每次请求最多自动重连一次、重试一次；重试用尽后返回**原错误**，不再重连。 */
  async function post(build: () => RequestSpec, signal: AbortSignal): Promise<McpTransportResult> {
    const first = await postOnce(build(), signal)
    if (first.ok) return first
    if (first.error !== 'MCP_PROTOCOL' || !sessionId || reconnects > 0 || recovering) return first
    reconnects += 1
    const recovered = await reconnect(signal)
    if (recovered === 'MCP_CANCELLED') return { ok: false, error: 'MCP_CANCELLED' }
    if (!recovered) return first
    const retried = await postOnce(build(), signal)
    // 成功才用重试结果；普通失败按合同返回原错误，只有取消优先。
    return retried.ok ? retried : retried.error === 'MCP_CANCELLED' ? retried : first
  }

  async function connect(signal: AbortSignal): Promise<{ protocolVersion: string; tools: McpTool[] }> {
    if (closed) throw new Error('MCP_CANCELLED')
    // 显式建连从新会话开始：旧 session 头不带到 initialize 上。
    sessionId = undefined
    const initialized = await post(() => requestSpec('initialize', INITIALIZE_PARAMS, MCP_PROTOCOL_VERSION), signal)
    if (!initialized.ok) throw new Error(initialized.error)
    protocolVersion = protocolVersionOf(initialized.message)
    const notified = await post(() => notificationSpec('notifications/initialized', protocolVersion), signal)
    if (!notified.ok) throw new Error(notified.error)
    const listed = await post(() => requestSpec('tools/list', {}, protocolVersion), signal)
    if (!listed.ok) throw new Error(listed.error)
    return { protocolVersion, tools: toolsOf(listed.message) }
  }

  async function call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    if (closed) throw new Error('MCP_CANCELLED')
    const sent = await post(() => requestSpec('tools/call', { name: tool, arguments: args }, protocolVersion), signal)
    if (!sent.ok) throw new Error(sent.error)
    const message = sent.message
    if (!isRecord(message)) throw new Error('MCP_PROTOCOL')
    // JSON-RPC error 只向调用方暴露固定码，服务器 error.message/data 一律丢弃。
    if (message.error !== undefined && message.error !== null) throw new Error('MCP_TOOL_FAILED')
    const result = message.result
    if (!isRecord(result)) throw new Error('MCP_PROTOCOL')

    const parts: string[] = []
    if (Array.isArray(result.content)) {
      for (const item of result.content as unknown[]) {
        if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
      }
    }
    const joined = parts.join('\n\n')
    // `bytes` 是截断前的累计文本字节数；`text` 是截到 64 KiB 后的内容。
    const totalBytes = Buffer.byteLength(joined, 'utf8')
    const limited = truncateUtf8(joined, MAX_TEXT_BYTES)
    return {
      text: limited.text,
      bytes: totalBytes,
      isError: result.isError === true,
      ...(limited.truncated ? { truncated: true } : {})
    }
  }

  return {
    serverHost: host,
    connect,
    call,
    close(): void {
      closed = true
      sessionId = undefined
      protocolVersion = MCP_PROTOCOL_VERSION
    }
  }
}
