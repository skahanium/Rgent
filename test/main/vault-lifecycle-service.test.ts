import { afterEach, describe, expect, it } from 'vitest'
import { renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeSecureFs, secureFsFor } from '../../src/main/secure-fs.ts'
import { VaultLifecycle } from '../../src/main/vault-lifecycle.ts'

const roots: string[] = []
async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-operations-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    closeSecureFs(root)
    await rm(root, { recursive: true, force: true })
  }
})

describe('VaultLifecycle', () => {
  it('previews and moves a note with its attachment folder, rules and confirmed links', async () => {
    const root = await vault()
    await mkdir(path.join(root, '工作', '晨间'), { recursive: true })
    await mkdir(path.join(root, '归档'))
    await writeFile(path.join(root, '工作', '晨间.md'), '# 原文\r\n')
    await writeFile(path.join(root, '工作', '晨间', '图.png'), Buffer.from([1, 2, 3]))
    await writeFile(path.join(root, '工作', '链接.md'), '参见 [[工作/晨间]]。')
    await writeFile(path.join(root, '.rgent-permissions'), '{"工作/晨间.md":"follow","工作/晨间/图.png":"follow"}\n')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '工作/晨间.md', target: '归档/晨间.md' })
    expect(preview.moves.map(({ from, to }) => [from, to])).toEqual([
      ['工作/晨间.md', '归档/晨间.md'],
      ['工作/晨间', '归档/晨间']
    ])
    expect(preview.linkChanges.map(({ relPath }) => relPath)).toEqual(['工作/链接.md'])
    await service.commit(preview.id, { repairLinks: true })
    expect(await readFile(path.join(root, '归档', '晨间.md'), 'utf8')).toBe('# 原文\r\n')
    expect(await readFile(path.join(root, '归档', '晨间', '图.png'))).toEqual(Buffer.from([1, 2, 3]))
    expect(await readFile(path.join(root, '工作', '链接.md'), 'utf8')).toBe('参见 [[归档/晨间]]。')
    expect(JSON.parse(await readFile(path.join(root, '.rgent-permissions'), 'utf8'))).toEqual({
      '归档/晨间.md': 'follow', '归档/晨间/图.png': 'follow'
    })
  })

  it('rejects a stale preview before moving anything', async () => {
    const root = await vault()
    await mkdir(path.join(root, '工作'))
    await writeFile(path.join(root, '旧.md'), 'first')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '旧.md', target: '工作/新.md' })
    await writeFile(path.join(root, '旧.md'), 'external change')
    await expect(service.commit(preview.id, { repairLinks: false })).rejects.toThrow('STALE_PREVIEW')
    expect(await readFile(path.join(root, '旧.md'), 'utf8')).toBe('external change')
  })

  it('repairs a full-path wikilink when the note has no attachment directory', async () => {
    const root = await vault()
    await mkdir(path.join(root, '归档'))
    await writeFile(path.join(root, '原篇.md'), '# 原文')
    await writeFile(path.join(root, '引用.md'), '参见 [[原篇]]。')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '原篇.md', target: '归档/新篇.md' })
    expect(preview.linkChanges.map((link) => link.relPath)).toEqual(['引用.md'])
    await service.commit(preview.id, { repairLinks: true })
    expect(await readFile(path.join(root, '引用.md'), 'utf8')).toBe('参见 [[归档/新篇]]。')
  })

  it('repairs links inside the moved note and clears the recovery record', async () => {
    const root = await vault()
    await mkdir(path.join(root, '归档'))
    await writeFile(path.join(root, '原篇.md'), '# 原文\n参见 [[原篇]]。')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '原篇.md', target: '归档/新篇.md' })
    expect(preview.linkChanges.map((link) => link.relPath)).toEqual(['原篇.md'])
    await service.commit(preview.id, { repairLinks: true })
    expect(await readFile(path.join(root, '归档', '新篇.md'), 'utf8')).toBe('# 原文\n参见 [[归档/新篇]]。')
    expect(JSON.parse(await readFile(path.join(root, '.rgent-lifecycle'), 'utf8')).active).toBeNull()
  })

  it('resumes after a moved note was atomically repaired but journal completion was interrupted', async () => {
    const root = await vault()
    await mkdir(path.join(root, '归档'))
    await writeFile(path.join(root, '原篇.md'), '参见 [[原篇]]。')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '原篇.md', target: '归档/新篇.md' })
    const fs = secureFsFor(root)
    const originalReplace = fs.replace.bind(fs)
    fs.replace = ((...args) => {
      if (args[0] === '.rgent-lifecycle' && args[2]?.includes('"active":null')) throw new Error('SIMULATED_INTERRUPTION')
      return originalReplace(...args)
    }) as typeof fs.replace
    try { await expect(service.commit(preview.id, { repairLinks: true })).rejects.toThrow('SIMULATED_INTERRUPTION') }
    finally { fs.replace = originalReplace }
    expect(await readFile(path.join(root, '归档', '新篇.md'), 'utf8')).toBe('参见 [[归档/新篇]]。')
    expect(await readFile(path.join(root, '.rgent-lifecycle'), 'utf8')).not.toContain('参见')
    expect((await service.recover())?.unrepaired).toEqual([])
    expect(JSON.parse(await readFile(path.join(root, '.rgent-lifecycle'), 'utf8')).active).toBeNull()
  })

  it('rejects an external edit after a moved note was repaired', async () => {
    const root = await vault()
    await mkdir(path.join(root, '归档'))
    await writeFile(path.join(root, '原篇.md'), '参见 [[原篇]]。')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '原篇.md', target: '归档/新篇.md' })
    const fs = secureFsFor(root)
    const originalReplace = fs.replace.bind(fs)
    fs.replace = ((...args) => {
      if (args[0] === '.rgent-lifecycle' && args[2]?.includes('"active":null')) throw new Error('SIMULATED_INTERRUPTION')
      return originalReplace(...args)
    }) as typeof fs.replace
    try { await expect(service.commit(preview.id, { repairLinks: true })).rejects.toThrow('SIMULATED_INTERRUPTION') }
    finally { fs.replace = originalReplace }
    await writeFile(path.join(root, '归档', '新篇.md'), '外部修改')
    await expect(service.recover()).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
    expect((await readFile(path.join(root, '.rgent-lifecycle'), 'utf8'))).toContain('"active":{')
  })

  it('moves nested folder permissions and refuses a note escaping an inherited restriction', async () => {
    const root = await vault()
    await mkdir(path.join(root, '限制'))
    await mkdir(path.join(root, '归档'))
    await writeFile(path.join(root, '限制', '笔记.md'), '原文')
    await writeFile(path.join(root, '.rgent-permissions'), '{"限制":"forbidden"}\n')
    const service = new VaultLifecycle(root)
    await expect(service.preview({ kind: 'note', source: '限制/笔记.md', target: '归档/笔记.md' }))
      .rejects.toThrow('PERMISSION_DOWNGRADE')
    const preview = await service.preview({ kind: 'folder', source: '限制', target: '归档/限制' })
    await service.commit(preview.id, { repairLinks: false })
    expect(await readFile(path.join(root, '归档', '限制', '笔记.md'), 'utf8')).toBe('原文')
    expect(JSON.parse(await readFile(path.join(root, '.rgent-permissions'), 'utf8'))).toEqual({ '归档/限制': 'forbidden' })
  })

  it('resumes an interrupted note and attachment move without duplicating either object', async () => {
    const root = await vault()
    await mkdir(path.join(root, '旧', '甲'), { recursive: true })
    await mkdir(path.join(root, '新'))
    await writeFile(path.join(root, '旧', '甲.md'), '正文')
    await writeFile(path.join(root, '旧', '甲', '图.png'), 'image')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '旧/甲.md', target: '新/甲.md' })
    const fs = secureFsFor(root)
    const originalMove = fs.move.bind(fs)
    let calls = 0
    fs.move = ((...args) => {
      if (++calls === 2) throw new Error('SIMULATED_INTERRUPTION')
      return originalMove(...args)
    }) as typeof fs.move
    try { await expect(service.commit(preview.id, { repairLinks: false })).rejects.toThrow('SIMULATED_INTERRUPTION') }
    finally { fs.move = originalMove }
    expect(await readFile(path.join(root, '新', '甲.md'), 'utf8')).toBe('正文')
    await service.recover()
    expect(await readFile(path.join(root, '新', '甲', '图.png'), 'utf8')).toBe('image')
    expect(await service.recover()).toBeNull()
  })

  it('keeps note text out of the recovery journal and reports a changed link source', async () => {
    const root = await vault()
    await mkdir(path.join(root, '归档'))
    await writeFile(path.join(root, '原篇.md'), '# 私密正文')
    await writeFile(path.join(root, '引用.md'), '保密片段 [[原篇]]')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '原篇.md', target: '归档/新篇.md' })
    const fs = secureFsFor(root)
    const originalMove = fs.move.bind(fs)
    fs.move = ((...args) => {
      originalMove(...args)
      throw new Error('SIMULATED_INTERRUPTION')
    }) as typeof fs.move
    try { await expect(service.commit(preview.id, { repairLinks: true })).rejects.toThrow('SIMULATED_INTERRUPTION') }
    finally { fs.move = originalMove }
    const journal = await readFile(path.join(root, '.rgent-lifecycle'), 'utf8')
    expect(journal).not.toContain('私密正文')
    expect(journal).not.toContain('保密片段')
    await writeFile(path.join(root, '引用.md'), '保密片段已改 [[原篇]]')
    const resumed = await service.recover()
    expect(resumed?.unrepaired).toEqual(['引用.md'])
    expect(await readFile(path.join(root, '引用.md'), 'utf8')).toBe('保密片段已改 [[原篇]]')
  })

  it('keeps recovery blocked if an attachment changes after a partial move', async () => {
    const root = await vault()
    await mkdir(path.join(root, '甲'))
    await mkdir(path.join(root, '乙'))
    await writeFile(path.join(root, '甲.md'), '正文')
    await writeFile(path.join(root, '甲', '图.png'), 'one')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '甲.md', target: '乙/甲.md' })
    const fs = secureFsFor(root)
    const originalMove = fs.move.bind(fs)
    let count = 0
    fs.move = ((...args) => {
      if (++count === 2) throw new Error('SIMULATED_INTERRUPTION')
      return originalMove(...args)
    }) as typeof fs.move
    try { await expect(service.commit(preview.id, { repairLinks: false })).rejects.toThrow('SIMULATED_INTERRUPTION') }
    finally { fs.move = originalMove }
    await writeFile(path.join(root, '甲', '图.png'), 'changed')
    await expect(service.recover()).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
    expect((await readFile(path.join(root, '.rgent-lifecycle'), 'utf8'))).toContain('"active":{')
  })

  it('keeps the recovery record when a move returns after relocating the wrong object', async () => {
    const root = await vault()
    await mkdir(path.join(root, '归档'))
    await writeFile(path.join(root, '原篇.md'), 'expected')
    await writeFile(path.join(root, '旁篇.md'), 'other')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '原篇.md', target: '归档/原篇.md' })
    const fs = secureFsFor(root)
    const originalMove = fs.move.bind(fs)
    fs.move = (() => {
      renameSync(path.join(root, '旁篇.md'), path.join(root, '归档', '原篇.md'))
    }) as typeof fs.move
    try {
      await expect(service.commit(preview.id, { repairLinks: false })).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
    } finally { fs.move = originalMove }
    expect(await readFile(path.join(root, '原篇.md'), 'utf8')).toBe('expected')
    expect(await readFile(path.join(root, '归档', '原篇.md'), 'utf8')).toBe('other')
    expect((await readFile(path.join(root, '.rgent-lifecycle'), 'utf8'))).toContain('"active":{')
  })

  it('keeps the recovery record if moved note bytes change during permission migration', async () => {
    const root = await vault()
    await mkdir(path.join(root, '归档'))
    await writeFile(path.join(root, '原篇.md'), 'expected')
    await writeFile(path.join(root, '.rgent-permissions'), '{"原篇.md":"follow"}\n')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '原篇.md', target: '归档/原篇.md' })
    const fs = secureFsFor(root)
    const originalReplace = fs.replace.bind(fs)
    fs.replace = ((...args) => {
      originalReplace(...args)
      if (args[0] === '.rgent-permissions') writeFileSync(path.join(root, '归档', '原篇.md'), 'tampered')
    }) as typeof fs.replace
    try {
      await expect(service.commit(preview.id, { repairLinks: false })).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
    } finally { fs.replace = originalReplace }
    expect((await readFile(path.join(root, '.rgent-lifecycle'), 'utf8'))).toContain('"active":{')
  })

  it('rejects a preview when the destination directory was replaced', async () => {
    const root = await vault()
    await mkdir(path.join(root, '目标'))
    await writeFile(path.join(root, '旧.md'), 'body')
    const service = new VaultLifecycle(root)
    const preview = await service.preview({ kind: 'note', source: '旧.md', target: '目标/新.md' })
    await rename(path.join(root, '目标'), path.join(root, '移走'))
    await mkdir(path.join(root, '目标'))
    await expect(service.commit(preview.id, { repairLinks: false })).rejects.toThrow('STALE_PREVIEW')
    expect(await readFile(path.join(root, '旧.md'), 'utf8')).toBe('body')
  })

  it('fails closed on a malformed recovery record', async () => {
    const root = await vault()
    await writeFile(path.join(root, '.rgent-lifecycle'), '{"version":1,"active":{"kind":"move","intent":{"source":"../outside.md"}}}')
    const service = new VaultLifecycle(root)
    await expect(service.recover()).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
  })

  it('does not execute a recovery record without a bound source fingerprint', async () => {
    const root = await vault()
    await writeFile(path.join(root, '原篇.md'), '正文')
    const id = secureFsFor(root).resolve('原篇.md').at(-1)!.id
    await writeFile(path.join(root, '.rgent-lifecycle'), JSON.stringify({ version: 1, active: {
      kind: 'move', intent: { kind: 'note', source: '原篇.md', target: '新篇.md',
        moves: [{ from: '原篇.md', to: '新篇.md', id }] },
      linkRepairs: [], fingerprints: [], permissionBefore: null, permissionAfter: null, repairLinks: false
    } }))
    const service = new VaultLifecycle(root)
    await expect(service.recover()).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
    expect(await readFile(path.join(root, '原篇.md'), 'utf8')).toBe('正文')
  })
})
