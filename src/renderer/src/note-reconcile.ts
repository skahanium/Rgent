import { composeSource, partitionSource, preferDiskLedger } from '@markdown'
import type { NoteSnapshot, NoteWriteRequest, NoteWriteResult } from '@shared'
import type { Tab } from './tabs.ts'

export type ReconcileChoice = 'window' | 'disk' | 'continue'
export type ReconcileResult = 'unchanged' | 'disk' | 'saved' | 'continued' | 'stale' | 'error'

export type ReconcileDeps = {
  isCurrent: () => boolean
  read: () => Promise<NoteSnapshot>
  draft: () => string
  choose: (windowBody: string, diskBody: string) => Promise<ReconcileChoice>
  write: (request: NoteWriteRequest) => Promise<NoteWriteResult>
  applyDisk: (snapshot: NoteSnapshot) => void
  applySaved: (body: string, ledger: string | null, revision: string) => void
}

/** Both filesystem notifications and failed noteWrite calls reach this same revision gate. */
export async function reconcileNote(tab: Tab, deps: ReconcileDeps): Promise<ReconcileResult> {
  for (;;) {
    if (!deps.isCurrent()) return 'stale'
    let disk: NoteSnapshot
    try {
      disk = await deps.read()
    } catch {
      return 'error'
    }
    if (!deps.isCurrent()) return 'stale'
    if (disk.revision === tab.revision) return 'unchanged'

    const body = deps.draft()
    if (!tab.dirty || composeSource(body, tab.ledger) === disk.content) {
      deps.applyDisk(disk)
      return 'disk'
    }

    const choice = await deps.choose(body, partitionSource(disk.content).body)
    if (!deps.isCurrent()) return 'stale'
    if (choice === 'continue') return 'continued'

    let latest: NoteSnapshot
    try {
      latest = await deps.read()
    } catch {
      return 'error'
    }
    if (!deps.isCurrent()) return 'stale'
    if (latest.revision !== disk.revision || latest.objectVersion !== disk.objectVersion) continue
    if (choice === 'disk') {
      deps.applyDisk(latest)
      return 'disk'
    }

    const ledger = preferDiskLedger(partitionSource(latest.content).ledger, tab.ledger)
    let result: NoteWriteResult
    try {
      result = await deps.write({
        relPath: tab.relPath,
        content: composeSource(body, ledger),
        expectedRevision: latest.revision,
        sessionId: latest.sessionId,
        objectVersion: latest.objectVersion
      })
    } catch {
      return 'error'
    }
    if (!deps.isCurrent()) return 'stale'
    if (!result.ok) {
      if (result.error === 'CONFLICT') continue
      return 'error'
    }
    tab.sessionId = result.sessionId
    tab.objectVersion = result.objectVersion
    deps.applySaved(body, ledger, result.revision)
    return 'saved'
  }
}
