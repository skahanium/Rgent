import { LedgerStore } from '../../src/main/ledger-store.ts'
import { VaultLifecycle } from '../../src/main/vault-lifecycle.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
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

  it('trashes a file only when the expected identity still matches', async () => {
    const root = await vault()
    await writeFile(path.join(root, '稿.md'), '原文')
    const fs = secureFsFor(root)
    const id = fs.resolve('稿.md').at(-1)!.id
    if (process.platform !== 'darwin') {
      expect(() => fs.trash('稿.md', id)).toThrow('PLATFORM_UNPROVEN')
      expect(await readFile(path.join(root, '稿.md'), 'utf8')).toBe('原文')
      return
    }
    expect(() => fs.trash('稿.md', 'stale')).toThrow('PATH_CHANGED')
    expect(await readFile(path.join(root, '稿.md'), 'utf8')).toBe('原文')
    await rename(path.join(root, '稿.md'), path.join(root, '停.md'))
    await writeFile(path.join(root, '稿.md'), '顶替')
    expect(() => fs.trash('稿.md', id)).toThrow('PATH_CHANGED')
    expect(await readFile(path.join(root, '稿.md'), 'utf8')).toBe('顶替')
    expect(await readFile(path.join(root, '停.md'), 'utf8')).toBe('原文')
    const current = fs.resolve('稿.md').at(-1)!.id
    const landing = fs.trash('稿.md', current)
    expect(existsSync(path.join(root, '稿.md'))).toBe(false)
    expect(landing.length).toBeGreaterThan(0)
    expect(await readFile(landing, 'utf8')).toBe('顶替')
    await rm(landing, { recursive: true, force: true })
  })

  it('returns a landing whose dev:ino still identifies the trashed object', async () => {
    const root = await vault()
    await writeFile(path.join(root, '落点.md'), '正文')
    const fs = secureFsFor(root)
    const id = fs.resolve('落点.md').at(-1)!.id
    if (process.platform !== 'darwin') {
      expect(() => fs.trash('落点.md', id)).toThrow('PLATFORM_UNPROVEN')
      return
    }
    const landing = fs.trash('落点.md', id)
    const info = lstatSync(landing)
    expect(`${info.dev}:${info.ino}`).toBe(id)
    await rm(landing, { recursive: true, force: true })
  })

  it('trashes a directory', async () => {
    const root = await vault()
    await mkdir(path.join(root, '附件'))
    await writeFile(path.join(root, '附件', '图.txt'), 'bit')
    const fs = secureFsFor(root)
    const id = fs.resolve('附件').at(-1)!.id
    if (process.platform !== 'darwin') {
      expect(() => fs.trash('附件', id)).toThrow('PLATFORM_UNPROVEN')
      expect(await readFile(path.join(root, '附件', '图.txt'), 'utf8')).toBe('bit')
      return
    }
    const landing = fs.trash('附件', id)
    expect(existsSync(path.join(root, '附件'))).toBe(false)
    expect(await readFile(path.join(landing, '图.txt'), 'utf8')).toBe('bit')
    await rm(landing, { recursive: true, force: true })
  })
})

it('binds note snapshots and writes to the opened object, including identical-byte replacements', async () => {
  const { readNoteSnapshot, writeNote } = await import('../../src/main/notes-fs.ts')
  const { rename } = await import('node:fs/promises')
  const root = await vault()
  await writeFile(path.join(root, 'a.md'), 'same\r\n')
  const first = await readNoteSnapshot(root, 'a.md')
  expect(first.objectVersion).toBe(secureFsFor(root).resolve('a.md').at(-1)!.id)
  await rename(path.join(root, 'a.md'), path.join(root, 'held.md'))
  await writeFile(path.join(root, 'a.md'), first.content)
  await expect(writeNote(root, 'a.md', 'changed', first.revision, first.objectVersion)).rejects.toThrow('PATH_CHANGED')
  expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe(first.content)
  const second = await readNoteSnapshot(root, 'a.md')
  const saved = await writeNote(root, 'a.md', 'saved', second.revision, second.objectVersion)
  expect(saved.objectVersion).not.toBe(second.objectVersion)
  expect(await readNoteSnapshot(root, 'a.md')).toMatchObject(saved)
})

it('checks expected object identity inside the native replace call', async () => {
  const root = await vault()
  await writeFile(path.join(root, 'a.md'), 'same')
  const fs = secureFsFor(root)
  expect(() => fs.replace('a.md', 'same', 'changed', 'stale-id')).toThrow('PATH_CHANGED')
  expect(fs.readText('a.md')).toBe('same')
})
it('keeps explicit multi-file ledger recovery paused across restart and rejects an external edit',async()=>{
 const root=await vault();const fs=secureFsFor(root);fs.createDirectory('.rgent');fs.createDirectory('.rgent/ledgers')
 const writes=[],store=new LedgerStore(fs,()=>{})
 for(let n=0;n<5;n++){fs.replace(`note${n}.md`,null,`body ${n}`);const owner=store.owner(`note${n}.md`),path=`.rgent/ledgers/${owner.noteId}/owner.json`,before=fs.readText(path);writes.push({path,before,beforeId:fs.readSnapshot(path).objectVersion,after:before})}
 const registry=fs.readText('.rgent/registry.json');writes.push({path:'.rgent/registry.json',before:registry,beforeId:fs.readSnapshot('.rgent/registry.json').objectVersion,after:registry})
 await writeFile(path.join(root,'a.md'),'body')
 const lifecycle=new VaultLifecycle(root);const plan=lifecycle.prepareRepair('restore',writes,null)
 const first=await lifecycle.commitRepair(plan);expect(first.status).toBe('pending');expect(first.processed).toBe(4)
 const restarted=new VaultLifecycle(root);expect(await restarted.recover()).toBeNull();expect(restarted.status().status).toBe('pending')
 await writeFile(path.join(root,'a.md'),'changed');await expect(restarted.resumeRepair(first.revision!)).rejects.toThrow('STALE_RECOVERY')
 expect(restarted.status().status).toBe('pending')
})
it('resumes an owner publication whose native write preceded the journal receipt',async()=>{
 const root=await vault(),fs=secureFsFor(root);fs.createDirectory('.rgent');fs.createDirectory('.rgent/ledgers');fs.replace('.rgent/registry.json',null,'{"version":1,"owners":[],"sequence":0} ')
 const lifecycle=new VaultLifecycle(root),plan=lifecycle.prepareRepair('rebuild',[{path:'.rgent/registry.json',before:fs.readText('.rgent/registry.json'),beforeId:fs.readSnapshot('.rgent/registry.json').objectVersion,after:'{"version":1,"owners":[],"sequence":0}'}],null)
 fs.replace('.rgent-lifecycle',null,JSON.stringify({version:1,active:plan}));fs.replace('.rgent/registry.json',fs.readText('.rgent/registry.json'),plan.writes[0].after)
 const restarted=new VaultLifecycle(root),status=restarted.status();expect(status.status).toBe('pending')
 expect((await restarted.resumeRepair(status.revision!)).status).toBe('complete');expect(restarted.status().status).toBe('ready')
})
it('treats a repair journal with arbitrary owner bytes as invalid rather than a write recipe',async()=>{
 const root=await vault(),fs=secureFsFor(root);fs.createDirectory('.rgent');fs.createDirectory('.rgent/ledgers');fs.createDirectory('.rgent/ledgers/id');fs.replace('.rgent/ledgers/id/owner.json',null,'{}')
 const lifecycle=new VaultLifecycle(root),plan=lifecycle.prepareRepair('restore',[{path:'.rgent/ledgers/id/owner.json',before:'{}',beforeId:fs.readSnapshot('.rgent/ledgers/id/owner.json').objectVersion,after:'{"tampered":true}'}],null)
 fs.replace('.rgent-lifecycle',null,JSON.stringify({version:1,active:plan}));expect(new VaultLifecycle(root).status().status).toBe('invalid')
})
