import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PreflightStore, VaultFailureStore } from '../../src/main/diagnostic-store.ts'
import { secureFsFor, closeSecureFs } from '../../src/main/secure-fs.ts'
import { makeTaskFailure } from '../../src/shared/task-failure.ts'
const roots: string[] = []
const dir = () => { const value = mkdtempSync(path.join(os.tmpdir(), 'rgent-diagnostics-')); roots.push(value); return value }
afterEach(() => roots.splice(0).forEach(root => { try { closeSecureFs(root) } catch { /* ignore */ } rmSync(root, { recursive: true, force: true }) }))

describe('diagnostic stores', () => {
  it('persists task failure pointers without prompt or answer', () => {
    const root = dir(), fs = secureFsFor(root)
    const store = new VaultFailureStore(fs, () => new Date('2026-10-24T12:00:00Z'))
    const failure = makeTaskFailure({ code: 'MODEL_REQUEST_FAILED', diagnosticId: 'diag-1', detail: { httpStatus: 503 } })
    store.record('task-1', 'a.md', failure, false)
    expect(store.forPath('a.md')).toEqual([{ taskId: 'task-1', relPath: 'a.md', at: '2026-10-24T12:00:00.000Z', failure, answerEmpty: false }])
    const raw = readFileSync(path.join(root, '.rgent', 'diagnostics', 'failures.json'), 'utf8')
    expect(raw).not.toContain('"prompt"')
    expect(raw).not.toContain('"answer"')
    store.forget('task-1')
    expect(store.forPath('a.md')).toEqual([])
  })

  it('bounds preflight entries and keeps only sanitized records', () => {
    const directory = dir(), store = new PreflightStore(directory, () => new Date('2026-10-24T12:00:00Z'))
    for (let i = 0; i < 25; i++) store.record({ code: 'MODEL_CONFIG_UNAVAILABLE', family: 'MODEL_AUTH', stage: 'preflight', action: 'open_model_settings', retryable: false, message: '配置不可用' })
    expect(store.all()).toHaveLength(20)
    expect(store.all()[0]!.code).toBe('MODEL_CONFIG_UNAVAILABLE')
    expect(JSON.stringify(store.all())).not.toContain('secret')
  })
})
