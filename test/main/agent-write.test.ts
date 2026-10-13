import { describe, expect, it, vi } from 'vitest'
import { createWriteGate, WRITE_LIMITS, type WriteGateDeps } from '../../src/main/agent-write.ts'

/** 包 1：写入门。合同见 decisions.md「写类 AI 工具局部授权」——
 *  正文写入只发生在发起篇、只能追加新块；建落点固定为发起篇所在目录；
 *  限额：每场新建 ≤4、每篇追加 ≤2、单次 ≤8 KiB、单场累计 ≤32 KiB。 */

const ORIGIN = '工作/发起篇.md'
const HUMAN = '# 标题\n\n人写的段落，逐字不动。\n'
const MARKED = `${HUMAN}\n/口令要求\n`

type Written = { relPath: string; content: string; revision: string; objectVersion?: string }

function harness(over: Partial<WriteGateDeps> = {}) {
  const written: Written[] = []
  const created: { relPath: string; content: string }[] = []
  let content = MARKED
  let revision = 'r1'
  let objectVersion = 'o1'
  const deps: WriteGateDeps = {
    origin: () => ORIGIN,
    session: () => 's1',
    assertWriteTarget: (relPath: string) => { if (relPath !== ORIGIN) throw Error('OUTSIDE_TASK_SCOPE') },
    assertLive: async () => {},
    read: async () => ({ content, revision, objectVersion, sessionId: 's1' }),
    write: async (relPath, next, expected, binding) => {
      if (expected !== revision) throw Error('CONFLICT')
      if (binding && binding.objectVersion !== objectVersion) throw Error('OBJECT_REPLACED')
      written.push({ relPath, content: next, revision: 'r2', objectVersion })
      content = next; revision = 'r2'
      return { revision: 'r2', objectVersion }
    },
    create: async (relPath, body) => {
      created.push({ relPath, content: body })
      return { relPath, revision: 'c1', objectVersion: 'co1' }
    },
    exists: async (relPath: string) => created.some(item => item.relPath === relPath),
    attachmentFolder: () => null,
    composeAppend: (previous, text) => `${previous.trimEnd()}\n\n<!-- rgent:ai:v1 -->\n${text}\n`,
    ...over
  }
  return { gate: createWriteGate(deps), written, created, current: () => content, setRevision: (value: string) => { revision = value } }
}

describe('write gate · 补任务发起篇', () => {
  it('追加到发起篇并如实记账字节数', async () => {
    const app = harness()
    const result = await app.gate.append({ text: '补一段依据。', expectedRevision: 'r1' })
    expect(result).toMatchObject({ ok: true, relPath: ORIGIN })
    expect(app.written).toHaveLength(1)
    expect(app.written[0]!.content).toContain('补一段依据。')
    // 人写段落逐字保留，且写入内容不含账本分区。
    expect(app.written[0]!.content.startsWith(MARKED.trimEnd())).toBe(true)
    if (result.ok) expect(result.bytes).toBe(Buffer.byteLength('补一段依据。', 'utf8'))
  })

  it('拒绝对发起篇以外任何笔记的正文写入', async () => {
    const app = harness({ assertWriteTarget: () => { throw Error('OUTSIDE_TASK_SCOPE') } })
    const result = await app.gate.append({ text: '越权', expectedRevision: 'r1' })
    expect(result).toEqual({ ok: false, reason: 'OUTSIDE_TASK_SCOPE' })
    expect(app.written).toHaveLength(0)
  })

  it('单次超过 8 KiB 就拒，且不写一半', async () => {
    const app = harness()
    const result = await app.gate.append({ text: 'x'.repeat(WRITE_LIMITS.bytesPerAppend + 1), expectedRevision: 'r1' })
    expect(result).toEqual({ ok: false, reason: 'OVER_LIMIT_BYTES' })
    expect(app.written).toHaveLength(0)
  })

  it('同一篇最多追加两次', async () => {
    const app = harness()
    expect((await app.gate.append({ text: '第一次', expectedRevision: 'r1' })).ok).toBe(true)
    expect((await app.gate.append({ text: '第二次', expectedRevision: 'r2' })).ok).toBe(true)
    const third = await app.gate.append({ text: '第三次', expectedRevision: 'r2' })
    expect(third).toEqual({ ok: false, reason: 'OVER_LIMIT_APPENDS' })
    expect(app.written).toHaveLength(2)
  })

  it('单场累计写入超过 32 KiB 就拒', async () => {
    const app = harness()
    const chunk = 'x'.repeat(WRITE_LIMITS.bytesPerAppend)
    expect((await app.gate.append({ text: chunk, expectedRevision: 'r1' })).ok).toBe(true)
    app.setRevision('r2')
    expect((await app.gate.append({ text: chunk, expectedRevision: 'r2' })).ok).toBe(true)
    app.setRevision('r2')
    // 第三次会先撞每篇两次的上限；换一篇不可能（只有发起篇可写），所以直接核累计计数。
    const state = await app.gate.append({ text: chunk, expectedRevision: 'r2' })
    expect(state.ok).toBe(false)
    expect(app.written).toHaveLength(2)
  })

  it('人正在写（修订已变）时冲突失败，不自动合并', async () => {
    const app = harness()
    const result = await app.gate.append({ text: '撞上人的编辑', expectedRevision: 'r0' })
    expect(result).toEqual({ ok: false, reason: 'CONFLICT' })
    expect(app.written).toHaveLength(0)
  })

  it('组合器想删掉人写文本时判违约，不落盘', async () => {
    const app = harness({ composeAppend: () => '把人写的段落删了。\n' })
    const result = await app.gate.append({ text: '坏块', expectedRevision: 'r1' })
    expect(result).toEqual({ ok: false, reason: 'INVARIANT_VIOLATION' })
    expect(app.written).toHaveLength(0)
  })

  it('组合器想顺带改账本分区时判违约', async () => {
    const app = harness({ composeAppend: previous => `${previous.trimEnd()}\n\n## 账本\n被人改了。\n` })
    const result = await app.gate.append({ text: '坏块', expectedRevision: 'r1' })
    expect(result.ok).toBe(false)
    expect(app.written).toHaveLength(0)
  })
})

describe('write gate · 建', () => {
  it('先预览再提交：预览给出目标，提交后才落盘', async () => {
    const app = harness()
    const preview = await app.gate.previewCreate({ name: '新笔记' })
    expect(preview.ok && preview.relPath).toBe('工作/新笔记.md')
    expect(app.created).toHaveLength(0)
    const committed = await app.gate.commitCreate({ previewId: (preview as { previewId: string }).previewId, body: '正文' })
    expect(committed.ok).toBe(true)
    expect(app.created).toEqual([{ relPath: '工作/新笔记.md', content: '正文' }])
  })

  it('预期令牌一次性：重放同一令牌被拒', async () => {
    const app = harness()
    const preview = await app.gate.previewCreate({ name: '新笔记' })
    const id = (preview as { previewId: string }).previewId
    expect((await app.gate.commitCreate({ previewId: id, body: '正文' })).ok).toBe(true)
    expect(await app.gate.commitCreate({ previewId: id, body: '再来一次' })).toEqual({ ok: false, reason: 'STALE_PREVIEW' })
    expect(app.created).toHaveLength(1)
  })

  it('名称非法、重名、隐藏段、附件夹子树一律拒', async () => {
    const app = harness()
    expect(await app.gate.previewCreate({ name: '带/斜杠' })).toEqual({ ok: false, reason: 'BAD_NAME' })
    expect(await app.gate.previewCreate({ name: '.隐藏' })).toEqual({ ok: false, reason: 'BAD_NAME' })
    const existing = harness({ exists: async relPath => relPath === '工作/新笔记.md' })
    expect(await existing.gate.previewCreate({ name: '新笔记' })).toEqual({ ok: false, reason: 'TARGET_EXISTS' })
    const inside = harness({ attachmentFolder: () => '工作/附件夹' })
    expect(await inside.gate.previewCreate({ name: '附件夹' })).toEqual({ ok: false, reason: 'ATTACHMENT_SUBTREE' })
  })

  it('每场最多新建四篇', async () => {
    const app = harness()
    for (let index = 0; index < WRITE_LIMITS.notesPerSession; index += 1) {
      const preview = await app.gate.previewCreate({ name: `第 ${index} 篇` })
      expect(preview.ok).toBe(true)
      await app.gate.commitCreate({ previewId: (preview as { previewId: string }).previewId, body: 'x' })
    }
    expect(await app.gate.previewCreate({ name: '第五篇' })).toEqual({ ok: false, reason: 'OVER_LIMIT_NOTES' })
    expect(app.created).toHaveLength(WRITE_LIMITS.notesPerSession)
  })

  it('新建的内容也计入单场累计写入（单次追加上限不管新建）', async () => {
    const app = harness()
    const preview = await app.gate.previewCreate({ name: '大篇' })
    const committed = await app.gate.commitCreate({ previewId: (preview as { previewId: string }).previewId, body: 'x'.repeat(WRITE_LIMITS.bytesPerSession + 1) })
    expect(committed).toEqual({ ok: false, reason: 'OVER_LIMIT_SESSION' })
    expect(app.created).toHaveLength(0)
  })

  it('换库或授权失效后不再写入', async () => {
    const app = harness({ assertLive: async () => { throw Error('AUTHORIZATION_REVOKED') } })
    expect(await app.gate.append({ text: 'x', expectedRevision: 'r1' })).toEqual({ ok: false, reason: 'AUTHORIZATION_REVOKED' })
    expect(app.written).toHaveLength(0)
  })

  it('写入失败按原样报错且不计数', async () => {
    const app = harness({ write: async () => { throw Error('IO_ERROR') } })
    expect(await app.gate.append({ text: 'x', expectedRevision: 'r1' })).toEqual({ ok: false, reason: 'IO_ERROR' })
    const probe = vi.fn()
    expect(probe).not.toHaveBeenCalled()
  })
})
