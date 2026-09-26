import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { closeSecureFs } from '../../src/main/secure-fs.ts'
import { watchVault } from '../../src/main/watch.ts'

const POLL = 20

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  if (!check()) throw new Error('等待监听回调超时')
}

async function vault(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'rgent-watch-'))
}

/** 收集回调，直到 stop() 被调用为止。 */
function collect(root: string, pollMs: number = POLL): { seen: Array<string | null>; stop: () => void } {
  const seen: Array<string | null> = []
  const stop = watchVault(root, (relPath) => seen.push(relPath), pollMs)
  return { seen, stop }
}

describe('watchVault', () => {
  it('reports an added file by its vault-relative path', async () => {
    const root = await vault()
    const { seen, stop } = collect(root)
    try {
      await writeFile(path.join(root, 'a.md'), '甲', 'utf8')
      await waitFor(() => seen.includes('a.md'))
    } finally {
      stop()
      closeSecureFs(root)
    }
  })

  it('reports a removed file by its vault-relative path', async () => {
    const root = await vault()
    await writeFile(path.join(root, 'a.md'), '甲', 'utf8')
    const { seen, stop } = collect(root)
    try {
      await rm(path.join(root, 'a.md'))
      await waitFor(() => seen.includes('a.md'))
    } finally {
      stop()
      closeSecureFs(root)
    }
  })

  it('reports nested paths and renames', async () => {
    const root = await vault()
    await mkdir(path.join(root, 'sub'))
    await writeFile(path.join(root, 'sub', 'a.md'), '甲', 'utf8')
    const { seen, stop } = collect(root)
    try {
      await rename(path.join(root, 'sub', 'a.md'), path.join(root, 'sub', 'b.md'))
      await waitFor(() => seen.includes('sub/b.md'))
    } finally {
      stop()
      closeSecureFs(root)
    }
  })

  it('collapses a bulk change into one null signal instead of flooding the handler', async () => {
    const root = await vault()
    // 轮询放慢，保证 25 个文件全部落在两次扫描之间：这条测的是「一次扫描看到
    // 超过 20 处变化就折叠成一个 null」，不是竞态。
    const { seen, stop } = collect(root, 200)
    try {
      await Promise.all(
        Array.from({ length: 25 }, (_, index) => writeFile(path.join(root, `n${index}.md`), '甲', 'utf8'))
      )
      await waitFor(() => seen.includes(null))
      expect(seen.every((item) => item === null)).toBe(true)
    } finally {
      stop()
      closeSecureFs(root)
    }
  })

  it('reports a scan failure once and stops hammering the handler', async () => {
    const root = await vault()
    const { seen, stop } = collect(root)
    try {
      // 关掉库句柄：后续扫描一律失败，模拟「安全状态不明」。
      closeSecureFs(root)
      await waitFor(() => seen.includes(null))
      const afterFirst = seen.filter((item) => item === null).length
      await new Promise((resolve) => setTimeout(resolve, POLL * 4))
      expect(seen.filter((item) => item === null).length).toBe(afterFirst)
    } finally {
      stop()
    }
  })

  it('does not traverse a directory reached through a link', async () => {
    const root = await vault()
    const outside = await vault()
    await writeFile(path.join(outside, 'secret.md'), '库外', 'utf8')
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const { seen, stop } = collect(root)
    try {
      await new Promise((resolve) => setTimeout(resolve, POLL * 4))
      expect(seen).not.toContain('linked/secret.md')
      expect(seen).not.toContain('linked')
    } finally {
      stop()
      closeSecureFs(root)
      closeSecureFs(outside)
    }
  })

  it('stops reporting after stop()', async () => {
    const root = await vault()
    const { seen, stop } = collect(root)
    stop()
    await writeFile(path.join(root, 'a.md'), '甲', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, POLL * 4))
    expect(seen).toEqual([])
    closeSecureFs(root)
  })
})
