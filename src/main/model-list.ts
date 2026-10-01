import type { ModelListEntry } from '../shared/ipc.ts'
import { validateModelBaseURL } from './model-config.ts'

/**
 * 「读取模型」：人手动触发的一次只读请求。
 * 只取模型 ID 与端点自报的上下文容量，不写账本、不进单场授权、不缓存、不后台轮询。
 */
export const MODEL_LIST_LIMITS = { timeoutMs: 10_000, maxBytes: 262_144, maxEntries: 100 } as const

const MAX_CONTEXT_TOKENS = 16777216

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MODEL_LIST_LIMITS.maxBytes) throw new Error('MODEL_LIST_TOO_LARGE')
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MODEL_LIST_LIMITS.maxBytes) {
      await reader.cancel().catch(() => { /* 已断开 */ })
      throw new Error('MODEL_LIST_TOO_LARGE')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

/** 只认 OpenAI 兼容的 `{ data: [{ id, context_window? }] }`；其它形状按失败处理。 */
export function parseModelList(payload: unknown): { models: ModelListEntry[]; truncated: boolean } {
  if (!payload || typeof payload !== 'object') throw new Error('MODEL_LIST_FAILED')
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) throw new Error('MODEL_LIST_FAILED')
  const seen = new Set<string>()
  const models: ModelListEntry[] = []
  let truncated = false
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/u.test(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    if (models.length >= MODEL_LIST_LIMITS.maxEntries) { truncated = true; continue }
    const reported = (item as { context_window?: unknown }).context_window
    const contextTokens = Number.isSafeInteger(reported) && Number(reported) > 0 && Number(reported) <= MAX_CONTEXT_TOKENS ? Number(reported) : undefined
    models.push({ id, ...(contextTokens !== undefined ? { contextTokens } : {}) })
  }
  return { models, truncated }
}

export async function fetchModelList(
  input: { baseURL: string; apiKey: string },
  options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}
): Promise<{ models: ModelListEntry[]; truncated: boolean }> {
  const baseURL = validateModelBaseURL(input.baseURL)
  const send = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODEL_LIST_LIMITS.timeoutMs)
  const relay = (): void => controller.abort()
  options.signal?.addEventListener('abort', relay, { once: true })
  try {
    const response = await send(`${baseURL}/models`, {
      method: 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${input.apiKey}`, accept: 'application/json' },
      signal: controller.signal
    })
    if (response.status === 401 || response.status === 403) throw new Error('KEY_REJECTED')
    if (response.status === 404 || response.status === 405 || response.status === 400) throw new Error('MODEL_LIST_UNSUPPORTED')
    if (!response.ok) throw new Error('MODEL_LIST_FAILED')
    const text = await readBounded(response)
    let payload: unknown
    try { payload = JSON.parse(text) } catch { throw new Error('MODEL_LIST_FAILED') }
    return parseModelList(payload)
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (['KEY_REJECTED', 'MODEL_LIST_UNSUPPORTED', 'MODEL_LIST_TOO_LARGE', 'MODEL_LIST_FAILED'].includes(code)) throw error
    if (controller.signal.aborted) throw new Error('MODEL_LIST_FAILED')
    throw new Error('MODEL_LIST_FAILED')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', relay)
  }
}
