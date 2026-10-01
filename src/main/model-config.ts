import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { defaultBaseURL } from '../shared/model-endpoints.ts'
import type { PublicModelConfig, RunLimits } from '../shared/ipc.ts'

export type { RunLimits }

export type ModelProvider = 'deepseek' | 'minimax' | 'custom'
export type LimitTier = 'none' | 'local' | 'network'
export type ModelCredential = {
  provider: ModelProvider
  baseURL: string
  modelId: string
  contextTokens: number
  apiKey: string
}

/** The main process passes Electron safeStorage here; no Electron dependency reaches tests or renderer. */
export type SecretProtection = {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

type StoredConnection = { id: string; provider: ModelProvider; baseURL: string; encryptedKey?: string }
type StoredModel = { id: string; connectionId: string; modelId: string; contextTokens: number }
type StoredConfig = {
  version: 2
  connections: StoredConnection[]
  models: StoredModel[]
  defaultModelId: string | null
  limits: Record<LimitTier, RunLimits>
}

const FILE = 'model-config.json'
const PROVIDERS: ModelProvider[] = ['deepseek', 'minimax', 'custom']
const TIERS: LimitTier[] = ['none', 'local', 'network']
export const MAX_MODELS_PER_PROVIDER = 100
const MAX_CONTEXT_TOKENS = 16777216

const defaults = (): StoredConfig => {
  const deepseek: StoredConnection = { id: randomUUID(), provider: 'deepseek', baseURL: defaultBaseURL('deepseek') }
  const minimax: StoredConnection = { id: randomUUID(), provider: 'minimax', baseURL: defaultBaseURL('minimax') }
  const deepseekModel: StoredModel = { id: randomUUID(), connectionId: deepseek.id, modelId: 'deepseek-flash', contextTokens: 1048576 }
  const minimaxModel: StoredModel = { id: randomUUID(), connectionId: minimax.id, modelId: 'MiniMax-M2.7', contextTokens: 204800 }
  return {
    version: 2,
    connections: [deepseek, minimax],
    models: [deepseekModel, minimaxModel],
    defaultModelId: deepseekModel.id,
    limits: {
      none: { seconds: 180, steps: 4, tools: 0 },
      local: { seconds: 300, steps: 12, tools: 24 },
      network: { seconds: 600, steps: 20, tools: 40 }
    }
  }
}

const isProvider = (value: unknown): value is ModelProvider => PROVIDERS.includes(value as ModelProvider)
const isTier = (value: unknown): value is LimitTier => TIERS.includes(value as LimitTier)
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const isRowId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9-]+$/u.test(value)

export function validateModelBaseURL(input: string): string {
  if (typeof input !== 'string' || input !== input.trim() || /[\u0000-\u001f\u007f]/u.test(input)) throw new Error('BAD_BASE_URL')
  let url: URL
  try { url = new URL(input) } catch { throw new Error('BAD_BASE_URL') }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('BAD_BASE_URL')
  }
  return url.href.replace(/\/$/u, '')
}

function validateModelId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('BAD_MODEL_ID')
  return value
}

function validateContextTokens(value: unknown): number {
  if (!positiveInteger(value) || Number(value) > MAX_CONTEXT_TOKENS) throw new Error('BAD_CONTEXT_TOKENS')
  return Number(value)
}

/** 自定义供应商允许先建连接、再填地址；预置供应商的地址必须当场有效。 */
function validateConnectionBaseURL(provider: ModelProvider, value: unknown): string {
  if (provider === 'custom' && value === '') return ''
  return validateModelBaseURL(value as string)
}

function validateLimits(tier: LimitTier, value: unknown): RunLimits {
  if (!value || typeof value !== 'object') throw new Error('BAD_LIMITS')
  const limits = value as Partial<RunLimits>
  if (!positiveInteger(limits.seconds) || limits.seconds > 86400 ||
      !positiveInteger(limits.steps) || limits.steps > 1000 ||
      !(Number.isSafeInteger(limits.tools) && Number(limits.tools) >= 0 && Number(limits.tools) <= 10000) ||
      (tier === 'none' && limits.tools !== 0) || (tier !== 'none' && limits.tools === 0)) throw new Error('BAD_LIMITS')
  return { seconds: limits.seconds, steps: limits.steps, tools: limits.tools as number }
}

function validEncryptedKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
}

/** v2 配置文件逐字段校验；损坏一律 BAD_MODEL_CONFIG，原文件不动。 */
function parseV2(value: unknown): StoredConfig {
  if (!value || typeof value !== 'object') throw new Error('BAD_MODEL_CONFIG')
  const record = value as Partial<StoredConfig>
  if (!Array.isArray(record.connections) || !Array.isArray(record.models) || !record.limits) throw new Error('BAD_MODEL_CONFIG')
  if (record.connections.length > PROVIDERS.length) throw new Error('BAD_MODEL_CONFIG')
  const connections: StoredConnection[] = []
  const seenConnections = new Set<string>()
  const seenProviders = new Set<string>()
  for (const candidate of record.connections) {
    if (!candidate || typeof candidate !== 'object') throw new Error('BAD_MODEL_CONFIG')
    if (!isRowId(candidate.id) || seenConnections.has(candidate.id) || !isProvider(candidate.provider)) throw new Error('BAD_MODEL_CONFIG')
    if (seenProviders.has(candidate.provider)) throw new Error('BAD_MODEL_CONFIG')
    seenConnections.add(candidate.id)
    seenProviders.add(candidate.provider)
    const connection: StoredConnection = {
      id: candidate.id,
      provider: candidate.provider,
      baseURL: validateConnectionBaseURL(candidate.provider, candidate.baseURL)
    }
    if (candidate.encryptedKey !== undefined) {
      if (!validEncryptedKey(candidate.encryptedKey)) throw new Error('BAD_MODEL_CONFIG')
      connection.encryptedKey = candidate.encryptedKey
    }
    connections.push(connection)
  }
  const models: StoredModel[] = []
  const seenModels = new Set<string>()
  const perConnection = new Map<string, number>()
  for (const candidate of record.models) {
    if (!candidate || typeof candidate !== 'object') throw new Error('BAD_MODEL_CONFIG')
    if (!isRowId(candidate.id) || seenModels.has(candidate.id) || !seenConnections.has(candidate.connectionId)) throw new Error('BAD_MODEL_CONFIG')
    seenModels.add(candidate.id)
    const count = (perConnection.get(candidate.connectionId) ?? 0) + 1
    if (count > MAX_MODELS_PER_PROVIDER) throw new Error('BAD_MODEL_CONFIG')
    perConnection.set(candidate.connectionId, count)
    models.push({
      id: candidate.id,
      connectionId: candidate.connectionId,
      modelId: validateModelId(candidate.modelId),
      contextTokens: validateContextTokens(candidate.contextTokens)
    })
  }
  if (new Set(models.map((model) => `${model.connectionId}:${model.modelId}`)).size !== models.length) throw new Error('BAD_MODEL_CONFIG')
  if (record.defaultModelId !== null && (!isRowId(record.defaultModelId) || !seenModels.has(record.defaultModelId))) throw new Error('BAD_MODEL_CONFIG')
  const config = defaults()
  config.connections = connections
  config.models = models
  config.defaultModelId = record.defaultModelId ?? null
  for (const tier of TIERS) config.limits[tier] = validateLimits(tier, record.limits[tier])
  return config
}

type StoredConfigV1 = {
  version: 1
  selected: ModelProvider
  profiles: Record<ModelProvider, { baseURL: string; modelId: string; contextTokens: number; encryptedKey?: string }>
  limits: Record<LimitTier, RunLimits>
}

function parseV1(value: unknown): StoredConfigV1 {
  if (!value || typeof value !== 'object') throw new Error('BAD_MODEL_CONFIG')
  const record = value as Partial<StoredConfigV1>
  if (record.version !== 1 || !isProvider(record.selected) || !record.profiles || !record.limits) throw new Error('BAD_MODEL_CONFIG')
  const profiles = {} as StoredConfigV1['profiles']
  for (const provider of PROVIDERS) {
    const candidate = record.profiles[provider]
    if (!candidate || typeof candidate !== 'object') throw new Error('BAD_MODEL_CONFIG')
    const empty = candidate.baseURL === '' && candidate.modelId === '' && candidate.contextTokens === 0
    if (provider === 'custom' && empty) {
      if (record.selected === 'custom') throw new Error('BAD_MODEL_CONFIG')
      profiles[provider] = { baseURL: '', modelId: '', contextTokens: 0 }
    } else {
      try {
        profiles[provider] = {
          baseURL: validateModelBaseURL(candidate.baseURL as string),
          modelId: validateModelId(candidate.modelId),
          contextTokens: validateContextTokens(candidate.contextTokens)
        }
      } catch { throw new Error('BAD_MODEL_CONFIG') }
    }
    if (candidate.encryptedKey !== undefined) {
      if (!validEncryptedKey(candidate.encryptedKey)) throw new Error('BAD_MODEL_CONFIG')
      profiles[provider].encryptedKey = candidate.encryptedKey
    }
  }
  const limits = {} as Record<LimitTier, RunLimits>
  for (const tier of TIERS) {
    try { limits[tier] = validateLimits(tier, record.limits[tier]) } catch { throw new Error('BAD_MODEL_CONFIG') }
  }
  return { version: 1, selected: record.selected, profiles, limits }
}

/** v1（selected + profiles）→ v2（connections + models + defaultModelId）。只在内存里做，下一次写操作才落盘。 */
export function migrateV1ToV2(old: StoredConfigV1): StoredConfig {
  const next: StoredConfig = { version: 2, connections: [], models: [], defaultModelId: null, limits: old.limits }
  for (const provider of PROVIDERS) {
    const profile = old.profiles[provider]
    const emptyCustom = provider === 'custom' && profile.baseURL === '' && profile.modelId === ''
    if (emptyCustom) continue
    const connection: StoredConnection = { id: randomUUID(), provider, baseURL: profile.baseURL }
    if (profile.encryptedKey !== undefined) connection.encryptedKey = profile.encryptedKey
    next.connections.push(connection)
    if (profile.modelId) {
      const model: StoredModel = { id: randomUUID(), connectionId: connection.id, modelId: profile.modelId, contextTokens: profile.contextTokens }
      next.models.push(model)
      if (provider === old.selected) next.defaultModelId = model.id
    }
  }
  return next
}

function parseStored(value: unknown): StoredConfig {
  const version = (value as { version?: unknown } | null)?.version
  if (version === 2) return parseV2(value)
  if (version === 1) return migrateV1ToV2(parseV1(value))
  throw new Error('BAD_MODEL_CONFIG')
}

function readConfig(userData: string): StoredConfig {
  let raw: string
  try { raw = readFileSync(path.join(userData, FILE), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults()
    throw error
  }
  try { return parseStored(JSON.parse(raw) as unknown) }
  catch { throw new Error('BAD_MODEL_CONFIG') }
}

function writeConfig(userData: string, config: StoredConfig): void {
  const target = path.join(userData, FILE)
  const temporary = path.join(userData, `.model-config-${randomUUID()}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(config), 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temporary, target)
  } catch (error) {
    if (fd !== null) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* may not exist */ }
    throw error
  }
}

/** BAD_MODEL_CONFIG is recoverable by the caller: keep notes available, disable model actions, and preserve the corrupt file for repair. */
export function createModelConfigStore(userData: string, protection: SecretProtection) {
  let current = readConfig(userData)
  const commit = (next: StoredConfig): void => {
    writeConfig(userData, next)
    current = next
  }
  const copy = (): StoredConfig => structuredClone(current)
  const connectionOf = (config: StoredConfig, id: string): StoredConnection => {
    const connection = config.connections.find((item) => item.id === id)
    if (!connection) throw new Error('CONNECTION_NOT_FOUND')
    return connection
  }
  const modelOf = (config: StoredConfig, id: string): StoredModel => {
    const model = config.models.find((item) => item.id === id)
    if (!model) throw new Error('MODEL_NOT_FOUND')
    return model
  }
  const encryptKey = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('BAD_API_KEY')
    if (!protection.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE')
    try { return protection.encryptString(value).toString('base64') } catch { throw new Error('KEY_ENCRYPT_FAILED') }
  }
  const decryptKey = (connection: StoredConnection): string => {
    if (!connection.encryptedKey) throw new Error('NO_API_KEY')
    if (!protection.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE')
    let apiKey: string
    try { apiKey = protection.decryptString(Buffer.from(connection.encryptedKey, 'base64')) }
    catch { throw new Error('KEY_DECRYPT_FAILED') }
    if (!apiKey) throw new Error('KEY_DECRYPT_FAILED')
    return apiKey
  }
  const requireBaseURL = (connection: StoredConnection): string => {
    if (!connection.baseURL) throw new Error('BAD_BASE_URL')
    return connection.baseURL
  }

  return {
    getPublic(): PublicModelConfig {
      return {
        providers: PROVIDERS.map((provider) => {
          const connection = current.connections.find((item) => item.provider === provider)
          return {
            provider,
            configured: connection !== undefined && (connection.baseURL !== '' || connection.encryptedKey !== undefined),
            baseURL: connection?.baseURL ?? '',
            hasKey: connection?.encryptedKey !== undefined,
            modelCount: connection ? current.models.filter((model) => model.connectionId === connection.id).length : 0
          }
        }),
        models: current.models.map((model) => ({
          id: model.id,
          provider: current.connections.find((connection) => connection.id === model.connectionId)!.provider,
          modelId: model.modelId,
          contextTokens: model.contextTokens
        })),
        defaultModelId: current.defaultModelId,
        limits: structuredClone(current.limits)
      }
    },
    /** 保存供应商配置：没有就建（含第一个模型），已有就只改端点与密钥；绝不为同一供应商建第二条。 */
    saveProvider(fields: { provider: unknown; baseURL: unknown; modelId: unknown; contextTokens: unknown }, newKey?: string): void {
      if (!isProvider(fields.provider)) throw new Error('BAD_PROVIDER')
      const next = copy()
      const existing = next.connections.find((connection) => connection.provider === fields.provider)
      const baseURL = validateConnectionBaseURL(fields.provider, fields.baseURL)
      const key = newKey !== undefined ? encryptKey(newKey) : undefined
      if (existing) {
        existing.baseURL = baseURL
        if (key !== undefined) existing.encryptedKey = key
        if (!next.models.some((model) => model.connectionId === existing.id)) {
          const model = { id: randomUUID(), connectionId: existing.id, modelId: validateModelId(fields.modelId), contextTokens: validateContextTokens(fields.contextTokens) }
          next.models.push(model)
          if (next.defaultModelId === null) next.defaultModelId = model.id
        }
      } else {
        const connection: StoredConnection = { id: randomUUID(), provider: fields.provider, baseURL }
        if (key !== undefined) connection.encryptedKey = key
        const model: StoredModel = { id: randomUUID(), connectionId: connection.id, modelId: validateModelId(fields.modelId), contextTokens: validateContextTokens(fields.contextTokens) }
        next.connections.push(connection)
        next.models.push(model)
        if (next.defaultModelId === null) next.defaultModelId = model.id
      }
      commit(next)
    },
    removeProvider(provider: unknown): void {
      if (!isProvider(provider)) throw new Error('BAD_PROVIDER')
      const next = copy()
      const connection = next.connections.find((item) => item.provider === provider)
      if (!connection) throw new Error('CONNECTION_NOT_FOUND')
      const removed = new Set(next.models.filter((model) => model.connectionId === connection.id).map((model) => model.id))
      next.connections = next.connections.filter((item) => item.id !== connection.id)
      next.models = next.models.filter((model) => model.connectionId !== connection.id)
      if (next.defaultModelId !== null && removed.has(next.defaultModelId)) next.defaultModelId = null
      commit(next)
    },
    deleteKey(provider: unknown): void {
      if (!isProvider(provider)) throw new Error('BAD_PROVIDER')
      const next = copy()
      const connection = next.connections.find((item) => item.provider === provider)
      if (!connection) throw new Error('CONNECTION_NOT_FOUND')
      delete connection.encryptedKey
      commit(next)
    },
    addModel(fields: { provider: unknown; modelId: unknown; contextTokens: unknown }): void {
      if (!isProvider(fields.provider)) throw new Error('BAD_PROVIDER')
      const next = copy()
      const connection = connectionOf(next, next.connections.find((item) => item.provider === fields.provider)?.id ?? '')
      const modelId = validateModelId(fields.modelId)
      if (next.models.some((model) => model.connectionId === connection.id && model.modelId === modelId)) throw new Error('DUPLICATE_MODEL')
      if (next.models.filter((model) => model.connectionId === connection.id).length >= MAX_MODELS_PER_PROVIDER) throw new Error('TOO_MANY_MODELS')
      next.models.push({ id: randomUUID(), connectionId: connection.id, modelId, contextTokens: validateContextTokens(fields.contextTokens) })
      commit(next)
    },
    updateModel(modelId: string, contextTokens: unknown): void {
      const next = copy()
      modelOf(next, modelId).contextTokens = validateContextTokens(contextTokens)
      commit(next)
    },
    removeModel(modelId: string): void {
      const next = copy()
      modelOf(next, modelId)
      next.models = next.models.filter((model) => model.id !== modelId)
      if (next.defaultModelId === modelId) next.defaultModelId = null
      commit(next)
    },
    setDefault(modelId: string | null): void {
      const next = copy()
      if (modelId !== null) modelOf(next, modelId)
      next.defaultModelId = modelId
      commit(next)
    },
    updateLimits(tier: LimitTier, limits: RunLimits): void {
      if (!isTier(tier)) throw new Error('BAD_LIMITS')
      const next = copy()
      next.limits[tier] = validateLimits(tier, limits)
      commit(next)
    },
    /** 新任务使用的模型：按 defaultModelId 解析，失败一律显错，不静默换别的。 */
    credential(): ModelCredential {
      if (current.defaultModelId === null) throw new Error('NO_MODEL_SELECTED')
      const model = modelOf(current, current.defaultModelId)
      const connection = connectionOf(current, model.connectionId)
      return {
        provider: connection.provider,
        baseURL: requireBaseURL(connection),
        modelId: model.modelId,
        contextTokens: model.contextTokens,
        apiKey: decryptKey(connection)
      }
    },
    /** 「读取模型」用：只取该供应商的端点与密钥，不用默认模型。 */
    providerSecret(provider: unknown): { baseURL: string; apiKey: string } {
      if (!isProvider(provider)) throw new Error('BAD_PROVIDER')
      const connection = current.connections.find((item) => item.provider === provider)
      if (!connection) throw new Error('CONNECTION_NOT_FOUND')
      return { baseURL: requireBaseURL(connection), apiKey: decryptKey(connection) }
    }
  }
}

export type ModelConfigStore = ReturnType<typeof createModelConfigStore>
