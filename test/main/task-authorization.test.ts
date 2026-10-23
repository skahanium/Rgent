import { describe, expect, it, vi } from 'vitest'
import { TaskAuthorizationRegistry } from '../../src/main/task-authorization.ts'
import type { AgentScopeLevel, NoteSnapshot, TreeEntry } from '../../src/shared/ipc.ts'
import { draftBody, draftRequest, draftSource } from './draft-fixture.ts'

type Snapshot = { content: string; revision: string; sessionId: string; objectVersion: string }

function treeOf(): TreeEntry[] {
  return [
    { name: 'root.md', relPath: 'root.md', kind: 'note' },
    { name: 'pic.png', relPath: 'pic.png', kind: 'file' },
    { name: 'dir', relPath: 'dir', kind: 'dir', children: [
      { name: 'a.md', relPath: 'dir/a.md', kind: 'note' },
      { name: 'b.md', relPath: 'dir/b.md', kind: 'note' },
      { name: 'sub', relPath: 'dir/sub', kind: 'dir', children: [
        { name: 'd.md', relPath: 'dir/sub/d.md', kind: 'note' }
      ] },
      { name: 'Note', relPath: 'dir/Note', kind: 'dir', attachmentOf: 'dir/note.md', children: [
        { name: 'image.md', relPath: 'dir/Note/image.md', kind: 'note' },
        { name: 'sub', relPath: 'dir/Note/sub', kind: 'dir', children: [
          { name: 'nested.md', relPath: 'dir/Note/sub/nested.md', kind: 'note' }
        ] }
      ] }
    ] },
    { name: 'other', relPath: 'other', kind: 'dir', children: [
      { name: 'e.md', relPath: 'other/e.md', kind: 'note' }
    ] }
  ]
}

function setup() {
  let onRead: ((path: string) => void | Promise<void>) | undefined
  let onTier: ((path: string) => void) | undefined
  let session = 'session-a'; let model = 'm'; let key = 'private'; let denied = ''
  let follow = new Set<string>()
  const records = new Map<string, Snapshot>([
    ['root.md', { content: draftSource('问').source, revision: 'r-root', sessionId: session, objectVersion: 'o-root' }],
    ['dir/a.md', { content: draftSource('问').source, revision: 'r-a', sessionId: session, objectVersion: 'o-a' }],
    ['dir/b.md', { content: '# B\n正文', revision: 'r-b', sessionId: session, objectVersion: 'o-b' }],
    ['dir/sub/d.md', { content: '# D\n正文', revision: 'r-d', sessionId: session, objectVersion: 'o-d' }],
    ['dir/Note/image.md', { content: '附件的 Markdown', revision: 'r-image', sessionId: session, objectVersion: 'o-image' }],
    ['dir/Note/sub/nested.md', { content: '附件子树里的 Markdown', revision: 'r-nested', sessionId: session, objectVersion: 'o-nested' }],
    ['other/e.md', { content: '# E\n正文', revision: 'r-e', sessionId: session, objectVersion: 'o-e' }]
  ])
  let tree = treeOf()
  const configurationCalls: boolean[] = []
  const deps = { root: () => '/vault', session: () => session,
    tree: async () => tree,
    read: async (path: string) => { await onRead?.(path); const item = records.get(path); if (!item) throw Error('ENOENT'); return { ...item } },
    tier: async (_root: string, path: string) => { onTier?.(path); if (path === denied) throw Error('FORBIDDEN'); return follow.has(path) ? 'follow' as const : 'reference' as const },
    acceptsObject: () => false,
    configuration: (extraReferences: boolean) => {
      configurationCalls.push(extraReferences)
      return { credential: { provider: 'custom' as const, baseURL: 'https://model.example/v1', modelId: model, contextTokens: 16000, apiKey: key }, limits: { seconds: 180, steps: 4, tools: extraReferences ? 24 : 0 } }
    }
  }
  const registry = new TaskAuthorizationRegistry(deps)
  const request = { relPath: 'dir/a.md', sessionId: session, objectVersion: 'o-a', expectedRevision: 'r-a', ...draftRequest(records.get('dir/a.md')!.content, '问'), modelRecordId: 'model-record', scope: 'folder' as AgentScopeLevel }
  return {
    registry, deps, request, records, tree: () => tree, configurationCalls,
    setTree: (next: TreeEntry[]) => { tree = next },
    onRead: (hook: (path: string) => void | Promise<void>) => { onRead = hook },
    onTier: (hook: (path: string) => void) => { onTier = hook },
    session: (x: string) => { session = x }, model: (x: string) => { model = x }, key: (x: string) => { key = x },
    deny: (x: string) => { denied = x }, setFollow: (paths: string[]) => { follow = new Set(paths) }
  }
}
const withScope = (request: ReturnType<typeof setup>['request'], scope: AgentScopeLevel, extra: Record<string, unknown> = {}) => ({ ...request, scope, ...extra })

describe('三档范围与惰性授权', () => {
  it('预览只冻结发起篇，范围标记按档推导，且不泄露密钥', async () => {
    const app = setup()
    const preview = await app.registry.preview('owner', app.request)
    expect(preview.sources.map(source => source.relPath)).toEqual(['dir/a.md'])
    expect(preview.origin).toBe('dir/a.md')
    expect(preview.scope).toBe('folder')
    expect(preview.canCreate).toBe(true)
    expect(preview.canStructure).toBe(false)
    expect(preview.canDelete).toBe(false)
    expect(preview.recipient.host).toBe('model.example')
    expect(JSON.stringify(preview)).not.toContain('private')
    // 目录里的其他笔记没有在预览期被读过。
    const note = await app.registry.preview('owner', withScope(app.request, 'note'))
    expect(note.scope).toBe('note')
    expect(note.canCreate).toBe(false)
    const vault = await app.registry.preview('owner', withScope(app.request, 'vault'))
    expect(vault.canCreate).toBe(true)
    expect(vault.canStructure).toBe(true)
    expect(vault.canDelete).toBe(true)
    expect(vault.sources.map(source => source.relPath)).toEqual(['dir/a.md'])
  })

  it('本篇范围只含发起篇：其他篇读不了，也拿不到写目标', async () => {
    const app = setup()
    const preview = await app.registry.preview('owner', withScope(app.request, 'note'))
    const grant = await app.registry.consume('owner', { ...withScope(app.request, 'note'), previewId: preview.id })
    expect(grant.scope).toBe('note')
    expect(grant.contains('dir/a.md')).toBe(true)
    expect(grant.contains('dir/b.md')).toBe(false)
    await expect(grant.assertLive('read', 'dir/b.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    await expect(grant.assertLive('write', 'dir/b.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    expect(() => grant.assertWriteTarget('dir/a.md')).not.toThrow()
    expect(grant.list).toBeTypeOf('function')
    const page = await grant.list({ offset: 0, limit: 10 })
    expect(page.items.map(item => item.relPath)).toEqual(['dir/a.md'])
  })

  it('同册范围按发起篇所在目录递归；根目录笔记不提供同册', async () => {
    const app = setup()
    await expect(app.registry.preview('owner', withScope({ ...app.request, relPath: 'root.md', objectVersion: 'o-root', expectedRevision: 'r-root' }, 'folder'))).rejects.toThrow('FOLDER_SCOPE_AT_ROOT')
    const preview = await app.registry.preview('owner', app.request)
    const grant = await app.registry.consume('owner', { ...app.request, previewId: preview.id })
    expect(grant.contains('dir/sub/d.md')).toBe(true)
    expect(grant.contains('dir/Note/image.md')).toBe(true) // 结构包含；是不是普通笔记由 validateRead 判
    expect(grant.contains('other/e.md')).toBe(false)
    expect(grant.contains('root.md')).toBe(false)
    expect(grant.contains('dir')).toBe(false)
    await expect(grant.assertLive('read', 'other/e.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    const page = await grant.list({ offset: 0, limit: 2 })
    expect(page.total).toBe(3)
    expect(page.complete).toBe(false)
    expect(page.items.map(item => item.relPath)).toEqual(['dir/a.md', 'dir/b.md'])
    const rest = await grant.list({ offset: 2, limit: 2 })
    expect(rest.items.map(item => item.relPath)).toEqual(['dir/sub/d.md'])
    expect(rest.complete).toBe(true)
  })

  it('整库范围可以读任意普通笔记，附件夹与非普通文件仍读不了', async () => {
    const app = setup()
    const preview = await app.registry.preview('owner', withScope(app.request, 'vault'))
    const grant = await app.registry.consume('owner', { ...withScope(app.request, 'vault'), previewId: preview.id })
    await expect(grant.assertLive('read', 'other/e.md')).resolves.toBeUndefined()
    await expect(grant.assertLive('read', 'dir/Note/image.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    await expect(grant.assertLive('read', 'dir/Note/sub/nested.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    await expect(grant.assertLive('read', 'pic.png')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    expect(grant.actualSources().map(proof => proof.relPath).sort()).toEqual(['dir/a.md', 'other/e.md'].sort())
  })

  it('大库（300 篇）预览不枚举也不受 256 上限约束', async () => {
    const app = setup()
    const reads: string[] = []
    app.onRead(path => { reads.push(path) })
    const children: TreeEntry[] = []
    for (let at = 0; at < 300; at += 1) {
      const relPath = `dir/big/n${at}.md`
      app.records.set(relPath, { content: '正文', revision: `r${at}`, sessionId: 'session-a', objectVersion: `o${at}` })
      children.push({ name: `n${at}.md`, relPath, kind: 'note' })
    }
    app.setTree([...treeOf(), { name: 'big', relPath: 'dir/big', kind: 'dir', children }])
    const preview = await app.registry.preview('owner', app.request)
    expect(preview.sources.map(source => source.relPath)).toEqual(['dir/a.md'])
    expect(reads).toEqual(['dir/a.md'])
    const grant = await app.registry.consume('owner', { ...app.request, previewId: preview.id })
    expect(reads.filter(path => path !== 'dir/a.md')).toEqual([])
    // 需要列表时才实时枚举；一页仍只给一页。
    const page = await grant.list({ offset: 0, limit: 5 })
    expect(page.total).toBe(303)
    expect(page.items).toHaveLength(5)
    // 预览与消费各读一次发起篇；列表不再读任何正文。
    expect(reads.filter(path => path !== 'dir/a.md')).toEqual([])
    expect(reads.filter(path => path === 'dir/a.md').length).toBeLessThanOrEqual(2)
  })

  it('每次读都实时核验普通笔记、非附件、非 forbidden 与会话', async () => {
    const app = setup()
    const preview = await app.registry.preview('owner', withScope(app.request, 'vault'))
    const grant = await app.registry.consume('owner', { ...withScope(app.request, 'vault'), previewId: preview.id })
    app.deny('other/e.md')
    await expect(grant.validateRead('other/e.md')).rejects.toThrow('FORBIDDEN')
    app.deny('')
    // 读前是普通目录、读中变成附件夹：读后复核必须拒。
    const tree = app.tree()
    app.onRead(path => { if (path === 'other/e.md') tree.find(entry => entry.relPath === 'other')!.attachmentOf = 'other.md' })
    await expect(grant.validateRead('other/e.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
  })

  it('结构目标只在整库、非发起篇、普通笔记、可参考时放行', async () => {
    const app = setup()
    const folder = await app.registry.consume('owner', { ...app.request, previewId: (await app.registry.preview('owner', app.request)).id })
    await expect(folder.assertStructuralTarget('dir/b.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    const note = await app.registry.consume('owner', { ...withScope(app.request, 'note'), previewId: (await app.registry.preview('owner', withScope(app.request, 'note'))).id })
    await expect(note.assertStructuralTarget('dir/b.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    const vaultRequest = withScope(app.request, 'vault')
    const vault = await app.registry.consume('owner', { ...vaultRequest, previewId: (await app.registry.preview('owner', vaultRequest)).id })
    await expect(vault.assertStructuralTarget('dir/b.md')).resolves.toBeUndefined()
    await expect(vault.assertStructuralTarget('dir/a.md')).rejects.toThrow('ORIGIN_LOCKED')
    app.setFollow(['dir/b.md'])
    await expect(vault.assertStructuralTarget('dir/b.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    app.setFollow([])
    await expect(vault.assertStructuralTarget('dir/Note/image.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    app.deny('dir/b.md')
    await expect(vault.assertStructuralTarget('dir/b.md')).rejects.toThrow('FORBIDDEN')
    app.deny('')
  })

  it('新建落点只能是发起篇所在目录；本篇范围不宣告也不放行建', async () => {
    const app = setup()
    const vaultRequest = withScope(app.request, 'vault')
    const vault = await app.registry.consume('owner', { ...vaultRequest, previewId: (await app.registry.preview('owner', vaultRequest)).id })
    await expect(vault.assertCreateTarget('dir/new.md')).resolves.toBeUndefined()
    await expect(vault.assertCreateTarget('other/new.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
    await expect(vault.assertCreateTarget('dir/a.md')).rejects.toThrow('TARGET_EXISTS')
    const noteRequest = withScope(app.request, 'note')
    const note = await app.registry.consume('owner', { ...noteRequest, previewId: (await app.registry.preview('owner', noteRequest)).id })
    await expect(note.assertCreateTarget('dir/new.md')).rejects.toThrow('OUTSIDE_TASK_SCOPE')
  })

  it('start 的 scope 必须与预览一致，旧四档字段一律拒', async () => {
    const app = setup()
    const preview = await app.registry.preview('owner', app.request)
    await expect(app.registry.consume('owner', { ...withScope(app.request, 'vault'), previewId: preview.id })).rejects.toThrow('INVALID_AUTHORIZATION')
    const fresh = await app.registry.preview('owner', app.request)
    await expect(app.registry.consume('owner', { ...app.request, previewId: fresh.id, scope: 'all' as never })).rejects.toThrow('INVALID_AUTHORIZATION')
    await expect(app.registry.preview('owner', { ...app.request, level: 'write' } as never)).rejects.toThrow('BAD_REQUEST')
    await expect(app.registry.preview('owner', { ...app.request, references: [] } as never)).rejects.toThrow('BAD_REQUEST')
    await expect(app.registry.preview('owner', withScope(app.request, 'all' as never))).rejects.toThrow('BAD_REQUEST')
  })

  it('阅后即焚、owner、过期与命令变更都按原样拒', async () => {
    const app = setup()
    const preview = await app.registry.preview('a', app.request)
    await expect(app.registry.consume('b', { ...app.request, previewId: preview.id })).rejects.toThrow('INVALID_AUTHORIZATION')
    const grant = await app.registry.consume('a', { ...app.request, previewId: preview.id })
    await expect(app.registry.consume('a', { ...app.request, previewId: preview.id })).rejects.toThrow('INVALID_AUTHORIZATION')
    grant.revoke()
    await expect(grant.assertLive('model')).rejects.toThrow('AUTHORIZATION_REVOKED')
    const p2 = await app.registry.preview('a', app.request)
    await expect(app.registry.consume('a', { ...app.request, promptText: '另一问', previewId: p2.id })).rejects.toThrow('STALE_AUTHORIZATION')
    const p3 = await app.registry.preview('a', app.request)
    app.registry.discard('b', p3.id)
    await expect(app.registry.consume('a', { ...app.request, previewId: p3.id })).resolves.toBeDefined()
    const p4 = await app.registry.preview('a', app.request)
    app.registry.discard('a', p4.id)
    await expect(app.registry.consume('a', { ...app.request, previewId: p4.id })).rejects.toThrow('INVALID_AUTHORIZATION')
    const p5 = await app.registry.preview('a', app.request)
    app.model('changed')
    await expect(app.registry.consume('a', { ...app.request, previewId: p5.id })).rejects.toThrow('STALE_AUTHORIZATION')
    const p6 = await app.registry.preview('a', app.request)
    app.key('changed-secret')
    await expect(app.registry.consume('a', { ...app.request, previewId: p6.id })).rejects.toThrow('STALE_AUTHORIZATION')
  })

  it('预览过期后不再被消费', async () => {
    vi.useFakeTimers()
    try {
      const app = setup()
      const preview = await app.registry.preview('a', app.request)
      vi.setSystemTime(Date.now() + 6 * 60 * 1000)
      await expect(app.registry.consume('a', { ...app.request, previewId: preview.id })).rejects.toThrow('INVALID_AUTHORIZATION')
    } finally { vi.useRealTimers() }
  })

  it('调用窗口失效、换库与改会话都会让活授权失败关闭', async () => {
    const app = setup()
    let valid = true
    const registry = new TaskAuthorizationRegistry({ ...app.deps, ownerValid: () => valid })
    const preview = await registry.preview('a', app.request)
    const grant = await registry.consume('a', { ...app.request, previewId: preview.id })
    valid = false
    await expect(grant.assertLive('model')).rejects.toThrow('AUTHORIZATION_REVOKED')
    valid = true
    app.session('session-b')
    await expect(grant.assertLive('model')).rejects.toThrow('VAULT_CHANGED')
  })

  it('发起篇仍按冻结的修订／对象／正文段核验，自己的写回只经收据推进', async () => {
    const app = setup()
    const preview = await app.registry.preview('a', app.request)
    const grant = await app.registry.consume('a', { ...app.request, previewId: preview.id })
    app.records.set('dir/a.md', { content: draftBody('问') + '\n\n人改了', revision: 'changed', sessionId: 'session-a', objectVersion: 'o-a' })
    await expect(grant.assertLive('model')).rejects.toThrow('SOURCE_CHANGED')
    // 人改之后重新预览（新修订与正文段），再证明只有受控收据会推进基准。
    const app2 = setup()
    const p2 = await app2.registry.preview('a', app2.request)
    const grant2 = await app2.registry.consume('a', { ...app2.request, previewId: p2.id })
    const updated = { content: draftBody('问') + '\n\n受控追加回答', revision: 'own-next', sessionId: 'session-a', objectVersion: 'o-a' }
    app2.records.set('dir/a.md', updated)
    grant2.acknowledgeOrigin(updated)
    await expect(grant2.assertLive('model')).resolves.toBeUndefined()
    grant2.revoke()
    expect(() => grant2.acknowledgeOrigin(updated)).toThrow('AUTHORIZATION_REVOKED')
  })

  it('发起篇被同字节换对象仍拒', async () => {
    const app = setup()
    const preview = await app.registry.preview('a', app.request)
    const grant = await app.registry.consume('a', { ...app.request, previewId: preview.id })
    app.records.set('dir/a.md', { content: draftSource('问').source, revision: 'r-a', sessionId: 'session-a', objectVersion: 'foreign' })
    await expect(grant.assertLive('model')).rejects.toThrow('SOURCE_REPLACED')
  })

  it('同册／整库的读搜预算按库档给，本篇按单篇档给', async () => {
    const app = setup()
    const note = await app.registry.preview('owner', withScope(app.request, 'note'))
    expect(note.memory?.search?.sharedTools).toBeUndefined()
    expect(app.configurationCalls.at(-1)).toBe(false)
    await app.registry.preview('owner', app.request)
    expect(app.configurationCalls.at(-1)).toBe(true)
    await app.registry.preview('owner', withScope(app.request, 'vault'))
    expect(app.configurationCalls.at(-1)).toBe(true)
  })

  it('config、memory、技能签名在消费时按原样复核', async () => {
    const app = setup()
    const preview = await app.registry.preview('owner', app.request)
    app.model('next')
    await expect(app.registry.consume('owner', { ...app.request, previewId: preview.id })).rejects.toThrow('STALE_AUTHORIZATION')

    let signature = 'first'; let search = true
    const registry = new TaskAuthorizationRegistry({ ...app.deps,
      memoryAuthorization: async () => ({ signature, search, disclosure: { use: true, consolidate: false, recipient: null, limits: { seconds: 120, calls: 2, tools: 0 } } }),
      configuration: (library, _model, memory) => ({ ...app.deps.configuration(library), limits: { seconds: 30, steps: memory ? 8 : 4, tools: memory ? 12 : 0 } }) })
    let p = await registry.preview('owner', app.request)
    expect(p.memory?.search).toEqual({ available: true, calls: 4, sharedTools: 12 })
    const grant = await registry.consume('owner', { ...app.request, previewId: p.id })
    expect(grant.limits.tools).toBe(12)
    p = await registry.preview('owner', app.request)
    signature = 'changed'
    await expect(registry.consume('owner', { ...app.request, previewId: p.id })).rejects.toThrow('STALE_AUTHORIZATION')
    search = false
    p = await registry.preview('owner', app.request)
    expect(p.memory?.search?.available).toBe(false)
    expect((await registry.consume('owner', { ...app.request, previewId: p.id })).limits.tools).toBe(0)
  })

  it('把技能与记忆的结论只当输入：预览不把正文带出来', async () => {
    const app = setup()
    const registry = new TaskAuthorizationRegistry({ ...app.deps, memoryAuthorization: async () => ({ signature: 's', search: true, disclosure: { use: true, consolidate: true, recipient: { modelId: 'm', host: 'h' }, limits: { seconds: 1, calls: 1, tools: 1 } } }) })
    const preview = await registry.preview('owner', app.request)
    expect(JSON.stringify(preview)).not.toContain('private')
    expect(preview.memory?.consolidate).toBe(true)
  })

  it('discloses deleteEnabled from the host and does not guess the platform', async () => {
    const off = setup()
    expect((await off.registry.preview('a', off.request)).deleteEnabled).toBe(false)
    const on = setup()
    const registry = new TaskAuthorizationRegistry({ ...on.deps, deleteAvailable: () => true })
    expect((await registry.preview('a', on.request)).deleteEnabled).toBe(true)
  })

  it('改参考不再作为推倒全场的理由；冻结的是范围与发起篇', async () => {
    const app = setup()
    const preview = await app.registry.preview('a', app.request)
    const grant = await app.registry.consume('a', { ...app.request, previewId: preview.id })
    // 范围外的目录新增一篇：既不在预览里，也不影响本场。
    app.records.set('other/new.md', { content: '新增', revision: 'new', sessionId: 'session-a', objectVersion: 'new' })
    app.setTree([...treeOf(), { name: 'other', relPath: 'other', kind: 'dir', children: [
      { name: 'e.md', relPath: 'other/e.md', kind: 'note' },
      { name: 'new.md', relPath: 'other/new.md', kind: 'note' }
    ] }])
    await expect(grant.assertLive('model')).resolves.toBeUndefined()
    expect(grant.contains('other/new.md')).toBe(false)
  })
})

/** 设备级 MCP：搜索类带标记，闸关时只保留非搜索组。 */
function mcpSetup() {
  const app = setup()
  const servers = [{ name: 'deepwiki', host: 'mcp.example', tools: ['search'], searchChannel: true }]
  let availability: { available: boolean; servers: typeof servers; reason?: 'off' | 'not-configured' | 'too-many-tools' } = { available: true, servers }
  let networkOn = true
  const registry = new TaskAuthorizationRegistry({ ...app.deps,
    network: () => ({ available: networkOn, search: networkOn, providerHost: networkOn ? 'api.search.brave.com' : null, ...(networkOn ? {} : { reason: 'off' as const }) }),
    mcp: () => structuredClone(availability)
  })
  return {
    ...app,
    registry,
    servers,
    set: (next: Partial<typeof availability>) => { availability = { ...availability, ...next } },
    setNetwork: (on: boolean) => { networkOn = on }
  }
}

describe('设备级联网与 MCP 快照', () => {
  it('freezes device-level MCP servers and exposes their search tag', async () => {
    const app = mcpSetup()
    const preview = await app.registry.preview('owner', app.request)
    const grant = await app.registry.consume('owner', { ...app.request, previewId: preview.id })
    expect(grant.mcp?.servers).toEqual([{ name: 'deepwiki', host: 'mcp.example', tools: ['search'], searchChannel: true }])
    expect(() => grant.assertMcp()).not.toThrow()
  })

  it.each([
    ['a widened whitelist', (app: ReturnType<typeof mcpSetup>) => { app.set({ servers: [{ name: 'deepwiki', host: 'mcp.example', tools: ['search', 'read'], searchChannel: true }] }) }],
    ['a renamed server', (app: ReturnType<typeof mcpSetup>) => { app.set({ servers: [{ name: 'other', host: 'mcp.example', tools: ['search'], searchChannel: true }] }) }],
    ['a changed host', (app: ReturnType<typeof mcpSetup>) => { app.set({ servers: [{ name: 'deepwiki', host: 'evil.example', tools: ['search'], searchChannel: true }] }) }],
    ['a revoked availability', (app: ReturnType<typeof mcpSetup>) => { app.set({ available: false, reason: 'not-configured' }) }]
  ] as const)('requires a new preview after %s between preview and start', async (_label, change) => {
    const app = mcpSetup()
    const preview = await app.registry.preview('owner', app.request)
    change(app)
    await expect(app.registry.consume('owner', { ...app.request, previewId: preview.id })).rejects.toThrow('INVALID_AUTHORIZATION')
  })

  it('keeps non-search MCP available when the search gate is off, but hides search servers', async () => {
    const app = mcpSetup()
    app.setNetwork(false)
    app.set({ servers: [
      { name: 'deepwiki', host: 'mcp.example', tools: ['search'], searchChannel: true },
      { name: 'files', host: 'files.example', tools: ['list'], searchChannel: false }
    ] })
    const preview = await app.registry.preview('owner', app.request)
    const grant = await app.registry.consume('owner', { ...app.request, previewId: preview.id })
    expect(grant.mcp?.servers.map(server => server.name)).toEqual(['files'])
    grant.revokeNetwork()
    expect(grant.mcp?.servers.map(server => server.name)).toEqual(['files'])
    expect(() => grant.assertMcp()).not.toThrow()
    grant.revokeMcp()
    expect(grant.mcp).toBeUndefined()
    expect(() => grant.assertMcp()).toThrow('MCP_NOT_AUTHORIZED')
    await expect(grant.assertLive('model')).resolves.toBeUndefined()
  })
})
