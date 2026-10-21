import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEgressLog, EGRESS_LOG_LIMITS } from '../../src/main/egress-log.ts'
import type { EgressLogEntry } from '../../src/shared/ipc.ts'

/** 外发日志：固定形状、只追加、轮转、坏行跳过，且永远不写 URL／正文／凭据。 */

const directories: string[] = []
function directory(): { dir: string; file: string; archive: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rgent-egress-log-'))
  directories.push(dir)
  return {
    dir,
    file: path.join(dir, 'network-egress.jsonl'),
    archive: path.join(dir, 'network-egress.jsonl.1'),
    done: () => rmSync(dir, { recursive: true, force: true })
  }
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const entry = (over: Partial<EgressLogEntry> = {}): EgressLogEntry => ({
  at: '2026-10-21T00:00:00.000Z',
  action: 'fetch',
  host: 'example.com',
  bytes: 12,
  outcome: 'ok',
  ...over
})

const lines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(Boolean)

describe('egress log', () => {
  it('appends JSON lines and reads them back in order with the requested limit', () => {
    const app = directory()
    try {
      const log = createEgressLog(app.dir)
      expect(log.recent()).toEqual({ entries: [], skipped: 0 })
      for (let index = 1; index <= 3; index += 1) {
        log.append(entry({ at: `2026-10-21T00:00:0${index}.000Z`, host: `h${index}.example` }))
      }
      expect(lines(app.file)).toHaveLength(3)
      expect(log.recent().entries.map(item => item.host)).toEqual(['h1.example', 'h2.example', 'h3.example'])
      expect(log.recent(2).entries.map(item => item.host)).toEqual(['h2.example', 'h3.example'])
      expect(JSON.parse(lines(app.file)[1]!)).toEqual(entry({ at: '2026-10-21T00:00:02.000Z', host: 'h2.example' }))
    } finally { app.done() }
  })

  it('caps recent() at 50 entries even when more are asked for', () => {
    const app = directory()
    try {
      const log = createEgressLog(app.dir)
      for (let index = 1; index <= 55; index += 1) log.append(entry({ host: `h${index}.example` }))
      const recent = log.recent(500)
      expect(recent.entries).toHaveLength(EGRESS_LOG_LIMITS.maxRecent)
      expect(recent.entries[0]!.host).toBe('h6.example')
      expect(recent.entries.at(-1)!.host).toBe('h55.example')
      expect(log.recent(0).entries).toHaveLength(1)
      expect(log.recent(Number.NaN).entries).toHaveLength(10)
    } finally { app.done() }
  })

  it('rotates to .1 before the 202nd append once the live file holds more than 200 lines', () => {
    const app = directory()
    try {
      const log = createEgressLog(app.dir)
      for (let index = 1; index <= 201; index += 1) log.append(entry({ host: `h${index}.example` }))
      expect(readdirSync(app.dir)).toEqual(['network-egress.jsonl'])
      log.append(entry({ host: 'h202.example' }))
      expect(readdirSync(app.dir).sort()).toEqual(['network-egress.jsonl', 'network-egress.jsonl.1'])
      expect(lines(app.archive)).toHaveLength(201)
      expect(lines(app.file)).toHaveLength(1)
      expect(JSON.parse(lines(app.archive)[0]!).host).toBe('h1.example')
      expect(log.recent().entries.map(item => item.host)).toEqual(['h202.example'])
      // 轮转把旧归档整份覆盖，不会无限长成 .2／.3。
      log.append(entry({ host: 'h203.example' }))
      expect(readdirSync(app.dir).sort()).toEqual(['network-egress.jsonl', 'network-egress.jsonl.1'])
    } finally { app.done() }
  })

  it('rotates when the live file exceeds 256 KiB even if it holds few lines', () => {
    const app = directory()
    try {
      writeFileSync(app.file, `${'x'.repeat(300 * 1024)}\n`)
      const log = createEgressLog(app.dir)
      log.append(entry({ host: 'after.example' }))
      expect(statSync(app.archive).size).toBeGreaterThan(EGRESS_LOG_LIMITS.maxBytes)
      expect(lines(app.file)).toHaveLength(1)
      expect(log.recent().entries.map(item => item.host)).toEqual(['after.example'])
    } finally { app.done() }
  })

  it('skips and counts corrupt lines instead of throwing', () => {
    const app = directory()
    try {
      const log = createEgressLog(app.dir)
      log.append(entry({ host: 'good.example' }))
      writeFileSync(app.file, readFileSync(app.file, 'utf8') + '这不是 JSON\n{"at":"not-a-date"}\n{"at":"2026-10-21T00:00:00.000Z"}\n')
      const recent = log.recent()
      expect(recent.entries.map(item => item.host)).toEqual(['good.example'])
      expect(recent.skipped).toBe(3)
      // 末尾换行与空行不算坏行。
      writeFileSync(app.file, readFileSync(app.file, 'utf8') + '\n\n')
      expect(log.recent().skipped).toBe(3)
    } finally { app.done() }
  })

  it('creates the file with 0600 permissions', () => {
    const app = directory()
    try {
      const log = createEgressLog(app.dir)
      log.append(entry())
      if (process.platform !== 'win32') expect(statSync(app.file).mode & 0o777).toBe(0o600)
    } finally { app.done() }
  })

  it('never writes a URL, query, body or credential even if the caller passes them', () => {
    const app = directory()
    try {
      const log = createEgressLog(app.dir)
      const leaky = {
        ...entry({ action: 'search', host: 'api.search.example', bytes: undefined, count: 3 }),
        url: 'https://example.com/secret?q=SECRET_QUERY',
        query: 'SECRET_QUERY',
        text: 'SECRET_BODY',
        key: 'SECRET_KEY'
      } as unknown as EgressLogEntry
      log.append(leaky)
      const raw = readFileSync(app.file, 'utf8')
      for (const secret of ['SECRET_QUERY', 'SECRET_BODY', 'SECRET_KEY', 'https://']) expect(raw).not.toContain(secret)
      expect(JSON.parse(lines(app.file)[0]!)).toEqual({
        at: '2026-10-21T00:00:00.000Z',
        action: 'search',
        host: 'api.search.example',
        count: 3,
        outcome: 'ok'
      })
    } finally { app.done() }
  })

  it('strips control characters and truncates host and code to the fixed shape', () => {
    const app = directory()
    try {
      const log = createEgressLog(app.dir)
      log.append(entry({ host: `bad\nhost${'x'.repeat(400)}`, outcome: 'refused', code: `bad\ncode${'y'.repeat(100)}` }))
      const written = JSON.parse(lines(app.file)[0]!)
      expect(written.host.startsWith('badhost')).toBe(true)
      expect(written.host).toHaveLength(EGRESS_LOG_LIMITS.maxHost)
      expect(written.code.startsWith('badcode')).toBe(true)
      expect(written.code).toHaveLength(EGRESS_LOG_LIMITS.maxCode)
      expect(lines(app.file)).toHaveLength(1)
    } finally { app.done() }
  })

  it('clear() removes both the live file and the archive, and succeeds when neither exists', () => {
    const app = directory()
    try {
      const log = createEgressLog(app.dir)
      log.append(entry())
      writeFileSync(app.archive, 'archive\n')
      log.clear()
      expect(readdirSync(app.dir)).toEqual([])
      expect(() => log.clear()).not.toThrow()
      expect(log.recent()).toEqual({ entries: [], skipped: 0 })
    } finally { app.done() }
  })
})
