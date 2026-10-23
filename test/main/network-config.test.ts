import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNetworkConfigStore } from '../../src/main/network-config.ts'
import type { SecretProtection } from '../../src/main/model-config.ts'
import type { NetworkConfigView } from '../../src/shared/ipc.ts'

function directory(): { dir: string; file: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rgent-network-config-'))
  return { dir, file: path.join(dir, 'network-config.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 只在本机内存里做「加密」：测试关心的是存进去的是密文、读回来的是明文。 */
function protection(over: Partial<SecretProtection> = {}): SecretProtection {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const raw = buffer.toString('utf8')
      if (!raw.startsWith('sealed:')) throw Error('cannot decrypt')
      return raw.slice('sealed:'.length)
    },
    ...over
  }
}
const sealed = (value: string): string => protection().encryptString(value).toString('base64')
/** 主进程调用点的等价处理：解密失败按「未配置」看。 */
const credentialOrNull = (store: ReturnType<typeof createNetworkConfigStore>) => {
  try { return store.credential() } catch { return null }
}

/** 期望的公开视图；`provider`/`hasKey` 两个 deprecated 字段按 `searchProvider`/`keyedProviders` 推导。 */
function publicView(over: Partial<NetworkConfigView> = {}): NetworkConfigView {
  const searchProvider = over.searchProvider !== undefined ? over.searchProvider : null
  const keyedProviders = over.keyedProviders ?? []
  return {
    enabled: false,
    searchProvider,
    keyedProviders,
    deepseekKeySource: 'own',
    fetch: 'direct',
    nativeSearch: { minimax: false },
    ...over,
    provider: searchProvider,
    hasKey: searchProvider !== null && keyedProviders.includes(searchProvider)
  }
}

const v3 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 3,
  enabled: false,
  searchProvider: null,
  credentials: {},
  deepseekKeySource: 'own',
  fetch: 'direct',
  nativeSearch: { minimax: false },
  ...over
})

describe('network config store (v3)', () => {
  it('defaults to disabled v3 before any file exists', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection())
      expect(store.enabled()).toBe(false)
      expect(store.getPublic()).toEqual(publicView())
      expect(store.credential()).toBeNull()
      expect(store.credential('brave')).toBeNull()
      expect(store.hasKey('brave')).toBe(false)
      expect(store.hasKey('tavily')).toBe(false)
      expect(store.hasKey('deepseek')).toBe(false)
      expect(() => readFileSync(app.file)).toThrow()
    } finally { app.done() }
  })

  it('persists the v3 shape with the master switch and reloads it', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection())
      expect(store.setEnabled(true)).toEqual(publicView({ enabled: true }))
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual(v3({ enabled: true }))
      expect(store.enabled()).toBe(true)
      expect(createNetworkConfigStore(app.dir, protection()).enabled()).toBe(true)
      store.setEnabled(false)
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual(v3({ enabled: false }))
      expect(createNetworkConfigStore(app.dir, protection()).enabled()).toBe(false)
      // 写入仍是 0600，且不留下临时文件。
      if (process.platform !== 'win32') expect(statSync(app.file).mode & 0o777).toBe(0o600)
      expect(readdirSync(app.dir)).toEqual(['network-config.json'])
    } finally { app.done() }
  })

  it('reads v1 (and the even older no-version file), then writes v3 on the next explicit save', () => {
    const app = directory()
    try {
      writeFileSync(app.file, JSON.stringify({ version: 1, enabled: true }))
      const store = createNetworkConfigStore(app.dir, protection())
      expect(store.enabled()).toBe(true)
      expect(store.getPublic()).toEqual(publicView({ enabled: true }))
      expect(store.credential()).toBeNull()
      // 读不改写：下一次保存才落 v3。
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual({ version: 1, enabled: true })
      store.setFetch('deepseek')
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual(v3({ enabled: true, fetch: 'deepseek' }))
      // 更早的 P3 文件没有 version 字段，同样按 v1 读，且默认值齐全。
      writeFileSync(app.file, JSON.stringify({ enabled: true }))
      expect(createNetworkConfigStore(app.dir, protection()).getPublic()).toEqual(publicView({ enabled: true }))
    } finally { app.done() }
  })

  it('migrates v2 provider/keyCipher into searchProvider/credentials without rewriting until a save', () => {
    const app = directory()
    try {
      const cipher = sealed('tvly-legacy')
      writeFileSync(app.file, JSON.stringify({ version: 2, enabled: true, provider: 'tavily', keyCipher: cipher }))
      const store = createNetworkConfigStore(app.dir, protection())
      expect(store.getPublic()).toEqual(publicView({ enabled: true, searchProvider: 'tavily', keyedProviders: ['tavily'] }))
      expect(store.credential()).toEqual({ provider: 'tavily', key: 'tvly-legacy' })
      expect(store.credential('tavily')).toEqual({ provider: 'tavily', key: 'tvly-legacy' })
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual({ version: 2, enabled: true, provider: 'tavily', keyCipher: cipher })
      // 下一次保存落 v3，密文原样搬运。
      store.setEnabled(false)
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual(v3({
        enabled: false,
        searchProvider: 'tavily',
        credentials: { tavily: cipher }
      }))
      expect(createNetworkConfigStore(app.dir, protection()).credential()).toEqual({ provider: 'tavily', key: 'tvly-legacy' })
      // v2 的「没选服务商、也没有密文」是合法形状，迁移为空凭据。
      writeFileSync(app.file, JSON.stringify({ version: 2, enabled: true, provider: null }))
      expect(createNetworkConfigStore(app.dir, protection()).getPublic()).toEqual(publicView({ enabled: true }))
    } finally { app.done() }
  })

  it('keeps one key per provider in a fixed order, selects the saved provider, and clears one at a time', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection())
      const keys = { brave: 'brave-SECRET', tavily: 'tvly-SECRET', deepseek: 'ds-SECRET' }
      expect(store.saveKey('brave', keys.brave)).toEqual(publicView({ searchProvider: 'brave', keyedProviders: ['brave'] }))
      expect(store.saveKey('tavily', keys.tavily)).toEqual(publicView({ searchProvider: 'tavily', keyedProviders: ['brave', 'tavily'] }))
      expect(store.saveKey('deepseek', keys.deepseek)).toEqual(publicView({
        searchProvider: 'deepseek',
        keyedProviders: ['brave', 'tavily', 'deepseek']
      }))
      const raw = readFileSync(app.file, 'utf8')
      for (const key of Object.values(keys)) expect(raw).not.toContain(key)
      expect((JSON.parse(raw) as { credentials: Record<string, string> }).credentials).toEqual({
        brave: sealed(keys.brave),
        tavily: sealed(keys.tavily),
        deepseek: sealed(keys.deepseek)
      })
      expect(store.credential()).toEqual({ provider: 'deepseek', key: keys.deepseek })
      expect(store.credential('brave')).toEqual({ provider: 'brave', key: keys.brave })
      expect(store.credential('tavily')).toEqual({ provider: 'tavily', key: keys.tavily })
      expect(store.hasKey('brave')).toBe(true)
      expect(store.hasKey('tavily')).toBe(true)
      expect(store.hasKey('deepseek')).toBe(true)

      // 明确清一家：只删这家的密文，当前 searchProvider 仍是 deepseek。
      expect(store.clearKey('tavily')).toEqual(publicView({ searchProvider: 'deepseek', keyedProviders: ['brave', 'deepseek'] }))
      expect(store.credential('tavily')).toBeNull()
      expect(store.credential()).toEqual({ provider: 'deepseek', key: keys.deepseek })
      expect(store.hasKey('tavily')).toBe(false)
      expect((JSON.parse(readFileSync(app.file, 'utf8')) as { credentials: Record<string, string> }).credentials.tavily).toBeUndefined()

      // 缺省清当前 searchProvider（deepseek）；选择本身保留，界面显示「这家 · 未配置」。
      expect(store.clearKey()).toEqual(publicView({ searchProvider: 'deepseek', keyedProviders: ['brave'] }))
      expect(store.credential()).toBeNull()
      expect(store.credential('deepseek')).toBeNull()
      expect(store.hasKey('deepseek')).toBe(false)
      expect(store.hasKey('brave')).toBe(true)
      expect(store.credential('brave')).toEqual({ provider: 'brave', key: keys.brave })
      expect(store.getPublic().provider).toBe('deepseek')
      expect(store.getPublic().hasKey).toBe(false)

      // 再清一次已经清过的服务是幂等空操作，不重写文件。
      const before = readFileSync(app.file, 'utf8')
      expect(store.clearKey('tavily')).toEqual(publicView({ searchProvider: 'deepseek', keyedProviders: ['brave'] }))
      expect(readFileSync(app.file, 'utf8')).toBe(before)
    } finally { app.done() }
  })

  it('never echoes a key or ciphertext, and fills the deprecated fields from the new ones', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection())
      store.saveKey('brave', 'brave-SECRET')
      const view = store.getPublic()
      expect(Object.keys(view).sort()).toEqual([
        'deepseekKeySource', 'enabled', 'fetch', 'hasKey', 'keyedProviders', 'nativeSearch', 'provider', 'searchProvider'
      ])
      expect(view.provider).toBe('brave')
      expect(view.hasKey).toBe(true)
      expect(JSON.stringify(view)).not.toContain('brave-SECRET')
      expect(JSON.stringify(view)).not.toContain(sealed('brave-SECRET'))
      // deprecated 字段跟随新字段，而不是另一份状态。
      store.clearKey()
      expect(store.getPublic().provider).toBe('brave')
      expect(store.getPublic().hasKey).toBe(false)
    } finally { app.done() }
  })

  it('allows an empty DeepSeek credential when the key source is the model, and does not silently use an old own key', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection())
      // 'model' 是合法形状：本文件可以完全没有 credentials.deepseek；设置来源即选中 DeepSeek。
      expect(store.setDeepSeekKeySource('model')).toEqual(publicView({
        searchProvider: 'deepseek', deepseekKeySource: 'model'
      }))
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual(v3({
        searchProvider: 'deepseek', deepseekKeySource: 'model'
      }))
      expect(store.credential('deepseek')).toBeNull()

      // 从别家切到 DeepSeek 也一样；选择 own 后独立密钥照常工作。
      store.saveKey('brave', 'brave-SECRET')
      expect(store.getPublic()).toEqual(publicView({
        searchProvider: 'brave', keyedProviders: ['brave'], deepseekKeySource: 'model'
      }))
      expect(store.setDeepSeekKeySource('own')).toEqual(publicView({
        searchProvider: 'deepseek', keyedProviders: ['brave']
      }))
      expect(store.credential('deepseek')).toBeNull()
      store.saveKey('deepseek', 'ds-own-SECRET')
      expect(store.credential('deepseek')).toEqual({ provider: 'deepseek', key: 'ds-own-SECRET' })
      // 切回 model：密钥仍算「存过」，但不在 model 来源下被悄悄使用。
      store.setDeepSeekKeySource('model')
      expect(store.getPublic()).toEqual(publicView({
        searchProvider: 'deepseek', keyedProviders: ['brave', 'deepseek'], deepseekKeySource: 'model'
      }))
      expect(store.hasKey('deepseek')).toBe(true)
      expect(store.credential('deepseek')).toBeNull()
      expect(store.credential()).toBeNull()
      // 切回 own 后旧独立密钥仍可用。
      store.setDeepSeekKeySource('own')
      expect(store.credential()).toEqual({ provider: 'deepseek', key: 'ds-own-SECRET' })
    } finally { app.done() }
  })

  it('validates fetch, native search and DeepSeek key source before touching the file', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection())
      expect(() => store.setEnabled('yes' as never)).toThrow('BAD_REQUEST')
      expect(() => store.setFetch('proxy' as never)).toThrow('BAD_REQUEST')
      expect(() => store.setNativeSearch('yes' as never)).toThrow('BAD_REQUEST')
      expect(() => store.setDeepSeekKeySource('page' as never)).toThrow('BAD_REQUEST')
      expect(() => readFileSync(app.file)).toThrow()
      // 合法值逐个落盘并保留其它字段。
      expect(store.setFetch('deepseek')).toEqual(publicView({ fetch: 'deepseek' }))
      expect(store.setNativeSearch(true)).toEqual(publicView({ fetch: 'deepseek', nativeSearch: { minimax: true } }))
      expect(store.setDeepSeekKeySource('model')).toEqual(publicView({
        searchProvider: 'deepseek', fetch: 'deepseek', nativeSearch: { minimax: true }, deepseekKeySource: 'model'
      }))
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual(v3({
        searchProvider: 'deepseek', fetch: 'deepseek', nativeSearch: { minimax: true }, deepseekKeySource: 'model'
      }))
      expect(createNetworkConfigStore(app.dir, protection()).getPublic()).toEqual(publicView({
        searchProvider: 'deepseek', fetch: 'deepseek', nativeSearch: { minimax: true }, deepseekKeySource: 'model'
      }))
    } finally { app.done() }
  })

  it('rejects bad provider and key inputs before touching the file', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection())
      expect(() => store.saveKey('google' as never, 'k')).toThrow('BAD_NETWORK_PROVIDER')
      expect(() => store.saveKey('brave', '')).toThrow('BAD_NETWORK_KEY')
      expect(() => store.saveKey('brave', '   ')).toThrow('BAD_NETWORK_KEY')
      expect(() => store.saveKey('brave', 'x'.repeat(4097))).toThrow('BAD_NETWORK_KEY')
      expect(() => store.saveKey('brave', 'line\nbreak')).toThrow('BAD_NETWORK_KEY')
      expect(() => store.clearKey('google' as never)).toThrow('BAD_NETWORK_PROVIDER')
      expect(() => store.credential('google' as never)).toThrow('BAD_NETWORK_PROVIDER')
      expect(() => store.hasKey('google' as never)).toThrow('BAD_NETWORK_PROVIDER')
      expect(() => readFileSync(app.file)).toThrow()
      // 4096 字是允许的上限。
      expect(store.saveKey('brave', 'x'.repeat(4096))).toEqual(publicView({ searchProvider: 'brave', keyedProviders: ['brave'] }))
      expect(store.credential()?.key).toBe('x'.repeat(4096))
    } finally { app.done() }
  })

  it('refuses to save a key when the system secret protection is unavailable', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection({ isEncryptionAvailable: () => false }))
      expect(() => store.saveKey('brave', 'k')).toThrow('SECURE_STORAGE_UNAVAILABLE')
      expect(() => readFileSync(app.file)).toThrow()
      // 已有密文但设备当下解不开：抛 BAD_NETWORK_CONFIG，调用方按未配置看。
      writeFileSync(app.file, JSON.stringify(v3({
        enabled: true, searchProvider: 'brave', credentials: { brave: sealed('k') }
      })))
      expect(() => store.credential()).toThrow('BAD_NETWORK_CONFIG')
      expect(credentialOrNull(store)).toBeNull()
    } finally { app.done() }
  })

  it('treats an undecryptable ciphertext as not configured and never leaks it', () => {
    const app = directory()
    try {
      const cipher = Buffer.from('not-a-sealed-value', 'utf8').toString('base64')
      writeFileSync(app.file, JSON.stringify(v3({
        enabled: true, searchProvider: 'brave', credentials: { brave: cipher }
      })))
      const store = createNetworkConfigStore(app.dir, protection())
      expect(store.getPublic()).toEqual(publicView({ enabled: true, searchProvider: 'brave', keyedProviders: ['brave'] }))
      expect(() => store.credential()).toThrow('BAD_NETWORK_CONFIG')
      expect(credentialOrNull(store)).toBeNull()
      // 坏密文不是坏文件：不覆盖，人能再保存修复。
      expect((JSON.parse(readFileSync(app.file, 'utf8')) as { credentials: { brave: string } }).credentials.brave).toBe(cipher)
    } finally { app.done() }
  })

  it('fails closed on a corrupt, malformed or unknown-version file without overwriting it', () => {
    const app = directory()
    try {
      const valid = v3({ enabled: true, searchProvider: 'brave', credentials: { brave: sealed('k') } })
      const corrupt = [
        'not json{',
        'null',
        '[]',
        JSON.stringify({ version: 1, enabled: 'yes' }),
        JSON.stringify({ version: 2, enabled: true }),
        JSON.stringify({ version: 2, enabled: true, provider: 'google' }),
        JSON.stringify({ version: 2, enabled: true, provider: null, keyCipher: 'AAAA' }),
        JSON.stringify({ version: 2, enabled: true, provider: 'brave' }),
        JSON.stringify({ version: 2, enabled: true, provider: 'brave', keyCipher: 'not base64' }),
        JSON.stringify({ ...valid, searchProvider: undefined }),
        JSON.stringify({ ...valid, searchProvider: 'google' }),
        JSON.stringify({ ...valid, credentials: undefined }),
        JSON.stringify({ ...valid, credentials: { google: 'AAAA' } }),
        JSON.stringify({ ...valid, credentials: { brave: '' } }),
        JSON.stringify({ ...valid, credentials: { brave: 'not base64' } }),
        JSON.stringify({ ...valid, deepseekKeySource: 'page' }),
        JSON.stringify({ ...valid, deepseekKeySource: undefined }),
        JSON.stringify({ ...valid, fetch: 'proxy' }),
        JSON.stringify({ ...valid, fetch: undefined }),
        JSON.stringify({ ...valid, nativeSearch: null }),
        JSON.stringify({ ...valid, nativeSearch: undefined }),
        JSON.stringify({ ...valid, nativeSearch: { minimax: 'yes' } }),
        JSON.stringify({ ...valid, nativeSearch: { minimax: true, extra: 1 } }),
        JSON.stringify({ ...valid, extra: true }),
        JSON.stringify({ ...valid, version: 4 })
      ]
      for (const raw of corrupt) {
        writeFileSync(app.file, raw)
        const store = createNetworkConfigStore(app.dir, protection())
        expect(store.enabled()).toBe(false)
        expect(store.getPublic()).toEqual(publicView())
        expect(store.credential()).toBeNull()
        expect(readFileSync(app.file, 'utf8')).toBe(raw)
      }
      // 人显式保存之后才替换坏文件。
      const store = createNetworkConfigStore(app.dir, protection())
      store.setEnabled(true)
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual(v3({ enabled: true }))
      expect(createNetworkConfigStore(app.dir, protection()).enabled()).toBe(true)
    } finally { app.done() }
  })
})
