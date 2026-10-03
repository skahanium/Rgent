/** One active binding. Target checks are read-only; commit is the only binding change. */
export class VaultSwitch<T, R> {
  busy = false
  constructor(private ports: {
    check: (target: T) => void
    prepare: (target: T) => Promise<void>
    flush: () => Promise<boolean>
    commit: (target: T) => Promise<R>
    release: () => void
  }) {}

  async run(target: T): Promise<R> {
    return this.select(run => run(target))
  }

  /** Keep native selection and its eventual switch under the same ownership. */
  async select<S>(action: (run: (target: T) => Promise<R>) => Promise<S>): Promise<S> {
    if (this.busy) throw Error('VAULT_SWITCH_BUSY')
    this.busy = true
    try {
      return await action(async target => {
        this.ports.check(target)
        await this.ports.prepare(target)
        if (!await this.ports.flush()) throw Error('UNSAVED_DRAFT')
        this.ports.check(target)
        return this.ports.commit(target)
      })
    } finally {
      this.busy = false
      this.ports.release()
    }
  }
}
