import { randomUUID } from 'node:crypto'
import type { VaultRestoreReceipt } from '../shared/vault-management.ts'

/** One binding and one close intent; a commit reply is not a restoration receipt. */
export class VaultSwitch<T, R> {
  phase: 'idle' | 'preparing' | 'committing' | 'restoring' = 'idle'
  private generation = 0
  private watchdog = 0
  operationId = ''
  private cancelled = false
  private deferredClose = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private restore: { id: string; owner: unknown; sessionId: string | null; result: R } | null = null
  get busy(): boolean { return this.phase !== 'idle' }
  constructor(private ports: {
    check: (target: T) => void
    prepare: (target: T, current: () => void) => Promise<void>
    flush: () => Promise<boolean>
    commit: (target: T) => Promise<R>
    release: () => void
    close?: () => void
    changed?: (phase: VaultSwitch<T,R>['phase'], closePending: boolean, operationId: string) => void
    handoff?: (result: R, id: string, owner: unknown, retry: boolean) => { result: R; sessionId: string | null }
    stalled?: (phase: VaultSwitch<T,R>['phase'], ticket: number) => void
    deadlineMs?: number
  }) {}

  requestClose(): boolean {
    if (!this.busy) return false
    this.deferredClose = true
    if (this.phase === 'preparing') this.cancelled = true
    this.ports.changed?.(this.phase, true, this.operationId)
    return true
  }
  cancelClose(): void { this.deferredClose = false; this.ports.changed?.(this.phase, false, this.operationId) }
  restored(owner: unknown, receipt: VaultRestoreReceipt, currentSession: string | null): boolean {
    const hold = this.restore
    if (this.phase !== 'restoring' || !hold || hold.owner !== owner || hold.id !== receipt.id ||
      hold.sessionId !== receipt.sessionId || currentSession !== hold.sessionId) return false
    this.finish()
    return true
  }
  retryRestore(owner?: unknown): boolean {
    if (this.phase !== 'restoring' || !this.restore) return false
    const hold = this.restore
    this.beginRestore(hold.result, owner ?? hold.owner, true)
    return true
  }
  isCurrentStall(ticket: number): boolean { return this.busy && this.watchdog === ticket }
  continueWaiting(): void { if(this.busy)this.arm() }
  private arm(): void {
    const ticket=++this.watchdog
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.ports.stalled?.(this.phase, ticket) }, this.ports.deadlineMs ?? 30_000)
    this.timer.unref?.()
  }
  private beginRestore(result: R, owner: unknown, retry = false): R {
    const id = randomUUID(), handoff = this.ports.handoff!(result, id, owner, retry)
    this.restore = { id, owner, sessionId: handoff.sessionId, result: handoff.result }
    this.phase = 'restoring'; this.ports.changed?.(this.phase, this.deferredClose, this.operationId); this.arm()
    return handoff.result
  }
  private finish(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.restore = null; this.phase = 'idle'; this.generation++;this.watchdog++
    this.ports.release()
    const close = this.deferredClose; this.deferredClose = false
    if (close) this.ports.close?.()
  }
  async run(target: T, owner: unknown = null): Promise<R> { return this.select(run => run(target), owner) }

  /** Native selection, preparation, commit and renderer handoff share ownership. */
  async select<S>(action: (run: (target: T) => Promise<R>, current: () => void) => Promise<S>, owner: unknown = null): Promise<S> {
    if (this.busy) throw Error('VAULT_SWITCH_BUSY')
    this.phase = 'preparing'; this.cancelled = false;this.operationId=randomUUID()
    const generation = ++this.generation
    const current = () => { if (generation !== this.generation || this.cancelled) throw Error('VAULT_SWITCH_CANCELLED') }
    this.ports.changed?.(this.phase, false, this.operationId)
    let deadline: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => { if (this.phase === 'preparing') reject(Error('VAULT_SWITCH_TIMEOUT')) }, this.ports.deadlineMs ?? 30_000)
      deadline.unref?.()
    })
    try {
      return await Promise.race([action(async target => {
        current(); this.ports.check(target)
        await this.ports.prepare(target, current); current()
        if (!await this.ports.flush()) throw Error('UNSAVED_DRAFT')
        current(); this.ports.check(target)
        this.phase = 'committing'; if (deadline) clearTimeout(deadline)
        this.ports.changed?.(this.phase, this.deferredClose, this.operationId); this.arm()
        const result = await this.ports.commit(target)
        return this.ports.handoff ? this.beginRestore(result, owner) : result
      }, current), timedOut])
    } finally {
      if (deadline) clearTimeout(deadline)
      if (!this.restore) this.finish()
    }
  }
}
