import { watch, type FSWatcher } from 'node:fs'
import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { isHiddenName, relFromAbs } from './paths.ts'

export type WatchHandler = (relPath: string | null) => void

export function watchVault(root: string, onChange: WatchHandler): () => void {
  const watchers = new Map<string, FSWatcher>()

  const add = (dir: string) => {
    if (watchers.has(dir)) return
    let watcher: FSWatcher
    try {
      if (dir !== root && !lstatSync(dir).isDirectory()) return
      watcher = watch(dir, (_event, filename) => {
        refresh(dir)
        if (typeof filename === 'string' && filename.length > 0) {
          onChange(relFromAbs(root, path.join(dir, filename)))
        } else {
          onChange(relFromAbs(root, dir) || null)
        }
      })
    } catch {
      return
    }
    watcher.on('error', () => {
      onChange(null)
    })
    watchers.set(dir, watcher)
    refresh(dir)
  }

  const refresh = (dir: string) => {
    let entries
    try {
      if (dir !== root && !lstatSync(dir).isDirectory()) {
        stopDir(dir)
        onChange(null)
        return
      }
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      stopDir(dir)
      onChange(null)
      return
    }
    const live = new Set<string>()
    for (const entry of entries) {
      if (isHiddenName(entry.name)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        live.add(abs)
        add(abs)
      }
    }
    for (const watched of [...watchers.keys()]) {
      if (watched === dir) continue
      if (!watched.startsWith(dir + path.sep)) continue
      const first = path.relative(dir, watched).split(path.sep)[0]
      if (!first) continue
      const child = path.join(dir, first)
      if (!live.has(child)) stopDir(child)
    }
  }

  const stopDir = (dir: string) => {
    for (const [watched, watcher] of watchers) {
      if (watched === dir || watched.startsWith(dir + path.sep)) {
        watcher.close()
        watchers.delete(watched)
      }
    }
  }

  add(root)

  return () => {
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
  }
}
