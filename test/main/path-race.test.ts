import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { listVaultTree, readNoteSnapshot, writeNote } from '../../src/main/notes-fs.ts'
import { loadPermissions, modelTierFor } from '../../src/main/permissions.ts'
import { readVaultMedia } from '../../src/main/paths.ts'
import { VaultIndex } from '../../src/main/vault-index.ts'

const swapWorker = `
  const { parentPort, workerData } = require('node:worker_threads')
  const fs = require('node:fs')
  const { live, held, outside, stop, platform } = workerData
  const flag = new Int32Array(stop)
  parentPort.postMessage('ready')
  while (Atomics.load(flag, 0) === 0) {
    try {
      fs.renameSync(live, held)
      fs.symlinkSync(outside, live, platform === 'win32' ? 'junction' : 'dir')
      Atomics.add(flag, 1, 1)
      fs.unlinkSync(live)
      fs.renameSync(held, live)
    } catch (error) {
      parentPort.postMessage(String(error))
      break
    }
  }
`

async function withSwappedDirectory(root: string, outside: string, run: () => Promise<void>): Promise<void> {
  const live = path.join(root, 'folder')
  const held = path.join(root, 'folder-held')
  const stop = new SharedArrayBuffer(8)
  const worker = new Worker(swapWorker, {
    eval: true,
    workerData: { live, held, outside, stop, platform: process.platform }
  })
  const [ready] = await once(worker, 'message')
  if (ready !== 'ready') throw new Error(String(ready))
  try {
    await run()
  } finally {
    Atomics.store(new Int32Array(stop), 0, 1)
    await worker.terminate()
    if (existsSync(live) && lstatSync(live).isSymbolicLink()) unlinkSync(live)
    if (!existsSync(live) && existsSync(held)) {
      const fs = await import('node:fs/promises')
      await fs.rename(held, live)
    }
  }
  expect(Atomics.load(new Int32Array(stop), 1)).toBeGreaterThan(0)
}

it('never returns outside note, index, or media content while a directory is replaced', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-race-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'rgent-out-'))
  mkdirSync(path.join(root, 'folder'))
  writeFileSync(path.join(root, 'folder', 'a.md'), 'inside note')
  writeFileSync(path.join(root, 'folder', 'pic.png'), 'inside image')
  writeFileSync(path.join(outside, 'a.md'), 'outside secret')
  writeFileSync(path.join(outside, 'pic.png'), 'outside image')
  const index = new VaultIndex(() => root, () => listVaultTree(root))
  await withSwappedDirectory(root, outside, async () => {
    for (let i = 0; i < 100; i++) {
      const note = await readNoteSnapshot(root, 'folder/a.md').catch(() => null)
      expect(note?.content).not.toBe('outside secret')
      const media = (() => { try { return readVaultMedia(root, 'folder/pic.png') } catch { return null } })()
      expect(media && 'bytes' in media ? media.bytes.toString() : null).not.toBe('outside image')
      index.markDirty()
      const hits = await index.search('outside secret').catch(() => [])
      expect(hits).toHaveLength(0)
    }
  })
})

it('never replaces an outside note during directory swaps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-race-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'rgent-out-'))
  mkdirSync(path.join(root, 'folder'))
  writeFileSync(path.join(root, 'folder', 'a.md'), 'inside note')
  writeFileSync(path.join(outside, 'a.md'), 'outside secret')
  await writeFile(path.join(root, '.rgent-permissions'), JSON.stringify({ folder: 'forbidden' }))
  await withSwappedDirectory(root, outside, async () => {
    for (let i = 0; i < 100; i++) {
      const policy = await loadPermissions(root)
      if (policy.status === 'ready') expect(policy.entries.map((entry) => entry.tier)).toContain('forbidden')
      const model = await modelTierFor(root, 'folder/a.md').catch((error: unknown) => String(error))
      expect(model).not.toBe('reference')
      const note = await readNoteSnapshot(root, 'folder/a.md').catch(() => null)
      if (note?.content === 'inside note') {
        await writeNote(root, 'folder/a.md', 'inside note', note.revision).catch(() => {})
      }
    }
  })
  expect(await readFile(path.join(outside, 'a.md'), 'utf8')).toBe('outside secret')
  expect(readFileSync(path.join(root, '.rgent-permissions'), 'utf8')).toContain('forbidden')
})

it.skipIf(process.platform === 'win32')('rejects named pipes without blocking the main process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-fifo-'))
  execFileSync('mkfifo', [path.join(root, 'pipe.md')])
  execFileSync('mkfifo', [path.join(root, '.rgent-permissions')])
  await expect(readNoteSnapshot(root, 'pipe.md')).rejects.toThrow()
  expect((await loadPermissions(root)).status).toBe('invalid')
})
