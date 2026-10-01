import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText, tool, jsonSchema, isStepCount, type ModelMessage, type ToolSet } from 'ai'

export type ToolSchema = { description: string; inputSchema: Parameters<typeof jsonSchema>[0] }
export type ModelStepEvent =
  | { type: 'text'; text: string }
  /** 模型自述的思考。它只进账本，不进正文。 */
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown; invalid?: boolean }
  | { type: 'finish'; reason: string }
export type ModelStreamInput = {
  baseURL: string
  modelId: string
  apiKey: string
  system?: string
  prompt: string
  signal: AbortSignal
  maxOutputTokens?: number
}
export type ModelStepInput = Omit<ModelStreamInput, 'prompt'> & {
  messages: ModelMessage[]
  tools?: Record<string, ToolSchema>
}
export const MODEL_STREAM_BOUNDS = { argumentBytes: 65536, callsPerStep: 64, responseBytes: 1048576 } as const

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

/** 末尾有多长的一段可能是标签前缀，需要留到下一片再判断。 */
function heldTail(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1)
  for (let size = max; size > 0; size -= 1) if (text.endsWith(tag.slice(0, size))) return size
  return 0
}

/**
 * 有的供应商把思维链内联在 `content` 里，用 `<think>…</think>` 包住。
 * 这里按标签切开：标签外的算正文，标签内的算推理；跨分片的半个标签留在缓冲里等下一片。
 */
export function createThinkSplitter(): {
  feed(chunk: string): { type: 'text' | 'reasoning'; text: string }[]
  flush(): { type: 'text' | 'reasoning'; text: string }[]
} {
  let mode: 'text' | 'reasoning' = 'text'
  let buffer = ''
  return {
    feed(chunk) {
      buffer += chunk
      const out: { type: 'text' | 'reasoning'; text: string }[] = []
      for (;;) {
        const tag = mode === 'text' ? THINK_OPEN : THINK_CLOSE
        const at = buffer.indexOf(tag)
        if (at < 0) {
          const hold = heldTail(buffer, tag)
          const safe = buffer.length - hold
          if (safe > 0) out.push({ type: mode, text: buffer.slice(0, safe) })
          buffer = buffer.slice(safe)
          return out
        }
        if (at > 0) out.push({ type: mode, text: buffer.slice(0, at) })
        buffer = buffer.slice(at + tag.length)
        mode = mode === 'text' ? 'reasoning' : 'text'
      }
    },
    flush() {
      const out: { type: 'text' | 'reasoning'; text: string }[] = buffer ? [{ type: mode, text: buffer }] : []
      buffer = ''
      return out
    }
  }
}

/** One provider step. Tool definitions deliberately have no execute callback. */
export async function* streamModelStep(input: ModelStepInput): AsyncGenerator<ModelStepEvent> {
  const provider = createOpenAICompatible({
    name: 'rgent', baseURL: input.baseURL, apiKey: input.apiKey,
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' })
  })
  const tools: ToolSet = Object.fromEntries(Object.entries(input.tools ?? {}).map(([name, schema]) =>
    [name, tool({ description: schema.description, inputSchema: jsonSchema(schema.inputSchema) })]))
  const result = streamText({
    model: provider.chatModel(input.modelId), messages: input.messages,
    ...(input.system ? { system: input.system } : {}),
    ...(Object.keys(tools).length ? { tools } : {}),
    stopWhen: isStepCount(1), abortSignal: input.signal, maxRetries: 0, onError: () => {},
    ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {})
  })
  let bytes = 0
  let argumentBytes = 0
  let calls = 0
  let finished = false
  const invalidIds = new Set<string>()
  const think = createThinkSplitter()
  for await (const part of result.fullStream) {
    if (part.type === 'reasoning-delta') {
      bytes += Buffer.byteLength(part.text, 'utf8')
      if (bytes > MODEL_STREAM_BOUNDS.responseBytes) throw Error('MODEL_OUTPUT_LIMIT')
      if (part.text) yield { type: 'reasoning', text: part.text }
    } else if (part.type === 'text-delta') {
      bytes += Buffer.byteLength(part.text, 'utf8')
      if (bytes > MODEL_STREAM_BOUNDS.responseBytes) throw Error('MODEL_OUTPUT_LIMIT')
      for (const piece of think.feed(part.text)) if (piece.text) yield { type: piece.type, text: piece.text }
    } else if (part.type === 'tool-input-start') {
      if (++calls > MODEL_STREAM_BOUNDS.callsPerStep) throw Error('TOOL_CALL_LIMIT')
      if (part.providerExecuted) throw Error('MODEL_PROTOCOL_ERROR')
    } else if (part.type === 'tool-input-delta') {
      const size = Buffer.byteLength(part.delta, 'utf8')
      argumentBytes += size
      bytes += size
      if (bytes > MODEL_STREAM_BOUNDS.responseBytes) throw Error('MODEL_OUTPUT_LIMIT')
      if (argumentBytes > MODEL_STREAM_BOUNDS.argumentBytes) throw Error('TOOL_ARGUMENT_LIMIT')
    } else if (part.type === 'tool-call') {
      if (part.providerExecuted || !part.toolCallId || part.toolCallId.length > 256 || part.toolName.length > 128) throw Error('MODEL_PROTOCOL_ERROR')
      if ('invalid' in part && part.invalid) invalidIds.add(part.toolCallId)
      yield { type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input, ...('invalid' in part && part.invalid ? { invalid: true } : {}) }
    } else if (part.type === 'finish') {
      if (finished || !['stop', 'length', 'content-filter', 'tool-calls'].includes(part.finishReason) || part.finishReason === 'tool-calls' && !calls) throw Error('MODEL_PROTOCOL_ERROR')
      finished = true
      for (const piece of think.flush()) if (piece.text) yield { type: piece.type, text: piece.text }
      yield { type: 'finish', reason: part.finishReason }
    } else if (part.type === 'error') {
      throw Error('MODEL_REQUEST_FAILED')
    } else if (part.type === 'tool-error' && invalidIds.has(part.toolCallId)) {
      // The SDK emits a validation error after an invalid call even without execute.
      // Host already received that attempt and owns its finite refusal.
    } else if (part.type === 'tool-result' || part.type === 'tool-error' || part.type === 'tool-approval-request' || part.type === 'tool-output-denied') {
      throw Error('MODEL_PROTOCOL_ERROR')
    }
  }
  if (!finished && !input.signal.aborted) throw Error('MODEL_PROTOCOL_ERROR')
}

/** The default current-note adapter rejects unsolicited tools. */
export async function* streamModelText(input: ModelStreamInput): AsyncGenerator<string> {
  for await (const event of streamModelStep({ ...input, messages: [{ role: 'user', content: input.prompt }] })) {
    if (event.type === 'text') yield event.text
    if (event.type === 'tool-call') throw Error('MODEL_PROTOCOL_ERROR')
  }
}
