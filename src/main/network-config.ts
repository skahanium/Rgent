import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SecretProtection } from './model-config.ts'
import type { DeepSeekKeySource, FetchService, NetworkConfigView, NetworkProvider } from '../shared/ipc.ts'

/**
 * 联网设备级配置（`network-config.json`，v3）：总闸、搜索服务、各服务商密钥、
 * 抓页服务、DeepSeek 密钥来源与模型自带搜索开关。
 *
 * v3 存储形状：
 * `{ version: 3, enabled, searchProvider, credentials: { brave?, tavily?, deepseek? },
 *    deepseekKeySource: 'own' | 'model', fetch: 'direct' | 'deepseek',
 *    nativeSearch: { minimax: boolean } }`
 *
 * 迁移：v2 `{ provider, keyCipher, enabled }` → `searchProvider`／`credentials[provider]`；
 * v1（或更早没有 version 字段的 P3 文件）只有 `enabled`。读时在内存里升级，写时落 v3。
 * 缺失、损坏、形状不对或版本不认识一律**回退为关闭**（fail closed），不覆盖磁盘上的坏文件；
 * 人下一次显式保存才会重写。写入仍是 tmp＋fsync＋rename＋0600。
 *
 * 密钥只用 `SecretProtection`（生产是 Electron `safeStorage`）加密后按 base64 存
 * `credentials[provider]`，明文只在主进程里出现；`getPublic()` 永不含密钥或密文。
 * 多服务商可以各存一份密钥，`searchProvider` 指当前使用的一家：保存某家密钥即选中该家。
 *
 * DeepSeek 密钥来源：`'own'` 用本文件里的独立密钥，`'model'` 复用模型页的 DeepSeek 密钥。
 * `'model'` 时本文件允许没有 `credentials.deepseek`；此时 `credential('deepseek')` 返回
 * `null`，由主进程另行从模型配置解析（本包不接线）。即使旧独立密钥还在，也**不**在
 * `'model'` 下悄悄使用它——来源是人的明确选择。
 */
export type NetworkCredential = { provider: NetworkProvider; key: string }
export type NetworkConfigStore = {
  enabled(): boolean
  /** 渲染层可看的摘要；永不含密钥或密文。 */
  getPublic(): NetworkConfigView
  setEnabled(enabled: boolean): NetworkConfigView
  /** 任务内抓页走直连还是 DeepSeek Fetch；人发起抓页始终直连。 */
  setFetch(fetch: FetchService): NetworkConfigView
  /** 模型自带搜索（MiniMax）开关；只存人的选择，是否可用由主进程探测。 */
  setNativeSearch(enabled: boolean): NetworkConfigView
  /** DeepSeek 独立密钥还是复用模型页密钥；设置来源即选中 DeepSeek。 */
  setDeepSeekKeySource(source: DeepSeekKeySource): NetworkConfigView
  /** 保存该服务商密钥并选中它（长度 1–4096、trim 后非空）；加密不可用即拒，不落明文。 */
  saveKey(provider: NetworkProvider, key: string): NetworkConfigView
  /** 清掉某家密钥；省略时清当前 `searchProvider` 的。不清 `searchProvider` 的选择。 */
  clearKey(provider?: NetworkProvider): NetworkConfigView
  /** 主进程取搜索凭据；省略时用 `searchProvider`；解不开抛 `BAD_NETWORK_CONFIG`。 */
  credential(provider?: NetworkProvider): NetworkCredential | null
  /** 该服务商是否存过密钥（不看 DeepSeek 来源选择）。 */
  hasKey(provider: NetworkProvider): boolean
}

const FILE = 'network-config.json'
const MAX_BYTES = 64 * 1024
const MAX_KEY = 4096
const PROVIDERS: readonly NetworkProvider[] = ['brave', 'tavily', 'deepseek']
const DEFAULT_FETCH: FetchService = 'direct'
const DEFAULT_DEEPSEEK_KEY_SOURCE: DeepSeekKeySource = 'own'

type Credentials = Partial<Record<NetworkProvider, string>>
type Stored = {
  version: 3
  enabled: boolean
  searchProvider: NetworkProvider | null
  credentials: Credentials
  deepseekKeySource: DeepSeekKeySource
  fetch: FetchService
  nativeSearch: { minimax: boolean }
}

const defaults = (enabled = false): Stored => ({
  version: 3,
  enabled,
  searchProvider: null,
  credentials: {},
  deepseekKeySource: DEFAULT_DEEPSEEK_KEY_SOURCE,
  fetch: DEFAULT_FETCH,
  nativeSearch: { minimax: false }
})
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const isProvider = (value: unknown): value is NetworkProvider => PROVIDERS.includes(value as NetworkProvider)
const isFetch = (value: unknown): value is FetchService => value === 'direct' || value === 'deepseek'
const isKeySource = (value: unknown): value is DeepSeekKeySource => value === 'own' || value === 'model'
/** safeStorage 的密文是 base64；形状不对的文件按坏文件处理，不去猜。 */
const validCipher = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)

/** v2：`{ version, enabled, provider, keyCipher? }`。有服务商就必须有密文，反之亦然。 */
function parseV2(record: Record<string, unknown>): Stored | null {
  if (typeof record.enabled !== 'boolean' || !('provider' in record)) return null
  if (record.provider !== null && !isProvider(record.provider)) return null
  const base = defaults(record.enabled)
  if (record.keyCipher === undefined) {
    if (record.provider !== null) return null
    return base
  }
  if (record.provider === null || !validCipher(record.keyCipher)) return null
  const provider = record.provider
  return { ...base, searchProvider: provider, credentials: { [provider]: record.keyCipher } }
}

/** v3 逐字段严格校验；未知顶层字段也拒（要加字段就升版本，不猜半懂的文件）。 */
function parseV3(record: Record<string, unknown>): Stored | null {
  const allowed = ['version', 'enabled', 'searchProvider', 'credentials', 'deepseekKeySource', 'fetch', 'nativeSearch']
  if (Object.keys(record).some(key => !allowed.includes(key))) return null
  if (typeof record.enabled !== 'boolean') return null
  if (record.searchProvider !== null && !isProvider(record.searchProvider)) return null
  if (!isRecord(record.credentials)) return null
  const credentials: Credentials = {}
  for (const [provider, cipher] of Object.entries(record.credentials)) {
    if (!isProvider(provider) || !validCipher(cipher)) return null
    credentials[provider] = cipher
  }
  if (!isKeySource(record.deepseekKeySource)) return null
  if (!isFetch(record.fetch)) return null
  if (!isRecord(record.nativeSearch)) return null
  if (Object.keys(record.nativeSearch).length !== 1 || typeof record.nativeSearch.minimax !== 'boolean') return null
  return {
    version: 3,
    enabled: record.enabled,
    searchProvider: record.searchProvider,
    credentials,
    deepseekKeySource: record.deepseekKeySource,
    fetch: record.fetch,
    nativeSearch: { minimax: record.nativeSearch.minimax }
  }
}

function parse(raw: string): Stored | null {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return null
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) return null
    // v1（含更早没有 version 字段的 P3 文件）只有总开关；读时升级，写时落 v3。
    if (value.version === undefined || value.version === 1) {
      if (typeof value.enabled !== 'boolean') return null
      return defaults(value.enabled)
    }
    if (value.version === 2) return parseV2(value)
    if (value.version !== 3) return null
    return parseV3(value)
  } catch { return null }
}

const view = (stored: Stored): NetworkConfigView => {
  const keyedProviders = PROVIDERS.filter(provider => stored.credentials[provider] !== undefined)
  const searchProvider = stored.searchProvider
  return {
    enabled: stored.enabled,
    searchProvider,
    keyedProviders,
    deepseekKeySource: stored.deepseekKeySource,
    fetch: stored.fetch,
    nativeSearch: { minimax: stored.nativeSearch.minimax },
    // deprecated：旧渲染层继续按这两个字段读，值与原语义保持一致。
    provider: searchProvider,
    hasKey: searchProvider !== null && stored.credentials[searchProvider] !== undefined
  }
}

export function createNetworkConfigStore(userData: string, protection: SecretProtection): NetworkConfigStore {
  const target = path.join(userData, FILE)
  const read = (): Stored => {
    try { return parse(readFileSync(target, 'utf8')) ?? defaults() }
    // 文件不存在、读不动、不是 UTF-8 文本：都按关闭处理。
    catch { return defaults() }
  }
  const write = (stored: Stored): NetworkConfigView => {
    const temporary = path.join(userData, `.network-config-${randomUUID()}.tmp`)
    let descriptor: number | null = null
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, JSON.stringify(stored), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = null
      renameSync(temporary, target)
    } finally {
      if (descriptor !== null) closeSync(descriptor)
      try { unlinkSync(temporary) } catch { /* committed or never created */ }
    }
    return view(stored)
  }
  return {
    enabled: () => read().enabled,
    getPublic: () => view(read()),
    setEnabled(enabled: boolean): NetworkConfigView {
      if (typeof enabled !== 'boolean') throw Error('BAD_REQUEST')
      // 坏的旧文件在下一次显式保存时被替换；这里只沿用能读出来的其余配置。
      return write({ ...read(), enabled })
    },
    setFetch(fetch: FetchService): NetworkConfigView {
      if (!isFetch(fetch)) throw Error('BAD_REQUEST')
      return write({ ...read(), fetch })
    },
    setNativeSearch(enabled: boolean): NetworkConfigView {
      if (typeof enabled !== 'boolean') throw Error('BAD_REQUEST')
      return write({ ...read(), nativeSearch: { minimax: enabled } })
    },
    setDeepSeekKeySource(source: DeepSeekKeySource): NetworkConfigView {
      if (!isKeySource(source)) throw Error('BAD_REQUEST')
      const stored = read()
      // 来源是 DeepSeek 专属选择：设它即选中 DeepSeek。'model' 时本文件可以没有独立密钥，
      // 否则共享类型里没有别的入口能在「不用独立密钥」的情况下把 DeepSeek 设为当前搜索服务。
      return write({ ...stored, deepseekKeySource: source, searchProvider: 'deepseek' })
    },
    saveKey(provider: NetworkProvider, key: string): NetworkConfigView {
      if (!isProvider(provider)) throw Error('BAD_NETWORK_PROVIDER')
      if (typeof key !== 'string' || !key.trim() || key.length > MAX_KEY || /[\u0000-\u001f\u007f]/u.test(key)) throw Error('BAD_NETWORK_KEY')
      if (!protection.isEncryptionAvailable()) throw Error('SECURE_STORAGE_UNAVAILABLE')
      let keyCipher: string
      try { keyCipher = protection.encryptString(key).toString('base64') } catch { throw Error('SECURE_STORAGE_UNAVAILABLE') }
      const stored = read()
      // 保存某家密钥即选中该家：同一时间只接一家，省掉一次额外的选择写入。
      return write({
        ...stored,
        searchProvider: provider,
        credentials: { ...stored.credentials, [provider]: keyCipher }
      })
    },
    clearKey(provider?: NetworkProvider): NetworkConfigView {
      if (provider !== undefined && !isProvider(provider)) throw Error('BAD_NETWORK_PROVIDER')
      const stored = read()
      const targetProvider = provider ?? stored.searchProvider
      // 没有当前搜索服务、或该家本来就没存密钥：幂等返回，不为空操作重写文件。
      if (!targetProvider || stored.credentials[targetProvider] === undefined) return view(stored)
      const credentials = { ...stored.credentials }
      delete credentials[targetProvider]
      // 只清密钥，不动人选的 searchProvider：界面仍显示「这家 · 未配置」。
      return write({ ...stored, credentials })
    },
    credential(provider?: NetworkProvider): NetworkCredential | null {
      if (provider !== undefined && !isProvider(provider)) throw Error('BAD_NETWORK_PROVIDER')
      const stored = read()
      const targetProvider = provider ?? stored.searchProvider
      if (!targetProvider) return null
      // 'model' 是人的明确选择：不使用本文件里的旧独立密钥，等主进程从模型配置取。
      if (targetProvider === 'deepseek' && stored.deepseekKeySource === 'model') return null
      const keyCipher = stored.credentials[targetProvider]
      if (!keyCipher) return null
      if (!protection.isEncryptionAvailable()) throw Error('BAD_NETWORK_CONFIG')
      let key: string
      try { key = protection.decryptString(Buffer.from(keyCipher, 'base64')) }
      catch { throw Error('BAD_NETWORK_CONFIG') }
      // 解出空串等于没有密钥：不把它当配置成功的凭据。
      if (!key) throw Error('BAD_NETWORK_CONFIG')
      return { provider: targetProvider, key }
    },
    hasKey(provider: NetworkProvider): boolean {
      if (!isProvider(provider)) throw Error('BAD_NETWORK_PROVIDER')
      return read().credentials[provider] !== undefined
    }
  }
}
