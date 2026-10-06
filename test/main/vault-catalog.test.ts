import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultCatalog } from '../../src/main/vault-catalog.ts'

const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgent-catalog-'))
  roots.push(root)
  const data = path.join(root, 'device'); fs.mkdirSync(data)
  const vault = path.join(root, 'vault'); fs.mkdirSync(vault)
  return { root, data, vault, catalog: new VaultCatalog(data) }
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('device vault catalog', () => {
  it('checks canonical parent nesting before creating a new root through an alias', () => {
    const { root, vault, catalog } = fixture()
    catalog.register(catalog.inspect(vault))
    const alias = path.join(root, 'alias'); fs.symlinkSync(vault, alias, 'dir')
    expect(() => catalog.create(path.join(alias, 'child'))).toThrow('VAULT_NESTED')
    expect(fs.existsSync(path.join(vault, 'child'))).toBe(false)
    const sibling = catalog.create(path.join(root, 'new'))
    expect(fs.readdirSync(sibling.path)).toEqual([])
    expect(() => catalog.create(sibling.path)).toThrow()
    expect(fs.readdirSync(sibling.path)).toEqual([])
  })
  it('preserves the filesystem when the catalogue cannot authorize creating a root', () => {
    const { root, data, catalog } = fixture()
    const file = path.join(data, 'vault-catalog.json'); fs.writeFileSync(file, 'damaged')
    const chosen = path.join(root, 'new')
    expect(() => catalog.create(chosen)).toThrow('VAULT_CATALOG_INVALID')
    expect(fs.existsSync(chosen)).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('damaged')
  })
  it('inspects only directory metadata and preserves an empty root', () => {
    const { vault, catalog } = fixture()
    const target = catalog.inspect(vault)
    expect(target).toMatchObject({ path: fs.realpathSync(vault), label: 'vault', id: null })
    expect(target.rootIdentity).toMatch(/^\d+:\d+$/)
    expect(fs.readdirSync(vault)).toEqual([])
    expect(() => catalog.inspect(path.join(vault, 'absent'))).toThrow()
  })
  it('registers aliases once and persists display updates and last successful use', () => {
    const { root, data, vault, catalog } = fixture()
    const first = catalog.register(catalog.inspect(vault))
    const alias = path.join(root, 'alias'); fs.symlinkSync(vault, alias, 'dir')
    expect(catalog.register(catalog.inspect(alias)).id).toBe(first.id)
    const view = catalog.update(first.id, { label: '工作笔记', pinned: true }, catalog.view().revision)
    expect(view.entries[0]).toMatchObject({ label: '工作笔记', pinned: true, lastUsed: null })
    expect(catalog.committed(catalog.inspect(alias)).lastUsed).toEqual(expect.any(Number))
    expect(new VaultCatalog(data).view().lastVaultId).toBe(first.id)
  })
  it('uses the same native root spelling for case aliases on insensitive volumes', context => {
    const { root, vault, catalog } = fixture()
    const capital = path.join(root, 'Vault'); fs.renameSync(vault, capital)
    if (!fs.existsSync(vault)) { context.skip(); return }
    const first = catalog.register(catalog.inspect(capital))
    expect(catalog.inspect(vault).path).toBe(first.path)
    expect(catalog.register(catalog.inspect(vault)).id).toBe(first.id)
  })
  it('rejects nested roots reached through a different case spelling on insensitive volumes', context => {
    const { root, vault, catalog } = fixture()
    const capital = path.join(root, 'Vault'); fs.renameSync(vault, capital)
    if (!fs.existsSync(vault)) { context.skip(); return }
    fs.mkdirSync(path.join(capital, 'child'))
    catalog.register(catalog.inspect(capital))
    expect(() => catalog.register(catalog.inspect(path.join(vault, 'child')))).toThrow('VAULT_NESTED')
  })
  it('rejects mutually nested roots through canonical aliases but allows siblings', () => {
    const { root, vault, catalog } = fixture()
    const child = path.join(vault, 'child'); fs.mkdirSync(child)
    catalog.register(catalog.inspect(child))
    expect(() => catalog.register(catalog.inspect(vault))).toThrow('VAULT_NESTED')
    const alias = path.join(root, 'child-alias'); fs.symlinkSync(child, alias, 'dir')
    expect(catalog.register(catalog.inspect(alias)).path).toBe(fs.realpathSync(child))
    const sibling = path.join(vault, 'sibling'); fs.mkdirSync(sibling)
    expect(catalog.register(catalog.inspect(sibling)).id).toBeTruthy()
  })
  it('keeps copied directories separate and refuses same-name root replacement', () => {
    const { root, vault, catalog } = fixture()
    const old = catalog.register(catalog.inspect(vault))
    const copy = path.join(root, 'copy'); fs.cpSync(vault, copy, { recursive: true })
    expect(catalog.register(catalog.inspect(copy)).rootIdentity).not.toBe(old.rootIdentity)
    fs.renameSync(vault, `${vault}-gone`); fs.mkdirSync(vault)
    expect(catalog.inspect(vault).id).toBeNull()
    expect(() => catalog.register(catalog.inspect(vault))).toThrow('VAULT_REPLACED')
    expect(() => catalog.committed({ ...old })).toThrow('VAULT_REPLACED')
    expect(catalog.relocate(old.id, catalog.inspect(vault), catalog.view().revision).entries.find(e => e.id === old.id)?.rootIdentity).not.toBe(old.rootIdentity)
  })
  it('refuses an outdated target after preflight and stale revisions across service instances', () => {
    const { data, vault, catalog } = fixture()
    const target = catalog.inspect(vault)
    fs.renameSync(vault, `${vault}-gone`); fs.mkdirSync(vault)
    expect(() => catalog.register(target)).toThrow('VAULT_REPLACED')
    const entry = catalog.register(catalog.inspect(vault))
    const stale = catalog.view().revision
    new VaultCatalog(data).update(entry.id, { pinned: true }, stale)
    expect(() => catalog.remove(entry.id, stale)).toThrow('VAULT_CATALOG_CONFLICT')
    expect(catalog.view().entries[0].pinned).toBe(true)
  })
  it('preserves corrupt catalog bytes while allowing readonly target inspection', () => {
    const { data, vault, catalog } = fixture()
    const file = path.join(data, 'vault-catalog.json'); fs.writeFileSync(file, '{broken')
    expect(catalog.view().diagnostic).toBeTruthy()
    const target = catalog.inspect(vault)
    expect(target.path).toBe(fs.realpathSync(vault))
    expect(() => catalog.register(target)).toThrow('VAULT_CATALOG_INVALID')
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
  })
  it('refuses structurally invalid catalog data and unsafe display values', () => {
    const { data, vault, catalog } = fixture()
    const entry = catalog.register(catalog.inspect(vault))
    for (const label of ['', 'x'.repeat(81), 'bad\nname']) expect(() => catalog.update(entry.id, { label }, catalog.view().revision)).toThrow()
    const file = path.join(data, 'vault-catalog.json')
    const corrupt = JSON.stringify({ version: 1, entries: [{ ...entry, pinned: 'yes' }], lastVaultId: null })
    fs.writeFileSync(file, corrupt)
    expect(catalog.view().diagnostic).toBeTruthy()
    expect(() => catalog.remove(entry.id, catalog.view().revision)).toThrow('VAULT_CATALOG_INVALID')
    expect(fs.readFileSync(file, 'utf8')).toBe(corrupt)
  })
  it('propagates atomic replace failure while preserving old catalog bytes', () => {
    const { data, vault, catalog } = fixture()
    const entry = catalog.register(catalog.inspect(vault))
    const file = path.join(data, 'vault-catalog.json'); const before = fs.readFileSync(file, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('simulated disk failure') })
    expect(() => catalog.update(entry.id, { pinned: true }, catalog.view().revision)).toThrow('simulated disk failure')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readdirSync(data)).toEqual(['vault-catalog.json'])
  })
  it('requires a revision for display mutations and detects identical-byte file replacement', () => {
    const { data, vault, catalog } = fixture()
    const entry = catalog.register(catalog.inspect(vault)); const revision = catalog.view().revision
    expect(() => catalog.update(entry.id, { pinned: true }, undefined as unknown as string)).toThrow('VAULT_CATALOG_CONFLICT')
    expect(() => catalog.remove(entry.id, undefined as unknown as string)).toThrow('VAULT_CATALOG_CONFLICT')
    expect(() => catalog.relocate(entry.id, catalog.inspect(vault), undefined as unknown as string)).toThrow('VAULT_CATALOG_CONFLICT')
    const file = path.join(data, 'vault-catalog.json'); const raw = fs.readFileSync(file, 'utf8')
    fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, raw)
    expect(() => catalog.update(entry.id, { pinned: true }, revision)).toThrow('VAULT_CATALOG_CONFLICT')
  })
  it('caps the directory at 128 roots while permitting repeated registration', () => {
    const { root, vault, catalog } = fixture()
    const first = catalog.register(catalog.inspect(vault))
    for (let i = 0; i < 127; i++) {
      const other = path.join(root, `other-${i}`); fs.mkdirSync(other); catalog.register(catalog.inspect(other))
    }
    const extra = path.join(root, 'extra'); fs.mkdirSync(extra)
    expect(() => catalog.register(catalog.inspect(extra))).toThrow('VAULT_CATALOG_LIMIT')
    expect(catalog.register(catalog.inspect(vault)).id).toBe(first.id)
    expect(catalog.view().entries).toHaveLength(128)
  }, 15_000)
  it('requires explicit relocation for a moved root and resets last-use binding', () => {
    const { root, vault, catalog } = fixture()
    const entry = catalog.committed(catalog.inspect(vault))
    const moved = path.join(root, 'moved'); fs.renameSync(vault, moved)
    const target = catalog.inspect(moved)
    expect(() => catalog.register(target)).toThrow('VAULT_RELOCATE_REQUIRED')
    expect(catalog.relocate(entry.id, target, catalog.view().revision)).toMatchObject({ lastVaultId: null })
    expect(catalog.view().entries[0]).toMatchObject({ id: entry.id, path: fs.realpathSync(moved), lastUsed: null })
  })
  it('removes only the device directory entry and clears last-use selection', () => {
    const { vault, catalog } = fixture()
    fs.writeFileSync(path.join(vault, 'a.md'), '原文')
    const entry = catalog.committed(catalog.inspect(vault))
    expect(catalog.remove(entry.id, catalog.view().revision)).toMatchObject({ entries: [], lastVaultId: null })
    expect(fs.readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('原文')
  })
})

describe('device workspaces', () => {
  it('normalizes finite fields and persists only approved workspace data', () => {
    const { data, vault, catalog } = fixture(); const target = catalog.inspect(vault)
    catalog.saveWorkspace(target, { version: 1, tabs: [
      { relPath: './目录\\a.md', selection: { anchor: 3, head: 9 }, scrollTop: 15, text: 'secret' },
      { relPath: '../escape.md' }, { relPath: '/abs.md' }, { relPath: 'C:\\a.md' },
      { relPath: 'b.md', selection: { anchor: -1, head: 1 }, scrollTop: Infinity }
    ], active: './目录\\a.md', sidebarHidden: true, treeScroll: -1, resourceScroll: 20, authorization: 'secret', model: 'secret' })
    expect(catalog.workspace(target)).toEqual({ version: 1, tabs: [
      { relPath: '目录/a.md', selection: { anchor: 3, head: 9 }, scrollTop: 15 }, { relPath: 'b.md' }
    ], active: '目录/a.md', sidebarHidden: true, treeScroll: 0, resourceScroll: 20 })
    expect(fs.readFileSync(path.join(data, 'vault-workspaces.json'), 'utf8')).not.toContain('secret')
  })
  it('shares workspace data across case aliases on insensitive volumes', context => {
    const { root, vault, catalog } = fixture()
    const capital = path.join(root, 'Vault'); fs.renameSync(vault, capital)
    if (!fs.existsSync(vault)) { context.skip(); return }
    catalog.saveWorkspace(catalog.inspect(capital), { version: 1, tabs: [{ relPath: 'a.md' }], active: 'a.md' })
    expect(catalog.workspace(catalog.inspect(vault))?.active).toBe('a.md')
  })
  it('rejects drive paths exposed by normalization and keeps serialization idempotent', () => {
    const { data, vault, catalog } = fixture(); const target = catalog.inspect(vault)
    catalog.saveWorkspace(target, { version: 1, tabs: [{ relPath: './C:/a.md' }, { relPath: './/D:/b.md' }, { relPath: 'valid.md' }], active: './C:/a.md' })
    const stored = JSON.parse(fs.readFileSync(path.join(data, 'vault-workspaces.json'), 'utf8')).entries[0].workspace
    expect(stored.tabs).toEqual([{ relPath: 'valid.md' }])
    expect(stored.active).toBeNull()
    expect(catalog.workspace(target)).toEqual(stored)
  })
  it('bounds tab count and positions, deduplicates paths and falls back invalid fields locally', () => {
    const { vault, catalog } = fixture(); const target = catalog.inspect(vault)
    catalog.saveWorkspace(target, { version: 1, tabs: [{ relPath: 'a.md', selection: { anchor: 1e20, head: 2 } }, { relPath: 'a.md' }, ...Array.from({ length: 100 }, (_, i) => ({ relPath: `${i}.md` }))], active: 'absent.md', sidebarHidden: 'yes', treeScroll: NaN, resourceScroll: 1e20 })
    const value = catalog.workspace(target)!
    expect(value.tabs).toHaveLength(64)
    expect(value.tabs[0]).toEqual({ relPath: 'a.md' })
    expect(value).toMatchObject({ active: null, sidebarHidden: false, treeScroll: 0, resourceScroll: 0 })
  })
  it('isolates canonical root and verified identity across aliases, copies and relocation', () => {
    const { root, vault, catalog } = fixture(); const target = catalog.inspect(vault)
    catalog.saveWorkspace(target, { version: 1, tabs: [{ relPath: 'a.md' }], active: 'a.md' })
    const alias = path.join(root, 'alias'); fs.symlinkSync(vault, alias, 'dir')
    expect(catalog.workspace(catalog.inspect(alias))?.active).toBe('a.md')
    fs.renameSync(vault, `${vault}-gone`); fs.mkdirSync(vault)
    expect(catalog.workspace(catalog.inspect(vault))).toBeNull()
    expect(catalog.workspace(catalog.inspect(`${vault}-gone`))).toBeNull()
    expect(() => catalog.saveWorkspace(target, {})).toThrow('VAULT_REPLACED')
  })
  it('refuses workspace growth beyond the readable file limit without damaging prior data', () => {
    const { root, data, vault, catalog } = fixture(); const target = catalog.inspect(vault)
    const tabs = Array.from({ length: 64 }, (_, i) => ({ relPath: `${i}-${'x'.repeat(4050)}.md` }))
    const entries = Array.from({ length: 16 }, (_, i) => ({ path: path.join(fs.realpathSync(root), `old-${i}`), rootIdentity: `1:${i}`, workspace: { version: 1, tabs } }))
    const raw = JSON.stringify({ version: 1, entries }); expect(Buffer.byteLength(raw)).toBeLessThan(4_194_304)
    const file = path.join(data, 'vault-workspaces.json'); fs.writeFileSync(file, raw)
    expect(() => catalog.saveWorkspace(target, { version: 1, tabs })).toThrow('VAULT_WORKSPACE_LIMIT')
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
  })
  it('preserves an invalid whole workspace file and reports write errors', () => {
    const { data, vault, catalog } = fixture(); const target = catalog.inspect(vault)
    const file = path.join(data, 'vault-workspaces.json'); fs.writeFileSync(file, 'broken')
    expect(catalog.workspace(target)).toBeNull()
    expect(() => catalog.saveWorkspace(target, { version: 1, tabs: [] })).toThrow('VAULT_WORKSPACE_INVALID')
    expect(fs.readFileSync(file, 'utf8')).toBe('broken')
    fs.unlinkSync(file); catalog.saveWorkspace(target, { version: 1, tabs: [] })
    const before = fs.readFileSync(file, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('workspace disk failure') })
    expect(() => catalog.saveWorkspace(target, { version: 1, tabs: [] })).toThrow('workspace disk failure')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
})
it('keeps workspace under the registered id across explicit relocation and isolates a new id',()=>{
 const {root,vault,catalog}=fixture();const entry=catalog.register(catalog.inspect(vault));const old=catalog.inspect(vault)
 catalog.saveWorkspace(old,{version:1,tabs:[{relPath:'a.md'}],active:'a.md'})
 const moved=path.join(root,'moved');fs.renameSync(vault,moved);catalog.relocate(entry.id,catalog.inspect(moved),catalog.view().revision)
 expect(catalog.workspace(catalog.inspect(moved))?.active).toBe('a.md')
 fs.mkdirSync(vault);const fresh=catalog.register(catalog.inspect(vault));expect(fresh.id).not.toBe(entry.id)
 expect(catalog.workspace(catalog.inspect(vault))).toBeNull()
 expect(()=>catalog.workspace({...catalog.inspect(vault),id:entry.id})).toThrow('VAULT_REPLACED')
})
it('offers a legacy preference key only for the matching previously verified catalog entry',()=>{
 const {root,data,vault,catalog}=fixture();const first=catalog.register(catalog.inspect(vault))
 const file=path.join(data,'vault-catalog.json'),old=JSON.parse(fs.readFileSync(file,'utf8'));delete old.entries[0].displayVersion;fs.writeFileSync(file,JSON.stringify(old))
 const oldKeys=catalog.displayKeys(catalog.inspect(vault));expect(oldKeys.legacy).toBeDefined()
 const moved=path.join(root,'renamed');fs.renameSync(vault,moved);catalog.relocate(first.id,catalog.inspect(moved),catalog.view().revision)
 expect(catalog.displayKeys(catalog.inspect(moved))).toEqual(oldKeys)
 catalog.remove(first.id,catalog.view().revision);fs.renameSync(moved,vault);catalog.register(catalog.inspect(vault))
 const fresh=catalog.displayKeys(catalog.inspect(vault));expect(fresh.key).not.toBe(oldKeys.key);expect(fresh.legacy).toBeUndefined()
})
it('roundtrips workspaces for distinct registration ids at the same physical root',()=>{
 const {data,vault,catalog}=fixture();const old=catalog.register(catalog.inspect(vault))
 catalog.saveWorkspace(catalog.inspect(vault),{version:1,tabs:[{relPath:'old.md'}],active:'old.md'})
 catalog.remove(old.id,catalog.view().revision);const fresh=catalog.register(catalog.inspect(vault))
 expect(fresh.id).not.toBe(old.id);expect(catalog.workspace(catalog.inspect(vault))).toBeNull()
 catalog.saveWorkspace(catalog.inspect(vault),{version:1,tabs:[{relPath:'new.md'}],active:'new.md'})
 expect(new VaultCatalog(data).workspace(catalog.inspect(vault))?.active).toBe('new.md')
 expect(()=>catalog.saveWorkspace(catalog.inspect(vault),{version:1,tabs:[]})).not.toThrow()
})
it('does not give a newly registered id an unclaimed legacy workspace',()=>{
 const {data,vault,catalog}=fixture(),target=catalog.inspect(vault)
 catalog.saveWorkspace(target,{version:1,tabs:[{relPath:'legacy.md'}],active:'legacy.md'})
 const legacy=fs.readFileSync(path.join(data,'vault-workspaces.json'),'utf8')
 catalog.register(target)
 expect(catalog.workspace(catalog.inspect(vault))).toBeNull()
 catalog.saveWorkspace(catalog.inspect(vault),{version:1,tabs:[{relPath:'fresh.md'}],active:'fresh.md'})
 expect(catalog.workspace(catalog.inspect(vault))?.active).toBe('fresh.md')
 expect(JSON.parse(fs.readFileSync(path.join(data,'vault-workspaces.json'),'utf8')).entries[0]).toEqual(JSON.parse(legacy).entries[0])
})
it('claims legacy workspace only through a matching old catalog entry',()=>{
 const {data,vault,catalog}=fixture(),entry=catalog.register(catalog.inspect(vault)),file=path.join(data,'vault-catalog.json')
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));delete saved.entries[0].displayVersion;fs.writeFileSync(file,JSON.stringify(saved))
 fs.writeFileSync(path.join(data,'vault-workspaces.json'),JSON.stringify({version:1,entries:[{path:entry.path,rootIdentity:entry.rootIdentity,workspace:{version:1,tabs:[{relPath:'legacy.md'}],active:'legacy.md'}}]}))
 catalog.register(catalog.inspect(vault));expect(catalog.workspace(catalog.inspect(vault))?.active).toBe('legacy.md')
 catalog.remove(entry.id,catalog.view().revision);catalog.register(catalog.inspect(vault));expect(catalog.workspace(catalog.inspect(vault))).toBeNull()
})
it('does not claim an unrelated legacy row when a new registration is relocated',()=>{
 const {data,root,vault,catalog}=fixture(),target=catalog.inspect(vault)
 catalog.saveWorkspace(target,{version:1,tabs:[{relPath:'old.md'}],active:'old.md'});const fresh=catalog.register(target)
 const moved=path.join(root,'moved');fs.renameSync(vault,moved);catalog.relocate(fresh.id,catalog.inspect(moved),catalog.view().revision)
 expect(catalog.workspace(catalog.inspect(moved))).toBeNull()
 expect(JSON.parse(fs.readFileSync(path.join(data,'vault-workspaces.json'),'utf8')).entries[0].id).toBeUndefined()
})
it('requires an explicit preview for same-inode identity change and keeps workspace identity bytes',()=>{
 const {data,vault,catalog}=fixture(),file=path.join(data,'vault-catalog.json'),workspaces=path.join(data,'vault-workspaces.json')
 const entry=catalog.register(catalog.inspect(vault))
 catalog.saveWorkspace(catalog.inspect(vault),{version:1,tabs:[{relPath:'keep.md'}],active:'keep.md'})
 const current=catalog.inspect(vault),inode=current.rootIdentity.slice(current.rootIdentity.indexOf(':')+1)
 const stale=`99999999:${inode}`
 // 卷重新挂载：记录里是旧设备号，磁盘上是新设备号，inode 相同。
 const rewrite=(rootIdentity:string)=>{const saved=JSON.parse(fs.readFileSync(file,'utf8'));saved.entries[0].rootIdentity=rootIdentity;fs.writeFileSync(file,JSON.stringify(saved))
  const savedWorkspaces=JSON.parse(fs.readFileSync(workspaces,'utf8'));savedWorkspaces.entries[0].rootIdentity=rootIdentity;fs.writeFileSync(workspaces,JSON.stringify(savedWorkspaces))}
 rewrite(stale)
 // 未确认前仍然拒绝把同一个位置当成新库登记。
 expect(()=>catalog.register(current)).toThrow('VAULT_REPLACED')
 // 人确认后：身份改记新设备号，工作区（tab／阅读位置）跟着换过去，没丢。
 const owner={caller:'1:1',sessionId:null},preview=catalog.previewRoot(entry.id,catalog.inspect(vault),catalog.view().revision,owner)
 const confirmed=catalog.confirmRoot(preview.id,owner)
 expect(confirmed.rootIdentity).toBe(current.rootIdentity)
 expect(catalog.view().entries[0].rootIdentity).toBe(current.rootIdentity)
 expect(catalog.workspace(catalog.inspect(vault))?.active).toBe('keep.md')
 expect(JSON.parse(fs.readFileSync(workspaces,'utf8')).entries[0].rootIdentity).toBe(stale)
 // 已经是当前身份时确认是幂等的。
 expect(()=>catalog.confirmRoot(preview.id,owner)).toThrow('STALE_PREVIEW')
})
it('refuses a remount confirmation when the inode changed too',()=>{
 const {data,vault,catalog}=fixture(),file=path.join(data,'vault-catalog.json')
 const entry=catalog.register(catalog.inspect(vault)),current=catalog.inspect(vault)
 const inode=Number(current.rootIdentity.slice(current.rootIdentity.indexOf(':')+1))
 const replaced=`99999999:${inode+1}`
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));saved.entries[0].rootIdentity=replaced;fs.writeFileSync(file,JSON.stringify(saved))
 expect(()=>catalog.committed({...entry})).toThrow('VAULT_REPLACED')
 expect(JSON.parse(fs.readFileSync(file,'utf8')).entries[0].rootIdentity).toBe(replaced)
})

it('requires a bound single-use explicit root preview and preserves stable-ID workspace bytes',()=>{
 const {data,vault,catalog}=fixture(),entry=catalog.register(catalog.inspect(vault))
 catalog.saveWorkspace({...entry},{version:1,tabs:[{relPath:'a.md'}],active:'a.md'})
 const workspace=fs.readFileSync(path.join(data,'vault-workspaces.json'),'utf8')
 fs.renameSync(vault,vault+'-old');fs.mkdirSync(vault)
 const before=fs.readFileSync(path.join(data,'vault-catalog.json'),'utf8'),api=catalog as any
 expect(typeof api.previewRoot).toBe('function')
 const view=api.previewRoot(entry.id,catalog.inspect(vault),catalog.view().revision,{caller:'window:frame',sessionId:'old'})
 expect(fs.readFileSync(path.join(data,'vault-catalog.json'),'utf8')).toBe(before)
 expect(()=>api.confirmRoot(view.id,{caller:'other:frame',sessionId:'old'})).toThrow('STALE_PREVIEW')
 const next=api.previewRoot(entry.id,catalog.inspect(vault),catalog.view().revision,{caller:'window:frame',sessionId:'old'})
 const target=api.confirmRoot(next.id,{caller:'window:frame',sessionId:'old'})
 expect(target.id).toBe(entry.id);expect(target.rootIdentity).not.toBe(entry.rootIdentity)
 expect(fs.readFileSync(path.join(data,'vault-workspaces.json'),'utf8')).toBe(workspace)
 expect(()=>api.confirmRoot(next.id,{caller:'window:frame',sessionId:'old'})).toThrow('STALE_PREVIEW')
})

it.each(['session','expired','cancelled','root','catalog','workspace'] as const)('rejects stale root preview proof (%s)',mode=>{
 const {data,vault,catalog}=fixture(),entry=catalog.register(catalog.inspect(vault)),owner={caller:'1:1',sessionId:'old'}
 fs.renameSync(vault,vault+'-old');fs.mkdirSync(vault)
 const preview=catalog.previewRoot(entry.id,catalog.inspect(vault),catalog.view().revision,owner),before=fs.readFileSync(path.join(data,'vault-catalog.json'),'utf8')
 if(mode==='expired')vi.spyOn(Date,'now').mockReturnValue(Date.now()+120001)
 if(mode==='cancelled')catalog.cancelRoot(preview.id,owner)
 if(mode==='root'){fs.renameSync(vault,vault+'-new');fs.mkdirSync(vault)}
 if(mode==='catalog')catalog.update(entry.id,{pinned:true},catalog.view().revision)
 if(mode==='workspace')fs.writeFileSync(path.join(data,'vault-workspaces.json'),'broken')
 expect(()=>catalog.confirmRoot(preview.id,mode==='session'?{...owner,sessionId:'new'}:owner)).toThrow()
 if(mode!=='catalog')expect(fs.readFileSync(path.join(data,'vault-catalog.json'),'utf8')).toBe(before)
})
it('caps root previews per window across frames and leaves bad workspace bytes intact on confirmation',()=>{
 const {data,vault,catalog}=fixture(),entry=catalog.register(catalog.inspect(vault));fs.writeFileSync(path.join(data,'vault-workspaces.json'),'broken')
 fs.renameSync(vault,vault+'-old');fs.mkdirSync(vault)
 const owner={caller:'1:1',sessionId:'old'},p=catalog.previewRoot(entry.id,catalog.inspect(vault),catalog.view().revision,owner)
 for(let i=2;i<=4;i++)catalog.previewRoot(entry.id,catalog.inspect(vault),catalog.view().revision,{caller:'1:'+i,sessionId:'old'})
 expect(()=>catalog.previewRoot(entry.id,catalog.inspect(vault),catalog.view().revision,{caller:'1:5',sessionId:'old'})).toThrow('VAULT_PREVIEW_LIMIT')
 expect(p.workspace).toBe('unavailable');catalog.confirmRoot(p.id,owner)
 expect(fs.readFileSync(path.join(data,'vault-workspaces.json'),'utf8')).toBe('broken')
 expect(()=>catalog.saveWorkspace(catalog.inspect(vault),{version:1,tabs:[],active:null})).toThrow('VAULT_WORKSPACE_INVALID')
})

it('retries a unique legacy workspace ID supplement after catalogue publication fails',()=>{
 const {data,vault,catalog}=fixture(),entry=catalog.register(catalog.inspect(vault)),file=path.join(data,'vault-catalog.json'),workspaceFile=path.join(data,'vault-workspaces.json')
 const legacy=JSON.parse(fs.readFileSync(file,'utf8'));delete legacy.entries[0].displayVersion;fs.writeFileSync(file,JSON.stringify(legacy))
 fs.writeFileSync(workspaceFile,JSON.stringify({version:1,entries:[{path:entry.path,rootIdentity:entry.rootIdentity,workspace:{version:1,tabs:[{relPath:'keep.md'}],active:'keep.md'}}]}))
 fs.renameSync(vault,vault+'-old');fs.mkdirSync(vault)
 const owner={caller:'1:1',sessionId:'old'},preview=catalog.previewRoot(entry.id,catalog.inspect(vault),catalog.view().revision,owner),rename=fs.renameSync
 const spy=vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(to===file)throw Error('catalog write interrupted');return rename(from,to)})
 expect(()=>catalog.confirmRoot(preview.id,owner)).toThrow('catalog write interrupted');spy.mockRestore()
 const supplemented=fs.readFileSync(workspaceFile,'utf8');expect(JSON.parse(supplemented).entries[0].id).toBe(entry.id)
 expect(catalog.view().entries[0].rootIdentity).toBe(entry.rootIdentity)
 const retry=catalog.previewRoot(entry.id,catalog.inspect(vault),catalog.view().revision,owner);catalog.confirmRoot(retry.id,owner)
 expect(fs.readFileSync(workspaceFile,'utf8')).toBe(supplemented);expect(catalog.workspace(catalog.inspect(vault))?.active).toBe('keep.md')
})

it('preserves valid-JSON malformed workspace instead of converting broken tabs into an empty position record',()=>{
 const {data,vault,catalog}=fixture(),entry=catalog.register(catalog.inspect(vault)),file=path.join(data,'vault-workspaces.json')
 const raw=JSON.stringify({version:1,entries:[{id:entry.id,path:entry.path,rootIdentity:entry.rootIdentity,workspace:{version:1,tabs:'corrupt',active:'keep.md'}}]});fs.writeFileSync(file,raw)
 fs.renameSync(vault,vault+'-old');fs.mkdirSync(vault)
 const owner={caller:'1:1',sessionId:'old'},preview=catalog.previewRoot(entry.id,catalog.inspect(vault),catalog.view().revision,owner)
 expect(preview.workspace).toBe('unavailable');catalog.confirmRoot(preview.id,owner)
 expect(()=>catalog.saveWorkspace(catalog.inspect(vault),{version:1,tabs:[],active:null})).toThrow('VAULT_WORKSPACE_INVALID')
 expect(fs.readFileSync(file,'utf8')).toBe(raw)
})
