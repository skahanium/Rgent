/**
 * AI 任务失败的机器目录。
 *
 * 这里是任务失败的单一语义来源：family 决定用户动作，detail 只允许脱敏的传输事实。
 * 通用 Host 错误（删除、恢复、设置）仍由 host-errors 翻译，不强行归入本文件。
 */
export type TaskFamily =
  | 'MODEL_AUTH' | 'MODEL_NOT_FOUND' | 'MODEL_RATE_LIMIT'
  | 'MODEL_CONTEXT' | 'MODEL_PROTOCOL' | 'MODEL_UNAVAILABLE'
  | 'NETWORK' | 'LEDGER' | 'PROMPT' | 'TOOL' | 'INTERNAL'

export type TaskStage = 'preflight' | 'provider' | 'stream' | 'tool' | 'finalize' | 'ledger'
export type TaskAction = 'retry' | 'open_model_settings' | 'open_network_settings' | 'repair_ledger' | 'edit_prompt' | 'view_details' | 'none'

export type TaskFailureDetail = {
  httpStatus?: number
  sdkType?: string
  networkCode?: string
  providerCode?: number
  retryAfterMs?: number
  step?: number
  endpointHost?: string
  modelId?: string
}

export type TaskFailure = {
  code: string
  family: TaskFamily
  stage: TaskStage
  action: TaskAction
  retryable: boolean
  diagnosticId: string
  message: string
  detail?: TaskFailureDetail
}

const FAMILY_MESSAGE: Record<TaskFamily, string> = {
  MODEL_AUTH: '密钥无效或未配置，请到「助手」页更新。',
  MODEL_NOT_FOUND: '这个模型当前不可用，请换一个模型。',
  MODEL_RATE_LIMIT: '模型限流了，稍后再试。',
  MODEL_CONTEXT: '本场内容超过上下文上限，请缩小范围或另开一篇。',
  MODEL_PROTOCOL: '模型返回格式不对，本场已停止。',
  MODEL_UNAVAILABLE: '模型服务没完成请求，可以重试。',
  NETWORK: '网络没有连上，检查网络后再试。',
  LEDGER: '账本需要修复，请到「笔记库」处理。',
  PROMPT: '提问块不完整，请修改后再发。',
  TOOL: '工具执行失败，回答已保留。',
  INTERNAL: '这次没有完成，可以重试；详情在账本。'
}

const CODE_MESSAGE: Record<string,string> = {
  MODEL_OUTPUT_LIMIT: '本场生成内容已达上限，可以缩小问题后重试。',
  MODEL_STEP_LIMIT: '本场模型步数已达上限。',
  TOOL_CALL_LIMIT: '本场工具次数已达上限。',
  TOOL_ARGUMENT_LIMIT: '本场工具参数超出上限。',
  TOOL_RESULT_LIMIT: '本场工具结果超出上限。'
}

const AUTH_CODES = new Set(['NO_API_KEY','KEY_DECRYPT_FAILED','ENCRYPTION_UNAVAILABLE','SECURE_STORAGE_UNAVAILABLE'])
const LEDGER_PREFIX = 'LEDGER_'
const PROMPT_CODES = new Set(['PROMPT_BLOCK_INVALID','PROMPT_UNSAFE'])
const TOOL_CODES = new Set(['TOOL_CALL_LIMIT','TOOL_ARGUMENT_LIMIT','TOOL_RESULT_LIMIT'])
const NETWORK_CODES = new Set(['NETWORK_NOT_AUTHORIZED','EGRESS_UNAVAILABLE','EGRESS_TIMEOUT','EGRESS_BUSY','EGRESS_ABORTED'])
const NETWORK_CAUSE = new Set(['ENOTFOUND','ECONNRESET','ECONNREFUSED','ETIMEDOUT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE'])

const DETAIL_KEYS = ['httpStatus','sdkType','networkCode','providerCode','retryAfterMs','step','endpointHost','modelId'] as const
const MAX_DETAIL_STRING = 256

export function sanitizeFailureDetail(value: unknown): TaskFailureDetail | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>, detail: TaskFailureDetail = {}
  for (const key of DETAIL_KEYS) {
    const item = source[key]
    if (key === 'httpStatus' || key === 'providerCode' || key === 'retryAfterMs' || key === 'step') {
      if (typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= Number.MAX_SAFE_INTEGER) (detail as Record<string, unknown>)[key] = Math.trunc(item)
    } else if (typeof item === 'string' && item.length > 0 && item.length <= MAX_DETAIL_STRING && !/[\u0000-\u001f]/u.test(item)) {
      (detail as Record<string, unknown>)[key] = item
    }
  }
  return Object.keys(detail).length ? detail : undefined
}

export function failureFamily(code: string, detail?: TaskFailureDetail): { family: TaskFamily; action: TaskAction; retryable: boolean } {
  if (AUTH_CODES.has(code)) return { family: 'MODEL_AUTH', action: 'open_model_settings', retryable: false }
  if (code.startsWith(LEDGER_PREFIX) || code === 'INVALID_LEDGER_PROVENANCE' || code === 'LEDGER_PROVENANCE_LIMIT' || code === 'LEDGER_BOUNDARY_INVALID') return { family: 'LEDGER', action: 'repair_ledger', retryable: false }
  if (PROMPT_CODES.has(code)) return { family: 'PROMPT', action: 'edit_prompt', retryable: false }
  if (TOOL_CODES.has(code)) return { family: 'TOOL', action: 'view_details', retryable: false }
  if (code === 'MODEL_CONTEXT_LIMIT' || code === 'MODEL_OUTPUT_LIMIT') return { family: 'MODEL_CONTEXT', action: 'edit_prompt', retryable: false }
  if (code === 'MODEL_PROTOCOL_ERROR') return { family: 'MODEL_PROTOCOL', action: 'view_details', retryable: false }
  if (NETWORK_CODES.has(code) || detail?.networkCode && NETWORK_CAUSE.has(detail.networkCode)) return { family: 'NETWORK', action: 'open_network_settings', retryable: code !== 'NETWORK_NOT_AUTHORIZED' }
  if (code === 'MODEL_REQUEST_FAILED') {
    const status = detail?.httpStatus
    if (status === 401 || status === 403) return { family: 'MODEL_AUTH', action: 'open_model_settings', retryable: false }
    if (status === 404) return { family: 'MODEL_NOT_FOUND', action: 'open_model_settings', retryable: false }
    if (status === 429) return { family: 'MODEL_RATE_LIMIT', action: 'retry', retryable: true }
    if (status !== undefined && status >= 500) return { family: 'MODEL_UNAVAILABLE', action: 'retry', retryable: true }
    return { family: 'INTERNAL', action: 'view_details', retryable: false }
  }
  return { family: 'INTERNAL', action: 'view_details', retryable: false }
}

export function makeTaskFailure(input: {
  code: string
  diagnosticId: string
  stage?: TaskStage
  detail?: unknown
  family?: TaskFamily
  action?: TaskAction
  retryable?: boolean
  message?: string
}): TaskFailure {
  const detail = sanitizeFailureDetail(input.detail)
  const rawCode = input.code
  const code = rawCode.length > 0 && rawCode.length <= 128 && !/[\u0000-\u001f]/u.test(rawCode) ? rawCode : 'INTERNAL'
  const inferred = failureFamily(code, detail)
  const family = input.family ?? inferred.family
  const action = input.action ?? inferred.action
  return {
    code,
    family,
    stage: input.stage ?? (family === 'LEDGER' ? 'ledger' : family === 'TOOL' ? 'tool' : 'provider'),
    action,
    retryable: input.retryable ?? inferred.retryable,
    diagnosticId: input.diagnosticId,
    message: input.message ?? CODE_MESSAGE[code] ?? FAMILY_MESSAGE[family],
    ...(detail ? { detail } : {})
  }
}

export function validTaskFailure(value: unknown): value is TaskFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const keys = Object.keys(v).sort().join()
  if (keys !== 'action,code,diagnosticId,family,message,retryable,stage' && keys !== 'action,code,detail,diagnosticId,family,message,retryable,stage') return false
  if (typeof v.code !== 'string' || !v.code || v.code.length > 128) return false
  if (!['MODEL_AUTH','MODEL_NOT_FOUND','MODEL_RATE_LIMIT','MODEL_CONTEXT','MODEL_PROTOCOL','MODEL_UNAVAILABLE','NETWORK','LEDGER','PROMPT','TOOL','INTERNAL'].includes(String(v.family))) return false
  if (!['preflight','provider','stream','tool','finalize','ledger'].includes(String(v.stage))) return false
  if (!['retry','open_model_settings','open_network_settings','repair_ledger','edit_prompt','view_details','none'].includes(String(v.action))) return false
  if (typeof v.retryable !== 'boolean' || typeof v.diagnosticId !== 'string' || !v.diagnosticId || v.diagnosticId.length > 128) return false
  if (typeof v.message !== 'string' || !v.message || v.message.length > 200) return false
  if ('detail' in v) {
    if (!v.detail || typeof v.detail !== 'object' || Array.isArray(v.detail)) return false
    const sanitized = sanitizeFailureDetail(v.detail)
    if (!sanitized || Object.keys(v.detail).sort().join() !== Object.keys(sanitized).sort().join()) return false
  }
  return true
}

export type FailurePointer = { taskId: string; relPath: string; at: string; failure: TaskFailure; answerEmpty: boolean }
export type PreflightEntry = {
  id: string
  at: string
  code: string
  family: TaskFamily
  stage: TaskStage
  action: TaskAction
  retryable: boolean
  message: string
  detail?: TaskFailureDetail
}
export type DiagnosticsSnapshot = { failures: FailurePointer[]; preflight: PreflightEntry[] }
