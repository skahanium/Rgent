import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import path from 'node:path'
import type { EgressLogEntry, EgressLogView } from '../shared/ipc.ts'

/**
 * 人发起外发的设备级审计日志：`network-egress.jsonl`（append-only、0600）。
 *
 * 只记「什么时候、抓还是搜、哪台主机、多少字节／几条、结果如何、拒绝码是什么」。
 * **不记 URL、查询串、正文与凭据**：写入前按固定形状重建条目，调用方多给的字段一律丢掉；
 * host／code 里的控制字符也会被清掉，一行一条，不会把 JSONL 撑成两行。
 *
 * 轮转发生在**追加之前**：现有文件超过 200 行或 256 KiB 就整份改名为 `.1`（覆盖旧 `.1`），
 * 新条目从空文件开始。`.1` 是归档，`recent()` 只读当前文件——设置卡要看的是「最近发
 * 生的事」，不是上一代归档。
 *
 * `recent()` 对损坏行只跳过并计数，绝不把一条坏行变成整页错误；`append()`／`clear()`
 * 的磁盘失败会如实抛出，由 IPC 层映射成机读码，不在这里吞掉。
 */
const FILE = 'network-egress.jsonl'
const ARCHIVE = `${FILE}.1`
export const EGRESS_LOG_LIMITS = {
  /** 追加前允许保留的最大行数；超过就轮转。 */
  maxLines: 200,
  /** 追加前允许保留的最大字节数；超过就轮转。 */
  maxBytes: 256 * 1024,
  defaultRecent: 10,
  maxRecent: 50,
  maxHost: 255,
  maxCode: 64
} as const

const CONTROL = /[\u0000-\u001f\u007f]/gu

/** host／code 只保留单行可见文本，并按合同截断；空串是合法的「尽力取不到」。 */
function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(CONTROL, '').trim().slice(0, max) : ''
}

function countLines(content: string): number {
  if (!content) return 0
  let lines = 0
  for (const line of content.split('\n')) if (line.length > 0) lines += 1
  return lines
}

/** 写入前重建条目：只有这些字段能落盘，顺序也固定，便于人直接读文件。 */
function normalize(entry: EgressLogEntry): EgressLogEntry {
  if (!entry || typeof entry !== 'object') throw Error('BAD_EGRESS_ENTRY')
  if (entry.action !== 'fetch' && entry.action !== 'search') throw Error('BAD_EGRESS_ENTRY')
  if (entry.outcome !== 'ok' && entry.outcome !== 'refused') throw Error('BAD_EGRESS_ENTRY')
  if (typeof entry.at !== 'string') throw Error('BAD_EGRESS_ENTRY')
  const at = Date.parse(entry.at)
  if (Number.isNaN(at)) throw Error('BAD_EGRESS_ENTRY')
  const host = clean(entry.host, EGRESS_LOG_LIMITS.maxHost)
  const code = clean(entry.code, EGRESS_LOG_LIMITS.maxCode)
  return {
    at: new Date(at).toISOString(),
    action: entry.action,
    host,
    ...(Number.isSafeInteger(entry.bytes) && (entry.bytes as number) >= 0 ? { bytes: entry.bytes } : {}),
    ...(Number.isSafeInteger(entry.count) && (entry.count as number) >= 0 ? { count: entry.count } : {}),
    outcome: entry.outcome,
    ...(code ? { code } : {})
  }
}

/** 读回时也按同一形状重建：归档里万一有旧版多写的字段，也不会经 `recent()` 漏到渲染层。 */
function parseLine(line: string): EgressLogEntry | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) return null
  if (record.action !== 'fetch' && record.action !== 'search') return null
  if (record.outcome !== 'ok' && record.outcome !== 'refused') return null
  if (typeof record.host !== 'string') return null
  if (record.bytes !== undefined && (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0)) return null
  if (record.count !== undefined && (!Number.isSafeInteger(record.count) || (record.count as number) < 0)) return null
  if (record.code !== undefined && typeof record.code !== 'string') return null
  return {
    at: new Date(record.at).toISOString(),
    action: record.action,
    host: clean(record.host, EGRESS_LOG_LIMITS.maxHost),
    ...(record.bytes !== undefined ? { bytes: record.bytes as number } : {}),
    ...(record.count !== undefined ? { count: record.count as number } : {}),
    outcome: record.outcome,
    ...(typeof record.code === 'string' && record.code ? { code: clean(record.code, EGRESS_LOG_LIMITS.maxCode) } : {})
  }
}

/** `recent()` 的条数：默认 10，最多 50；越界一律夹回合同范围。 */
function limitOf(limit: number | undefined): number {
  if (limit === undefined || !Number.isSafeInteger(limit)) return EGRESS_LOG_LIMITS.defaultRecent
  return Math.min(Math.max(limit, 1), EGRESS_LOG_LIMITS.maxRecent)
}

export type EgressLog = {
  append(entry: EgressLogEntry): void
  recent(limit?: number): EgressLogView
  clear(): void
}

export function createEgressLog(userData: string): EgressLog {
  const target = path.join(userData, FILE)
  const archive = path.join(userData, ARCHIVE)

  /** 追加前轮转；文件不存在时什么都不做。读不出来就抛，不盲目改名。 */
  const rotateIfNeeded = (): void => {
    let size: number
    try { size = statSync(target).size } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (size <= EGRESS_LOG_LIMITS.maxBytes) {
      const content = readFileSync(target, 'utf8')
      if (countLines(content) <= EGRESS_LOG_LIMITS.maxLines) return
    }
    // Windows 的 rename 不覆盖已有文件；先删旧归档，再改名。归档本身是审计副本，
    // 轮转没有跨文件原子性可言，这里只保证「不会把新旧两代写进同一个文件」。
    rmSync(archive, { force: true })
    renameSync(target, archive)
  }

  const lockDownMode = (): void => {
    // 创建时已用 0600；旧文件或别处创建的文件再收一次（Windows 上 chmod 无意义，忽略失败）。
    try { chmodSync(target, 0o600) } catch { /* best effort */ }
  }

  return {
    append(entry: EgressLogEntry): void {
      const line = JSON.stringify(normalize(entry))
      rotateIfNeeded()
      const descriptor = openSync(target, 'a', 0o600)
      try {
        writeSync(descriptor, `${line}\n`)
        // 审计链比普通配置更怕掉电：一次外发一条，fsync 的代价可以接受。
        fsyncSync(descriptor)
      } finally { closeSync(descriptor) }
      lockDownMode()
    },

    recent(limit?: number): EgressLogView {
      const max = limitOf(limit)
      let content: string
      try { content = readFileSync(target, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], skipped: 0 }
        throw error
      }
      const entries: EgressLogEntry[] = []
      let skipped = 0
      for (const line of content.split('\n')) {
        // 文件末尾的换行不是一条空记录。
        if (!line) continue
        const entry = parseLine(line)
        if (entry) entries.push(entry)
        else skipped += 1
      }
      return { entries: entries.slice(-max), skipped }
    },

    clear(): void {
      // 两个都不存在也算成功。
      rmSync(target, { force: true })
      rmSync(archive, { force: true })
    }
  }
}
