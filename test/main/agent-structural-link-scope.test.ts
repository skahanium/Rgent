import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultSession } from '../../src/main/vault.ts'
import { serializeStoredVault } from '../../src/main/notes-fs.ts'
import { TaskAuthorizationRegistry } from '../../src/main/task-authorization.ts'
import { modelTierFor } from '../../src/main/permissions.ts'
import { AgentHost, type HostStart } from '../../src/main/agent-host.ts'
import { createScopedAgentTools } from '../../src/main/scoped-agent-tools.ts'
import type { AgentAuthorizationRequest, AgentStartRequest } from '../../src/shared/ipc.ts'
import type { ModelCredential } from '../../src/main/model-config.ts'
import { hostLedgerFixture } from './host-ledger-fixture.ts'
import { draftBody, draftRequest } from './draft-fixture.ts'

/** 真实库夹具：改名／挪走的仍是库自己的 previewRelocation／commitRelocation，
 *  这里只证明 AI 的引用修复范围判据与人的路径互不干扰。 */
const SOURCE = '发起篇.md'
const TARGET = '参考篇.md'
const NEW_TARGET = '新参考篇.md'
const REF = '引用篇.md'
const CREDENTIAL: ModelCredential = { provider: 'custom', baseURL: 'https://model.example/v1', modelId: 'm', contextTokens: 32000, apiKey: 'fixture' }
const LIMITS = { seconds: 30, steps: 4, tools: 4 }

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Scenario = { originLink?: boolean; refTier?: 'reference' | 'follow' | 'forbidden' }

async function makeVault(scenario: Scenario = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'rgent-link-scope-'))
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-link-vault-'))
  const source = `人写的段落。\n\n${scenario.originLink ? `[[${TARGET.slice(0, -3)}]]\n\n` : ''}${draftBody('问')}\n`
  await writeFile(path.join(root, SOURCE), source)
  await writeFile(path.join(root, TARGET), '# 参考\n正文')
  await writeFile(path.join(root, REF), `[[${TARGET.slice(0, -3)}]]`)
  const permissions = scenario.refTier === 'follow' || scenario.refTier === 'forbidden'
    ? JSON.stringify({ [REF]: scenario.refTier })
    : null
  if (permissions) await writeFile(path.join(root, '.rgent-permissions'), permissions)
  await writeFile(path.join(userData, 'vault.json'), serializeStoredVault(root))
  const session = new VaultSession(userData, vi.fn())
  const state = await session.restore()
  if (state.status !== 'ready') {
    session.dispose()
    await rm(userData, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
    throw new Error(`VAULT_NOT_READY:${state.status}`)
  }
  cleanups.push(async () => { session.dispose(); await rm(userData, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) })
  return { session, root, source, permissions }
}

/** 走真实授权（vault 范围）与真实库层迁移；第一次模型步请求改名，第二步收尾回答。 */
async function runRename(scenario: Scenario = {}) {
  const vault = await makeVault(scenario)
  const { session, root } = vault
  const note = await session.read(SOURCE)
  const request: AgentAuthorizationRequest = {
    modelRecordId: 'model-record', relPath: SOURCE, sessionId: note.sessionId!, objectVersion: note.objectVersion!,
    expectedRevision: note.revision, ...draftRequest(note.content, '问'), scope: 'vault'
  }
  const registry = new TaskAuthorizationRegistry({
    root: () => session.requireUsableRoot(),
    session: () => session.sessionId(),
    tree: () => session.tree(),
    assertOrdinaryNotes: paths => session.requireOrdinaryNotes(paths),
    read: relPath => session.read(relPath),
    tier: modelTierFor,
    acceptsObject: (relPath, expected, current) => session.acceptsObject(relPath, expected, current),
    configuration: () => ({ credential: CREDENTIAL, limits: LIMITS })
  })
  const preview = await registry.preview('owner', request)
  const history = hostLedgerFixture()
  const requests: Parameters<NonNullable<import('../../src/main/agent-host.ts').HostDependencies['streamStep']>>[0][] = []
  const events: unknown[] = []
  const host = new AgentHost({
    ledger: history.ledger,
    root: () => session.requireUsableRoot(),
    session: () => session.sessionId(),
    read: relPath => session.read(relPath),
    write: (relPath, content, revision, binding) => session.write(relPath, content, revision, binding!),
    tier: modelTierFor,
    acceptsObject: (relPath, expected, current) => session.acceptsObject(relPath, expected, current),
    credential: () => CREDENTIAL,
    limits: () => LIMITS,
    authorize: input => registry.consume((input as HostStart).authorizationOwner!, input as AgentStartRequest),
    stream: async function* () {},
    streamStep: async function* (input) {
      requests.push(input)
      if (requests.length === 1) {
        yield { type: 'tool-call', id: 'call-1', name: 'rename_note', input: { relPath: TARGET, newName: '新参考篇' } } as never
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text', text: '已答。' }
        yield { type: 'finish', reason: 'stop' }
      }
    },
    createReadOnlyTools: (granted, id, _memory, _materials, write) => createScopedAgentTools(granted, id, {
      read: relPath => session.read(relPath), tier: modelTierFor,
      acceptsObject: (relPath, expected, current) => session.acceptsObject(relPath, expected, current),
      ...(write ? { write } : {})
    }),
    relocationPreview: request => session.previewRelocation({ kind: request.kind, source: request.source, target: request.target }),
    relocationCommit: (previewId, repairLinks) => session.commitRelocation(previewId, repairLinks),
    emit: event => { events.push(event) }
  })
  const commit = vi.spyOn(session, 'commitRelocation')
  const start = {
    ...note, relPath: SOURCE, expectedRevision: note.revision, modelRecordId: request.modelRecordId,
    ...draftRequest(note.content, '问'),
    previewId: preview.id, authorizationOwner: 'owner', scope: 'vault'
  } satisfies HostStart & AgentStartRequest
  const task = await host.start(start)
  const result = await task.done
  return { ...vault, history, requests, events, result, commit }
}

const exists = async (file: string): Promise<boolean> => readFile(file).then(() => true, () => false)

describe('AI 结构操作 · 引用修复来源范围', () => {
  it('reference 回链：改名成功并由库层修好引用', async () => {
    const app = await runRename()
    expect(app.result).toEqual({ status: 'cancelled', reason: 'vault-change' })
    expect(await exists(path.join(app.root, TARGET))).toBe(false)
    expect(await readFile(path.join(app.root, NEW_TARGET), 'utf8')).toContain('# 参考')
    expect(await readFile(path.join(app.root, REF), 'utf8')).toBe('[[新参考篇]]')
    expect(app.commit).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['follow', { refTier: 'follow' as const }],
    ['forbidden', { refTier: 'forbidden' as const }],
    ['origin', { originLink: true }]
  ])('%s 回链：整次失败，文件与权限不变，库层提交没被调用', async (_label, scenario) => {
    const app = await runRename(scenario)
    expect(app.result).toEqual({ status: 'completed' })
    const trace = app.history.records().at(-1)?.trace?.join('\n') ?? ''
    expect(trace).toContain('LINK_REPAIR_OUT_OF_SCOPE')
    // 目标没动、引用没改、权限文件一个字节没变。
    expect(await readFile(path.join(app.root, TARGET), 'utf8')).toBe('# 参考\n正文')
    expect(await exists(path.join(app.root, NEW_TARGET))).toBe(false)
    expect(await readFile(path.join(app.root, REF), 'utf8')).toBe('[[参考篇]]')
    if (app.permissions) expect(await readFile(path.join(app.root, '.rgent-permissions'), 'utf8')).toBe(app.permissions)
    expect(app.commit).not.toHaveBeenCalled()
  })

  it('人自己的预览与提交不受 AI 引用来源判据限制', async () => {
    const { session, root } = await makeVault({ refTier: 'follow' })
    const preview = await session.previewRelocation({ kind: 'note', source: TARGET, target: NEW_TARGET })
    expect(preview.linkChanges.map(change => change.relPath)).toContain(REF)
    const result = await session.commitRelocation(preview.id, true)
    expect(result.moved.map(move => move.to)).toContain(NEW_TARGET)
    expect(await readFile(path.join(root, NEW_TARGET), 'utf8')).toContain('# 参考')
    expect(await readFile(path.join(root, REF), 'utf8')).toBe('[[新参考篇]]')
  })
})
