import { isHiddenName } from './paths.ts'
import { secureFsFor } from './secure-fs.ts'

export type WatchHandler = (relPath: string | null) => void

const POLL_MS = 1000

/** 元数据轮询只经固定在所选库上的目录句柄。`pollMs` 只为测试留口，生产用默认值。 */
export function watchVault(root: string, onChange: WatchHandler, pollMs: number = POLL_MS): () => void {
  const fs = secureFsFor(root)
  const scan = (): Map<string, string> => {
    const snapshot = new Map<string, string>()
    const visit = (dir: string): void => {
      for (const entry of fs.list(dir)) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name
        snapshot.set(rel, `${entry.kind}:${entry.size}:${entry.mtimeMs}`)
        if (entry.kind === 'dir' && !isHiddenName(entry.name)) visit(rel)
      }
    }
    visit('')
    return snapshot
  }

  let previous = scan()
  let failed = false
  const timer = setInterval(() => {
    try {
      const current = scan()
      const changed = new Set<string>()
      for (const [rel, value] of current) if (previous.get(rel) !== value) changed.add(rel)
      for (const rel of previous.keys()) if (!current.has(rel)) changed.add(rel)
      previous = current
      failed = false
      if (changed.size > 20) onChange(null)
      else for (const rel of changed) onChange(rel)
    } catch {
      if (!failed) onChange(null)
      failed = true
    }
  }, pollMs)
  timer.unref()
  return () => clearInterval(timer)
}
