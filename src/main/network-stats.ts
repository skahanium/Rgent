import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  NetworkStatKind,
  NetworkStatsCounts,
  NetworkStatsView
} from '../shared/ipc.ts'

/**
 * 设备级联网外发统计：`network-stats.json`（v1、0600、去抖 500ms 原子写）。
 *
 * 只回答「哪个口子成功／拒绝了几次、抓页搬了多少字节、最近一次成功是什么时候、
 * 最近拒绝码是什么」。**不接受也不落盘** URL、查询串、正文、主机或凭据；错误只留
 * 机读码。设置卡读的是 `view()` 的快照，看不到文件路径。
 *
 * 读盘缺失 → 空统计；损坏或形状不对 → 内存归零并置 `corrupt`，**下一次写入之前**
 * 先把坏文件改名成 `network-stats.json.corrupt-<ISO>` 留证，再写新文件；改名失败就
 * 不覆盖证据，`corrupt` 保持，等下一次写入再试。
 *
 * `record()` 永远不抛：统计是可观测的旁路，不能把一次已经发生（或已经拒绝）的
 * 外发变成新的失败。`flush()` 与 `clear()` 的同步写失败会抛出，交给 IPC 如实回
 * `IO_ERROR`，不假装清空已经落盘。
 */
export type NetworkStatEvent = {
  outcome: 'ok' | 'refused'
  /** 仅 fetch／humanFetch 有意义；其它口子忽略。 */
  bytes?: number
  /** 拒绝码，只接受固定大写码形状；消息与自由文本一律丢弃。 */
  code?: string
}

export type NetworkStats = {
  record(kind: NetworkStatKind, event: NetworkStatEvent): void
  view(): NetworkStatsView
  clear(): void
  flush(): void
}

const FILE = 'network-stats.json'
const MAX_BYTES = 64 * 1024
const DEBOUNCE_MS = 500
const MAX_CODES = 10
const KINDS: readonly NetworkStatKind[] = ['fetch', 'search', 'mcp', 'humanFetch', 'humanSearch']
const BYTE_KINDS: ReadonlySet<NetworkStatKind> = new Set(['fetch', 'humanFetch'])
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,63}$/u

/**
 * 只有合同内出现过的码才进统计；未知异常文本折成 `EGRESS_UNAVAILABLE`。
 * 与渲染层 IPC 的错误映射共用同一份白名单：统计与界面不会各说各话。
 */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'NETWORK_NOT_AUTHORIZED',
  'SEARCH_NOT_CONFIGURED', 'SEARCH_UNAUTHORIZED', 'SEARCH_REFUSED', 'SEARCH_MALFORMED', 'SEARCH_EMPTY',
  'EGRESS_INVALID_URL', 'EGRESS_HTTP_REFUSED', 'EGRESS_CROSS_ORIGIN_REFUSED', 'EGRESS_UNSUPPORTED_TYPE',
  'EGRESS_ENCODING_REFUSED', 'EGRESS_TOO_LARGE', 'EGRESS_TIMEOUT', 'EGRESS_UNAVAILABLE', 'EGRESS_BUSY',
  'EGRESS_CONTENT_ECHO', 'EGRESS_ABORTED'
])

/**
 * DOMException／Node AbortError 不一定带可读消息（浏览器里是 `AbortError`，
 * Node 事件流里是 `code: 'ABORT_ERR'`）；按名字／旧码识别，绝不靠文本猜。
 */
function isAbortShape(error: unknown): boolean {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR'
}

/** 错误只取机读码；AbortError 归一成 `EGRESS_ABORTED`，其它未知折成 `EGRESS_UNAVAILABLE`。 */
export function networkErrorCode(error: unknown): string {
  if (isAbortShape(error)) return 'EGRESS_ABORTED'
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return NETWORK_CODES.has(message) ? message : 'EGRESS_UNAVAILABLE'
}

/**
 * 记录失败时的码：信号已 abort 是确定事实，优先于出口自己报的码
 * （搜索出口把取消折成 `SEARCH_REFUSED`，统计与宿主账本仍应按取消记 `EGRESS_ABORTED`）。
 */
export function networkFailureCode(error: unknown, signal?: { aborted: boolean } | null): string {
  if (signal?.aborted === true) return 'EGRESS_ABORTED'
  return networkErrorCode(error)
}

type Stored = {
  version: 1
  kinds: Record<NetworkStatKind, NetworkStatsCounts>
  lastOkAt?: string
  lastCodes: { code: string; at: string }[]
}

const counts = (): NetworkStatsCounts => ({ ok: 0, refused: 0, bytes: 0 })
const empty = (): Stored => ({
  version: 1,
  kinds: { fetch: counts(), search: counts(), mcp: counts(), humanFetch: counts(), humanSearch: counts() },
  lastCodes: []
})

/** 磁盘上的数值只接受非负安全整数；其它一律当 0，不把 NaN／负数带进快照。 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** 计数器累加也不越过 safe integer；统计只用于人看，饱和比回绕诚实。 */
function add(current: number, delta: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + delta)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) return undefined
  return new Date(value).toISOString()
}

function isKind(value: unknown): value is NetworkStatKind {
  return KINDS.includes(value as NetworkStatKind)
}

function parse(raw: string): Stored | null {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return null
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.kinds)) return null
    const parsed = empty()
    for (const kind of KINDS) {
      const source = value.kinds[kind]
      if (source === undefined) continue
      // 单个口子的数值写坏了按 0 处理（合同要求），不让一处坏数把整份统计判成损坏。
      if (!isRecord(source)) continue
      parsed.kinds[kind] = { ok: num(source.ok), refused: num(source.refused), bytes: num(source.bytes) }
    }
    const lastOkAt = timestamp(value.lastOkAt)
    if (lastOkAt) parsed.lastOkAt = lastOkAt
    if (value.lastCodes !== undefined) {
      if (!Array.isArray(value.lastCodes)) return null
      for (const item of value.lastCodes) {
        if (!isRecord(item)) continue
        const code = typeof item.code === 'string' && CODE_SHAPE.test(item.code) ? item.code : null
        const at = timestamp(item.at)
        if (!code || !at) continue
        parsed.lastCodes.push({ code, at })
        if (parsed.lastCodes.length >= MAX_CODES) break
      }
    }
    return parsed
  } catch { return null }
}

export function createNetworkStats(userData: string): NetworkStats {
  const target = path.join(userData, FILE)

  let stored = empty()
  let corrupt = false
  try {
    const parsed = parse(readFileSync(target, 'utf8'))
    if (parsed) stored = parsed
    else corrupt = true
  } catch (error) {
    // 文件不存在是正常起点；读不动或内容坏了都按空统计并如实标损坏。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') corrupt = true
  }

  let timer: ReturnType<typeof setTimeout> | null = null

  const serialized = (): string => JSON.stringify(stored)

  /** 写入前把坏文件改名留证；改名失败就不写，绝不用新文件把证据顶掉。 */
  const preserveCorrupt = (): boolean => {
    if (!corrupt) return true
    const iso = new Date().toISOString()
    // Windows 文件名不接受冒号；时间戳语义不变，取证仍能按前缀找到。
    const stamp = process.platform === 'win32' ? iso.replace(/:/gu, '-') : iso
    try { renameSync(target, path.join(userData, `${FILE}.corrupt-${stamp}`)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
    corrupt = false
    return true
  }

  const write = (): void => {
    if (!preserveCorrupt()) throw Error('IO_ERROR')
    const temporary = path.join(userData, `.network-stats-${randomUUID()}.tmp`)
    let descriptor: number | null = null
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, serialized(), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = null
      renameSync(temporary, target)
    } finally {
      if (descriptor !== null) closeSync(descriptor)
      try { unlinkSync(temporary) } catch { /* committed or never created */ }
    }
  }

  const cancel = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      // 定时写失败保留内存里的计数，下一次 record／flush 再试，不崩主进程。
      try { write() } catch { /* best effort until the next write */ }
    }, DEBOUNCE_MS)
    const handle = timer as unknown as { unref?: () => void }
    if (typeof handle.unref === 'function') handle.unref()
  }

  const pushCode = (code: string): void => {
    // 相邻同码只留一条并保留第一次的时间：连续超时不应把「最近失败码」刷成十条一样。
    if (stored.lastCodes[0]?.code === code) return
    stored.lastCodes.unshift({ code, at: new Date().toISOString() })
    if (stored.lastCodes.length > MAX_CODES) stored.lastCodes.length = MAX_CODES
  }

  return {
    record(kind: NetworkStatKind, event: NetworkStatEvent): void {
      if (!isKind(kind) || !event || typeof event !== 'object') return
      if (event.outcome !== 'ok' && event.outcome !== 'refused') return
      const entry = stored.kinds[kind]
      if (event.outcome === 'ok') {
        entry.ok = add(entry.ok, 1)
        if (BYTE_KINDS.has(kind)) {
          const bytes = num(event.bytes)
          if (bytes > 0) entry.bytes = add(entry.bytes, bytes)
        }
        stored.lastOkAt = new Date().toISOString()
      } else {
        entry.refused = add(entry.refused, 1)
        // 只收固定形状的码；自由文本、消息与超长串直接丢弃（计数仍然保留）。
        if (typeof event.code === 'string' && CODE_SHAPE.test(event.code)) pushCode(event.code)
      }
      schedule()
    },

    view(): NetworkStatsView {
      const snapshot: NetworkStatsView = {
        version: 1,
        kinds: {
          fetch: { ...stored.kinds.fetch },
          search: { ...stored.kinds.search },
          mcp: { ...stored.kinds.mcp },
          humanFetch: { ...stored.kinds.humanFetch },
          humanSearch: { ...stored.kinds.humanSearch }
        },
        lastCodes: stored.lastCodes.map(item => ({ ...item }))
      }
      if (stored.lastOkAt) snapshot.lastOkAt = stored.lastOkAt
      if (corrupt) snapshot.corrupt = true
      return snapshot
    },

    clear(): void {
      cancel()
      stored = empty()
      // 清空是显式动作：同步写，写失败要如实抛给 IPC，不留在内存里假装成功。
      write()
    },

    flush(): void {
      cancel()
      write()
    }
  }
}

/**
 * 退出收尾：把去抖窗口里最后 ≤500ms 的计数同步写盘。
 * 写失败只放弃这次收尾，绝不阻止退出；入口在 `will-quit`（窗口已关、库拆掉之前）。
 */
export function flushNetworkStats(stats: Pick<NetworkStats, 'flush'> | null | undefined): void {
  try { stats?.flush() } catch { /* shutdown must continue */ }
}
