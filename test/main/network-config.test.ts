import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNetworkConfigStore } from '../../src/main/network-config.ts'

function directory(): { dir: string; file: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rgent-network-config-'))
  return { dir, file: path.join(dir, 'network-config.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('network config store', () => {
  it('defaults to disabled before any file exists', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir)
      expect(store.enabled()).toBe(false)
      expect(store.getPublic()).toEqual({ enabled: false })
      expect(() => readFileSync(app.file)).toThrow()
    } finally { app.done() }
  })

  it('persists the master switch in network-config.json v1', () => {
    const app = directory()
    try {
      const store = createNetworkConfigStore(app.dir)
      expect(store.setEnabled(true)).toEqual({ enabled: true })
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual({ version: 1, enabled: true })
      expect(store.enabled()).toBe(true)
      expect(store.getPublic()).toEqual({ enabled: true })
      expect(createNetworkConfigStore(app.dir).enabled()).toBe(true)
      store.setEnabled(false)
      expect(JSON.parse(readFileSync(app.file, 'utf8'))).toEqual({ version: 1, enabled: false })
      expect(createNetworkConfigStore(app.dir).enabled()).toBe(false)
    } finally { app.done() }
  })

  it('falls back to disabled on a corrupt or malformed file and recovers on the next save', () => {
    const app = directory()
    try {
      for (const raw of ['not json{', JSON.stringify({ version: 1, enabled: 'yes' }), JSON.stringify({ version: 2, enabled: true }), '[]']) {
        writeFileSync(app.file, raw)
        expect(createNetworkConfigStore(app.dir).enabled()).toBe(false)
      }
      const store = createNetworkConfigStore(app.dir)
      store.setEnabled(true)
      expect(createNetworkConfigStore(app.dir).enabled()).toBe(true)
    } finally { app.done() }
  })
})
