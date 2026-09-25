import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listVaultTree } from '../../src/main/notes-fs.ts'
import { ROOT_GROUP, VaultIndex } from '../../src/main/vault-index.ts'

async function vault(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'rgent-index-'))
}

async function note(root: string, relPath: string, body: string): Promise<void> {
  const abs = path.join(root, ...relPath.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, body, 'utf8')
}

function indexFor(root: string): VaultIndex {
  return new VaultIndex(
    () => root,
    () => listVaultTree(root)
  )
}

describe('vault index backlinks', () => {
  it('counts note wikilinks, embeds included, and ignores media embeds', async () => {
    const root = await vault()
    await note(root, '日记/2026-09-24.md', '今天\n')
    await note(
      root,
      '工作/会议纪要.md',
      '见 [[日记/2026-09-24]] 与 ![[日记/2026-09-24]]，还有 ![[pic.png]] 和 [普通链接](日记/2026-09-24.md)。\n'
    )

    const groups = await indexFor(root).backlinks('日记/2026-09-24.md')
    expect(groups).toEqual([
      { folder: '工作', notes: [{ relPath: '工作/会议纪要.md', title: '会议纪要' }] }
    ])
  })

  it('groups the vault root first and sorts folders and titles', async () => {
    const root = await vault()
    await note(root, '目标.md', '目标\n')
    await note(root, '根链.md', '链到 [[目标]]\n')
    await note(root, '工作/乙.md', '链到 [[目标]]\n')
    await note(root, '工作/甲.md', '链到 [[目标]]\n')
    await note(root, '笔记/丙.md', '链到 [[目标]]\n')

    const groups = await indexFor(root).backlinks('目标.md')
    expect(groups.map((group) => group.folder)).toEqual([ROOT_GROUP, '笔记', '工作'])
    expect(groups[2]?.notes.map((ref) => ref.title)).toEqual(['甲', '乙'])
  })

  it('returns nothing when no note links here', async () => {
    const root = await vault()
    await note(root, 'a.md', '没人链我\n')
    expect(await indexFor(root).backlinks('a.md')).toEqual([])
  })
})

describe('vault index search', () => {
  it('hits titles and body sentences, and the snippet offset lands on the match', async () => {
    const root = await vault()
    await note(root, '工作/会议纪要.md', '# 会议纪要\n\n今天讨论了发布节奏，节奏偏慢。\n')
    await note(root, '无关.md', '别的东西\n')

    const index = indexFor(root)
    const byBody = await index.search('发布节奏')
    expect(byBody).toHaveLength(1)
    expect(byBody[0]?.relPath).toBe('工作/会议纪要.md')
    expect(byBody[0]?.titleHit).toBe(false)
    expect(byBody[0]?.count).toBe(1)
    const hit = byBody[0]!
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe('发布节奏')

    const byTitle = await index.search('会议纪要')
    expect(byTitle[0]?.relPath).toBe('工作/会议纪要.md')
    expect(byTitle[0]?.titleHit).toBe(true)

    expect(await index.search('节奏')).toHaveLength(1)
    expect((await index.search('节奏'))[0]?.count).toBe(2)
  })

  it('is case insensitive and treats regular expressions literally', async () => {
    const root = await vault()
    await note(root, 'a.md', 'Hello World 与 a.b\n')
    const index = indexFor(root)
    expect(await index.search('hello')).toHaveLength(1)
    expect((await index.search('a.b'))[0]?.count).toBe(1)
    expect(await index.search('a.b.c')).toEqual([])
  })

  it('returns nothing for an empty query', async () => {
    const root = await vault()
    await note(root, 'a.md', '内容\n')
    expect(await indexFor(root).search('   ')).toEqual([])
  })

  it('never sees the ledger: no search hits and no backlinks from it', async () => {
    const root = await vault()
    await note(root, 'a.md', '正文一句话。\n<!-- rgent:ledger:v1 -->\n\n口令：幽灵词\n\n[[幽灵笔记]]\n')

    const index = indexFor(root)
    expect(await index.search('幽灵词')).toEqual([])
    expect(await index.search('正文一句话')).toHaveLength(1)
    expect(await index.backlinks('幽灵笔记.md')).toEqual([])
  })
})

describe('vault index lifecycle', () => {
  it('picks up added, changed and deleted notes after markDirty', async () => {
    const root = await vault()
    await note(root, 'a.md', '甲\n')
    const index = indexFor(root)
    expect(await index.search('甲')).toHaveLength(1)

    await note(root, 'b.md', '乙\n')
    expect(await index.search('乙')).toEqual([])
    index.markDirty()
    expect(await index.search('乙')).toHaveLength(1)

    await writeFile(path.join(root, 'a.md'), '丙\n', 'utf8')
    index.markDirty()
    expect(await index.search('甲')).toEqual([])
    expect(await index.search('丙')).toHaveLength(1)

    await symlink(path.join(root, 'nowhere'), path.join(root, 'gone.md'))
    index.markDirty()
    expect(await index.search('丙')).toHaveLength(1)
  })

  it('drops the cache on reset instead of serving stale notes', async () => {
    const root = await vault()
    await note(root, 'a.md', '甲\n')
    const index = indexFor(root)
    expect(await index.search('甲')).toHaveLength(1)
    await rm(path.join(root, 'a.md'))
    index.reset()
    expect(await index.search('甲')).toEqual([])
  })

  it('skips notes it cannot read without failing the rebuild', async () => {
    const root = await vault()
    await note(root, '好.md', '找得到\n')
    await symlink(path.join(root, 'nowhere'), path.join(root, '坏.md'))

    const index = indexFor(root)
    expect(await index.search('找得到')).toHaveLength(1)
  })

  it('returns nothing when there is no vault', async () => {
    const index = new VaultIndex(
      () => null,
      () => Promise.resolve([])
    )
    expect(await index.backlinks('a.md')).toEqual([])
    expect(await index.search('甲')).toEqual([])
  })

  it('rebuilds again if marked dirty while a rebuild is in flight', async () => {
    const root = await vault()
    await note(root, 'a.md', '甲\n')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let listCalls = 0
    const index = new VaultIndex(
      () => root,
      async () => {
        listCalls += 1
        if (listCalls === 1) await gate
        return listVaultTree(root)
      }
    )
    const first = index.search('甲')
    await note(root, 'a.md', '乙\n')
    index.markDirty()
    release()
    await first
    expect(await index.search('乙')).toHaveLength(1)
    expect(await index.search('甲')).toEqual([])
  })
})
