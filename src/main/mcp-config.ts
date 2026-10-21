import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { egressUrl } from './egress.ts'
import type { SecretProtection } from './model-config.ts'
import type { McpConfigView, McpPublicServer, McpPublicTool } from '../shared/ipc.ts'

/**
 * 远端只读 MCP 的设备级配置（`mcp-config.json`，v1、0600、原子写）。
 *
 * 一台服务器＝一个 HTTPS Streamable HTTP 端点＋一把 Bearer token＋**人工勾选**的工具白名单。
 * token 只用 `SecretProtection`（生产是 Electron `safeStorage`）加密后按 base64 存
 * `tokenCipher`，明文只在主进程里出现；`getPublic()` 永远不含 token 或密文，
 * `servers()` 才带解密后的凭据（解密失败按「没有 token」看）。
 *
 * 白名单只能来自 `saveDiscovered()` 存下的工具名；启用必须有 token；同一个归一化 URL
 * 只允许一条。写入沿用 network-config 的 tmp＋fsync＋rename＋0600。
 *
 * 坏文件（缺失以外的读取失败、JSON 坏了、形状／版本不认识、越过上限）**fail closed**：
 * 一律当「没有服务器」，不覆盖磁盘上的证据；人下一次显式保存前先把坏文件改名成
 * `mcp-config.json.corrupt-<ISO>` 保留，改名失败就不写新文件。
 *
 * 失败一律抛固定机读码（宿主只把码回渲染层，文件系统原文与服务器文本都不外泄）：
 * `MCP_BAD_NAME`／`MCP_BAD_URL`／`MCP_BAD_TOKEN`／`MCP_DUPLICATE_URL`／`MCP_TOO_MANY`／
 * `MCP_BAD_WHITELIST`／`MCP_NOT_FOUND`／`MCP_CONFIG_UNAVAILABLE`。
 */

export type McpStoredTool = {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
}

export type McpCredential = { url: string; token: string }

/** 主进程用的视图：带工具 schema 与解密后的凭据；**不能**直接跨 IPC 交给渲染层。 */
export type McpRuntimeServer = {
  id: string
  name: string
  url: string
  host: string
  enabled: boolean
  tools: McpStoredTool[]
  whitelist: string[]
  credential: McpCredential | null
}

export type McpServerUpsert = {
  id?: string
  name: string
  url: string
  /** 省略＝保留已有 token；提供时必须 1–4096 字。 */
  token?: string
  enabled: boolean
}

/** 任务授权快照只读形状：只有「已启用＋有 token＋白名单非空」的服务器。 */
export type McpAvailabilityServer = { name: string; host: string; tools: string[] }
export type McpAvailability = { available: boolean; servers: McpAvailabilityServer[] }

export type McpConfigStore = {
  /** 渲染层可看的摘要；永不含 token 或密文。 */
  getPublic(): McpConfigView
  /** 主进程用：含解密凭据；解密失败的那台 `credential` 为 null。 */
  servers(): McpRuntimeServer[]
  /** 单台凭据；未知 id、没有 token、解不开都回 null。 */
  credential(id: string): McpCredential | null
  upsert(input: McpServerUpsert): McpConfigView
  remove(id: string): McpConfigView
  saveDiscovered(id: string, tools: readonly McpStoredTool[]): McpConfigView
  saveWhitelist(id: string, names: readonly string[]): McpConfigView
  availability(): McpAvailability
}

const FILE = 'mcp-config.json'
const MAX_SERVERS = 8
const MAX_NAME = 80
const MAX_TOKEN = 4096
const MAX_TOOLS = 64
const MAX_TOOL_NAME = 128
const MAX_SCHEMA_BYTES = 8 * 1024
const MAX_PUBLIC_BYTES = 64 * 1024
/** 单台端点上限；和联网只读的目标 URL 上限一致，避免配置文件被一条超长 URL 撑大。 */
const MAX_URL = 2048
/** 8 台 × 64 个工具 × 8 KiB schema 约 4 MiB；留一倍余量，超出即按坏文件处理。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024
/** 第三方标题／说明只作展示；截断而不是让一次发现整个失败。 */
const MAX_TITLE = 200
const MAX_DESCRIPTION = 2000
const CONTROL = /[\u0000-\u001f\u007f]/u

type StoredServer = {
  id: string
  name: string
  url: string
  enabled: boolean
  tokenCipher?: string
  tools: McpStoredTool[]
  whitelist: string[]
}
type Stored = { version: 1; servers: StoredServer[] }

const empty = (): Stored => ({ version: 1, servers: [] })
const fail = (code: string): never => { throw Error(code) }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
/** safeStorage 的密文是 base64；形状不对的文件按坏文件处理，不去猜。 */
const validCipher = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024 &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)

const validName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= MAX_NAME && !CONTROL.test(value)

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 64 && !CONTROL.test(value)

const validToolName = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= MAX_TOOL_NAME && !CONTROL.test(value)

/**
 * 只做 URL 形状、协议、端口与 userinfo 的把关（复用出口核心）。DNS 解析后的公网地址
 * 由 transport 在每次连接时兜底；这里拒 http、私网字面量、非 443 与带凭据的 URL。
 * 归一化用 `URL.href`（主机小写、默认端口去掉），并丢掉无意义的 fragment。
 */
function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL) return null
  const url = egressUrl(raw, [443])
  if (!url || url.protocol !== 'https:') return null
  url.hash = ''
  return url.href
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^\[|\]$/gu, '') } catch { return '' }
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/** 工具名去重（按首次出现），非法名跳过；第三方标题／说明只截断，不信任其内容。 */
function sanitizeTool(value: unknown): McpStoredTool | null {
  if (!isRecord(value) || !validToolName(value.name)) return null
  const tool: McpStoredTool = { name: value.name }
  if (typeof value.title === 'string') tool.title = truncate(value.title, MAX_TITLE)
  if (typeof value.description === 'string') tool.description = truncate(value.description, MAX_DESCRIPTION)
  if (value.inputSchema !== undefined) {
    try {
      const serialized = JSON.stringify(value.inputSchema)
      // 超大或不可序列化的 schema 不落盘；工具本身仍可按名字与参数转发。
      if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= MAX_SCHEMA_BYTES) tool.inputSchema = value.inputSchema
    } catch { /* drop the schema, keep the tool */ }
  }
  return tool
}

function publicTool(tool: McpStoredTool): McpPublicTool {
  const view: McpPublicTool = { name: tool.name }
  if (tool.title !== undefined) view.title = tool.title
  if (tool.description !== undefined) view.description = tool.description
  return view
}

function publicFrom(stored: Stored): McpConfigView {
  return {
    servers: stored.servers.map(server => {
      const view: McpPublicServer = {
        id: server.id,
        name: server.name,
        url: server.url,
        host: hostOf(server.url),
        enabled: server.enabled,
        hasToken: server.tokenCipher !== undefined,
        tools: server.tools.map(publicTool),
        whitelist: [...server.whitelist]
      }
      return view
    })
  }
}

const publicBytes = (view: McpConfigView): number => Buffer.byteLength(JSON.stringify(view), 'utf8')

function cloneTools(tools: readonly McpStoredTool[]): McpStoredTool[] {
  return tools.map(tool => ({
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {})
  }))
}

function parseServer(value: unknown): StoredServer | null {
  if (!isRecord(value)) return null
  if (!validId(value.id) || !validName(value.name)) return null
  const url = normalizeUrl(value.url)
  if (!url || typeof value.enabled !== 'boolean') return null
  if (value.tokenCipher !== undefined && !validCipher(value.tokenCipher)) return null
  // 启用必须有 token；文件里出现「启用却没密文」是坏形状。
  if (value.enabled && value.tokenCipher === undefined) return null
  if (!Array.isArray(value.tools) || value.tools.length > MAX_TOOLS) return null
  const tools: McpStoredTool[] = []
  const seen = new Set<string>()
  for (const entry of value.tools as unknown[]) {
    const tool = sanitizeTool(entry)
    if (!tool || seen.has(tool.name)) continue
    seen.add(tool.name)
    tools.push(tool)
  }
  // 存进文件的工具必须全部可解析：上面跳过任何一项都说明形状和写入路径不一致。
  if (tools.length !== value.tools.length) return null
  if (!Array.isArray(value.whitelist) || value.whitelist.length > MAX_TOOLS) return null
  const whitelist: string[] = []
  const allowed = new Set(tools.map(tool => tool.name))
  for (const name of value.whitelist as unknown[]) {
    if (!validToolName(name) || !allowed.has(name) || whitelist.includes(name)) return null
    whitelist.push(name)
  }
  return {
    id: value.id,
    name: value.name.trim(),
    url,
    enabled: value.enabled,
    ...(value.tokenCipher !== undefined ? { tokenCipher: value.tokenCipher } : {}),
    tools,
    whitelist
  }
}

function parse(raw: string): Stored | null {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) return null
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.servers)) return null
    if (value.servers.length > MAX_SERVERS) return null
    const servers: StoredServer[] = []
    const ids = new Set<string>()
    const urls = new Set<string>()
    for (const entry of value.servers as unknown[]) {
      const server = parseServer(entry)
      if (!server || ids.has(server.id) || urls.has(server.url)) return null
      ids.add(server.id)
      urls.add(server.url)
      servers.push(server)
    }
    const stored: Stored = { version: 1, servers }
    // 公开视图的总量上限也是读盘条件：不让人手改出一个超过上限、界面无法安全渲染的文件。
    if (publicBytes(publicFrom(stored)) > MAX_PUBLIC_BYTES) return null
    return stored
  } catch { return null }
}

/** 设备本地时间的 ISO；Windows 文件名不接受冒号，时间戳语义不变。 */
function corruptStamp(): string {
  const iso = new Date().toISOString()
  return process.platform === 'win32' ? iso.replace(/:/gu, '-') : iso
}

export function createMcpConfigStore(userData: string, protection: SecretProtection): McpConfigStore {
  const target = path.join(userData, FILE)

  const read = (): Stored => {
    try { return parse(readFileSync(target, 'utf8')) ?? empty() }
    // 文件不存在、读不动、不是 UTF-8 文本：都按「没有服务器」处理（fail closed）。
    catch { return empty() }
  }

  /**
   * 写入前把读不出来的旧文件改名留证。改名失败就不写，绝不用新文件把证据顶掉；
   * `ENOENT` 只说明文件在此期间消失，不是坏文件。
   */
  const preserveCorrupt = (): void => {
    let raw: string
    try { raw = readFileSync(target, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      // 读不动但文件还在：按坏文件处理，尝试改名保留。
      raw = ''
    }
    if (raw && parse(raw)) return
    try {
      renameSync(target, path.join(userData, `${FILE}.corrupt-${corruptStamp()}`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('MCP_CONFIG_UNAVAILABLE')
    }
  }

  const write = (stored: Stored): McpConfigView => {
    const view = publicFrom(stored)
    if (publicBytes(view) > MAX_PUBLIC_BYTES) fail('MCP_TOO_MANY')
    preserveCorrupt()
    const temporary = path.join(userData, `.mcp-config-${randomUUID()}.tmp`)
    let descriptor: number | null = null
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, JSON.stringify(stored), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = null
      renameSync(temporary, target)
    } catch {
      fail('MCP_CONFIG_UNAVAILABLE')
    } finally {
      if (descriptor !== null) closeSync(descriptor)
      try { unlinkSync(temporary) } catch { /* committed or never created */ }
    }
    return view
  }

  /** 解密失败、没有密文、系统保护不可用都按「没有 token」看。 */
  const decrypt = (server: StoredServer): McpCredential | null => {
    if (!server.tokenCipher) return null
    if (!protection.isEncryptionAvailable()) return null
    let token: string
    try { token = protection.decryptString(Buffer.from(server.tokenCipher, 'base64')) }
    catch { return null }
    if (!token) return null
    return { url: server.url, token }
  }

  const find = (stored: Stored, id: unknown): StoredServer => {
    if (!validId(id)) throw Error('MCP_NOT_FOUND')
    const server = stored.servers.find(entry => entry.id === id)
    if (!server) throw Error('MCP_NOT_FOUND')
    return server
  }

  return {
    getPublic(): McpConfigView {
      return publicFrom(read())
    },

    servers(): McpRuntimeServer[] {
      return read().servers.map(server => ({
        id: server.id,
        name: server.name,
        url: server.url,
        host: hostOf(server.url),
        enabled: server.enabled,
        tools: cloneTools(server.tools),
        whitelist: [...server.whitelist],
        credential: decrypt(server)
      }))
    },

    credential(id: string): McpCredential | null {
      const stored = read()
      // 未知 id 不抛错：调用方（发现／任务）只需要知道「这台现在能不能用」。
      const server = stored.servers.find(entry => entry.id === id)
      return server ? decrypt(server) : null
    },

    upsert(input: McpServerUpsert): McpConfigView {
      if (!isRecord(input)) fail('MCP_CONFIG_UNAVAILABLE')
      if (!validName(input.name)) fail('MCP_BAD_NAME')
      const name = (input.name as string).trim()
      const url = normalizeUrl(input.url) ?? fail('MCP_BAD_URL')
      if (typeof input.enabled !== 'boolean') fail('MCP_CONFIG_UNAVAILABLE')
      const stored = read()
      let index = -1
      if (input.id !== undefined) {
        if (typeof input.id !== 'string' || !validId(input.id)) fail('MCP_NOT_FOUND')
        index = stored.servers.findIndex(entry => entry.id === input.id)
        if (index < 0) fail('MCP_NOT_FOUND')
      } else if (stored.servers.length >= MAX_SERVERS) fail('MCP_TOO_MANY')
      if (stored.servers.some((entry, at) => at !== index && entry.url === url)) fail('MCP_DUPLICATE_URL')
      const existing = index >= 0 ? stored.servers[index]! : null
      let tokenCipher = existing?.tokenCipher
      if (input.token !== undefined) {
        if (typeof input.token !== 'string' || !input.token.trim() || input.token.length > MAX_TOKEN || CONTROL.test(input.token)) {
          fail('MCP_BAD_TOKEN')
        }
        if (!protection.isEncryptionAvailable()) fail('MCP_CONFIG_UNAVAILABLE')
        try { tokenCipher = protection.encryptString(input.token).toString('base64') }
        catch { fail('MCP_CONFIG_UNAVAILABLE') }
      }
      // 启用必须有 token：既没有旧密文，这次也没给新 token，就是非法组合。
      if (input.enabled && !tokenCipher) fail('MCP_BAD_TOKEN')
      // 换了端点等于换了服务器：旧工具发现与白名单都不再适用，不把旧名字套到新端点上。
      const moved = existing !== null && existing.url !== url
      const next: StoredServer = {
        id: existing?.id ?? randomUUID(),
        name,
        url,
        enabled: input.enabled,
        ...(tokenCipher !== undefined ? { tokenCipher } : {}),
        tools: moved ? [] : cloneTools(existing?.tools ?? []),
        whitelist: moved ? [] : [...(existing?.whitelist ?? [])]
      }
      const servers = stored.servers.map((entry, at) => at === index ? next : entry)
      if (index < 0) servers.push(next)
      return write({ version: 1, servers })
    },

    remove(id: string): McpConfigView {
      const stored = read()
      find(stored, id)
      return write({ version: 1, servers: stored.servers.filter(entry => entry.id !== id) })
    },

    saveDiscovered(id: string, tools: readonly McpStoredTool[]): McpConfigView {
      if (!Array.isArray(tools)) fail('MCP_CONFIG_UNAVAILABLE')
      const stored = read()
      const server = find(stored, id)
      const discovered: McpStoredTool[] = []
      const seen = new Set<string>()
      // 非法条目跳过（客户端已经做过一次名字过滤）；数量上限按有效工具算。
      for (const entry of tools as unknown[]) {
        const tool = sanitizeTool(entry)
        if (!tool || seen.has(tool.name)) continue
        seen.add(tool.name)
        discovered.push(tool)
        if (discovered.length > MAX_TOOLS) fail('MCP_TOO_MANY')
      }
      const names = new Set(discovered.map(tool => tool.name))
      const next: StoredServer = {
        ...server,
        tools: discovered,
        // 重新发现时工具可能变少：白名单只能保留仍在列表里的名字（不变量：白名单 ⊆ 已发现工具）。
        whitelist: server.whitelist.filter(name => names.has(name))
      }
      return write({
        version: 1,
        servers: stored.servers.map(entry => entry.id === server.id ? next : entry)
      })
    },

    saveWhitelist(id: string, names: readonly string[]): McpConfigView {
      if (!Array.isArray(names) || names.length > MAX_TOOLS) fail('MCP_BAD_WHITELIST')
      const stored = read()
      const server = find(stored, id)
      const known = new Set(server.tools.map(tool => tool.name))
      const whitelist: string[] = []
      for (const name of names as unknown[]) {
        if (!validToolName(name)) throw Error('MCP_BAD_WHITELIST')
        if (!known.has(name)) throw Error('MCP_BAD_WHITELIST')
        if (!whitelist.includes(name)) whitelist.push(name)
      }
      const next: StoredServer = { ...server, whitelist }
      return write({
        version: 1,
        servers: stored.servers.map(entry => entry.id === server.id ? next : entry)
      })
    },

    availability(): McpAvailability {
      const servers = read().servers
        .filter(server => server.enabled && server.tokenCipher !== undefined && server.whitelist.length > 0)
        .map(server => ({ name: server.name, host: hostOf(server.url), tools: [...server.whitelist] }))
      return { available: servers.length > 0, servers }
    }
  }
}
