import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export type ModelProvider = 'deepseek' | 'minimax' | 'custom'
export type LimitTier = 'none' | 'local' | 'network'
export type ModelProfileInput = { baseURL: string; modelId: string; contextTokens: number }
export type RunLimits = { seconds: number; steps: number; tools: number }
export type PublicModelConfig = {
  selected: ModelProvider
  profiles: Record<ModelProvider, ModelProfileInput & { hasKey: boolean }>
  limits: Record<LimitTier, RunLimits>
}
export type ModelCredential = ModelProfileInput & { provider: ModelProvider; apiKey: string }

/** The main process passes Electron safeStorage here; no Electron dependency reaches tests or renderer. */
export type SecretProtection = {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

type StoredProfile = ModelProfileInput & { encryptedKey?: string }
type StoredConfig = {
  version: 1
  selected: ModelProvider
  profiles: Record<ModelProvider, StoredProfile>
  limits: Record<LimitTier, RunLimits>
}

const FILE = 'model-config.json'
const PROVIDERS: ModelProvider[] = ['deepseek', 'minimax', 'custom']
const TIERS: LimitTier[] = ['none', 'local', 'network']

const defaults = (): StoredConfig => ({
  version: 1,
  selected: 'deepseek',
  profiles: {
    deepseek: { baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576 },
    minimax: { baseURL: 'https://api.minimax.io/v1', modelId: 'MiniMax-M2.7', contextTokens: 204800 },
    custom: { baseURL: '', modelId: '', contextTokens: 0 }
  },
  limits: {
    none: { seconds: 180, steps: 4, tools: 0 },
    local: { seconds: 300, steps: 12, tools: 24 },
    network: { seconds: 600, steps: 20, tools: 40 }
  }
})

const isProvider = (value: unknown): value is ModelProvider => PROVIDERS.includes(value as ModelProvider)
const isTier = (value: unknown): value is LimitTier => TIERS.includes(value as LimitTier)
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0

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

function validateProfile(value: unknown): ModelProfileInput {
  if (!value || typeof value !== 'object') throw new Error('BAD_MODEL_PROFILE')
  const profile = value as Partial<ModelProfileInput>
  const baseURL = validateModelBaseURL(profile.baseURL as string)
  if (typeof profile.modelId !== 'string' || !profile.modelId.trim() || profile.modelId !== profile.modelId.trim() || profile.modelId.length > 200 || /[\u0000-\u001f\u007f]/u.test(profile.modelId)) throw new Error('BAD_MODEL_ID')
  if (!positiveInteger(profile.contextTokens) || profile.contextTokens > 16777216) throw new Error('BAD_CONTEXT_TOKENS')
  return { baseURL, modelId: profile.modelId, contextTokens: profile.contextTokens }
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

function parseStored(value: unknown): StoredConfig {
  if (!value || typeof value !== 'object') throw new Error('BAD_MODEL_CONFIG')
  const record = value as Partial<StoredConfig>
  if (record.version !== 1 || !isProvider(record.selected) || !record.profiles || !record.limits) throw new Error('BAD_MODEL_CONFIG')
  const config = defaults()
  config.selected = record.selected
  for (const provider of PROVIDERS) {
    const candidate = record.profiles[provider]
    if (!candidate || typeof candidate !== 'object') throw new Error('BAD_MODEL_CONFIG')
    if (provider === 'custom' && candidate.baseURL === '' && candidate.modelId === '' && candidate.contextTokens === 0) {
      if (record.selected === 'custom') throw new Error('BAD_MODEL_CONFIG')
    } else {
      try { config.profiles[provider] = validateProfile(candidate) } catch { throw new Error('BAD_MODEL_CONFIG') }
    }
    if (candidate.encryptedKey !== undefined) {
      if (!validEncryptedKey(candidate.encryptedKey)) throw new Error('BAD_MODEL_CONFIG')
      config.profiles[provider].encryptedKey = candidate.encryptedKey
    }
  }
  for (const tier of TIERS) {
    try { config.limits[tier] = validateLimits(tier, record.limits[tier]) } catch { throw new Error('BAD_MODEL_CONFIG') }
  }
  return config
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

  return {
    getPublic(): PublicModelConfig {
      const profiles = {} as PublicModelConfig['profiles']
      for (const provider of PROVIDERS) {
        const { baseURL, modelId, contextTokens, encryptedKey } = current.profiles[provider]
        profiles[provider] = { baseURL, modelId, contextTokens, hasKey: encryptedKey !== undefined }
      }
      return { selected: current.selected, profiles, limits: structuredClone(current.limits) }
    },
    updateProfile(provider: ModelProvider, fields: Partial<ModelProfileInput>, newKey?: string): void {
      if (!isProvider(provider)) throw new Error('BAD_PROVIDER')
      const next = copy()
      const merged = { ...next.profiles[provider], ...fields }
      const validated = validateProfile(merged)
      next.profiles[provider] = { ...validated, encryptedKey: next.profiles[provider].encryptedKey }
      if (newKey !== undefined) {
        if (typeof newKey !== 'string' || !newKey.trim()) throw new Error('BAD_API_KEY')
        if (!protection.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE')
        try { next.profiles[provider].encryptedKey = protection.encryptString(newKey).toString('base64') }
        catch { throw new Error('KEY_ENCRYPT_FAILED') }
      }
      commit(next)
    },
    select(provider: ModelProvider): void {
      if (!isProvider(provider)) throw new Error('BAD_PROVIDER')
      if (provider === 'custom' && !current.profiles.custom.baseURL) throw new Error('BAD_MODEL_PROFILE')
      const next = copy()
      next.selected = provider
      commit(next)
    },
    deleteKey(provider: ModelProvider): void {
      if (!isProvider(provider)) throw new Error('BAD_PROVIDER')
      const next = copy()
      delete next.profiles[provider].encryptedKey
      commit(next)
    },
    updateLimits(tier: LimitTier, limits: RunLimits): void {
      if (!isTier(tier)) throw new Error('BAD_LIMITS')
      const next = copy()
      next.limits[tier] = validateLimits(tier, limits)
      commit(next)
    },
    credential(provider: ModelProvider): ModelCredential {
      if (!isProvider(provider)) throw new Error('BAD_PROVIDER')
      const { baseURL, modelId, contextTokens, encryptedKey } = current.profiles[provider]
      if (!encryptedKey) throw new Error('NO_API_KEY')
      if (!protection.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE')
      let apiKey: string
      try { apiKey = protection.decryptString(Buffer.from(encryptedKey, 'base64')) }
      catch { throw new Error('KEY_DECRYPT_FAILED') }
      if (!apiKey) throw new Error('KEY_DECRYPT_FAILED')
      return { provider, baseURL, modelId, contextTokens, apiKey }
    }
  }
}

export type ModelConfigStore = ReturnType<typeof createModelConfigStore>
