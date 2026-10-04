/** One commit lane for all mutations to an attached vault. */
export class VaultMutationQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  idle(): Promise<void> { return this.tail }
}

type StructureScope = { root: string; exact: string[]; prefixes: string[] }

/** New tasks stop immediately; existing writes may finish before the move is sealed. */
export class VaultStructureGate {
  private operation: (StructureScope & { sealed: boolean }) | null = null

  isBusy(): boolean { return this.operation !== null }

  begin(scope: StructureScope): void {
    if (this.operation) throw new Error('STRUCTURE_BUSY')
    this.operation = { root: scope.root, exact: [...scope.exact], prefixes: [...scope.prefixes], sealed: false }
  }

  affects(root: string, relPath: string): boolean {
    const operation = this.operation
    return !!operation && operation.root === root &&
      (operation.exact.includes(relPath) || operation.prefixes.some((prefix) => prefix === '' || relPath.startsWith(`${prefix}/`)))
  }

  blocksWrite(root: string, relPath: string): boolean {
    return !!this.operation?.sealed && this.affects(root, relPath)
  }

  seal(): void {
    if (!this.operation) throw new Error('STRUCTURE_BUSY')
    this.operation.sealed = true
  }

  async recover<T>(root: string, deps: {
    assert: () => void; quiesce: () => Promise<void>; prepare: () => Promise<boolean>
    drain: () => Promise<void>; release: () => void
  }, run: () => Promise<T>): Promise<T> {
    this.begin({ root, exact: [], prefixes: [''] })
    try {
      await deps.quiesce(); deps.assert()
      if (!await deps.prepare()) throw Error('UNSAVED_DRAFT')
      deps.assert(); this.seal()
      await deps.drain(); deps.assert()
      const result = await run(); deps.assert(); return result
    } finally { this.finish(); deps.release() }
  }

  finish(): void { this.operation = null }
}
