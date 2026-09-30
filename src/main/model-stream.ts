import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText, tool, jsonSchema, isStepCount, type ModelMessage, type ToolSet } from 'ai'

export type ToolSchema = { description: string; inputSchema: Parameters<typeof jsonSchema>[0] }
export type ModelStepEvent =
  | { type: 'text'; text: string }
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
  for await (const part of result.fullStream) {
    if (part.type === 'reasoning-delta') {
      bytes += Buffer.byteLength(part.text, 'utf8')
      if (bytes > MODEL_STREAM_BOUNDS.responseBytes) throw Error('MODEL_OUTPUT_LIMIT')
    } else if (part.type === 'text-delta') {
      bytes += Buffer.byteLength(part.text, 'utf8')
      if (bytes > MODEL_STREAM_BOUNDS.responseBytes) throw Error('MODEL_OUTPUT_LIMIT')
      yield { type: 'text', text: part.text }
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
