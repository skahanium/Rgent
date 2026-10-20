import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNetworkConfigStore } from '../../src/main/network-config.ts'
import type { SecretProtection } from '../../src/main/model-config.ts'

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
/** 主进程调用点的等价处理：解密失败按「未配置」看。 */
const credentialOrNull = (store: ReturnType<typeof createNetworkConfigStore>) => {
  try { return store.credential() } catch { return null }
}

describe('network config store', () => {
  it('defaults to disabled before any file exists', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection())
      expect(store.enabled()).toBe(false)
      expect(store.getPublic()).toEqual({ enabled: false, provider: null, hasKey: false })
      expect(store.credential()).toBeNull()
      expect(() => readFileSync(app.file)).toThrow()
    } finally { app.done() }
  })

  it('persists the master switch as v2 and reloads it', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection())
      expect(store.setEnabled(true)).toEqual({ enabled: true, provider: null, hasKey: false })
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual({ version: 2, enabled: true, provider: null })
      expect(store.enabled()).toBe(true)
      expect(createNetworkConfigStore(app.dir, protection()).enabled()).toBe(true)
      store.setEnabled(false)
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual({ version: 2, enabled: false, provider: null })
      expect(createNetworkConfigStore(app.dir, protection()).enabled()).toBe(false)
      // 写入仍是 0600，且不留下临时文件。
      if (process.platform !== 'win32') expect(statSync(app.file).mode & 0o777).toBe(0o600)
      expect(readdirSync(app.dir)).toEqual(['network-config.json'])
    } finally { app.done() }
  })

  it('reads a v1 file with only the switch, then writes v2 on the next explicit save', () => {
    const app = directory()
    try {
      writeFileSync(app.file, JSON.stringify({ version: 1, enabled: true }))
      const store = createNetworkConfigStore(app.dir, protection())
      expect(store.enabled()).toBe(true)
      expect(store.getPublic()).toEqual({ enabled: true, provider: null, hasKey: false })
      expect(store.credential()).toBeNull()
      // 读不改写：下一次保存才落 v2。
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual({ version: 1, enabled: true })
      store.setEnabled(false)
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual({ version: 2, enabled: false, provider: null })
      // 更早的 P3 文件没有 version 字段，同样按 v1 读。
      writeFileSync(app.file, JSON.stringify({ enabled: true }))
      expect(createNetworkConfigStore(app.dir, protection()).enabled()).toBe(true)
    } finally { app.done() }
  })

  it('round-trips provider and key, and the public view never contains the key', () => {
    const app = directory()
    try {
      const key = 'tvly-SECRET-1234567890'
      const store = createNetworkConfigStore(app.dir, protection())
      expect(store.setProvider('tavily', key)).toEqual({ enabled: false, provider: 'tavily', hasKey: true })
      const raw = readFileSync(app.file, 'utf8')
      const stored = JSON.parse(raw) as Record<string, unknown>
      expect(stored).toEqual({
        version: 2, enabled: false, provider: 'tavily',
        keyCipher: protection().encryptString(key).toString('base64')
      })
      expect(raw).not.toContain(key)
      expect(Object.keys(store.getPublic()).sort()).toEqual(['enabled', 'hasKey', 'provider'])
      expect(JSON.stringify(store.getPublic())).not.toContain(key)
      expect(JSON.stringify(store.getPublic())).not.toContain(String(stored.keyCipher))
      expect(store.credential()).toEqual({ provider: 'tavily', key })
      // 总开关保存不能顺手丢掉服务商与密文。
      store.setEnabled(true)
      expect(store.credential()).toEqual({ provider: 'tavily', key })
      expect(createNetworkConfigStore(app.dir, protection()).credential()).toEqual({ provider: 'tavily', key })
      expect(createNetworkConfigStore(app.dir, protection()).getPublic()).toEqual({ enabled: true, provider: 'tavily', hasKey: true })
    } finally { app.done() }
  })

  it('refuses to save a key when the system secret protection is unavailable', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection({ isEncryptionAvailable: () => false }))
      expect(() => store.setProvider('brave', 'k')).toThrow('SECURE_STORAGE_UNAVAILABLE')
      expect(() => readFileSync(app.file)).toThrow()
      // 已有密文但设备当下解不开：抛 BAD_NETWORK_CONFIG，调用方按未配置看。
      writeFileSync(app.file, JSON.stringify({ version: 2, enabled: true, provider: 'brave', keyCipher: protection().encryptString('k').toString('base64') }))
      expect(() => store.credential()).toThrow('BAD_NETWORK_CONFIG')
      expect(credentialOrNull(store)).toBeNull()
    } finally { app.done() }
  })

  it('treats an undecryptable ciphertext as not configured and never leaks it', () => {
    const app = directory()
    try {
      const cipher = Buffer.from('not-a-sealed-value', 'utf8').toString('base64')
      writeFileSync(app.file, JSON.stringify({ version: 2, enabled: true, provider: 'brave', keyCipher: cipher }))
      const store = createNetworkConfigStore(app.dir, protection())
      expect(store.getPublic()).toEqual({ enabled: true, provider: 'brave', hasKey: true })
      expect(() => store.credential()).toThrow('BAD_NETWORK_CONFIG')
      expect(credentialOrNull(store)).toBeNull()
      // 坏密文不是坏文件：不覆盖，人能再保存修复。
      expect(JSON.parse(readFileSync(app.file, 'utf8')).keyCipher).toBe(cipher)
    } finally { app.done() }
  })

  it('clears only the provider and key, keeping the master switch', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection())
      store.setEnabled(true)
      store.setProvider('brave', 'brave-key')
      expect(store.clearProvider()).toEqual({ enabled: true, provider: null, hasKey: false })
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual({ version: 2, enabled: true, provider: null })
      expect(store.credential()).toBeNull()
      expect(store.enabled()).toBe(true)
    } finally { app.done() }
  })

  it('fails closed on a corrupt, malformed or unknown-version file without overwriting it', () => {
    const app = directory()
    try {
      const corrupt = [
        'not json{',
        JSON.stringify({ version: 1, enabled: 'yes' }),
        JSON.stringify({ version: 2, enabled: true }), // 缺 provider
        JSON.stringify({ version: 2, enabled: true, provider: 'google' }),
        JSON.stringify({ version: 2, enabled: true, provider: null, keyCipher: 'AAAA' }), // 有密文没服务商
        JSON.stringify({ version: 2, enabled: true, provider: 'brave' }), // 有服务商没密文
        JSON.stringify({ version: 2, enabled: true, provider: 'brave', keyCipher: 'not base64' }),
        JSON.stringify({ version: 3, enabled: true, provider: null }),
        '[]'
      ]
      for (const raw of corrupt) {
        writeFileSync(app.file, raw)
        const store = createNetworkConfigStore(app.dir, protection())
        expect(store.enabled()).toBe(false)
        expect(store.getPublic()).toEqual({ enabled: false, provider: null, hasKey: false })
        expect(store.credential()).toBeNull()
        expect(readFileSync(app.file, 'utf8')).toBe(raw)
      }
      // 人显式保存之后才替换坏文件。
      const store = createNetworkConfigStore(app.dir, protection())
      store.setEnabled(true)
      expect(createNetworkConfigStore(app.dir, protection()).enabled()).toBe(true)
    } finally { app.done() }
  })

  it('rejects bad service, key and switch inputs before touching the file', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir, protection())
      expect(() => store.setProvider('google' as never, 'k')).toThrow('BAD_NETWORK_PROVIDER')
      expect(() => store.setProvider('brave', '')).toThrow('BAD_NETWORK_KEY')
      expect(() => store.setProvider('brave', '   ')).toThrow('BAD_NETWORK_KEY')
      expect(() => store.setProvider('brave', 'x'.repeat(4097))).toThrow('BAD_NETWORK_KEY')
      expect(() => store.setProvider('brave', 'line\nbreak')).toThrow('BAD_NETWORK_KEY')
      expect(() => store.setEnabled('yes' as never)).toThrow('BAD_REQUEST')
      expect(() => readFileSync(app.file)).toThrow()
      // 4096 字是允许的上限。
      expect(store.setProvider('brave', 'x'.repeat(4096))).toEqual({ enabled: false, provider: 'brave', hasKey: true })
    } finally { app.done() }
  })
})
