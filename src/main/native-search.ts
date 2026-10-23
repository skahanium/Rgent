import type { ModelMessage, ToolResultPart } from 'ai'
import type { NativeSearchProbeResult } from '../shared/ipc.ts'
import type { ModelStepEvent, ModelStepInput } from './model-stream.ts'

/**
 * 模型自带联网（MiniMax Responses）：服务端执行 `web_search`，Rgent 只在模型请求里
 * 追加工具声明，不经过本机出口。这里只做协议适配，不发笔记正文、不写账本、不碰配置。
 *
 * 合同见 docs/decisions.md 的 2026-10-23 联网搜索与抓取整合第 5 条：
 * 启用前探测、按模型允许列表开放、失败不留给任务。
 *
 * 适配器把 AI SDK 的 `ModelMessage[]` 转成 Responses `input`：
 * - system → `instructions`
 * - user／assistant 文本 → `{ role, content }`
 * - assistant tool-call → `function_call`
 * - tool role → `function_call_output`
 * 请求里额外追加 `{ type: 'web_search' }`；函数工具仍是客户端工具。
 */

const RESPONSE_BYTES = 1048576
const ARGUMENT_BYTES = 65536
const CALLS_PER_STEP = 64
const MAX_TOOL_CALL_ID = 256
const MAX_TOOL_NAME = 128
const STREAM_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 20_000

/** 只有 MiniMax 的 M3／M3.1 系列声明支持模型自带联网；其它模型一律 false。 */
export function supportsNativeSearch(provider: string, modelId: string): boolean {
  return provider === 'minimax' && /^MiniMax-M3(?:\b|\.)/iu.test(modelId)
}

/** 适配器只额外暴露一个旁路计数：web_search_call 不是模型工具调用，留给后续账本。 */
export type NativeSearchStepInput = ModelStepInput & {
  /** 服务端每发起一次 web_search_call 回调一次（从 1 开始），不产出模型工具事件。 */
  onWebSearchCall?: (count: number) => void
}

const requestFailure = (cause?: Record<string, unknown>): Error =>
  Error('MODEL_REQUEST_FAILED', cause ? { cause } : undefined)
const protocolFailure = (): Error => Error('MODEL_PROTOCOL_ERROR')
const KNOWN_ERRORS = new Set(['MODEL_REQUEST_FAILED', 'MODEL_PROTOCOL_ERROR', 'MODEL_OUTPUT_LIMIT', 'TOOL_CALL_LIMIT', 'TOOL_ARGUMENT_LIMIT', 'TASK_CANCELLED'])

function failMessage(error: unknown): string {
  return error instanceof Error ? error.message : ''
}
function isKnownFailure(error: unknown): boolean {
  return KNOWN_ERRORS.has(failMessage(error))
}

function responseURL(baseURL: string): string {
  let url: URL
  try { url = new URL(baseURL) } catch { throw requestFailure() }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || !url.hostname ||
      url.username || url.password || url.search || url.hash) throw requestFailure()
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/responses`
  return url.href
}

type AbortScope = {
  signal: AbortSignal
  timedOut: () => boolean
  dispose: () => void
}
/** 把调用方 signal 与本地超时合成一个；超时与取消都不把上游原文带进错误。 */
function abortScope(caller: AbortSignal | undefined, timeoutMs: number): AbortScope {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  ;(timer as { unref?: () => void }).unref?.()
  const forward = (): void => controller.abort()
  if (caller) {
    if (caller.aborted) controller.abort()
    else caller.addEventListener('abort', forward, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      caller?.removeEventListener('abort', forward)
    }
  }
}

/** 调用方取消按取消语义；本地超时与网络错误按请求失败。 */
function abortFailure(caller: AbortSignal | undefined, scope: AbortScope): Error {
  if (caller?.aborted) return Error('TASK_CANCELLED')
  return requestFailure(scope.timedOut() ? { timeout: true } : undefined)
}

function systemText(message: ModelMessage): string {
  if (typeof message.content !== 'string') throw protocolFailure()
  return message.content
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw protocolFailure()
  let text = ''
  for (const part of content) {
    if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'text') throw protocolFailure()
    const value = (part as { text?: unknown }).text
    if (typeof value !== 'string') throw protocolFailure()
    text += value
  }
  return text
}

function jsonArguments(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? '{}' : text
  } catch { throw protocolFailure() }
}

function toolCallID(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_TOOL_CALL_ID) throw protocolFailure()
  return value
}
function toolName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_TOOL_NAME) throw protocolFailure()
  return value
}

function toolOutputText(output: ToolResultPart['output']): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value)
    case 'execution-denied':
      return output.reason ? `execution denied: ${output.reason}` : 'execution denied'
    case 'content':
      return output.value.map(part => part.type === 'text' ? part.text : '').join('')
    default:
      throw protocolFailure()
  }
}

type ResponsesItem = Record<string, unknown>
function functionCallItem(part: Record<string, unknown>): ResponsesItem {
  return {
    type: 'function_call',
    call_id: toolCallID(part.toolCallId),
    name: toolName(part.toolName),
    arguments: jsonArguments(part.input)
  }
}
function functionOutputItem(part: Record<string, unknown>): ResponsesItem {
  const output = part.output
  if (!output || typeof output !== 'object') throw protocolFailure()
  return {
    type: 'function_call_output',
    call_id: toolCallID(part.toolCallId),
    output: toolOutputText(output as ToolResultPart['output'])
  }
}

function assistantItems(content: unknown): ResponsesItem[] {
  if (typeof content === 'string') return content ? [{ role: 'assistant', content }] : []
  if (!Array.isArray(content)) throw protocolFailure()
  let text = ''
  const items: ResponsesItem[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') throw protocolFailure()
    const record = part as Record<string, unknown>
    switch (record.type) {
      case 'text':
        if (typeof record.text !== 'string') throw protocolFailure()
        text += record.text
        break
      case 'tool-call':
        items.push(functionCallItem(record))
        break
      case 'tool-result':
        items.push(functionOutputItem(record))
        break
      case 'reasoning':
        // 推理不回放：合同只要求正文与工具调用进入下一轮。
        break
      default:
        throw protocolFailure()
    }
  }
  return text ? [{ role: 'assistant', content: text }, ...items] : items
}

function toolItems(content: unknown): ResponsesItem[] {
  if (!Array.isArray(content)) throw protocolFailure()
  const items: ResponsesItem[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'tool-result') throw protocolFailure()
    items.push(functionOutputItem(part as Record<string, unknown>))
  }
  return items
}

type Conversion = { instructions: string; input: ResponsesItem[] }
function convertMessages(input: ModelStepInput): Conversion {
  const instructions: string[] = []
  if (typeof input.system === 'string' && input.system) instructions.push(input.system)
  const items: ResponsesItem[] = []
  for (const message of input.messages) {
    if (!message || typeof message !== 'object') throw protocolFailure()
    switch (message.role) {
      case 'system':
        instructions.push(systemText(message))
        break
      case 'user':
        items.push({ role: 'user', content: userText(message.content) })
        break
      case 'assistant':
        items.push(...assistantItems(message.content))
        break
      case 'tool':
        items.push(...toolItems(message.content))
        break
      default:
        throw protocolFailure()
    }
  }
  return { instructions: instructions.filter(Boolean).join('\n\n'), input: items }
}

function requestTools(tools: ModelStepInput['tools']): Record<string, unknown>[] {
  const list: Record<string, unknown>[] = []
  for (const [name, schema] of Object.entries(tools ?? {})) {
    if (typeof name !== 'string' || !name || name.length > MAX_TOOL_NAME || !schema || typeof schema.description !== 'string') throw protocolFailure()
    try { JSON.stringify(schema.inputSchema) } catch { throw protocolFailure() }
    list.push({ type: 'function', name, description: schema.description, parameters: schema.inputSchema })
  }
  // 服务端搜索是每次模型请求都追加的一项，不是客户端工具。
  list.push({ type: 'web_search' })
  return list
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
function finishUsage(value: unknown): { inputTokens: number | null; outputTokens: number | null } {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    inputTokens: tokenCount(usage.input_tokens ?? usage.inputTokens),
    outputTokens: tokenCount(usage.output_tokens ?? usage.outputTokens)
  }
}

type PendingCall = { id: string; name: string; arguments: string; emitted: boolean }
type ParsedArguments = { value: unknown; invalid: boolean }
function parseArguments(text: string): ParsedArguments {
  if (!text.trim()) return { value: {}, invalid: false }
  try { return { value: JSON.parse(text), invalid: false } }
  catch { return { value: {}, invalid: true } }
}

function eventType(value: unknown): string {
  return value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
    ? (value as { type: string }).type
    : ''
}

/**
 * 读取一个 Responses 请求：SSE 事件按顺序产出模型步事件。
 * `completed` 才产出 finish；`failed`／HTTP 非 2xx 一律失败关闭，消息里没有 key 或上游正文。
 */
export async function* streamNativeSearchStep(input: NativeSearchStepInput, signal: AbortSignal = input.signal): AsyncGenerator<ModelStepEvent> {
  const url = responseURL(input.baseURL)
  const { instructions, input: items } = convertMessages(input)
  const body: Record<string, unknown> = {
    model: input.modelId,
    input: items,
    tools: requestTools(input.tools),
    stream: true,
    ...(instructions ? { instructions } : {}),
    ...(input.maxOutputTokens ? { max_output_tokens: input.maxOutputTokens } : {})
  }
  const scope = abortScope(signal, STREAM_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream'
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: scope.signal
    })
  } catch (error) {
    scope.dispose()
    if (isKnownFailure(error)) throw error
    throw abortFailure(signal, scope)
  }
  if (!response.ok) {
    scope.dispose()
    void response.body?.cancel().catch(() => {})
    throw requestFailure({ httpStatus: response.status })
  }
  if (!response.body) {
    scope.dispose()
    throw protocolFailure()
  }

  const calls = new Map<string, PendingCall>()
  /** 同一次调用可能先按 output_index、后按 item id／call_id 出现：别名认回同一条，避免重复交回。 */
  const aliases = new Map<string, PendingCall>()
  let createdCalls = 0
  let emittedCalls = 0
  let webSearchCalls = 0
  const webSearchSeen = new Set<string>()
  let completed = false
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ''
  let dataLines: string[] = []

  const ensureCall = (key: string, hints?: { id?: unknown; itemId?: unknown; name?: unknown }): PendingCall => {
    let call = calls.get(key) ?? aliases.get(key)
    // 同一次调用可能先按 output_index、后按 item id／call_id 出现；按 id 认回同一条，避免重复交回。
    if (!call && typeof hints?.id === 'string' && hints.id) call = aliases.get(`id:${hints.id}`)
    if (!call && typeof hints?.itemId === 'string' && hints.itemId) call = aliases.get(`item:${hints.itemId}`)
    if (!call) {
      if (++createdCalls > CALLS_PER_STEP) throw Error('TOOL_CALL_LIMIT')
      call = { id: '', name: '', arguments: '', emitted: false }
      calls.set(key, call)
    }
    if (typeof hints?.id === 'string' && hints.id) {
      call.id = hints.id
      aliases.set(`id:${hints.id}`, call)
    }
    if (typeof hints?.itemId === 'string' && hints.itemId) aliases.set(`item:${hints.itemId}`, call)
    if (typeof hints?.name === 'string' && hints.name) call.name = hints.name
    return call
  }
  const argumentBytes = (): number => {
    let total = 0
    for (const call of calls.values()) total += Buffer.byteLength(call.arguments, 'utf8')
    return total
  }
  const checkArguments = (): void => {
    if (argumentBytes() > ARGUMENT_BYTES) throw Error('TOOL_ARGUMENT_LIMIT')
  }
  const updateArguments = (call: PendingCall, value: unknown, append: boolean): void => {
    if (typeof value === 'string') call.arguments = append ? call.arguments + value : value
    else if (!append && value && typeof value === 'object') call.arguments = jsonArguments(value)
    checkArguments()
  }
  const emitCall = (call: PendingCall): ModelStepEvent[] => {
    if (call.emitted) return []
    // 还没拿到 name／call_id 时不猜：等 output_item 或 completed 里的完整项。
    if (!call.name || !call.id) return []
    call.emitted = true
    emittedCalls += 1
    const parsed = parseArguments(call.arguments)
    return [{ type: 'tool-call', id: call.id, name: call.name, input: parsed.value, ...(parsed.invalid ? { invalid: true } : {}) }]
  }
  const keyOf = (payload: Record<string, unknown>, item?: Record<string, unknown>): string => {
    if (Number.isSafeInteger(payload.output_index)) return `idx:${String(payload.output_index)}`
    const identifier = item?.id ?? payload.item_id ?? payload.call_id
    if (typeof identifier === 'string' && identifier) return `id:${identifier}`
    throw protocolFailure()
  }
  const handle = (value: unknown): ModelStepEvent[] => {
    if (!value || typeof value !== 'object') throw protocolFailure()
    const payload = value as Record<string, unknown>
    switch (eventType(payload)) {
      case 'response.output_text.delta':
        return typeof payload.delta === 'string' && payload.delta ? [{ type: 'text', text: payload.delta }] : []
      case 'response.reasoning_text.delta':
        return typeof payload.delta === 'string' && payload.delta ? [{ type: 'reasoning', text: payload.delta }] : []
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const item = payload.item
        if (!item || typeof item !== 'object') return []
        const record = item as Record<string, unknown>
        if (record.type === 'function_call') {
          const call = ensureCall(keyOf(payload, record), { id: record.call_id ?? record.id, itemId: record.id, name: record.name })
          if ('arguments' in record) updateArguments(call, record.arguments, false)
          return eventType(payload) === 'response.output_item.done' ? emitCall(call) : []
        }
        if (record.type === 'web_search_call') {
          // 服务端搜索不是客户端工具调用：只计数，不交给工具环。
          const identifier = typeof record.id === 'string' && record.id
            ? `id:${record.id}`
            : Number.isSafeInteger(payload.output_index) ? `idx:${String(payload.output_index)}` : ''
          // 有稳定标识时 added／done 只记一次；没有标识时退回旧行为，只在 added 计一次。
          if (identifier ? !webSearchSeen.has(identifier) : eventType(payload) === 'response.output_item.added') {
            if (identifier) webSearchSeen.add(identifier)
            webSearchCalls += 1
            input.onWebSearchCall?.(webSearchCalls)
          }
        }
        return []
      }
      case 'response.function_call_arguments.delta': {
        const call = ensureCall(keyOf(payload), { id: payload.call_id, itemId: payload.item_id, name: payload.name })
        updateArguments(call, payload.delta, true)
        return []
      }
      case 'response.function_call_arguments.done': {
        const call = ensureCall(keyOf(payload), { id: payload.call_id, itemId: payload.item_id, name: payload.name })
        updateArguments(call, payload.arguments, false)
        return emitCall(call)
      }
      case 'response.completed': {
        if (completed) throw protocolFailure()
        const result = payload.response
        const responseRecord = result && typeof result === 'object' ? result as Record<string, unknown> : {}
        if (responseRecord.status === 'failed') throw requestFailure()
        const output = Array.isArray(responseRecord.output) ? responseRecord.output : []
        for (const item of output) {
          if (!item || typeof item !== 'object') continue
          const record = item as Record<string, unknown>
          if (record.type !== 'function_call') continue
          const call = ensureCall(keyOf({ output_index: record.output_index }, record), { id: record.call_id ?? record.id, itemId: record.id, name: record.name })
          if ('arguments' in record) updateArguments(call, record.arguments, false)
        }
        const events: ModelStepEvent[] = []
        for (const call of calls.values()) {
          const emitted = emitCall(call)
          if (!emitted.length && !call.emitted) throw protocolFailure()
          events.push(...emitted)
        }
        completed = true
        const incomplete = responseRecord.incomplete_details && typeof responseRecord.incomplete_details === 'object'
          ? responseRecord.incomplete_details as Record<string, unknown>
          : {}
        const reason = emittedCalls > 0
          ? 'tool-calls'
          : incomplete.reason === 'max_output_tokens'
            ? 'length'
            : incomplete.reason === 'content_filter'
              ? 'content-filter'
              : 'stop'
        events.push({ type: 'finish', reason, usage: finishUsage(responseRecord.usage) })
        return events
      }
      case 'response.failed':
        throw requestFailure()
      default:
        return []
    }
  }

  const processLine = (line: string, events: ModelStepEvent[]): boolean => {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line) {
      if (!dataLines.length) return false
      const data = dataLines.join('\n')
      dataLines = []
      if (data === '[DONE]') return true
      // completed 之后不再接受新事件：finish 必须是最后一条，迟到的内容不追加到回答里。
      if (completed) return false
      let parsed: unknown
      try { parsed = JSON.parse(data) } catch { throw protocolFailure() }
      events.push(...handle(parsed))
      return false
    }
    if (line.startsWith(':')) return false
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /u, ''))
    return false
  }

  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw Error('MODEL_OUTPUT_LIMIT')
      }
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const events: ModelStepEvent[] = []
        processLine(line, events)
        for (const event of events) yield event
        index = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer) {
      const events: ModelStepEvent[] = []
      processLine(buffer, events)
      for (const event of events) yield event
    }
    const events: ModelStepEvent[] = []
    processLine('', events)
    for (const event of events) yield event
    if (!completed) throw protocolFailure()
  } catch (error) {
    if (isKnownFailure(error)) throw error
    throw abortFailure(signal, scope)
  } finally {
    scope.dispose()
    try { reader.releaseLock() } catch { /* already released by cancel */ }
  }
}

/**
 * 最小探测：只发 `ping` 与 `web_search` 工具，不带用户数据、不写配置。
 * 2xx 且 JSON 可解析即通过；其它情况只回码，不把上游原文或密钥带出去。
 */
export async function probeNativeSearch(input: {
  baseURL: string
  apiKey: string
  modelId: string
  signal?: AbortSignal
}): Promise<NativeSearchProbeResult> {
  const unavailable: NativeSearchProbeResult = { ok: false, error: 'NATIVE_SEARCH_UNAVAILABLE' }
  const scope = abortScope(input.signal, PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(responseURL(input.baseURL), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        model: input.modelId,
        input: 'ping',
        tools: [{ type: 'web_search' }],
        stream: false
      }),
      redirect: 'error',
      signal: scope.signal
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      return unavailable
    }
    if (!response.body) {
      // 204 这类空响应：JSON 不可解析，按不可用处理。
      return unavailable
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    let text = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > RESPONSE_BYTES) {
          await reader.cancel().catch(() => {})
          return unavailable
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } finally {
      try { reader.releaseLock() } catch { /* cancelled */ }
    }
    JSON.parse(text)
    return { ok: true }
  } catch {
    return unavailable
  } finally {
    scope.dispose()
  }
}
