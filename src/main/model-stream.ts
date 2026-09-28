import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText } from 'ai'

export type ModelStreamInput = {
  baseURL: string
  modelId: string
  apiKey: string
  system?: string
  prompt: string
  signal: AbortSignal
  maxOutputTokens?: number
}

/** The model credential stays in the main process. Authenticated redirects are refused. */
export async function* streamModelText(input: ModelStreamInput): AsyncGenerator<string> {
  const provider = createOpenAICompatible({
    name: 'rgent',
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' })
  })
  const result = streamText({
    model: provider.chatModel(input.modelId),
    prompt: input.prompt,
    ...(input.system ? { system: input.system } : {}),
    abortSignal: input.signal,
    maxRetries: 0,
    onError: () => {},
    ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {})
  })
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') yield part.text
    if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error('MODEL_STREAM_ERROR')
  }
}
