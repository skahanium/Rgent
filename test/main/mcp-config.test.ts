import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMcpConfigStore } from '../../src/main/mcp-config.ts'
import type { SecretProtection } from '../../src/main/model-config.ts'

const URL_A = 'https://mcp.example.com/mcp'
const URL_B = 'https://other.example.org/mcp'

function directory(): { dir: string; file: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rgent-mcp-config-'))
  return { dir, file: path.join(dir, 'mcp-config.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
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

const storeIn = (dir: string, over: Partial<SecretProtection> = {}) => createMcpConfigStore(dir, protection(over))
const cipherOf = (token: string): string => protection().encryptString(token).toString('base64')
const corruptFiles = (dir: string): string[] => readdirSync(dir).filter(name => name.startsWith('mcp-config.json.corrupt-'))
const tempFiles = (dir: string): string[] => readdirSync(dir).filter(name => name.endsWith('.tmp'))
const storedServer = (raw: string): Record<string, unknown> =>
  (JSON.parse(raw) as { servers: Record<string, unknown>[] }).servers[0]!

/** 先完整添加一台可用的服务器；返回 id。 */
function addServer(store: ReturnType<typeof storeIn>, over: { name?: string; url?: string; token?: string; enabled?: boolean } = {}): string {
  const view = store.upsert({
    name: over.name ?? '示例服务器',
    url: over.url ?? URL_A,
    token: over.token ?? 'token-123',
    enabled: over.enabled ?? false
  })
  return view.servers[view.servers.length - 1]!.id
}

describe('MCP 配置存储', () => {
  it('starts empty and fail-closed, without creating a file', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      expect(store.getPublic()).toEqual({ servers: [] })
      expect(store.servers()).toEqual([])
      expect(store.availability()).toEqual({ available: false, servers: [] })
      expect(store.credential('nope')).toBeNull()
      expect(() => readFileSync(app.file)).toThrow()
    } finally { app.done() }
  })

  it('round-trips a token through SecretProtection; the public view never contains it or the cipher', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      const id = addServer(store)
      const token = 'token-123'
      const raw = readFileSync(app.file, 'utf8')
      const stored = storedServer(raw)
      expect(stored).toMatchObject({
        id,
        name: '示例服务器',
        url: URL_A,
        enabled: false,
        tools: [],
        whitelist: [],
        tokenCipher: cipherOf(token)
      })
      expect(raw).not.toContain(token)
      expect(store.credential(id)).toEqual({ url: URL_A, token })
      expect(store.servers().find(server => server.id === id)?.credential).toEqual({ url: URL_A, token })
      const view = store.getPublic()
      expect(view.servers).toHaveLength(1)
      expect(JSON.stringify(view)).not.toContain(token)
      expect(JSON.stringify(view)).not.toContain(cipherOf(token))
      expect(view.servers[0]).toMatchObject({
        id, name: '示例服务器', url: URL_A, host: 'mcp.example.com', enabled: false, hasToken: true, tools: [], whitelist: []
      })
      // 再来一个 store 从磁盘读回同样的内容。
      expect(storeIn(app.dir).credential(id)).toEqual({ url: URL_A, token })
    } finally { app.done() }
  })

  it('writes 0600 atomically and leaves no temporary file behind', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      addServer(store)
      if (process.platform !== 'win32') expect(statSync(app.file).mode & 0o777).toBe(0o600)
      expect(readdirSync(app.dir)).toEqual(['mcp-config.json'])
      expect(tempFiles(app.dir)).toEqual([])
    } finally { app.done() }
  })

  it('refuses to save a token when secret protection is unavailable or fails, without writing a file', () => {
    for (const over of [
      { isEncryptionAvailable: () => false },
      { encryptString: () => { throw Error('sealed storage broke') } }
    ] as Partial<SecretProtection>[]) {
      const app = directory()
      try {
        const store = storeIn(app.dir, over)
        expect(() => store.upsert({ name: 'x', url: URL_A, token: 'token', enabled: false })).toThrow('MCP_CONFIG_UNAVAILABLE')
        expect(() => readFileSync(app.file)).toThrow()
      } finally { app.done() }
    }
  })

  it('validates names, URLs, provided tokens, duplicates and server count before touching the file', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      expect(() => store.upsert({ name: '', url: URL_A, token: 't', enabled: false })).toThrow('MCP_BAD_NAME')
      expect(() => store.upsert({ name: '   ', url: URL_A, token: 't', enabled: false })).toThrow('MCP_BAD_NAME')
      expect(() => store.upsert({ name: 'x'.repeat(81), url: URL_A, token: 't', enabled: false })).toThrow('MCP_BAD_NAME')
      expect(() => store.upsert({ name: 'line\nbreak', url: URL_A, token: 't', enabled: false })).toThrow('MCP_BAD_NAME')
      for (const url of [
        'http://mcp.example.com/mcp',
        'https://user:pass@mcp.example.com/mcp',
        'https://mcp.example.com:8443/mcp',
        'https://127.0.0.1/mcp',
        'https://localhost/mcp',
        'not a url'
      ]) expect(() => store.upsert({ name: 'x', url, token: 't', enabled: false })).toThrow('MCP_BAD_URL')
      // MCP_BAD_TOKEN 只表示「提供了 token 但非法」；空／空白也算提供了非法 token。
      expect(() => store.upsert({ name: 'x', url: URL_A, token: '', enabled: false })).toThrow('MCP_BAD_TOKEN')
      expect(() => store.upsert({ name: 'x', url: URL_A, token: '   ', enabled: false })).toThrow('MCP_BAD_TOKEN')
      expect(() => store.upsert({ name: 'x', url: URL_A, token: 'x'.repeat(4097), enabled: false })).toThrow('MCP_BAD_TOKEN')
      expect(() => store.upsert({ name: 'x', url: URL_A, token: 'bad\ntoken', enabled: false })).toThrow('MCP_BAD_TOKEN')
      // 校验全部发生在落盘之前。
      expect(() => readFileSync(app.file)).toThrow()
      // 4096 字是允许的上限。
      expect(() => store.upsert({ name: 'x', url: URL_A, token: 'x'.repeat(4096), enabled: true })).not.toThrow()
      // 归一化后同一地址只允许一条。
      const id = store.getPublic().servers[0]!.id
      expect(() => store.upsert({ name: 'dup', url: 'https://MCP.EXAMPLE.COM:443/mcp#frag', token: 't', enabled: false })).toThrow('MCP_DUPLICATE_URL')
      // 同一台自己保存自己不算重复；url 归一化后落盘。
      expect(store.upsert({ id, name: '改名', url: 'https://MCP.EXAMPLE.COM:443/mcp#frag', enabled: true }).servers[0]!.url).toBe(URL_A)
      // 8 台上限。
      for (let index = 1; index < 8; index += 1) {
        store.upsert({ name: `s${index}`, url: `https://mcp${index}.example.com/mcp`, token: 't', enabled: false })
      }
      expect(store.getPublic().servers).toHaveLength(8)
      expect(() => store.upsert({ name: 's9', url: 'https://mcp9.example.com/mcp', token: 't', enabled: false })).toThrow('MCP_TOO_MANY')
    } finally { app.done() }
  })

  it('lets a public read-only server be enabled, discovered and whitelisted without a token', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      const view = store.upsert({ name: '公共只读', url: URL_A, enabled: true })
      const id = view.servers[0]!.id
      expect(view.servers[0]).toMatchObject({ id, enabled: true, hasToken: false, tools: [], whitelist: [] })
      // 没有密文＝空 token 的凭据；客户端据此不发 authorization 头。
      expect(store.credential(id)).toEqual({ url: URL_A, token: '' })
      expect(store.servers()[0]!.credential).toEqual({ url: URL_A, token: '' })
      // 还没有白名单：不算可用。
      expect(store.availability()).toEqual({ available: false, servers: [] })
      store.saveDiscovered(id, [{ name: 'read_a' }, { name: 'read_b' }])
      store.saveWhitelist(id, ['read_a'])
      expect(store.availability()).toEqual({
        available: true,
        servers: [{ name: '公共只读', host: 'mcp.example.com', tools: ['read_a'] }]
      })
      // 磁盘上就是「启用、没有密文」的形状；重新读盘仍然有效。
      const stored = storedServer(readFileSync(app.file, 'utf8'))
      expect(stored.enabled).toBe(true)
      expect(stored).not.toHaveProperty('tokenCipher')
      const reopened = storeIn(app.dir)
      expect(reopened.getPublic().servers[0]).toMatchObject({ id, enabled: true, hasToken: false })
      expect(reopened.credential(id)).toEqual({ url: URL_A, token: '' })
    } finally { app.done() }
  })

  it('keeps an existing token when saving without one, and lets enabled flip on afterwards', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      const id = addServer(store)
      const view = store.upsert({ id, name: '示例服务器', url: URL_A, enabled: true })
      expect(view.servers[0]).toMatchObject({ id, name: '示例服务器', enabled: true, hasToken: true })
      expect(store.credential(id)).toEqual({ url: URL_A, token: 'token-123' })
      // 显式换 token 才算换。
      store.upsert({ id, name: '示例服务器', url: URL_A, token: 'token-456', enabled: true })
      expect(store.credential(id)).toEqual({ url: URL_A, token: 'token-456' })
    } finally { app.done() }
  })

  it('clears discovered tools and whitelist when the endpoint changes', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      const id = addServer(store)
      store.saveDiscovered(id, [{ name: 'read_a' }, { name: 'read_b' }])
      store.saveWhitelist(id, ['read_a'])
      const moved = store.upsert({ id, name: '示例服务器', url: URL_B, enabled: false })
      expect(moved.servers[0]).toMatchObject({ url: URL_B, tools: [], whitelist: [] })
    } finally { app.done() }
  })

  it('stores discovered tools without schema in the public view and keeps the whitelist a subset', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      const id = addServer(store)
      const schema = { type: 'object', properties: { query: { type: 'string' } } }
      const view = store.saveDiscovered(id, [
        { name: 'read_a', title: '读 A', description: '只读 A', inputSchema: schema },
        { name: 'read_b', description: '只读 B' },
        { name: 'read_a', title: '重复名被去掉' },
        { name: '', title: '非法名被跳过' }
      ])
      expect(view.servers[0]!.tools).toEqual([
        { name: 'read_a', title: '读 A', description: '只读 A' },
        { name: 'read_b', description: '只读 B' }
      ])
      const runtime = store.servers().find(server => server.id === id)!
      expect(runtime.tools.find(tool => tool.name === 'read_a')?.inputSchema).toEqual(schema)
      // 白名单只能来自已发现工具。
      expect(() => store.saveWhitelist(id, ['read_c'])).toThrow('MCP_BAD_WHITELIST')
      expect(store.saveWhitelist(id, ['read_a', 'read_b']).servers[0]!.whitelist).toEqual(['read_a', 'read_b'])
      // 重新发现时工具变少：白名单自动收窄到仍存在的名字。
      expect(store.saveDiscovered(id, [{ name: 'read_b' }]).servers[0]!.whitelist).toEqual(['read_b'])
    } finally { app.done() }
  })

  it('caps tools at 64, drops an oversized schema, and rejects a public view over 64 KiB', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      const id = addServer(store)
      expect(() => store.saveDiscovered(id, Array.from({ length: 65 }, (_, index) => ({ name: `t${index}` })))).toThrow('MCP_TOO_MANY')
      // 8 KiB 以上的 schema 不落盘，但工具本身仍保留。
      const huge = { type: 'object', description: 'x'.repeat(9 * 1024) }
      store.saveDiscovered(id, [{ name: 'read_a', inputSchema: huge }])
      expect(store.servers()[0]!.tools[0]!.inputSchema).toBeUndefined()
      expect(store.getPublic().servers[0]!.tools).toEqual([{ name: 'read_a' }])
      // 64 个工具 × 2000 字说明会让公开 JSON 超过 64 KiB：整次保存拒绝，不写半截。
      const verbose = Array.from({ length: 64 }, (_, index) => ({ name: `v${index}`, description: 'x'.repeat(2000) }))
      expect(() => store.saveDiscovered(id, verbose)).toThrow('MCP_TOO_MANY')
      expect(store.getPublic().servers[0]!.tools).toEqual([{ name: 'read_a' }])
      expect(tempFiles(app.dir)).toEqual([])
    } finally { app.done() }
  })

  it('rejects unknown ids and unknown whitelist names', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      const id = addServer(store)
      expect(() => store.remove('missing')).toThrow('MCP_NOT_FOUND')
      expect(() => store.upsert({ id: 'missing', name: 'x', url: URL_B, enabled: false })).toThrow('MCP_NOT_FOUND')
      expect(() => store.saveDiscovered('missing', [])).toThrow('MCP_NOT_FOUND')
      expect(() => store.saveWhitelist('missing', [])).toThrow('MCP_NOT_FOUND')
      expect(() => store.saveWhitelist(id, ['read_a'])).toThrow('MCP_BAD_WHITELIST')
      expect(() => store.saveWhitelist(id, ['x'.repeat(129)])).toThrow('MCP_BAD_WHITELIST')
      // 删除只删一台。
      const second = addServer(store, { name: '第二台', url: URL_B, token: 't2' })
      const view = store.remove(id)
      expect(view.servers.map(server => server.id)).toEqual([second])
    } finally { app.done() }
  })

  it('fails closed on a corrupt or malformed file and preserves it before the next write', () => {
    const app = directory()
    try {
      const bad = [
        'not json{',
        JSON.stringify({ version: 2, servers: [] }),
        JSON.stringify({ version: 1 }),
        JSON.stringify({ version: 1, servers: {} }),
        JSON.stringify({ version: 1, servers: [{ id: 'a', name: 'x', url: 'http://mcp.example.com/mcp', enabled: false, tools: [], whitelist: [] }] }),
        JSON.stringify({ version: 1, servers: [{ id: 'a', name: 'x', url: URL_A, enabled: true, tokenCipher: 'not base64!', tools: [], whitelist: [] }] }),
        JSON.stringify({ version: 1, servers: [{ id: 'a', name: 'x', url: URL_A, enabled: false, tools: [], whitelist: ['nope'] }] }),
        JSON.stringify({ version: 1, servers: Array.from({ length: 9 }, (_, index) => ({ id: `s${index}`, name: 'x', url: `https://m${index}.example.com/mcp`, enabled: false, tools: [], whitelist: [] })) })
      ]
      for (const raw of bad) {
        writeFileSync(app.file, raw)
        const store = storeIn(app.dir)
        expect(store.getPublic()).toEqual({ servers: [] })
        expect(store.servers()).toEqual([])
        expect(store.availability()).toEqual({ available: false, servers: [] })
        // 读不改写：坏文件原样保留，等下一次显式写入再留证。
        expect(readFileSync(app.file, 'utf8')).toBe(raw)
        expect(corruptFiles(app.dir)).toEqual([])
      }
      // 下一次写入前把最后一次的坏文件改名保留，再写新文件。
      const last = readFileSync(app.file, 'utf8')
      const store = storeIn(app.dir)
      addServer(store)
      const preserved = corruptFiles(app.dir)
      expect(preserved).toHaveLength(1)
      expect(readFileSync(path.join(app.dir, preserved[0]!), 'utf8')).toBe(last)
      expect(JSON.parse(readFileSync(app.file, 'utf8')).version).toBe(1)
      expect(storeIn(app.dir).getPublic().servers).toHaveLength(1)
    } finally { app.done() }
  })

  it('treats an undecryptable cipher as unusable but a missing cipher as a public no-token server', () => {
    const app = directory()
    try {
      writeFileSync(app.file, JSON.stringify({
        version: 1,
        servers: [{
          id: 'a', name: 'x', url: URL_A, enabled: true,
          tokenCipher: Buffer.from('not-sealed', 'utf8').toString('base64'),
          tools: [{ name: 'read_a' }], whitelist: ['read_a']
        }]
      }))
      const store = storeIn(app.dir)
      const view = store.getPublic()
      expect(view.servers[0]).toMatchObject({ enabled: true, hasToken: true })
      expect(JSON.stringify(view)).not.toContain('not-sealed')
      // 有密文却解不开：不能静默降级成「公共无 token」，这台按不可用看。
      expect(store.credential('a')).toBeNull()
      expect(store.servers()[0]!.credential).toBeNull()
      // 加密不可用同样按「有密文却解不开」看。
      expect(storeIn(app.dir, { isEncryptionAvailable: () => false }).credential('a')).toBeNull()
      // 坏密文不是坏文件：不覆盖，人能再保存修复。
      expect(JSON.parse(readFileSync(app.file, 'utf8')).servers[0].tokenCipher).toBe(Buffer.from('not-sealed', 'utf8').toString('base64'))

      // 没有密文是合法的公共只读形状：启用、有白名单，凭据是空 token。
      writeFileSync(app.file, JSON.stringify({
        version: 1,
        servers: [{ id: 'public', name: '公共', url: URL_B, enabled: true, tools: [{ name: 'read_b' }], whitelist: ['read_b'] }]
      }))
      const publicStore = storeIn(app.dir)
      expect(publicStore.getPublic().servers[0]).toMatchObject({ id: 'public', enabled: true, hasToken: false })
      expect(publicStore.credential('public')).toEqual({ url: URL_B, token: '' })
      expect(publicStore.servers()[0]!.credential).toEqual({ url: URL_B, token: '' })
      expect(publicStore.availability()).toEqual({
        available: true,
        servers: [{ name: '公共', host: 'other.example.org', tools: ['read_b'] }]
      })
    } finally { app.done() }
  })

  it('availability lists enabled servers with a non-empty whitelist, with or without a token', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      const enabled = addServer(store, { name: '可用', token: 't1' })
      store.saveDiscovered(enabled, [{ name: 'read_a' }, { name: 'read_b' }])
      store.saveWhitelist(enabled, ['read_b'])
      store.upsert({ id: enabled, name: '可用', url: URL_A, enabled: true })
      // 未启用：即使有 token 与白名单也不可用。
      const disabled = addServer(store, { name: '未启用', url: URL_B, token: 't2' })
      store.saveDiscovered(disabled, [{ name: 'read_c' }])
      store.saveWhitelist(disabled, ['read_c'])
      expect(store.availability()).toEqual({
        available: true,
        servers: [{ name: '可用', host: 'mcp.example.com', tools: ['read_b'] }]
      })
      // 启用但没有白名单：不可用。
      const emptyWhitelist = addServer(store, { name: '空白名单', url: 'https://third.example.net/mcp', token: 't3' })
      store.saveDiscovered(emptyWhitelist, [{ name: 'read_d' }])
      store.upsert({ id: emptyWhitelist, name: '空白名单', url: 'https://third.example.net/mcp', enabled: true })
      // 启用、有白名单、没有 token：公共只读服务器同样可用（token 不再参与判定）。
      const publicServer = store.upsert({ name: '公共只读', url: 'https://public.example.net/mcp', enabled: true }).servers
        .find(server => server.name === '公共只读')!
      store.saveDiscovered(publicServer.id, [{ name: 'read_e' }])
      store.saveWhitelist(publicServer.id, ['read_e'])
      expect(store.availability()).toEqual({
        available: true,
        servers: [
          { name: '可用', host: 'mcp.example.com', tools: ['read_b'] },
          { name: '公共只读', host: 'public.example.net', tools: ['read_e'] }
        ]
      })
      // 全部停用：available 为 false。
      store.upsert({ id: enabled, name: '可用', url: URL_A, enabled: false })
      store.upsert({ id: publicServer.id, name: '公共只读', url: 'https://public.example.net/mcp', enabled: false })
      expect(store.availability()).toEqual({ available: false, servers: [] })
    } finally { app.done() }
  })

  it('returns fresh view objects so callers cannot mutate the store', () => {
    const app = directory()
    try {
      const store = storeIn(app.dir)
      const id = addServer(store)
      store.saveDiscovered(id, [{ name: 'read_a' }])
      const view = store.getPublic()
      view.servers[0]!.whitelist.push('hacked')
      view.servers[0]!.tools.push({ name: 'hacked' })
      expect(store.getPublic().servers[0]!.whitelist).toEqual([])
      expect(store.getPublic().servers[0]!.tools).toEqual([{ name: 'read_a' }])
    } finally { app.done() }
  })
})
