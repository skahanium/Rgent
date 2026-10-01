import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createModelConfigStore, MAX_MODELS_PER_PROVIDER, type SecretProtection } from '../../src/main/model-config.ts'

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

const configPath = (root: string): string => path.join(root, 'model-config.json')

const v1File = (overrides: { selected?: string; keys?: Record<string, string> } = {}): string => JSON.stringify({
  version: 1,
  selected: overrides.selected ?? 'minimax',
  profiles: {
    deepseek: { baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576, ...(overrides.keys?.deepseek ? { encryptedKey: Buffer.from(`encrypted:${overrides.keys.deepseek}`).toString('base64') } : {}) },
    minimax: { baseURL: 'https://api.minimaxi.com/v1', modelId: 'MiniMax-M3', contextTokens: 204800, ...(overrides.keys?.minimax ? { encryptedKey: Buffer.from(`encrypted:${overrides.keys.minimax}`).toString('base64') } : {}) },
    custom: { baseURL: '', modelId: '', contextTokens: 0 }
  },
  limits: {
    none: { seconds: 180, steps: 4, tools: 0 },
    local: { seconds: 300, steps: 12, tools: 24 },
    network: { seconds: 600, steps: 20, tools: 40 }
  }
})

describe('model configuration', () => {
  it('exposes exactly one entry per provider and creates no file until something changes', () => {
    const root = directory()
    const snapshot = createModelConfigStore(root, protection).getPublic()
    expect(snapshot.providers).toEqual([
      { provider: 'deepseek', configured: true, baseURL: 'https://api.deepseek.com', hasKey: false, modelCount: 1 },
      { provider: 'minimax', configured: true, baseURL: 'https://api.minimax.io/v1', hasKey: false, modelCount: 1 },
      { provider: 'custom', configured: false, baseURL: '', hasKey: false, modelCount: 0 }
    ])
    expect(snapshot.models.map((model) => [model.provider, model.modelId, model.contextTokens])).toEqual([
      ['deepseek', 'deepseek-flash', 1048576],
      ['minimax', 'MiniMax-M2.7', 204800]
    ])
    expect(snapshot.defaultModelId).toBe(snapshot.models[0]!.id)
    expect(snapshot.limits).toEqual({
      none: { seconds: 180, steps: 4, tools: 0 },
      local: { seconds: 300, steps: 12, tools: 24 },
      network: { seconds: 600, steps: 20, tools: 40 }
    })
    expect(() => readFileSync(configPath(root))).toThrow()
  })

  it('keeps one credential per provider and never adds a second configuration for the same provider', () => {
    const root = directory()
    const store = createModelConfigStore(root, protection)
    store.saveProvider({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576 }, 'key-deepseek')
    store.saveProvider({ provider: 'minimax', baseURL: 'https://api.minimaxi.com/v1', modelId: 'MiniMax-M3', contextTokens: 204800 }, 'key-minimax')

    const disk = readFileSync(configPath(root), 'utf8')
    for (const secret of ['key-deepseek', 'key-minimax']) expect(disk).not.toContain(secret)
    expect(JSON.stringify(store.getPublic())).not.toContain('key-')

    // 再次保存同一供应商：只改端点与密钥，不新增第二条配置、不重复建模型
    store.saveProvider({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', modelId: 'ignored', contextTokens: 1 })
    const after = store.getPublic()
    expect(after.providers).toHaveLength(3)
    expect(after.providers.filter((item) => item.provider === 'deepseek')).toHaveLength(1)
    expect(after.models.filter((model) => model.provider === 'deepseek')).toHaveLength(1)

    expect(store.providerSecret('deepseek').apiKey).toBe('key-deepseek')
    expect(store.providerSecret('minimax').apiKey).toBe('key-minimax')
    expect(createModelConfigStore(root, protection).providerSecret('minimax').apiKey).toBe('key-minimax')

    store.deleteKey('minimax')
    expect(store.getPublic().providers[1]!.hasKey).toBe(false)
    expect(store.getPublic().providers[0]!.hasKey).toBe(true)
    expect(() => store.providerSecret('minimax')).toThrow('NO_API_KEY')
  })

  it('fails closed when encryption is unavailable or stored ciphertext cannot be decrypted', () => {
    const root = directory()
    const unavailable = createModelConfigStore(root, { ...protection, isEncryptionAvailable: () => false })
    expect(() => unavailable.saveProvider({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576 }, 'key')).toThrow('ENCRYPTION_UNAVAILABLE')
    expect(existsSync(configPath(root))).toBe(false)

    const store = createModelConfigStore(root, protection)
    store.saveProvider({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576 }, 'key')
    expect(() => createModelConfigStore(root, { ...protection, isEncryptionAvailable: () => false }).credential()).toThrow('ENCRYPTION_UNAVAILABLE')
    expect(() => createModelConfigStore(root, { ...protection, decryptString: () => { throw new Error('broken') } }).credential()).toThrow('KEY_DECRYPT_FAILED')
  })

  it('rejects unsafe base URLs and invalid limits without changing the saved configuration', () => {
    const root = directory()
    const store = createModelConfigStore(root, protection)
    store.saveProvider({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576 }, 'key')
    const before = readFileSync(configPath(root), 'utf8')
    for (const baseURL of ['http://remote.example/v1', 'http://localhost.evil/v1', 'https://user:pass@example.com', 'file:///etc/passwd', 'https://example.com/#x']) {
      expect(() => store.saveProvider({ provider: 'deepseek', baseURL, modelId: 'deepseek-flash', contextTokens: 1048576 })).toThrow('BAD_BASE_URL')
    }
    expect(() => store.updateLimits('none', { seconds: Infinity, steps: 4, tools: 0 })).toThrow('BAD_LIMITS')
    expect(() => store.updateLimits('none', { seconds: 180, steps: 4, tools: 1 })).toThrow('BAD_LIMITS')
    expect(readFileSync(configPath(root), 'utf8')).toBe(before)

    // 自定义供应商允许先建后填地址；真要用它时显错，而不是拿空地址去请求
    store.saveProvider({ provider: 'custom', baseURL: '', modelId: 'local', contextTokens: 8192 }, 'key-local')
    const customModel = store.getPublic().models.find((model) => model.provider === 'custom')!
    store.setDefault(customModel.id)
    expect(() => store.providerSecret('custom')).toThrow('BAD_BASE_URL')
    expect(() => store.credential()).toThrow('BAD_BASE_URL')
  })

  it('rejects corrupt saved data without replacing it', () => {
    const root = directory()
    writeFileSync(configPath(root), '{broken')
    expect(() => createModelConfigStore(root, protection)).toThrow('BAD_MODEL_CONFIG')
    expect(readFileSync(configPath(root), 'utf8')).toBe('{broken')

    const limits = { none: { seconds: 180, steps: 4, tools: 0 }, local: { seconds: 300, steps: 12, tools: 24 }, network: { seconds: 600, steps: 20, tools: 40 } }
    const dangling = JSON.stringify({ version: 2, connections: [{ id: 'c1', provider: 'deepseek', baseURL: 'https://api.deepseek.com' }], models: [{ id: 'm1', connectionId: 'nope', modelId: 'x', contextTokens: 1024 }], defaultModelId: null, limits })
    writeFileSync(configPath(root), dangling)
    expect(() => createModelConfigStore(root, protection)).toThrow('BAD_MODEL_CONFIG')
    expect(readFileSync(configPath(root), 'utf8')).toBe(dangling)

    // 同一供应商两条配置的存储文件必须被拒绝：这是「一个供应商一份凭据」的硬保证
    const duplicate = JSON.stringify({
      version: 2,
      connections: [
        { id: 'c1', provider: 'deepseek', baseURL: 'https://api.deepseek.com' },
        { id: 'c2', provider: 'deepseek', baseURL: 'https://api.deepseek.com' }
      ],
      models: [],
      defaultModelId: null,
      limits
    })
    writeFileSync(configPath(root), duplicate)
    expect(() => createModelConfigStore(root, protection)).toThrow('BAD_MODEL_CONFIG')
    expect(readFileSync(configPath(root), 'utf8')).toBe(duplicate)
  })

  it('caps models per provider and refuses duplicates before timer or budget calculations can overflow', () => {
    const store = createModelConfigStore(directory(), protection)
    store.updateLimits('none', { seconds: 86400, steps: 1000, tools: 0 })
    store.updateLimits('network', { seconds: 86400, steps: 1000, tools: 10000 })
    store.addModel({ provider: 'deepseek', modelId: 'big', contextTokens: 16777216 })
    expect(() => store.updateLimits('none', { seconds: 86401, steps: 1, tools: 0 })).toThrow('BAD_LIMITS')
    expect(() => store.updateLimits('local', { seconds: 1, steps: 1001, tools: 1 })).toThrow('BAD_LIMITS')
    expect(() => store.updateLimits('local', { seconds: 1, steps: 1, tools: 10001 })).toThrow('BAD_LIMITS')
    expect(() => store.addModel({ provider: 'deepseek', modelId: 'too-big', contextTokens: 16777217 })).toThrow('BAD_CONTEXT_TOKENS')
    expect(() => store.addModel({ provider: 'deepseek', modelId: 'zero', contextTokens: 0 })).toThrow('BAD_CONTEXT_TOKENS')
    expect(() => store.addModel({ provider: 'deepseek', modelId: 'big', contextTokens: 1024 })).toThrow('DUPLICATE_MODEL')
    expect(() => store.addModel({ provider: 'custom', modelId: 'x', contextTokens: 1024 })).toThrow('CONNECTION_NOT_FOUND')
    expect(() => store.addModel({ provider: 'nope', modelId: 'x', contextTokens: 1024 })).toThrow('BAD_PROVIDER')
    const used = store.getPublic().models.filter((model) => model.provider === 'deepseek').length
    for (let index = used; index < MAX_MODELS_PER_PROVIDER; index += 1) {
      store.addModel({ provider: 'deepseek', modelId: `filler-${index}`, contextTokens: 1024 })
    }
    expect(() => store.addModel({ provider: 'deepseek', modelId: 'overflow', contextTokens: 1024 })).toThrow('TOO_MANY_MODELS')
    // 另一家供应商的额度互不影响
    store.addModel({ provider: 'minimax', modelId: 'independent', contextTokens: 1024 })
  })

  it('migrates a v1 file in memory, keeps its keys and default, and only writes v2 on the next change', () => {
    const root = directory()
    const original = v1File({ keys: { deepseek: 'key-deepseek', minimax: 'key-minimax' } })
    writeFileSync(configPath(root), original)
    const store = createModelConfigStore(root, protection)
    const snapshot = store.getPublic()
    expect(readFileSync(configPath(root), 'utf8')).toBe(original)
    expect(snapshot.providers).toEqual([
      { provider: 'deepseek', configured: true, baseURL: 'https://api.deepseek.com', hasKey: true, modelCount: 1 },
      { provider: 'minimax', configured: true, baseURL: 'https://api.minimaxi.com/v1', hasKey: true, modelCount: 1 },
      { provider: 'custom', configured: false, baseURL: '', hasKey: false, modelCount: 0 }
    ])
    expect(snapshot.models.map((model) => model.modelId)).toEqual(['deepseek-flash', 'MiniMax-M3'])
    expect(snapshot.defaultModelId).toBe(snapshot.models[1]!.id)
    expect(store.credential()).toEqual({
      provider: 'minimax', baseURL: 'https://api.minimaxi.com/v1', modelId: 'MiniMax-M3', contextTokens: 204800, apiKey: 'key-minimax'
    })

    store.setDefault(snapshot.models[0]!.id)
    const written = JSON.parse(readFileSync(configPath(root), 'utf8')) as { version: number; defaultModelId: string }
    expect(written.version).toBe(2)
    expect(written.defaultModelId).toBe(snapshot.models[0]!.id)
    expect(createModelConfigStore(root, protection).credential().apiKey).toBe('key-deepseek')
  })

  it('never falls back to another model when the default is missing or removed', () => {
    const root = directory()
    const store = createModelConfigStore(root, protection)
    const deepseek = store.getPublic().models.find((model) => model.provider === 'deepseek')!
    const minimax = store.getPublic().models.find((model) => model.provider === 'minimax')!

    store.setDefault(null)
    expect(store.getPublic().defaultModelId).toBeNull()
    expect(() => store.credential()).toThrow('NO_MODEL_SELECTED')
    expect(() => store.setDefault('missing')).toThrow('MODEL_NOT_FOUND')

    store.setDefault(deepseek.id)
    store.removeModel(deepseek.id)
    expect(store.getPublic().defaultModelId).toBeNull()
    expect(() => store.credential()).toThrow('NO_MODEL_SELECTED')

    store.setDefault(minimax.id)
    store.removeProvider('minimax')
    expect(store.getPublic().defaultModelId).toBeNull()
    expect(store.getPublic().providers[1]).toEqual({ provider: 'minimax', configured: false, baseURL: '', hasKey: false, modelCount: 0 })

    // 空配置里首次保存的模型会成为默认，避免用户配好却无法发起
    store.removeProvider('deepseek')
    store.saveProvider({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576 })
    expect(store.getPublic().defaultModelId).toBe(store.getPublic().models[0]!.id)
  })
})
