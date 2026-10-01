import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createModelConfigStore, MAX_CONNECTIONS, MAX_MODELS_PER_CONNECTION, type SecretProtection } from '../../src/main/model-config.ts'

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
  it('provides preset connections and finite run limits without creating a file', () => {
    const root = directory()
    const snapshot = createModelConfigStore(root, protection).getPublic()
    expect(snapshot.connections.map((connection) => [connection.provider, connection.baseURL, connection.hasKey, connection.modelCount])).toEqual([
      ['deepseek', 'https://api.deepseek.com', false, 1],
      ['minimax', 'https://api.minimax.io/v1', false, 1]
    ])
    expect(snapshot.models.map((model) => [model.modelId, model.contextTokens])).toEqual([
      ['deepseek-flash', 1048576],
      ['MiniMax-M2.7', 204800]
    ])
    expect(snapshot.defaultModelId).toBe(snapshot.models[0]!.id)
    expect(snapshot.limits).toEqual({
      none: { seconds: 180, steps: 4, tools: 0 },
      local: { seconds: 300, steps: 12, tools: 24 },
      network: { seconds: 600, steps: 20, tools: 40 }
    })
    expect(() => readFileSync(configPath(root))).toThrow()
  })

  it('keeps each connection key separate, hides ciphertext, and allows two connections of one provider', () => {
    const root = directory()
    const store = createModelConfigStore(root, protection)
    const [deepseek, minimax] = store.getPublic().connections
    store.updateConnection(deepseek!.id, deepseek!.baseURL, 'key-deepseek')
    store.updateConnection(minimax!.id, minimax!.baseURL, 'key-minimax')
    store.addConnection({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', modelId: 'deepseek-reasoner', contextTokens: 1048576 }, 'key-second')

    const disk = readFileSync(configPath(root), 'utf8')
    for (const secret of ['key-deepseek', 'key-minimax', 'key-second']) expect(disk).not.toContain(secret)
    expect(JSON.stringify(store.getPublic())).not.toContain('key-')

    const connections = store.getPublic().connections
    const second = connections[2]!
    expect(connections.filter((connection) => connection.provider === 'deepseek')).toHaveLength(2)
    expect(store.connectionSecret(second.id).apiKey).toBe('key-second')
    expect(store.connectionSecret(deepseek!.id).apiKey).toBe('key-deepseek')
    expect(createModelConfigStore(root, protection).connectionSecret(minimax!.id).apiKey).toBe('key-minimax')

    store.deleteKey(second.id)
    expect(store.getPublic().connections[2]!.hasKey).toBe(false)
    expect(store.getPublic().connections[0]!.hasKey).toBe(true)
    expect(() => store.connectionSecret(second.id)).toThrow('NO_API_KEY')
  })

  it('fails closed when encryption is unavailable or stored ciphertext cannot be decrypted', () => {
    const root = directory()
    // 未落盘时每次实例化各自生成预置 id，所以同一实例内取 id
    const unavailable = createModelConfigStore(root, { ...protection, isEncryptionAvailable: () => false })
    const draft = unavailable.getPublic().connections[0]!
    expect(() => unavailable.updateConnection(draft.id, draft.baseURL, 'key')).toThrow('ENCRYPTION_UNAVAILABLE')
    expect(existsSync(configPath(root))).toBe(false)

    const store = createModelConfigStore(root, protection)
    const deepseek = store.getPublic().connections[0]!
    store.updateConnection(deepseek.id, deepseek.baseURL, 'key')
    expect(() => createModelConfigStore(root, { ...protection, isEncryptionAvailable: () => false }).credential()).toThrow('ENCRYPTION_UNAVAILABLE')
    expect(() => createModelConfigStore(root, { ...protection, decryptString: () => { throw new Error('broken') } }).credential()).toThrow('KEY_DECRYPT_FAILED')
  })

  it('rejects unsafe base URLs and invalid limits without changing the saved configuration', () => {
    const root = directory()
    const store = createModelConfigStore(root, protection)
    const connection = store.getPublic().connections[0]!
    store.updateConnection(connection.id, 'https://api.deepseek.com', 'key')
    const before = readFileSync(configPath(root), 'utf8')
    for (const baseURL of ['http://remote.example/v1', 'http://localhost.evil/v1', 'https://user:pass@example.com', 'file:///etc/passwd', 'https://example.com/#x']) {
      expect(() => store.updateConnection(connection.id, baseURL)).toThrow('BAD_BASE_URL')
    }
    expect(() => store.updateLimits('none', { seconds: Infinity, steps: 4, tools: 0 })).toThrow('BAD_LIMITS')
    expect(() => store.updateLimits('none', { seconds: 180, steps: 4, tools: 1 })).toThrow('BAD_LIMITS')
    expect(readFileSync(configPath(root), 'utf8')).toBe(before)
    // 自定义连接允许先建后填地址，但真要用它时必须失败，而不是拿空地址去请求
    store.addConnection({ provider: 'custom', baseURL: '', modelId: 'local', contextTokens: 8192 }, 'key-local')
    const custom = store.getPublic().connections.find((item) => item.provider === 'custom')!
    store.setDefault(store.getPublic().models.find((model) => model.connectionId === custom.id)!.id)
    expect(() => store.connectionSecret(custom.id)).toThrow('BAD_BASE_URL')
    expect(() => store.credential()).toThrow('BAD_BASE_URL')
  })

  it('rejects corrupt saved data without replacing it', () => {
    const root = directory()
    writeFileSync(configPath(root), '{broken')
    expect(() => createModelConfigStore(root, protection)).toThrow('BAD_MODEL_CONFIG')
    expect(readFileSync(configPath(root), 'utf8')).toBe('{broken')

    const dangling = JSON.stringify({
      version: 2,
      connections: [{ id: 'c1', provider: 'deepseek', baseURL: 'https://api.deepseek.com' }],
      models: [{ id: 'm1', connectionId: 'nope', modelId: 'x', contextTokens: 1024 }],
      defaultModelId: null,
      limits: { none: { seconds: 180, steps: 4, tools: 0 }, local: { seconds: 300, steps: 12, tools: 24 }, network: { seconds: 600, steps: 20, tools: 40 } }
    })
    writeFileSync(configPath(root), dangling)
    expect(() => createModelConfigStore(root, protection)).toThrow('BAD_MODEL_CONFIG')
    expect(readFileSync(configPath(root), 'utf8')).toBe(dangling)
  })

  it('caps connections, models and context before timer or budget calculations can overflow', () => {
    const store = createModelConfigStore(directory(), protection)
    store.updateLimits('none', { seconds: 86400, steps: 1000, tools: 0 })
    store.updateLimits('network', { seconds: 86400, steps: 1000, tools: 10000 })
    const connection = store.getPublic().connections[0]!
    store.addModel({ connectionId: connection.id, modelId: 'big', contextTokens: 16777216 })
    expect(() => store.updateLimits('none', { seconds: 86401, steps: 1, tools: 0 })).toThrow('BAD_LIMITS')
    expect(() => store.updateLimits('local', { seconds: 1, steps: 1001, tools: 1 })).toThrow('BAD_LIMITS')
    expect(() => store.updateLimits('local', { seconds: 1, steps: 1, tools: 10001 })).toThrow('BAD_LIMITS')
    expect(() => store.addModel({ connectionId: connection.id, modelId: 'too-big', contextTokens: 16777217 })).toThrow('BAD_CONTEXT_TOKENS')
    expect(() => store.addModel({ connectionId: connection.id, modelId: 'zero', contextTokens: 0 })).toThrow('BAD_CONTEXT_TOKENS')
    expect(() => store.addModel({ connectionId: connection.id, modelId: 'big', contextTokens: 1024 })).toThrow('DUPLICATE_MODEL')
    expect(() => store.addModel({ connectionId: 'missing', modelId: 'x', contextTokens: 1024 })).toThrow('CONNECTION_NOT_FOUND')
    for (let index = store.getPublic().connections.length; index < MAX_CONNECTIONS; index += 1) {
      store.addConnection({ provider: 'custom', baseURL: '', modelId: `m${index}`, contextTokens: 1024 })
    }
    expect(() => store.addConnection({ provider: 'custom', baseURL: '', modelId: 'one-too-many', contextTokens: 1024 })).toThrow('TOO_MANY_CONNECTIONS')
    for (let index = store.getPublic().models.filter((model) => model.connectionId === connection.id).length; index < MAX_MODELS_PER_CONNECTION; index += 1) {
      store.addModel({ connectionId: connection.id, modelId: `filler-${index}`, contextTokens: 1024 })
    }
    expect(() => store.addModel({ connectionId: connection.id, modelId: 'overflow', contextTokens: 1024 })).toThrow('TOO_MANY_MODELS')
  })

  it('migrates a v1 file in memory, keeps its keys and default, and only writes v2 on the next change', () => {
    const root = directory()
    writeFileSync(configPath(root), v1File({ keys: { deepseek: 'key-deepseek', minimax: 'key-minimax' } }))
    const store = createModelConfigStore(root, protection)
    const snapshot = store.getPublic()
    expect(readFileSync(configPath(root), 'utf8')).toBe(v1File({ keys: { deepseek: 'key-deepseek', minimax: 'key-minimax' } }))
    expect(snapshot.connections.map((connection) => [connection.provider, connection.baseURL, connection.hasKey])).toEqual([
      ['deepseek', 'https://api.deepseek.com', true],
      ['minimax', 'https://api.minimaxi.com/v1', true]
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
    const [deepseekConnection, minimaxConnection] = store.getPublic().connections
    const deepseekModel = store.getPublic().models.find((model) => model.connectionId === deepseekConnection!.id)!
    const minimaxModel = store.getPublic().models.find((model) => model.connectionId === minimaxConnection!.id)!

    store.setDefault(null)
    expect(store.getPublic().defaultModelId).toBeNull()
    expect(() => store.credential()).toThrow('NO_MODEL_SELECTED')
    expect(() => store.setDefault('missing')).toThrow('MODEL_NOT_FOUND')

    store.setDefault(deepseekModel.id)
    store.removeModel(deepseekModel.id)
    expect(store.getPublic().defaultModelId).toBeNull()
    expect(() => store.credential()).toThrow('NO_MODEL_SELECTED')

    store.setDefault(minimaxModel.id)
    store.removeConnection(minimaxConnection!.id)
    expect(store.getPublic().defaultModelId).toBeNull()
    expect(store.getPublic().connections).toHaveLength(1)

    // 空配置里新加的第一条连接会成为默认，避免用户加完却无法发起
    store.removeConnection(deepseekConnection!.id)
    store.addConnection({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576 })
    expect(store.getPublic().defaultModelId).toBe(store.getPublic().models[0]!.id)
  })
})
