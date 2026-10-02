import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultSession } from '../../src/main/vault.ts'
import { createModelConfigStore } from '../../src/main/model-config.ts'
import { secureFsFor } from '../../src/main/secure-fs.ts'
import { appendLedgerChapter } from '../../src/main/host-source.ts'
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../../src/main/watch.ts', async original => ({ ...await original<typeof import('../../src/main/watch.ts')>(), watchVault: vi.fn(() => () => {}) }))
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0)) await fn() })
async function setup(content = '长期使用中文。\n\n无关段落。') {
  const data = await mkdtemp(path.join(os.tmpdir(), 'rgent-memory-')); const root = path.join(data, 'vault'); await mkdir(root)
  await writeFile(path.join(data, 'vault.json'), JSON.stringify({ path: root }))
  await writeFile(path.join(root, 'note.md'), content)
  const config = createModelConfigStore(data, { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: b => b.toString() })
  const session = new VaultSession(data, vi.fn(), undefined, config.memoryStoragePins())
  session.restore()
  cleanup.push(async () => { session.dispose(); await rm(data, { recursive: true, force: true }) })
  return { data, root, session, config, store: session.memory() }
}
async function remember(env: Awaited<ReturnType<typeof setup>>, text = '长期使用中文。') {
  const note = await env.session.read('note.md')
  const source = await env.store.createManualSource({ relPath: 'note.md', ...note, kind: 'body', start: note.content.indexOf(text), end: note.content.indexOf(text) + text.length })
  const snapshot = await env.store.snapshot()
  return env.store.remember(snapshot, { content: '优先中文', layer: 'core', scope: '本库', sources: [source], explicit: true })
}
describe('vault memory storage', () => {
  it('creates only on a valid commit, omits hidden data from tree, and checks native CAS even for equal bytes', async () => {
    const env = await setup(); const empty = await env.store.snapshot()
    expect(empty.record.entries).toEqual([])
    await expect(readFile(path.join(env.root, '.rgent-memory'))).rejects.toThrow()
    const entry = await remember(env); expect(entry.version).toBe(1)
    expect(JSON.stringify(await env.session.tree())).not.toContain('.rgent-memory')
    const before = await env.store.snapshot(); const raw = await readFile(path.join(env.root, '.rgent-memory'), 'utf8')
    await rename(path.join(env.root, '.rgent-memory'), path.join(env.root, '.held'))
    await writeFile(path.join(env.root, '.rgent-memory'), raw)
    await expect(env.store.edit(before, entry.id, 1, { content: 'override' })).rejects.toThrow('MEMORY_REPLACED')
    expect(await readFile(path.join(env.root, '.rgent-memory'), 'utf8')).toBe(raw)
    expect((await env.store.status()).status).toBe('invalid')
  })
  it('preserves corrupt records and rejects replacement across restarts', async () => {
    const env = await setup(); await remember(env)
    const raw = await readFile(path.join(env.root, '.rgent-memory'), 'utf8')
    await rename(path.join(env.root, '.rgent-memory'), path.join(env.root, '.held'))
    await writeFile(path.join(env.root, '.rgent-memory'), raw)
    env.session.restore()
    await expect(env.session.memory().snapshot()).rejects.toThrow('MEMORY_REPLACED')
    await writeFile(path.join(env.root, '.rgent-memory'), '{bad')
    expect((await env.session.memory().status()).status).toBe('invalid')
    expect(await readFile(path.join(env.root, '.rgent-memory'), 'utf8')).toBe('{bad')
  })
  it('continues unchanged material only through a committed identity edge and persists it', async () => {
    const env = await setup(); const entry = await remember(env)
    const note = await env.session.read('note.md')
    await env.session.write('note.md', '新增。\n\n' + note.content, note.revision, note)
    expect((await env.store.validatedEntries()).map(e => e.id)).toEqual([entry.id])
    env.session.restore(); const fresh = env.session.memory()
    expect((await fresh.validatedEntries()).map(e => e.id)).toEqual([entry.id])
    const current = await env.session.read('note.md')
    await env.session.write('note.md', current.content.replace('长期使用中文。', '长期使用英文。'), current.revision, current)
    expect(await fresh.validatedEntries()).toEqual([])
    expect((await fresh.list())[0]!.status).toBe('paused')
  })
  it('rejects duplicate material, external same-content source replacement and tightened permissions', async () => {
    const env = await setup(); await remember(env)
    const note = await env.session.read('note.md')
    await env.session.write('note.md', note.content + '\n长期使用中文。', note.revision, note)
    expect(await env.store.validatedEntries()).toEqual([])
    const other = await setup(); await remember(other)
    await rename(path.join(other.root, 'note.md'), path.join(other.root, 'held.md'))
    await writeFile(path.join(other.root, 'note.md'), '长期使用中文。\n\n无关段落。')
    expect(await other.store.validatedEntries()).toEqual([])
    const policy = await setup(); await remember(policy)
    await writeFile(path.join(policy.root, '.rgent-permissions'), JSON.stringify({ 'note.md': 'follow' }))
    expect(await policy.store.validatedEntries()).toEqual([])
  })
  it('keeps forget evidence textless, old versions blocked, and stale candidates unable to overwrite edits', async () => {
    const env = await setup(); const entry = await remember(env); const before = await env.store.snapshot()
    await env.store.edit(before, entry.id, 1, { content: '更正中文' })
    await expect(env.store.edit(before, entry.id, 1, { content: 'late' })).rejects.toThrow('MEMORY_CONFLICT')
    await env.store.forget(await env.store.snapshot(), entry.id, 2)
    const raw = await readFile(path.join(env.root, '.rgent-memory'), 'utf8')
    expect(raw).not.toContain('更正中文'); expect(raw).not.toContain('长期使用中文'); expect(raw).not.toContain('优先中文')
    expect(await env.store.validateDependency({ id: entry.id, version: 1 })).toBe(false)
    const next = await remember(env)
    expect(next.id).not.toBe(entry.id)
    expect(await env.store.validateDependency({ id: entry.id, version: 1 })).toBe(false)
  })
  it('blocks stale sessions and attachments and isolates same-path replacement roots', async () => {
    const env = await setup(); const context = env.session.memoryContext(); await remember(env)
    await mkdir(path.join(env.root, 'note')); await writeFile(path.join(env.root, 'note', 'a.md'), 'attachment')
    const attachment = await env.session.read('note/a.md')
    await expect(env.store.createManualSource({ relPath: 'note/a.md', ...attachment, kind: 'body', start: 0, end: 10 })).rejects.toThrow()
    env.session.restore(); await expect(env.store.snapshot()).rejects.toThrow('VAULT_CHANGED')
    expect(env.session.memoryContext().vaultKey).toBe(context.vaultKey)
    env.session.dispose(); await rename(env.root, env.root + '-old'); await mkdir(env.root); env.session.restore()
    expect(env.session.memoryContext().vaultKey).not.toBe(context.vaultKey)
  })
  it('does not report a successful note save as failed if hidden storage cannot be committed', async () => {
    const env = await setup(); await remember(env)
    const fs = secureFsFor(env.root); const replace = fs.replace.bind(fs)
    vi.spyOn(fs, 'replace').mockImplementation((rel, ...args) => { if (rel === '.rgent-memory') throw new Error('DISK_FULL'); return replace(rel, ...args) })
    const note = await env.session.read('note.md')
    await expect(env.session.write('note.md', note.content + '\n别处更改', note.revision, note)).resolves.toHaveProperty('revision')
    await expect(env.store.validatedEntries()).rejects.toThrow('DISK_FULL')
    expect(await env.store.status()).toMatchObject({ status: 'invalid', reason: 'DISK_FULL' })
  })
  it('keeps a ledger source valid across unrelated chapter append and inherits AI answer dependencies after adoption', async () => {
    const env = await setup(appendLedgerChapter('答复事实。', { taskId: 'task1', startedAt: 'today', status: 'completed', prompt: 'question', answer: '答复事实。', provenance: { version: 1, model: { provider: 'test', modelId: 'x', endpointHost: 'example.test' }, scope: ['dep.md'], sources: [], tools: [] } }))
    const note = await env.session.read('note.md')
    const source = await env.store.createManualSource({ relPath: 'note.md', ...note, kind: 'body', start: 0, end: 5 })
    expect(source.classification).toBe('adopted-ai')
    expect(source.taskId).toBe('task1')
    const entry = await env.store.remember(await env.store.snapshot(), { content: '答复事实', layer: 'demand', scope: '本库', sources: [source], explicit: true })
    const saved = appendLedgerChapter(note.content, { taskId: 'task2', startedAt: 'later', status: 'completed', prompt: 'next', answer: 'next' })
    await env.session.write('note.md', saved, note.revision, note)
    expect((await env.store.validatedEntries()).map(e => e.id)).toEqual([entry.id])
  })
})

it('rejects old forgotten material after a controlled save or a new preview unless explicitly remembered again', async () => {
  const env = await setup(); const entry = await remember(env)
  await env.store.forget(await env.store.snapshot(), entry.id, 1)
  const note = await env.session.read('note.md'); await env.session.write('note.md', note.content + '\nnew paragraph', note.revision, note)
  const changed = await env.session.read('note.md')
  const source = await env.store.createManualSource({ relPath: 'note.md', ...changed, kind: 'body', start: 0, end: '长期使用中文。'.length })
  await expect(env.store.remember(await env.store.snapshot(), { content: 'revived', layer: 'core', scope: '本库', sources: [source], explicit: false })).rejects.toThrow('MEMORY_FORGOTTEN_BASIS')
})
it('accepts a bounded human selection spanning multiple blocks', async () => {
  const env = await setup(); const note = await env.session.read('note.md')
  const source = await env.store.createManualSource({ relPath: 'note.md', ...note, kind: 'body', start: 0, end: note.content.length })
  expect(source.classification).toBe('human')
})
it('enforces entry limits without creating or overwriting a record', async () => {
  const env = await setup(); const note = await env.session.read('note.md')
  const source = await env.store.createManualSource({ relPath: 'note.md', ...note, kind: 'body', start: 0, end: 7 })
  await expect(env.store.remember(await env.store.snapshot(), { content: '字'.repeat(1366), layer: 'core', scope: '本库', sources: [source], explicit: true })).rejects.toThrow('MEMORY_RECORD_INVALID')
  await expect(readFile(path.join(env.root, '.rgent-memory'))).rejects.toThrow()
})
it('keeps successful note bytes but disables memory if device pin persistence fails', async () => {
  const env = await setup(); await remember(env)
  const pins = env.config.memoryStoragePins(); const note = await env.session.read('note.md')
  // The store shares this closure; a failed model configuration atomic write is observed by pins.set.
  await rename(path.join(env.data, 'model-config.json'), path.join(env.data, 'old-config.json'))
  await mkdir(path.join(env.data, 'model-config.json'))
  await expect(env.session.write('note.md', note.content + '\nnew', note.revision, note)).resolves.toHaveProperty('revision')
  expect((await env.store.status()).status).toBe('invalid')
  expect(pins.get(env.session.memoryContext().vaultKey)).not.toBeNull()
})
it('keeps an observed external source change paused after old bytes return until explicit resume', async () => {
  const env = await setup(); const entry = await remember(env); const file = path.join(env.root, 'note.md'); const before = await readFile(file, 'utf8')
  await writeFile(file, before.replace('中文', '英文'))
  expect(await env.store.validatedEntries()).toEqual([])
  await writeFile(file, before)
  expect(await env.store.validatedEntries()).toEqual([])
  const paused = (await env.store.list())[0]!
  env.session.restore(); const reopened = env.session.memory()
  expect(await reopened.validatedEntries()).toEqual([])
  await reopened.resume(await reopened.snapshot(), entry.id, paused.version)
  expect((await reopened.validatedEntries())[0]!.id).toBe(entry.id)
})
it('rechecks the exact manual preview revision even for an unrelated in-place edit', async () => {
  const env = await setup(); const note = await env.session.read('note.md')
  const source = await env.store.createManualSource({ relPath: 'note.md', ...note, kind: 'body', start: 0, end: 7 })
  await writeFile(path.join(env.root, 'note.md'), note.content + '\nother')
  await expect(env.store.remember(await env.store.snapshot(), { content: '中文', layer: 'core', scope: '本库', sources: [source], explicit: true })).rejects.toThrow('MEMORY_SOURCE_CHANGED')
})
it('cannot use a case alias to bypass source permission checks', async context => {
  const env = await setup()
  try { if (secureFsFor(env.root).resolve('NOTE.md').at(-1)?.id !== secureFsFor(env.root).resolve('note.md').at(-1)?.id) context.skip() } catch { context.skip() }
  await writeFile(path.join(env.root, '.rgent-permissions'), JSON.stringify({ 'note.md': 'forbidden' }))
  const note = await env.session.read('NOTE.md')
  await expect(env.store.createManualSource({ relPath: 'NOTE.md', ...note, kind: 'body', start: 0, end: 7 })).rejects.toThrow()
})
it('pauses adopted AI material if the original task provenance is changed with the body intact', async () => {
  const env = await setup(appendLedgerChapter('答复事实。', { taskId: 'task1', startedAt: 'today', status: 'completed', prompt: 'question', answer: '答复事实。', provenance: { version: 1, model: { provider: 'test', modelId: 'x', endpointHost: 'example.test' }, scope: [], sources: [], tools: [] } }))
  const note = await env.session.read('note.md')
  const source = await env.store.createManualSource({ relPath: 'note.md', ...note, kind: 'body', start: 0, end: 5 })
  await env.store.remember(await env.store.snapshot(), { content: '事实', layer: 'core', scope: '本库', sources: [source], explicit: true })
  await writeFile(path.join(env.root, 'note.md'), note.content.replace(' · completed', ' · failed'))
  expect(await env.store.validatedEntries()).toEqual([])
})
it('migrates pure rename before journal clear and retains stable forget material across rename', async () => {
  const env = await setup(); const entry = await remember(env)
  const preview = await env.session.previewRelocation({ kind: 'note', source: 'note.md', target: 'renamed.md' })
  await env.session.commitRelocation(preview.id, false)
  expect((await env.store.validatedEntries())[0]!.sources[0]!.relPath).toBe('renamed.md')
  expect(JSON.parse(await readFile(path.join(env.root, '.rgent-lifecycle'), 'utf8')).active).toBeNull()
  await env.store.forget(await env.store.snapshot(), entry.id, 1)
  const note = await env.session.read('renamed.md')
  const source = await env.store.createManualSource({ relPath: 'renamed.md', ...note, kind: 'body', start: 0, end: 7 })
  await expect(env.store.remember(await env.store.snapshot(), { content: 'old', layer: 'core', scope: '本库', sources: [source], explicit: false })).rejects.toThrow('MEMORY_FORGOTTEN_BASIS')
})
it('rejects a permission change during local source verification', async () => {
  const env = await setup(); const note = await env.session.read('note.md'); const fs = secureFsFor(env.root)
  const original = fs.readSnapshot.bind(fs)
  vi.spyOn(fs, 'readSnapshot').mockImplementation(rel => {
    const result = original(rel)
    if (rel === 'note.md') fs.replace('.rgent-permissions', null, JSON.stringify({ 'note.md': 'forbidden' }))
    return result
  })
  await expect(env.store.createManualSource({ relPath: 'note.md', ...note, kind: 'body', start: 0, end: 7 })).rejects.toThrow('PERMISSIONS_CHANGED')
})
it('allows only textless forget management while a relocation waits for source identity proof', async () => {
  const env = await setup('长期使用中文。\n\n[[note]]'); const entry = await remember(env)
  vi.spyOn(env.store, 'onCommittedWrite').mockRejectedValueOnce(new Error('CRASH_BEFORE_MEMORY'))
  const preview = await env.session.previewRelocation({ kind: 'note', source: 'note.md', target: 'renamed.md' })
  await expect(env.session.commitRelocation(preview.id, true)).rejects.toThrow('CRASH_BEFORE_MEMORY')
  env.session.restore(); const fresh = env.session.memory()
  expect((await env.session.lifecycleStatus()).status).toBe('pending')
  await expect(fresh.snapshot()).rejects.toThrow('LIFECYCLE_RECOVERY_REQUIRED')
  const management = await fresh.managementSnapshot()
  expect(management.record.entries[0]!.status).toBe('paused')
  await fresh.forget(management, entry.id, management.record.entries[0]!.version)
  const pending = await env.session.lifecycleStatus()
  await env.session.lifecycleRetry({ sessionId: pending.sessionId, revision: pending.revision! })
  expect((await env.session.lifecycleStatus()).status).toBe('ready')
  expect(await fresh.validatedEntries()).toEqual([])
})
it('does not wash an unmarked AI excerpt inside a larger manual selection into human material', async () => {
  const content = appendLedgerChapter('人写段落。\n\n答复事实。', { taskId: 'task1', startedAt: 'today', status: 'completed', prompt: 'question', answer: '答复事实。' })
  const env = await setup(content); const note = await env.session.read('note.md')
  await expect(env.store.createManualSource({ relPath: 'note.md', ...note, kind: 'body', start: 0, end: '人写段落。\n\n答复事实。'.length })).rejects.toThrow('MEMORY_SOURCE_UNKNOWN')
})
it('consumes a successful manual preview once', async () => {
  const env = await setup(); const note = await env.session.read('note.md')
  const source = await env.store.createManualSource({ relPath: 'note.md', ...note, kind: 'body', start: 0, end: 7 })
  const input = { content: '中文', layer: 'core' as const, scope: '本库', sources: [source], explicit: true }
  await env.store.remember(await env.store.snapshot(), input)
  await expect(env.store.remember(await env.store.snapshot(), input)).rejects.toThrow('MEMORY_SOURCE_NOT_VERIFIED')
})
it('remembers unrelated human paragraphs in a note that also has an AI task ledger', async () => {
  const env = await setup(appendLedgerChapter('长期使用中文。', { taskId: 'task1', startedAt: 'today', status: 'completed', prompt: 'question', answer: '完全无关的答复。' }))
  expect((await remember(env)).sources[0]!.classification).toBe('human')
})
it('rejects duplicate source and memory dependency keys in the strict record schema', async () => {
  const { parseMemoryRecord } = await import('../../src/main/memory-store.ts')
  const env = await setup(); await remember(env); const snapshot = await env.store.snapshot()
  const source = snapshot.record.entries[0]!.sources[0]!
  source.memoryDeps = [{ id: 'entry', version: 1 }, { id: 'entry', version: 1 }]
  expect(() => parseMemoryRecord(JSON.stringify(snapshot.record))).toThrow('MEMORY_RECORD_INVALID')
  source.memoryDeps = []
  source.sourceDeps = [1, 2].map(() => ({ relPath: 'other.md', objectVersion: 'native', bodyHash: 'a'.repeat(64), permissionTier: 'reference' }))
  expect(() => parseMemoryRecord(JSON.stringify(snapshot.record))).toThrow('MEMORY_RECORD_INVALID')
})
it('checks file size, entry count, unknown fields and unknown versions before any commit', async () => {
  const { parseMemoryRecord, MAX_MEMORY_FILE_BYTES } = await import('../../src/main/memory-store.ts')
  expect(() => parseMemoryRecord(' '.repeat(MAX_MEMORY_FILE_BYTES + 1))).toThrow('MEMORY_FILE_LIMIT')
  const env = await setup(); const entry = await remember(env); const record = (await env.store.snapshot()).record
  expect(() => parseMemoryRecord(JSON.stringify({ ...record, version: 2 }))).toThrow('MEMORY_RECORD_INVALID')
  expect(() => parseMemoryRecord(JSON.stringify({ ...record, extra: true }))).toThrow('MEMORY_RECORD_INVALID')
  record.entries = Array.from({ length: 1001 }, (_, i) => ({ ...entry, id: `entry${i}` }))
  expect(() => parseMemoryRecord(JSON.stringify(record))).toThrow('MEMORY_RECORD_INVALID')
})

it('rejects a provable AI answer embedded inside the same human paragraph without provenance', async () => {
  const body = '人写段落。答复事实。'
  const env = await setup(appendLedgerChapter(body, { taskId: 'task1', startedAt: 'today', status: 'completed', prompt: 'question', answer: '答复事实。' }))
  const note = await env.session.read('note.md')
  await expect(env.store.createManualSource({ relPath: 'note.md', ...note, kind: 'body', start: 0, end: body.length })).rejects.toThrow('MEMORY_SOURCE_UNKNOWN')
})
it.each(['external', 'committed'])('pauses a human source when its unchanged text becomes an unaccepted AI block (%s)', async mode => {
  const env = await setup(); const entry = await remember(env); const note = await env.session.read('note.md')
  const changed = '<!-- rgent:ai:v1 -->\n' + note.content
  if (mode === 'external') await writeFile(path.join(env.root, 'note.md'), changed)
  else {
    await env.session.write('note.md', changed, note.revision, note)
    expect((await env.store.snapshot()).record.entries[0]!.status).toBe('paused')
  }
  expect(await env.store.verifySource(entry.sources[0]!)).toBe(false)
  expect(await env.store.validatedEntries()).toEqual([])
  expect((await env.store.list())[0]!.status).toBe('paused')
})
it('rejects a new task association for a previously verified human source', async () => {
  const env = await setup(); await remember(env); const note = await env.session.read('note.md')
  await writeFile(path.join(env.root, 'note.md'), '<!-- rgent:prompt:v1 task-id="new-task" -->\n' + note.content)
  expect(await env.store.validatedEntries()).toEqual([])
})
it('pauses a human source if an unknown identity marker now governs the same material', async () => {
  const env = await setup(); await remember(env); const note = await env.session.read('note.md')
  await writeFile(path.join(env.root, 'note.md'), '<!-- rgent:ai:v2 -->\n' + note.content)
  expect(await env.store.validatedEntries()).toEqual([])
})
it('keeps an unrelated human source usable after appending an unrelated task ledger', async () => {
  const env = await setup(); const entry = await remember(env); const note = await env.session.read('note.md')
  const next = appendLedgerChapter(note.content, { taskId: 'later-task', startedAt: 'today', status: 'completed', prompt: 'question', answer: '完全无关的答复。' })
  await env.session.write('note.md', next, note.revision, note)
  expect((await env.store.snapshot()).record.entries[0]!.status).toBe('active')
  expect((await env.store.validatedEntries())[0]!.id).toBe(entry.id)
})
it('rejects a complete known AI sentence embedded in a larger human paragraph', async () => {
  const body = '人写段落。答复事实。'
  const env = await setup(appendLedgerChapter(body, { taskId: 'task1', startedAt: 'today', status: 'completed', prompt: 'question', answer: '答复事实。另一句答复。' }))
  const note = await env.session.read('note.md')
  await expect(env.store.createManualSource({ relPath: 'note.md', ...note, kind: 'body', start: 0, end: body.length })).rejects.toThrow('MEMORY_SOURCE_UNKNOWN')
})

it('inherits adopted v2 memory dependencies and cannot wash a forgotten version into a new source', async () => {
  const { memoryDependency } = await import('../../src/main/memory-use.ts')
  const env = await setup(); const parent = await remember(env)
  const derived = appendLedgerChapter('派生事实。', { taskId: 'derived', startedAt: 'now', status: 'completed', prompt: '问', answer: '派生事实。', provenance: { version: 2, model: { provider: 'test', modelId: 'm', endpointHost: 'example.test' }, scope: ['derived.md'], sources: [], tools: [], memoryDeps: [memoryDependency(parent)] } })
  await writeFile(path.join(env.root, 'derived.md'), derived)
  const note = await env.session.read('derived.md')
  const request = { ...note, relPath: 'derived.md', kind: 'body' as const, start: 0, end: '派生事实。'.length }
  const source = await env.store.createManualSource(request)
  expect(source.memoryDeps).toEqual([{ id: parent.id, version: 1 }])
  const child = await env.store.remember(await env.store.snapshot(), { content: '派生', layer: 'demand', scope: '本库', sources: [source], explicit: true })
  await env.store.forget(await env.store.snapshot(), parent.id, 1)
  expect(await env.store.validateDependency({ id: child.id, version: 1 })).toBe(false)
  await expect(env.store.createManualSource(request)).rejects.toThrow('MEMORY_DEPENDENCY_CHANGED')
})

it('does not reclassify an established human source when a later AI answer quotes it', async () => {
  const env = await setup(); const entry = await remember(env); const note = await env.session.read('note.md')
  const next = appendLedgerChapter(note.content, {taskId:'later',startedAt:'now',status:'completed',prompt:'重复原文',answer:'长期使用中文。',provenance:{version:1,model:{provider:'test',modelId:'m',endpointHost:'example.test'},scope:['note.md'],sources:[],tools:[]}})
  await env.session.write('note.md',next,note.revision,note)
  expect((await env.store.snapshot()).record.entries[0]?.status).toBe('active')
  expect((await env.store.validatedEntries()).map(e=>e.id)).toEqual([entry.id])
})

it('rechecks the real source before another memory send and does not revive the paused version', async () => {
 const {createMemoryUsePermit}=await import('../../src/main/memory-use.ts')
 const env=await setup(),entry=await remember(env)
 const model={provider:'custom' as const,baseURL:'https://example.test/v1',modelId:'m',contextTokens:16000,apiKey:'key'}
 const permit=await createMemoryUsePermit({context:()=>env.session.memoryContext(),config:()=>({enabled:true,epoch:0}),entries:()=>env.store.validatedEntries()},model,'问','')
 permit.stage([entry.id]);await permit.assertCurrent(model);permit.markSent()
 const note=await env.session.read('note.md')
 await env.session.write('note.md',note.content.replace('长期使用中文。','长期使用英文。'),note.revision,note)
 await expect(permit.assertCurrent(model)).rejects.toThrow('MEMORY_CHANGED')
 const changed=await env.session.read('note.md');await env.session.write('note.md',note.content,changed.revision,changed)
 expect(await env.store.validateDependency({id:entry.id,version:1})).toBe(false)
})

it.each(['普通引言。\n\n### 工具摘要\n\nFORGOTTEN_SECRET。','普通引言。\n\n```md\n### 工具摘要\n```\n\nFORGOTTEN_SECRET。'])('refuses to remember adopted text hidden past an ambiguous ledger heading: %s', async answer=>{
 const {memoryDependency}=await import('../../src/main/memory-use.ts')
 const env=await setup(),parent=await remember(env)
 const derived=appendLedgerChapter('FORGOTTEN_SECRET。',{taskId:'ambiguous',startedAt:'now',status:'completed',prompt:'问',answer,provenance:{version:2,model:{provider:'test',modelId:'m',endpointHost:'example.test'},scope:['derived.md'],sources:[],tools:[],memoryDeps:[memoryDependency(parent)]}})
 await writeFile(path.join(env.root,'derived.md'),derived)
 await env.store.forget(await env.store.snapshot(),parent.id,parent.version)
 const note=await env.session.read('derived.md')
 await expect(env.store.createManualSource({...note,relPath:'derived.md',kind:'body',start:0,end:'FORGOTTEN_SECRET。'.length})).rejects.toThrow('MEMORY_SOURCE_AMBIGUOUS')
})

it('validates only requested memory IDs and their dependencies after startup, without reading unrelated sources', async()=>{
 const env=await setup(),entry=await remember(env)
 await writeFile(path.join(env.root,'unrelated.md'),'另一个来源。')
 const note=await env.session.read('unrelated.md')
 const source=await env.store.createManualSource({...note,relPath:'unrelated.md',kind:'body',start:0,end:note.content.length})
 await env.store.remember(await env.store.snapshot(),{content:'无关条目',layer:'demand',scope:'本库',sources:[source],explicit:true})
 const read=vi.spyOn(secureFsFor(env.root),'readSnapshot')
 expect((await env.store.validatedEntries([entry.id])).map(e=>e.id)).toEqual([entry.id])
 expect(read.mock.calls.some(([p])=>p==='note.md')).toBe(true)
 expect(read.mock.calls.some(([p])=>p==='unrelated.md')).toBe(false)
})

it('persists observed recursive dependency failures when validating only the selected child', async () => {
  const { memoryDependency } = await import('../../src/main/memory-use.ts')
  const env = await setup(), parent = await remember(env)
  const original = (await env.session.read('note.md')).content
  const derived = appendLedgerChapter('派生事实。', { taskId: 'derived', startedAt: 'now', status: 'completed', prompt: '问', answer: '派生事实。', provenance: { version: 2, model: { provider: 'test', modelId: 'm', endpointHost: 'example.test' }, scope: ['derived.md'], sources: [], tools: [], memoryDeps: [memoryDependency(parent)] } })
  await writeFile(path.join(env.root, 'derived.md'), derived)
  const note = await env.session.read('derived.md')
  const source = await env.store.createManualSource({ ...note, relPath: 'derived.md', kind: 'body', start: 0, end: '派生事实。'.length })
  const child = await env.store.remember(await env.store.snapshot(), { content: '派生', layer: 'demand', scope: '本库', sources: [source], explicit: true })
  await writeFile(path.join(env.root, 'note.md'), original.replace('长期使用中文。', '长期使用英文。'))
  expect(await env.store.validatedEntries([child.id])).toEqual([])
  const snapshot = await env.store.snapshot()
  expect(snapshot.record.entries.find(e => e.id === child.id)).toMatchObject({ status: 'paused', version: 2 })
  expect(snapshot.record.entries.find(e => e.id === parent.id)).toMatchObject({ status: 'paused', version: 2 })
  await writeFile(path.join(env.root, 'note.md'), original)
  expect(await env.store.validatedEntries([parent.id])).toEqual([])
  expect(await env.store.validateDependency({ id: parent.id, version: 1 })).toBe(false)
})
