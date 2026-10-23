// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrashEntryView, TrashListResult, TrashPurgeResult, TrashRestoreResult } from '../../src/shared/ipc.ts'
import {
  formatTrashBytes, formatTrashTime, mountTrashManager, trashErrorText, trashRemainingDays,
  type TrashManagerHandlers
} from '../../src/renderer/src/trash-manager.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date(2026, 9, 23, 12, 0, 0).getTime()
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

const entry = (patch: Partial<TrashEntryView> = {}): TrashEntryView => ({
  id: 't1',
  name: 'a.md',
  originalRelPath: 'a.md',
  kind: 'note',
  deletedAt: new Date(NOW - 2 * DAY).toISOString(),
  expiresAt: new Date(NOW + 12 * DAY).toISOString(),
  bytes: 2048,
  source: 'human',
  state: 'ok',
  ...patch
})
const listed = (entries: TrashEntryView[]): TrashListResult =>
  ({ ok: true, entries, bytes: entries.reduce((sum, item) => sum + item.bytes, 0) })

let container: HTMLElement
beforeEach(() => {
  document.body.replaceChildren()
  container = document.createElement('div')
  document.body.append(container)
})
afterEach(() => { document.body.replaceChildren() })

function start(overrides: Partial<TrashManagerHandlers> = {}) {
  const handlers: TrashManagerHandlers = {
    list: vi.fn(async () => listed([entry()])),
    restore: vi.fn(async (): Promise<TrashRestoreResult> => ({ ok: true, relPath: 'a.md', copied: false })),
    purge: vi.fn(async (): Promise<TrashPurgeResult> => ({ ok: true })),
    ...overrides
  }
  const onBack = vi.fn()
  const onChanged = vi.fn()
  const onBusyChange = vi.fn()
  const page = mountTrashManager({
    body: container, isCurrent: () => true, onBack, onChanged, onBusyChange, now: () => NOW
  }, handlers)
  const row = (id = 't1') => container.querySelector<HTMLElement>(`[data-trash-id="${id}"]`)!
  const action = (name: string, id = 't1') => row(id).querySelector<HTMLButtonElement>(`[data-trash-action="${name}"]`)!
  return { page, handlers, onBack, onChanged, onBusyChange, row, action }
}

describe('in-vault deleted page', () => {
  it('renders newest first with name, path, type, time, remaining days, size and source', async () => {
    const older = entry({
      id: 'old', name: '旧.md', originalRelPath: '旧.md', deletedAt: new Date(NOW - 5 * DAY).toISOString(),
      expiresAt: new Date(NOW + 25 * DAY).toISOString(), bytes: 512, source: 'ai'
    })
    const newer = entry({
      id: 'new', name: '图/新.png', originalRelPath: '图/新.png', kind: 'attachment',
      deletedAt: new Date(NOW - DAY).toISOString(), expiresAt: new Date(NOW + 12 * DAY).toISOString(),
      bytes: 2 * 1024 * 1024
    })
    start({ list: vi.fn(async () => listed([older, newer])) })
    await flush()

    const rows = [...container.querySelectorAll<HTMLElement>('[data-trash-id]')]
    expect(rows.map(row => row.dataset.trashId)).toEqual(['new', 'old'])
    const newest = rows[0]!
    const field = (label: string): string => [...newest.querySelectorAll('.trash-field')]
      .find(group => group.querySelector('dt')!.textContent === label)!.querySelector('dd')!.textContent
    expect(newest.querySelector('.trash-name')!.textContent).toBe('图/新.png')
    expect(field('原路径')).toBe('图/新.png')
    expect(field('类型')).toBe('附件夹')
    expect(field('删除时间')).toBe(formatTrashTime(newer.deletedAt))
    expect(field('剩余')).toBe('12 天')
    expect(field('体积')).toBe('2 MB')
    expect(field('来源')).toBe('人')
    expect(newest.querySelector('.trash-state')!.textContent).toBe('正常')
    const oldest = rows[1]!
    expect(oldest.textContent).toContain('笔记')
    expect(oldest.textContent).toContain('AI')
    expect(oldest.textContent).toContain('512 B')
    expect(container.querySelector<HTMLElement>('.trash-empty')!.hidden).toBe(true)
    expect(container.querySelector<HTMLElement>('.trash-list')!.hidden).toBe(false)
  })

  it('shows the empty state instead of an invented list', async () => {
    start({ list: vi.fn(async () => listed([])) })
    await flush()
    expect(container.querySelector<HTMLElement>('.trash-empty')!.hidden).toBe(false)
    expect(container.querySelector('.trash-empty')!.textContent).toBe('没有已删除的笔记。')
    expect(container.querySelector<HTMLElement>('.trash-list')!.hidden).toBe(true)
    expect(container.querySelector<HTMLElement>('.trash-loading')!.hidden).toBe(true)
  })

  it('marks damaged entries and keeps both actions disabled with an explanation', async () => {
    const { action, handlers } = start({ list: vi.fn(async () => listed([entry({ state: 'damaged' })])) })
    await flush()
    const row = container.querySelector<HTMLElement>('[data-trash-id="t1"]')!
    expect(row.dataset.trashState).toBe('damaged')
    expect(row.querySelector('.trash-state')!.textContent).toBe('损坏')
    expect(row.textContent).toContain('记录已损坏')
    expect(action('restore').disabled).toBe(true)
    expect(action('purge').disabled).toBe(true)
    action('restore').click(); action('purge').click(); await flush()
    expect(handlers.restore).not.toHaveBeenCalled()
    expect(handlers.purge).not.toHaveBeenCalled()
  })

  it('restores in place, reports the path and reloads the authoritative list', async () => {
    const restore = vi.fn(async (): Promise<TrashRestoreResult> => ({ ok: true, relPath: 'a.md', copied: false }))
    const list = vi.fn()
      .mockResolvedValueOnce(listed([entry()]))
      .mockResolvedValueOnce(listed([]))
    const { action, onChanged, onBusyChange } = start({ list, restore })
    await flush()

    action('restore').click(); await flush()
    expect(restore).toHaveBeenCalledWith('t1')
    expect(container.querySelector('.trash-status')!.textContent).toBe('已还原到：a.md')
    expect(container.querySelector<HTMLElement>('.trash-error')!.hidden).toBe(true)
    expect(list).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-trash-id="t1"]')).toBeNull()
    expect(container.querySelector<HTMLElement>('.trash-empty')!.hidden).toBe(false)
    expect(onChanged).toHaveBeenLastCalledWith(0)
    expect(onBusyChange).toHaveBeenNthCalledWith(1, true)
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
  })

  it('reports a restored copy when the original path is occupied', async () => {
    const restore = vi.fn(async (): Promise<TrashRestoreResult> => ({ ok: true, relPath: 'a 副本.md', copied: true }))
    const { action } = start({ restore })
    await flush()
    action('restore').click(); await flush()
    expect(container.querySelector('.trash-status')!.textContent).toBe('已还原为副本：a 副本.md')
  })

  it('moves a record to the system trash with one click and no confirmation step', async () => {
    const purge = vi.fn(async (): Promise<TrashPurgeResult> => ({ ok: true }))
    const list = vi.fn()
      .mockResolvedValueOnce(listed([entry()]))
      .mockResolvedValueOnce(listed([]))
    const { action } = start({ list, purge })
    await flush()

    action('purge').click(); await flush()
    expect(purge).toHaveBeenCalledWith('t1')
    expect(container.querySelector('.trash-status')!.textContent).toBe('已移入系统废纸篓。')
    expect(list).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-trash-id="t1"]')).toBeNull()
    expect(container.querySelector<HTMLElement>('.trash-empty')!.hidden).toBe(false)
  })

  it('keeps the record and shows a readable reason when restore fails', async () => {
    const restore = vi.fn(async (): Promise<TrashRestoreResult> => ({ ok: false, error: 'TRASH_RESTORE_FAILED' }))
    const list = vi.fn(async () => listed([entry()]))
    const { action, row } = start({ list, restore })
    await flush()

    action('restore').click(); await flush()
    expect(row().querySelector('button')).not.toBeNull()
    expect(container.querySelector('.trash-error')!.textContent).toBe('没有还原，记录仍在已删除里。')
    expect(container.querySelector<HTMLElement>('.trash-error')!.hidden).toBe(false)
    expect(container.textContent).not.toContain('TRASH_RESTORE_FAILED')
    expect(list).toHaveBeenCalledTimes(1) // 失败不重拉列表，保留同一行让人重试
    expect(action('restore').disabled).toBe(false)
  })

  it('reports purge failures in page and keeps the record', async () => {
    const purge = vi.fn(async (): Promise<TrashPurgeResult> => ({ ok: false, error: 'NO_VAULT' }))
    const { action } = start({ purge })
    await flush()
    action('purge').click(); await flush()
    expect(container.querySelector('.trash-error')!.textContent).toContain('还没有打开笔记库')
    expect(container.querySelector('[data-trash-id="t1"]')).not.toBeNull()
  })

  it('translates Electron-wrapped errors without leaking the raw message', async () => {
    const { action } = start({
      restore: vi.fn(async () => { throw Error("Error invoking remote method 'vault:trash-restore': Error: TRASH_DAMAGED") })
    })
    await flush()
    action('restore').click(); await flush()
    expect(container.querySelector('.trash-error')!.textContent).toBe('这条记录已损坏，无法还原或删除。')
    expect(container.textContent).not.toContain('Error invoking remote method')
  })

  it('removes the row on success and reports a follow-up list read failure', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce(listed([entry()]))
      .mockResolvedValueOnce({ ok: false as const, error: 'IO_ERROR' })
    const restore = vi.fn(async (): Promise<TrashRestoreResult> => ({ ok: true, relPath: 'a.md', copied: false }))
    const { action } = start({ list, restore })
    await flush()
    action('restore').click(); await flush()
    expect(container.querySelector('[data-trash-id="t1"]')).toBeNull()
    expect(container.querySelector<HTMLElement>('.trash-empty')!.hidden).toBe(false)
    expect(container.querySelector('.trash-status')!.textContent).toBe('已还原到：a.md')
    expect(container.querySelector('.trash-error')!.textContent).toContain('读写笔记库失败')
  })

  it('reports the count from every successful list read', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce(listed([entry(), entry({ id: 't2', name: 'b.md', originalRelPath: 'b.md' })]))
      .mockResolvedValueOnce(listed([entry()]))
    const purge = vi.fn(async (): Promise<TrashPurgeResult> => ({ ok: true }))
    const { action, onChanged } = start({ list, purge })
    await flush()
    expect(onChanged).toHaveBeenLastCalledWith(2)
    action('purge').click(); await flush()
    expect(onChanged).toHaveBeenLastCalledWith(1)
  })

  it('blocks repeated clicks while an operation is in flight and reports busy to the host', async () => {
    const pending = deferred<TrashRestoreResult>()
    const restore = vi.fn(() => pending.promise)
    const { action, onBusyChange, page } = start({ restore })
    await flush()
    action('restore').click()
    expect(page.isBusy()).toBe(true)
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    expect(action('restore').disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[data-trash-action="back"]')!.disabled).toBe(true)
    action('restore').click()
    expect(restore).toHaveBeenCalledTimes(1)

    pending.resolve({ ok: true, relPath: 'a.md', copied: false }); await flush()
    expect(page.isBusy()).toBe(false)
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
    expect(action('restore').disabled).toBe(false)
  })

  it('does not ask to leave while an operation is in flight', async () => {
    const pending = deferred<TrashPurgeResult>()
    const { action, onBack, onBusyChange } = start({ purge: vi.fn(() => pending.promise) })
    await flush()
    action('purge').click()
    container.querySelector<HTMLButtonElement>('[data-trash-action="back"]')!.click()
    expect(onBack).not.toHaveBeenCalled()
    pending.resolve({ ok: true }); await flush()
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
  })

  it('ignores a late list after the page is disposed', async () => {
    const late = deferred<TrashListResult>()
    const onChanged = vi.fn()
    const page = mountTrashManager({
      body: container, isCurrent: () => true, onBack: vi.fn(), onChanged, now: () => NOW
    }, {
      list: () => late.promise,
      restore: async () => ({ ok: true, relPath: 'a.md', copied: false }),
      purge: async () => ({ ok: true })
    })
    page.dispose()
    late.resolve(listed([entry()]))
    await flush()
    expect(container.querySelector('[data-trash-id]')).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('deleted page formatting', () => {
  it('formats sizes in binary units and clamps invalid values', () => {
    expect(formatTrashBytes(0)).toBe('0 B')
    expect(formatTrashBytes(-3)).toBe('0 B')
    expect(formatTrashBytes(Number.NaN)).toBe('0 B')
    expect(formatTrashBytes(512)).toBe('512 B')
    expect(formatTrashBytes(2048)).toBe('2 KB')
    expect(formatTrashBytes(2 * 1024 * 1024)).toBe('2 MB')
    expect(formatTrashBytes(1024 * 1024 * 1024)).toBe('1 GB')
  })

  it('formats local time and remaining days', () => {
    const local = new Date(2026, 9, 23, 14, 5, 0)
    expect(formatTrashTime(local.toISOString())).toBe('2026-10-23 14:05')
    expect(formatTrashTime('not-a-time')).toBe('时间未知')
    expect(trashRemainingDays(new Date(NOW + 12 * DAY).toISOString(), NOW)).toBe(12)
    expect(trashRemainingDays(new Date(NOW + 1).toISOString(), NOW)).toBe(1)
    expect(trashRemainingDays(new Date(NOW - DAY).toISOString(), NOW)).toBe(0)
    expect(trashRemainingDays('bad', NOW)).toBe(0)
  })

  it('keeps machine error codes out of human messages', () => {
    expect(trashErrorText('TRASH_ENTRY_MISSING')).toContain('这条记录已不在已删除里')
    expect(trashErrorText(Error('PATH_RESERVED'))).toContain('原路径已被保留占用')
    expect(trashErrorText('TRASH_PARTIAL')).toContain('只完成了一部分')
    expect(trashErrorText('TRASH_CONFLICT')).toContain('都被占用')
    expect(trashErrorText('SOMETHING_ELSE')).not.toContain('SOMETHING_ELSE')
  })
})
