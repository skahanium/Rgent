import { isIP } from 'node:net'
import { egressUrl, publicAddress } from './egress.ts'
import {
  resolveImageAddresses,
  requestPinnedImage,
  type ImageAddress,
  type PinnedRequestInit
} from './remote-image-transport.ts'

/**
 * 远端只读 MCP 的传输层（B1）：复用 `remote-image` 的钉地址出口，只做
 * 「一次 HTTPS POST + 按块读一个 JSON-RPC 消息」，不做会话、重连或工具语义。
 *
 * 硬边界：仅 https、仅 443、仅公网；3xx 不跟随；Bearer 等头由调用方传；
 * 单次 ≤20s、单消息 ≤1 MiB；服务器错误文本不进错误码，失败以固定 `MCP_*` 结果码返回，
 * 内部抛出一律是标准 `Error`（message 恰为码），不会有字符串码逃逸。
 */

export type McpTransportError =
  | 'MCP_INVALID_URL'
  | 'MCP_CONNECT_FAILED'
  | 'MCP_UNAUTHORIZED'
  | 'MCP_PROTOCOL'
  | 'MCP_TIMEOUT'
  | 'MCP_TOO_LARGE'
  | 'MCP_CANCELLED'

export type McpTransportResult =
  | { ok: true; message: unknown; sessionId?: string; status: number }
  | { ok: false; error: McpTransportError }

export type McpPostOptions = {
  signal?: AbortSignal
  /** 调用方头（`authorization`、`mcp-protocol-version`、`mcp-session-id` …），同名覆盖默认头。 */
  headers?: Record<string, string>
  /** 内部 deadline；默认 20s。调用方 signal abort 优先映射 `MCP_CANCELLED`。 */
  timeoutMs?: number
  /** 单条消息／单次读取上限；默认 1 MiB。 */
  maxBytes?: number
  /** `null` 表示通知（无 id）：第一帧或 202／空响应体即返回；给值时只认 id 相等的响应。 */
  expectId?: string | number | null
}

export type McpTransport = {
  post(url: string, body: string, options?: McpPostOptions): Promise<McpTransportResult>
}

/** `remote-image` 传输的注入点；生产不传，测试用假 resolver／request，不碰真网络。 */
export type McpTransportDependencies = {
  resolve?: (hostname: string) => Promise<ImageAddress[]>
  request?: (
    url: URL,
    address: ImageAddress,
    signal: AbortSignal,
    headers?: Record<string, string>,
    init?: PinnedRequestInit
  ) => Promise<Response>
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_BYTES = 1024 * 1024
const ACCEPT = 'application/json, text/event-stream'

/** 内部哨兵：即使意外逃逸，message 也恰为对应错误码（正常路径都会折成 result）。 */
class McpAborted extends Error { constructor() { super('MCP_CANCELLED') } }
class McpTooLarge extends Error { constructor() { super('MCP_TOO_LARGE') } }
class McpProtocol extends Error { constructor() { super('MCP_PROTOCOL') } }

const fail = (error: McpTransportError): McpTransportResult => ({ ok: false, error })

/** 与 egress 的超时竞速同形：真正的取消仍靠 AbortSignal，这里只保证 promise 立刻落地。 */
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // 仍挂一个空 handler，避免调用方已放弃后产生 unhandled rejection。
    void promise.catch(() => {})
    return Promise.reject(new McpAborted())
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new McpAborted())
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error) => { signal.removeEventListener('abort', abort); reject(error) }
    )
  })
}

function isMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON-RPC 响应必须带 id；通知（无 id）不匹配任何请求 id。 */
function matchesId(message: unknown, expectId: string | number): boolean {
  return isMessage(message) && Object.prototype.hasOwnProperty.call(message, 'id') && message.id === expectId
}

function mediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
}

function cancelBody(response: Response): void {
  try { void response.body?.cancel().catch(() => {}) } catch { /* already locked */ }
}

async function nextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new McpAborted()
  try {
    return await untilAbort(reader.read(), signal)
  } catch (error) {
    // abort 时把底层流也收掉；cancel 可能等底层 source，故不阻塞返回值。
    try { void reader.cancel().catch(() => {}) } catch { /* already errored */ }
    throw error
  }
}

async function readWhole(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await nextChunk(reader, signal)
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { void reader.cancel().catch(() => {}) } catch { /* already errored */ }
        throw new McpTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch { /* cancel pending */ }
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

function parseMessage(bytes: Uint8Array): unknown {
  let message: unknown
  try { message = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new McpProtocol() }
  if (!isMessage(message)) throw new McpProtocol()
  return message
}

function result(message: unknown, status: number, sessionId: string | undefined): McpTransportResult {
  return { ok: true, message, ...(sessionId ? { sessionId } : {}), status }
}

async function readJson(
  response: Response,
  maxBytes: number,
  expectId: string | number | null | undefined,
  signal: AbortSignal,
  sessionId: string | undefined
): Promise<McpTransportResult> {
  const bytes = await readWhole(response.body!, maxBytes, signal)
  if (bytes.byteLength === 0) {
    if (expectId === null || expectId === undefined) return result(null, response.status, sessionId)
    throw new McpProtocol()
  }
  const message = parseMessage(bytes)
  if (expectId !== null && expectId !== undefined && !matchesId(message, expectId)) throw new McpProtocol()
  return result(message, response.status, sessionId)
}

/**
 * SSE：按行切 `data:`，空行把累积行拼成一帧；帧是 JSON-RPC 响应（id 匹配，或
 * `expectId === null` 时任意帧）就立刻 `reader.cancel()` 返回，后续块不再读、不等待流关闭。
 */
async function readEventStream(
  response: Response,
  maxBytes: number,
  expectId: string | number | null | undefined,
  signal: AbortSignal,
  sessionId: string | undefined
): Promise<McpTransportResult> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  let dataLines: string[] = []
  let finished = false
  let outcome: McpTransportResult | undefined
  const stop = (message: unknown): void => {
    finished = true
    outcome = result(message, response.status, sessionId)
    try { void reader.cancel().catch(() => {}) } catch { /* already errored */ }
  }
  const dispatch = (): void => {
    if (finished || dataLines.length === 0) return
    const payload = dataLines.join('\n')
    dataLines = []
    const message = parseMessage(new TextEncoder().encode(payload))
    if (expectId === null || expectId === undefined) { stop(message); return }
    if (matchesId(message, expectId)) stop(message)
  }
  const consumeLine = (line: string): void => {
    if (finished) return
    if (line === '') { dispatch(); return }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  const drain = (final: boolean): void => {
    for (;;) {
      if (finished) return
      const lf = buffer.indexOf('\n')
      const cr = buffer.indexOf('\r')
      if (lf < 0 && cr < 0) break
      let at: number
      let width: number
      if (cr >= 0 && (lf < 0 || cr < lf)) {
        // 块边界可能把 CRLF 切开；CR 在末尾且流未结束时先等下一个块。
        if (!final && cr === buffer.length - 1) break
        at = cr
        width = buffer[at + 1] === '\n' ? 2 : 1
      } else {
        at = lf
        width = 1
      }
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + width)
      consumeLine(line)
    }
    if (final && !finished) {
      if (buffer.length > 0) { const line = buffer; buffer = ''; consumeLine(line) }
      dispatch()
    }
  }
  const onAbort = (): void => { try { void reader.cancel().catch(() => {}) } catch { /* already errored */ } }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { done, value } = await nextChunk(reader, signal)
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new McpTooLarge()
      buffer += decoder.decode(value, { stream: true })
      drain(false)
      if (finished) return outcome!
    }
    buffer += decoder.decode()
    drain(true)
    if (finished) return outcome!
    if (expectId === null || expectId === undefined) return result(null, response.status, sessionId)
    throw new McpProtocol()
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!finished) { try { void reader.cancel().catch(() => {}) } catch { /* already errored */ } }
    try { reader.releaseLock() } catch { /* cancel pending */ }
  }
}

export function createMcpTransport(dependencies: McpTransportDependencies = {}): McpTransport {
  const resolve = dependencies.resolve ?? resolveImageAddresses
  const request = dependencies.request ?? requestPinnedImage
  return {
    async post(raw, body, options = {}) {
      const target = egressUrl(raw, [443])
      if (!target || target.protocol !== 'https:') return fail('MCP_INVALID_URL')
      if (options.signal?.aborted) return fail('MCP_CANCELLED')

      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
      const controller = new AbortController()
      let callerAborted = false
      let timedOut = false
      const onCallerAbort = (): void => { callerAborted = true; controller.abort() }
      options.signal?.addEventListener('abort', onCallerAbort, { once: true })
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(0, timeoutMs))
      // 调用方 signal 优先于内部 deadline；两者都没触发时才是真正的连接失败。
      const failure = (): McpTransportError =>
        callerAborted ? 'MCP_CANCELLED' : timedOut ? 'MCP_TIMEOUT' : 'MCP_CONNECT_FAILED'

      try {
        const host = target.hostname.replace(/^\[|\]$/g, '')
        const family = isIP(host)
        let answers: ImageAddress[]
        try {
          answers = family
            ? [{ address: host, family: family as 4 | 6 }]
            : await untilAbort(resolve(host), controller.signal)
        } catch {
          return fail(failure())
        }
        if (controller.signal.aborted) return fail(failure())
        // DNS 答案在连接前逐个核公网；任一私网／保留地址即整次拒绝。
        if (!answers.length || answers.some((answer) => !publicAddress(answer.address) || isIP(answer.address) !== answer.family)) {
          return fail('MCP_INVALID_URL')
        }

        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: ACCEPT,
          'accept-encoding': 'identity'
        }
        for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = value

        let response: Response
        try {
          response = await untilAbort(
            request(target, answers[0]!, controller.signal, headers, { method: 'POST', body }),
            controller.signal
          )
        } catch {
          return fail(failure())
        }
        if (controller.signal.aborted) { cancelBody(response); return fail(failure()) }

        const status = response.status
        const sessionId = response.headers.get('mcp-session-id') || undefined
        // 3xx 一律不跟随；MCP 端点不该把 POST 重定向到别处。
        if (status >= 300 && status < 400) { cancelBody(response); return fail('MCP_CONNECT_FAILED') }
        if (status === 401 || status === 403) { cancelBody(response); return fail('MCP_UNAUTHORIZED') }
        if (status === 429 || (status >= 500 && status <= 599)) { cancelBody(response); return fail('MCP_CONNECT_FAILED') }
        if (status < 200 || status >= 300) { cancelBody(response); return fail('MCP_PROTOCOL') }

        if (!response.body) {
          if (options.expectId === null || options.expectId === undefined) return result(null, status, sessionId)
          return fail('MCP_PROTOCOL')
        }
        const encoding = response.headers.get('content-encoding')
        if (encoding && encoding.trim().toLowerCase() !== 'identity') {
          cancelBody(response)
          return fail('MCP_PROTOCOL')
        }
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > maxBytes) {
          cancelBody(response)
          return fail('MCP_TOO_LARGE')
        }

        const type = mediaType(response)
        try {
          if (type === 'text/event-stream') {
            return await readEventStream(response, maxBytes, options.expectId, controller.signal, sessionId)
          }
          if (type === 'application/json') {
            return await readJson(response, maxBytes, options.expectId, controller.signal, sessionId)
          }
          // 未知类型只允许「空响应体 + 通知」这一种 202 形状；其余按协议错误。
          const bytes = await readWhole(response.body, maxBytes, controller.signal)
          if (bytes.byteLength === 0 && (options.expectId === null || options.expectId === undefined)) {
            return result(null, status, sessionId)
          }
          return fail('MCP_PROTOCOL')
        } catch (error) {
          if (error instanceof McpTooLarge) return fail('MCP_TOO_LARGE')
          if (error instanceof McpProtocol) return fail('MCP_PROTOCOL')
          if (error instanceof McpAborted || controller.signal.aborted) return fail(failure())
          return fail('MCP_CONNECT_FAILED')
        }
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onCallerAbort)
      }
    }
  }
}
