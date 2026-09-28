import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createModelConfigStore, type SecretProtection } from '../../src/main/model-config.ts'

const directories: string[] = []
const directory = (): string => {
  const result = mkdtempSync(path.join(os.tmpdir(), 'rgent-model-'))
  directories.push(result)
  return result
}

afterEach(() => {
  for (const item of directories.splice(0)) rmSync(item, { recursive: true, force: true })
})

const protection: SecretProtection = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => {
    const decoded = value.toString()
    if (!decoded.startsWith('encrypted:')) throw new Error('cannot decrypt')
    return decoded.slice('encrypted:'.length)
  }
}

describe('model configuration', () => {
  it('provides current presets and finite run limits without creating a file', () => {
    const root = directory()
    const store = createModelConfigStore(root, protection)
    const snapshot = store.getPublic()
    expect(snapshot.selected).toBe('deepseek')
    expect(snapshot.profiles.deepseek).toEqual({
      baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576, hasKey: false
    })
    expect(snapshot.profiles.minimax).toEqual({
      baseURL: 'https://api.minimax.io/v1', modelId: 'MiniMax-M2.7', contextTokens: 204800, hasKey: false
    })
    expect(snapshot.limits).toEqual({
      none: { seconds: 180, steps: 4, tools: 0 },
      local: { seconds: 300, steps: 12, tools: 24 },
      network: { seconds: 600, steps: 20, tools: 40 }
    })
    expect(() => readFileSync(path.join(root, 'model-config.json'))).toThrow()
  })

  it('encrypts each provider key and never exposes key contents in a public snapshot', () => {
    const root = directory()
    const store = createModelConfigStore(root, protection)
    store.updateProfile('deepseek', {}, 'key-deepseek')
    store.updateProfile('minimax', {}, 'key-minimax')
    store.select('minimax')
    const disk = readFileSync(path.join(root, 'model-config.json'), 'utf8')
    expect(disk).not.toContain('key-deepseek')
    expect(disk).not.toContain('key-minimax')
    expect(store.getPublic().profiles.deepseek.hasKey).toBe(true)
    expect(JSON.stringify(store.getPublic())).not.toContain('key-minimax')
    expect(store.credential('minimax').apiKey).toBe('key-minimax')
    expect(createModelConfigStore(root, protection).credential('minimax').apiKey).toBe('key-minimax')
    store.deleteKey('minimax')
    expect(store.getPublic().profiles.minimax.hasKey).toBe(false)
    expect(() => store.credential('minimax')).toThrow('NO_API_KEY')
  })

  it('fails closed when encryption is unavailable or stored ciphertext cannot be decrypted', () => {
    const root = directory()
    const unavailable = createModelConfigStore(root, { ...protection, isEncryptionAvailable: () => false })
    expect(() => unavailable.updateProfile('deepseek', {}, 'key')).toThrow('ENCRYPTION_UNAVAILABLE')
    expect(existsSync(path.join(root, 'model-config.json'))).toBe(false)
    const store = createModelConfigStore(root, protection)
    store.updateProfile('deepseek', {}, 'key')
    const unavailableAfterSave = createModelConfigStore(root, { ...protection, isEncryptionAvailable: () => false })
    expect(() => unavailableAfterSave.credential('deepseek')).toThrow('ENCRYPTION_UNAVAILABLE')
    const broken = createModelConfigStore(root, { ...protection, decryptString: () => { throw new Error('broken') } })
    expect(() => broken.credential('deepseek')).toThrow('KEY_DECRYPT_FAILED')
  })

  it('rejects unsafe base URLs and invalid finite limits without changing the saved configuration', () => {
    const root = directory()
    const store = createModelConfigStore(root, protection)
    store.updateProfile('custom', { baseURL: 'http://localhost:11434/v1', modelId: 'local', contextTokens: 8192 })
    store.select('custom')
    const before = readFileSync(path.join(root, 'model-config.json'), 'utf8')
    for (const baseURL of ['http://remote.example/v1', 'http://localhost.evil/v1', 'https://user:pass@example.com', 'file:///etc/passwd', 'https://example.com/#x']) {
      expect(() => store.updateProfile('custom', { baseURL, modelId: 'local', contextTokens: 8192 })).toThrow('BAD_BASE_URL')
    }
    expect(() => store.updateLimits('none', { seconds: Infinity, steps: 4, tools: 0 })).toThrow('BAD_LIMITS')
    expect(() => store.updateLimits('none', { seconds: 180, steps: 4, tools: 1 })).toThrow('BAD_LIMITS')
    expect(readFileSync(path.join(root, 'model-config.json'), 'utf8')).toBe(before)
    expect(() => store.credential('custom')).toThrow('NO_API_KEY')
  })

  it('rejects corrupt saved data without replacing it', () => {
    const root = directory()
    writeFileSync(path.join(root, 'model-config.json'), '{broken')
    expect(() => createModelConfigStore(root, protection)).toThrow('BAD_MODEL_CONFIG')
    expect(readFileSync(path.join(root, 'model-config.json'), 'utf8')).toBe('{broken')
  })

  it('caps adjustable limits and context before timer or budget calculations can overflow', () => {
    const store = createModelConfigStore(directory(), protection)
    store.updateLimits('none', { seconds: 86400, steps: 1000, tools: 0 })
    store.updateLimits('network', { seconds: 86400, steps: 1000, tools: 10000 })
    store.updateProfile('custom', { baseURL: 'http://[::1]:11434/v1', modelId: 'local', contextTokens: 16777216 })
    expect(store.getPublic().profiles.custom.contextTokens).toBe(16777216)
    expect(() => store.updateLimits('none', { seconds: 86401, steps: 1, tools: 0 })).toThrow('BAD_LIMITS')
    expect(() => store.updateLimits('local', { seconds: 1, steps: 1001, tools: 1 })).toThrow('BAD_LIMITS')
    expect(() => store.updateLimits('local', { seconds: 1, steps: 1, tools: 10001 })).toThrow('BAD_LIMITS')
    expect(() => store.updateProfile('custom', { contextTokens: 16777217 })).toThrow('BAD_CONTEXT_TOKENS')
    expect(() => store.updateProfile('custom', { contextTokens: 0 })).toThrow('BAD_CONTEXT_TOKENS')
  })
})
