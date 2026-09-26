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
import { secureFsFor } from '../../src/main/secure-fs.ts'

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
  // Windows directory handles intentionally deny rename sharing; a blocked
  // swap is a valid secure outcome there.
  if (process.platform !== 'win32') expect(Atomics.load(new Int32Array(stop), 1)).toBeGreaterThan(0)
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

it('does not commit outside the vault when an opened child directory moves out', async () => {
  // 两平台同一条保证：已打开的子目录被整体搬出库外时，提交必须失败，库外原文一字不动。
  // macOS 靠 RENAME_RESOLVE_BENEATH；Windows 靠提交前从库根重走父目录、比对身份，
  // 再把目标名解析在核验过的父句柄上（见 native/vault_win.cc 的 Replace）。
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-move-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'rgent-out-'))
  mkdirSync(path.join(root, 'sub'))
  writeFileSync(path.join(root, 'sub', 'a.md'), 'old')
  const moved = new SharedArrayBuffer(4)
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads')
    const fs = require('node:fs')
    const path = require('node:path')
    const flag = new Int32Array(workerData.moved)
    parentPort.postMessage('ready')
    // 临时文件建在目标父目录里（两平台一致），所以盯 sub 而不是库根。
    while (Atomics.load(flag, 0) === 0) {
      if (fs.readdirSync(workerData.live).some((name) => name.startsWith('.rgent-') && name.endsWith('.tmp'))) {
        try {
          fs.renameSync(workerData.live, path.join(workerData.outside, 'sub'))
          Atomics.store(flag, 0, 1)   // 搬成功了
        } catch {
          Atomics.store(flag, 0, 2)   // 系统不让搬（我们的句柄把它钉住了）
        }
        break
      }
    }
  `, { eval: true, workerData: { live: path.join(root, 'sub'), outside, moved } })
  await once(worker, 'message')
  try {
    // 先跑提交（临时文件只在提交过程中存在，标志也是在那时被置上），再看结果。
    let threw = false
    try {
      secureFsFor(root).replace('sub/a.md', 'old', 'x'.repeat(64 * 1024 * 1024))
    } catch {
      threw = true
    }
    const outcome = Atomics.load(new Int32Array(moved), 0)
    expect([1, 2]).toContain(outcome)
    if (outcome === 1) {
      // 目录真被搬出去了：提交必须失败，库外原文一字不动。
      expect(threw).toBe(true)
      expect(readFileSync(path.join(outside, 'sub', 'a.md'), 'utf8')).toBe('old')
    } else {
      // 系统没让搬（Windows 上我们持有的句柄可能就把目录钉住）：那就没有这个窗口，
      // 提交照常落在库内，库外什么也没多出来。
      expect(threw).toBe(false)
      expect(readFileSync(path.join(root, 'sub', 'a.md'), 'utf8')).toBe('x'.repeat(64 * 1024 * 1024))
      expect(existsSync(path.join(outside, 'sub'))).toBe(false)
    }
  } finally {
    Atomics.store(new Int32Array(moved), 0, 1)
    await worker.terminate()
  }
})
