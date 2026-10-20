import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/**
 * 联网总闸的设备级最小配置（`network-config.json`，v1）。
 *
 * P3 只有 `{ enabled }` 一个字段；服务商、key、密文由 P4 扩展，不在本包做。
 * 读盘遇到缺失、损坏、形状不对或版本不认识，一律**回退为关闭**（fail closed），
 * 不覆盖磁盘上的坏文件；人下一次显式保存才会重写。
 */
export type NetworkConfig = { enabled: boolean }
export type NetworkConfigStore = {
  enabled(): boolean
  setEnabled(enabled: boolean): NetworkConfig
  getPublic(): NetworkConfig
}

const FILE = 'network-config.json'
const MAX_BYTES = 64 * 1024
const disabled = (): NetworkConfig => ({ enabled: false })

function parse(raw: string): NetworkConfig | null {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (record.version !== undefined && record.version !== 1) return null
    if (typeof record.enabled !== 'boolean') return null
    return { enabled: record.enabled }
  } catch { return null }
}

export function createNetworkConfigStore(userData: string): NetworkConfigStore {
  const target = path.join(userData, FILE)
  const read = (): NetworkConfig => {
    try { return parse(readFileSync(target, 'utf8')) ?? disabled() }
    // 文件不存在、读不动、不是 UTF-8 文本：都按关闭处理。
    catch { return disabled() }
  }
  return {
    enabled: () => read().enabled,
    getPublic: () => read(),
    setEnabled(enabled: boolean): NetworkConfig {
      if (typeof enabled !== 'boolean') throw Error('BAD_REQUEST')
      const next: NetworkConfig = { enabled }
      const temporary = path.join(userData, `.network-config-${randomUUID()}.tmp`)
      let descriptor: number | null = null
      try {
        descriptor = openSync(temporary, 'wx', 0o600)
        writeFileSync(descriptor, JSON.stringify({ version: 1, ...next }))
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = null
        renameSync(temporary, target)
      } finally {
        if (descriptor !== null) closeSync(descriptor)
        try { unlinkSync(temporary) } catch { /* committed or never created */ }
      }
      return next
    }
  }
}
