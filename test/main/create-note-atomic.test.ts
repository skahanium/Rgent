import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecureVaultFs } from '../../src/main/secure-fs.ts'
import { createNoteWithBody, listVaultTree, readNoteSnapshot } from '../../src/main/notes-fs.ts'

/** 「建」的原子落地：正文与文件一次出现。
 *  旧三步（create → read → write）在写失败时会留下一个空笔记，而删除是硬停、没法回滚——
 *  这里钉住的是「要么整篇在，要么什么都没有」，以及目标已存在时的绝不覆盖。 */

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
afterEach(() => { vi.restoreAllMocks() })

async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-create-'))
  roots.push(root)
  return root
}

describe('原子新建笔记', () => {
  it('成功路径：正文、修订与对象版本与读回一致，目录里没有临时文件', async () => {
    const root = await vault()
    await mkdir(path.join(root, '工作'))
    const created = await createNoteWithBody(root, '计划', '工作', '# 计划\n\n正文。\n')
    expect(created.relPath).toBe('工作/计划.md')
    const snapshot = await readNoteSnapshot(root, '工作/计划.md')
    expect(snapshot.content).toBe('# 计划\n\n正文。\n')
    expect(created.revision).toBe(snapshot.revision)
    expect(created.objectVersion).toBe(snapshot.objectVersion)
    expect(await readdir(path.join(root, '工作'))).toEqual(['计划.md'])
    expect((await listVaultTree(root)).map(entry => entry.name)).toEqual(['工作'])
  })

  it('目标已存在：拒写、原字节逐字保留、不留临时文件', async () => {
    const root = await vault()
    await writeFile(path.join(root, '计划.md'), '人的原稿。\n', 'utf8')
    await expect(createNoteWithBody(root, '计划', '', '替换掉')).rejects.toThrow('同名')
    expect(await readFile(path.join(root, '计划.md'), 'utf8')).toBe('人的原稿。\n')
    expect(await readdir(root)).toEqual(['计划.md'])
  })

  it('写入中途失败：目标位置没有半成品，失败之后同一个名字还能重新建', async () => {
    const root = await vault()
    // 原生层的原子步骤失败（临时文件写了一半就报错，目标名字从未出现过）。
    vi.spyOn(SecureVaultFs.prototype, 'replace').mockImplementationOnce(() => { throw new Error('IO_ERROR') })
    await expect(createNoteWithBody(root, '半成品', '', '写到一半')).rejects.toThrow('IO_ERROR')
    expect(await readdir(root)).toEqual([])
    expect(await listVaultTree(root)).toEqual([])
    // 失败没有在目标地址留下任何挡路的对象：同一个名字重新建能成功，内容是这一次的。
    const created = await createNoteWithBody(root, '半成品', '', '这次写完了')
    expect(created.relPath).toBe('半成品.md')
    expect(await readFile(path.join(root, created.relPath), 'utf8')).toBe('这次写完了')
    expect(created.revision).toBe((await readNoteSnapshot(root, created.relPath)).revision)
  })

  it('一次排他创建完成：不先建空文件再写正文', async () => {
    const root = await vault()
    const replace = vi.spyOn(SecureVaultFs.prototype, 'replace')
    const create = vi.spyOn(SecureVaultFs.prototype, 'create')
    const created = await createNoteWithBody(root, '一次成型', '', '正文')
    expect(create).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledTimes(1)
    // expected=null：目标已存在即失败（绝不覆盖），正文与文件一次落定。
    expect(replace.mock.calls[0]![1]).toBeNull()
    expect(replace.mock.calls[0]![2]).toBe('正文')
    expect(await readFile(path.join(root, created.relPath), 'utf8')).toBe('正文')
  })
})
