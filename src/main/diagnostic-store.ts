import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { SecureVaultFs } from './secure-fs.ts'
import { validTaskFailure, type FailurePointer, type PreflightEntry, type TaskFailure } from '../shared/task-failure.ts'

type FailureFile = { version: 1; failures: FailurePointer[] }
const FAILURE_PATH = '.rgent/diagnostics/failures.json'
const MAX_FAILURES = 256
const MAX_AGE = 30 * 24 * 60 * 60 * 1000

const validPointer = (value: unknown): value is FailurePointer => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).sort().join() === 'answerEmpty,at,failure,relPath,taskId'
    && typeof v.taskId === 'string' && v.taskId.length > 0 && v.taskId.length <= 128
    && typeof v.relPath === 'string' && v.relPath.length > 0 && v.relPath.length <= 4096
    && typeof v.at === 'string' && Number.isFinite(Date.parse(v.at)) && typeof v.answerEmpty === 'boolean'
    && validTaskFailure(v.failure)
}

/** Vault-local failure pointers. Contains no prompt, answer or response body. */
export class VaultFailureStore {
  constructor(private readonly fs: SecureVaultFs, private readonly now: () => Date = () => new Date()) {}

  read(): FailurePointer[] {
    let raw: string
    try { raw = this.fs.readText(FAILURE_PATH) } catch (error) {
      if (error instanceof Error && error.message === 'ENOENT') return []
      throw error
    }
    try {
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const v = value as Record<string, unknown>
      if (v.version !== 1 || !Array.isArray(v.failures) || !v.failures.every(validPointer)) return []
      return v.failures.slice(-MAX_FAILURES)
    } catch { return [] }
  }

  private write(entries: FailurePointer[]): void {
    const cutoff = this.now().getTime() - MAX_AGE
    const failures = entries
      .filter(entry => Date.parse(entry.at) >= cutoff)
      .slice(-MAX_FAILURES)
    try { this.fs.createDirectory('.rgent') } catch { /* exists */ }
    try { this.fs.createDirectory('.rgent/diagnostics') } catch { /* exists */ }
    const raw = JSON.stringify({ version: 1, failures } satisfies FailureFile)
    let previous: string | null = null
    try { previous = this.fs.readText(FAILURE_PATH) } catch { /* missing */ }
    this.fs.replace(FAILURE_PATH, previous, raw)
  }

  record(taskId: string, relPath: string, failure: TaskFailure, answerEmpty = true): void {
    if (!validTaskFailure(failure)) throw new Error('BAD_FAILURE')
    const at = this.now().toISOString()
    const next = this.read().filter(entry => entry.taskId !== taskId)
    next.push({ taskId, relPath, at, failure, answerEmpty })
    this.write(next)
  }

  forget(taskId: string): void {
    const next = this.read().filter(entry => entry.taskId !== taskId)
    this.write(next)
  }

  forPath(relPath: string): FailurePointer[] {
    return this.read().filter(entry => entry.relPath === relPath)
  }

  all(): FailurePointer[] { return this.read() }
}

type PreflightFile = { version: 1; entries: PreflightEntry[] }
const MAX_PREFLIGHT = 20
const PREFLIGHT_AGE = 7 * 24 * 60 * 60 * 1000

export class PreflightStore {
  private readonly file: string
  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date()) {
    this.file = path.join(directory, 'diagnostics', 'preflight.json')
  }
  read(): PreflightEntry[] {
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const v = value as Record<string, unknown>
      if (v.version !== 1 || !Array.isArray(v.entries)) return []
      return (v.entries as PreflightEntry[]).filter(entry => entry && typeof entry.id === 'string' && Number.isFinite(Date.parse(entry.at))).slice(-MAX_PREFLIGHT)
    } catch { return [] }
  }
  record(entry: Omit<PreflightEntry, 'id' | 'at'>): PreflightEntry[] {
    const at = this.now().toISOString(), id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const cutoff = this.now().getTime() - PREFLIGHT_AGE
    const next = [...this.read().filter(item => Date.parse(item.at) >= cutoff), { ...entry, id, at }].slice(-MAX_PREFLIGHT)
    try { mkdirSync(path.dirname(this.file), { recursive: true }) } catch { /* exists */ }
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, entries: next } satisfies PreflightFile))
    renameSync(temp, this.file)
    return next
  }
  all(): PreflightEntry[] { return this.read().filter(entry => Date.parse(entry.at) >= this.now().getTime() - PREFLIGHT_AGE) }
}

export { FAILURE_PATH, MAX_FAILURES, MAX_PREFLIGHT, PREFLIGHT_AGE }
