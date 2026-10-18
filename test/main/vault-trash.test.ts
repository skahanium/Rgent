import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultSession } from '../../src/main/vault.ts'
import { serializeStoredVault } from '../../src/main/notes-fs.ts'
import { markPrompt, upsertAiAnswer } from '../../src/main/host-source.ts'
import { WRITE_TOOL_SCHEMAS } from '../../src/main/scoped-agent-tools.ts'
import { IPC } from '../../src/shared/ipc.ts'
import { HUMAN_TRASH_ON_THIS_PLATFORM } from '../../src/shared/human-trash.ts'
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../../src/main/watch.ts', async importOriginal => ({ ...await importOriginal<typeof import('../../src/main/watch.ts')>(), watchVault: () => () => {} }))

async function reclaim(landing: string | null | undefined): Promise<void> {
  if (!landing) return
  await rm(landing, { recursive: true, force: true })
}

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rgent-trash-'))
  const root = path.join(base, 'vault')
  await mkdir(root)
  await writeFile(path.join(base, 'vault.json'), serializeStoredVault(root))
  await mkdir(path.join(root, 'a'))
  await writeFile(path.join(root, 'a', '附件.txt'), '附件正文')
  const marked = markPrompt('/以后用中文', { taskId: 'task', range: { start: 0, end: 6 }, expectedText: '/以后用中文', promptText: '以后用中文' })
  await writeFile(path.join(root, 'a.md'), marked)
  const vault = new VaultSession(base, vi.fn())
  vault.restore()
  let note = await vault.readOpened('a.md')
  await vault.ledgerPrepare('a.md', { taskId: 'task', startedAt: new Date().toISOString(), status: 'completed', prompt: '以后用中文', answer: '好的' })
  const saved = await vault.write('a.md', upsertAiAnswer(note.content, { taskId: 'task', answer: '好的' }), note.revision, note)
  await vault.ledgerComplete('a.md', 'task', saved.revision)
  note = await vault.read('a.md')
  return { base, root, vault, binding: { sessionId: note.sessionId, objectVersion: note.objectVersion } }
}

describe('human trash', () => {
  const bases: string[] = []
  afterEach(async () => {
    for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true }).catch(() => {})
  })

  it('registers delete_note for the model but not an agent trash channel', () => {
    expect(Object.keys(WRITE_TOOL_SCHEMAS)).toContain('delete_note')
    expect(WRITE_TOOL_SCHEMAS.delete_note.inputSchema.required).toEqual(['relPath'])
    expect(IPC.noteTrashPreview).toBe('note:trash-preview')
    expect(IPC.noteTrashCommit).toBe('note:trash-commit')
    expect(Object.values(IPC).some((value) => /agent:.*trash|tool:.*delete/i.test(String(value)))).toBe(false)
  })

  it('refuses preview on Windows and does not touch the note', async () => {
    if (HUMAN_TRASH_ON_THIS_PLATFORM) return
    const f = await fixture()
    bases.push(f.base)
    try {
      await expect(f.vault.previewTrash('a.md')).rejects.toThrow('PLATFORM_UNPROVEN')
      expect(existsSync(path.join(f.root, 'a.md'))).toBe(true)
    } finally { f.vault.dispose() }
  })

  it('cancels with zero disk change', async () => {
    if (!HUMAN_TRASH_ON_THIS_PLATFORM) return
    const f = await fixture()
    bases.push(f.base)
    try {
      const preview = await f.vault.previewTrash('a.md')
      expect(preview.hasAttachments).toBe(true)
      const result = await f.vault.commitTrash(preview.id, false)
      expect(result.cancelled).toBe(true)
      expect(await readFile(path.join(f.root, 'a.md'), 'utf8')).toContain('以后用中文')
      expect(existsSync(path.join(f.root, 'a', '附件.txt'))).toBe(true)
    } finally { f.vault.dispose() }
  })

  it('refuses when the object is swapped after preview', async () => {
    if (!HUMAN_TRASH_ON_THIS_PLATFORM) return
    const f = await fixture()
    bases.push(f.base)
    try {
      const preview = await f.vault.previewTrash('a.md')
      await rename(path.join(f.root, 'a.md'), path.join(f.root, '停.md'))
      await writeFile(path.join(f.root, 'a.md'), '顶替')
      await expect(f.vault.commitTrash(preview.id, true)).rejects.toThrow('PATH_CHANGED')
      expect(await readFile(path.join(f.root, 'a.md'), 'utf8')).toBe('顶替')
      expect(await readFile(path.join(f.root, '停.md'), 'utf8')).toContain('以后用中文')
    } finally { f.vault.dispose() }
  })

  it('trashes the note then the companion folder and reserves the path', async () => {
    if (!HUMAN_TRASH_ON_THIS_PLATFORM) return
    const f = await fixture()
    bases.push(f.base)
    let landing: string | undefined
    let attachmentLanding: string | null | undefined
    try {
      const preview = await f.vault.previewTrash('a.md')
      const result = await f.vault.commitTrash(preview.id, true)
      expect(result.cancelled).toBe(false)
      expect(result.orphan).toBe(false)
      landing = result.landing
      attachmentLanding = result.attachmentLanding
      expect(existsSync(path.join(f.root, 'a.md'))).toBe(false)
      expect(existsSync(path.join(f.root, 'a'))).toBe(false)
      expect(await readFile(landing!, 'utf8')).toContain('以后用中文')
      expect(await readFile(path.join(attachmentLanding!, '附件.txt'), 'utf8')).toBe('附件正文')
      await expect(f.vault.create('a')).rejects.toThrow('PATH_RESERVED')
      const ledgers = path.join(f.root, '.rgent', 'ledgers')
      const owners = (await readdir(ledgers)).filter(name => name !== '.DS_Store')
      const files = await readdir(path.join(ledgers, owners[0]!))
      expect(files).toContain('humantrash.json')
      const record = JSON.parse(await readFile(path.join(ledgers, owners[0]!, 'humantrash.json'), 'utf8')) as { chapter: { prompt: string; answer: string } }
      expect(record.chapter.prompt).toBe('移入系统废纸篓')
      expect(record.chapter.answer).toContain(landing)
    } finally {
      f.vault.dispose()
      await reclaim(landing)
      await reclaim(attachmentLanding)
    }
  })

  it('leaves an orphan attachment folder when the second step fails', async () => {
    if (!HUMAN_TRASH_ON_THIS_PLATFORM) return
    const f = await fixture()
    bases.push(f.base)
    let landing: string | undefined
    try {
      const preview = await f.vault.previewTrash('a.md')
      await rm(path.join(f.root, 'a'), { recursive: true, force: true })
      await writeFile(path.join(f.root, 'a'), '不是附件夹')
      const result = await f.vault.commitTrash(preview.id, true)
      expect(result.cancelled).toBe(false)
      expect(result.orphan).toBe(true)
      landing = result.landing
      expect(existsSync(path.join(f.root, 'a.md'))).toBe(false)
      expect(await readFile(path.join(f.root, 'a'), 'utf8')).toBe('不是附件夹')
      await expect(f.vault.create('a')).rejects.toThrow('PATH_RESERVED')
    } finally {
      f.vault.dispose()
      await reclaim(landing)
    }
  })

  it('AI 确认删除把账本记在本场 taskId 下，不占用 humantrash', async () => {
    if (!HUMAN_TRASH_ON_THIS_PLATFORM) return
    const f = await fixture()
    bases.push(f.base)
    let landing: string | undefined
    let attachmentLanding: string | null | undefined
    try {
      const session = f.vault.sessionId()
      expect(session).toBeTruthy()
      const preview = await f.vault.previewTrash('a.md')
      const result = await f.vault.commitTrash(preview.id, true, session!, { taskId: 'agent-task-1', prompt: 'AI 提议移入系统废纸篓（人已确认）' })
      landing = result.landing
      attachmentLanding = result.attachmentLanding
      const ledgers = path.join(f.root, '.rgent', 'ledgers')
      const owners = (await readdir(ledgers)).filter(name => name !== '.DS_Store')
      const files = await readdir(path.join(ledgers, owners[0]!))
      expect(files).toContain('agent-task-1.json')
      expect(files).not.toContain('humantrash.json')
      const record = JSON.parse(await readFile(path.join(ledgers, owners[0]!, 'agent-task-1.json'), 'utf8')) as { chapter: { prompt: string; answer: string } }
      expect(record.chapter.prompt).toBe('AI 提议移入系统废纸篓（人已确认）')
      expect(record.chapter.answer).toContain(landing)
    } finally {
      f.vault.dispose()
      await reclaim(landing)
      await reclaim(attachmentLanding)
    }
  })
})
