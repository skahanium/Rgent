import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SecretProtection } from './model-config.ts'
import type { NetworkConfigView, NetworkProvider } from '../shared/ipc.ts'

/**
 * 联网总闸与预设搜索服务的设备级配置（`network-config.json`，v2）。
 *
 * v1 只有 `{ enabled }`；v2 增加 `{ provider, keyCipher? }`。密钥只用 `SecretProtection`
 * （生产是 Electron `safeStorage`）加密后按 base64 存 `keyCipher`，明文只在主进程里出现；
 * `getPublic()` 永远只给「哪一家、有没有密钥」。
 *
 * 读盘遇到缺失、损坏、形状不对或版本不认识，一律**回退为关闭**（fail closed），
 * 不覆盖磁盘上的坏文件；人下一次显式保存才会重写。写入仍是
 * tmp＋fsync＋rename＋0600：半截文件不会顶替旧配置。
 */
export type NetworkCredential = { provider: NetworkProvider; key: string }
export type NetworkConfigStore = {
  enabled(): boolean
  /** 渲染层可看的摘要；永不含密钥或密文。 */
  getPublic(): NetworkConfigView
  setEnabled(enabled: boolean): NetworkConfigView
  /** 保存服务商与密钥（长度 1–4096、trim 后非空）；加密不可用即拒，不落明文。 */
  setProvider(provider: NetworkProvider, key: string): NetworkConfigView
  clearProvider(): NetworkConfigView
  /** 只在主进程用：解密失败抛 `BAD_NETWORK_CONFIG`，调用方按「未配置」处理。 */
  credential(): NetworkCredential | null
}

const FILE = 'network-config.json'
const MAX_BYTES = 64 * 1024
const MAX_KEY = 4096
const PROVIDERS: readonly NetworkProvider[] = ['brave', 'tavily']

type Stored = { version: 2; enabled: boolean; provider: NetworkProvider | null; keyCipher?: string }
const disabled = (): Stored => ({ version: 2, enabled: false, provider: null })
const isProvider = (value: unknown): value is NetworkProvider => PROVIDERS.includes(value as NetworkProvider)
/** safeStorage 的密文是 base64；形状不对的文件按坏文件处理，不去猜。 */
const validCipher = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)

function parse(raw: string): Stored | null {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    // v1（含更早没有 version 字段的 P3 文件）只有总开关；读时升级，写时落 v2。
    if (record.version === undefined || record.version === 1) {
      if (typeof record.enabled !== 'boolean') return null
      return { version: 2, enabled: record.enabled, provider: null }
    }
    if (record.version !== 2) return null
    if (typeof record.enabled !== 'boolean' || !('provider' in record)) return null
    if (record.provider !== null && !isProvider(record.provider)) return null
    const provider = record.provider
    if (record.keyCipher !== undefined) {
      // 有密文就必须有服务商；反过来不会出现「有服务商没密文」——那是坏形状。
      if (provider === null || !validCipher(record.keyCipher)) return null
      return { version: 2, enabled: record.enabled, provider, keyCipher: record.keyCipher }
    }
    if (provider !== null) return null
    return { version: 2, enabled: record.enabled, provider: null }
  } catch { return null }
}

const view = (stored: Stored): NetworkConfigView => ({
  enabled: stored.enabled,
  provider: stored.provider,
  hasKey: stored.keyCipher !== undefined
})

export function createNetworkConfigStore(userData: string, protection: SecretProtection): NetworkConfigStore {
  const target = path.join(userData, FILE)
  const read = (): Stored => {
    try { return parse(readFileSync(target, 'utf8')) ?? disabled() }
    // 文件不存在、读不动、不是 UTF-8 文本：都按关闭处理。
    catch { return disabled() }
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
      // 坏的旧文件在下一次显式保存时被替换；这里只沿用能读出来的服务商配置。
      const stored = read()
      return write({ version: 2, enabled, provider: stored.provider, ...(stored.keyCipher ? { keyCipher: stored.keyCipher } : {}) })
    },
    setProvider(provider: NetworkProvider, key: string): NetworkConfigView {
      if (!isProvider(provider)) throw Error('BAD_NETWORK_PROVIDER')
      if (typeof key !== 'string' || !key.trim() || key.length > MAX_KEY || /[\u0000-\u001f\u007f]/u.test(key)) throw Error('BAD_NETWORK_KEY')
      if (!protection.isEncryptionAvailable()) throw Error('SECURE_STORAGE_UNAVAILABLE')
      let keyCipher: string
      try { keyCipher = protection.encryptString(key).toString('base64') } catch { throw Error('SECURE_STORAGE_UNAVAILABLE') }
      const stored = read()
      return write({ version: 2, enabled: stored.enabled, provider, keyCipher })
    },
    clearProvider(): NetworkConfigView {
      // 只清服务商与密文，总开关保持人的选择。
      const stored = read()
      return write({ version: 2, enabled: stored.enabled, provider: null })
    },
    credential(): NetworkCredential | null {
      const stored = read()
      if (!stored.provider || !stored.keyCipher) return null
      if (!protection.isEncryptionAvailable()) throw Error('BAD_NETWORK_CONFIG')
      let key: string
      try { key = protection.decryptString(Buffer.from(stored.keyCipher, 'base64')) }
      catch { throw Error('BAD_NETWORK_CONFIG') }
      // 解出空串等于没有密钥：不把它当配置成功的凭据。
      if (!key) throw Error('BAD_NETWORK_CONFIG')
      return { provider: stored.provider, key }
    }
  }
}
