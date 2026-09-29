import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeSecureFs, secureFsFor } from '../../src/main/secure-fs.ts'

const roots: string[] = []
async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-lifecycle-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    closeSecureFs(root)
    await rm(root, { recursive: true, force: true })
  }
})

describe('secure vault structure', () => {
  it('creates a directory beneath an existing verified parent', async () => {
    const root = await vault()
    await mkdir(path.join(root, '工作'))
    const fs = secureFsFor(root)
    fs.createDirectory('工作/研究')
    expect(fs.resolve('工作/研究').at(-1)?.kind).toBe('dir')
    expect(() => fs.createDirectory('工作/研究')).toThrow('EEXIST')
  })

  it('moves a file without rewriting its bytes and refuses a stale identity', async () => {
    const root = await vault()
    await mkdir(path.join(root, '归档'))
    await writeFile(path.join(root, '初稿.md'), '# 原文\r\n')
    const fs = secureFsFor(root)
    const id = fs.resolve('初稿.md').at(-1)!.id
    fs.move('初稿.md', '归档/定稿.md', id)
    expect(await readFile(path.join(root, '归档', '定稿.md'), 'utf8')).toBe('# 原文\r\n')
    expect(() => fs.move('归档/定稿.md', '初稿.md', 'stale')).toThrow('PATH_CHANGED')
  })

  it('rejects a linked parent and never moves data outside the vault', async () => {
    const root = await vault()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'rgent-outside-'))
    roots.push(outside)
    await writeFile(path.join(root, '笔记.md'), 'inside')
    await symlink(outside, path.join(root, '跳转'))
    const fs = secureFsFor(root)
    const id = fs.resolve('笔记.md').at(-1)!.id
    expect(() => fs.move('笔记.md', '跳转/笔记.md', id)).toThrow()
    expect(await readFile(path.join(root, '笔记.md'), 'utf8')).toBe('inside')
  })

  it('moves a folder and refuses to overwrite an existing destination', async () => {
    const root = await vault()
    await mkdir(path.join(root, '资料'))
    await mkdir(path.join(root, '归档'))
    await writeFile(path.join(root, '资料', '一.md'), 'one')
    const fs = secureFsFor(root)
    const id = fs.resolve('资料').at(-1)!.id
    fs.move('资料', '归档/资料', id)
    expect(await readFile(path.join(root, '归档', '资料', '一.md'), 'utf8')).toBe('one')
    await mkdir(path.join(root, '资料'))
    expect(() => fs.move('归档/资料', '资料', id)).toThrow('EEXIST')
  })
})
