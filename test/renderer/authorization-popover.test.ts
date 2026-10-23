// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { openAuthorizationPopover, resetScopeMemory, type AuthorizationPopover } from '../../src/renderer/src/authorization-popover.ts'
import { SKILL_REASON_TEXT } from '../../src/shared/skills.ts'
import type { AgentAuthorizationPreview, AgentPermissionLevel, TreeEntry } from '../../src/shared/ipc.ts'
beforeEach(()=>{
  resetScopeMemory()
  // jsdom 没实现 dialog 的 show/showModal；卡片现在走非模态 show()。
  Object.defineProperty(HTMLDialogElement.prototype,'show',{configurable:true,value:function(){this.setAttribute('open','')}})
  Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(){this.setAttribute('open','')}})
  Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(){this.removeAttribute('open');this.dispatchEvent(new Event('close'))}})
})
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks()})

/** 预览与宿主同源：档位决定写工具，来源决定读搜与结构。 */
const basePreview = (level: AgentPermissionLevel, overrides: Partial<AgentAuthorizationPreview> = {}): AgentAuthorizationPreview => ({
  id: 'p', sessionId: 's', origin: 'a.md',
  sources: [{ sourceId: 'a', relPath: 'a.md', title: 'a', revision: 'r', objectVersion: 'o', sessionId: 's', fingerprint: 'x', tier: 'reference' }],
  recipient: { modelId: 'model', host: 'model.example', provider: 'custom' },
  level,
  write: level === 'write' || level === 'auto',
  autoApproveWrites: level === 'auto',
  ...overrides
})
const source = (relPath: string, tier: 'reference' | 'follow' = 'reference') => ({
  sourceId: relPath, relPath, title: relPath, revision: 'r', objectVersion: 'o', sessionId: 's', fingerprint: `f-${relPath}`, tier
})
type Options = Parameters<typeof openAuthorizationPopover>[0]
const openWith = (overrides: Partial<Options> = {}): AuthorizationPopover => openAuthorizationPopover({
  anchor: { left: 100, top: 100, bottom: 120 },
  origin: 'a.md',
  entries: [],
  initialLevel: 'read',
  preview: vi.fn(async (_references: string[], level: AgentPermissionLevel) => ({ ok: true as const, preview: basePreview(level) })),
  send: vi.fn(async () => ({ ok: true as const, id: 'task' })),
  ...overrides
})
const sendButton = (popup: AuthorizationPopover): HTMLButtonElement => popup.root.querySelector<HTMLButtonElement>('.authorization-send')!
const radio = (popup: AuthorizationPopover, level: AgentPermissionLevel): HTMLButtonElement => popup.root.querySelector<HTMLButtonElement>(`.authorization-level[data-level="${level}"]`)!
const ready = async (popup: AuthorizationPopover): Promise<void> => { await vi.waitFor(() => expect(sendButton(popup).disabled).toBe(false)) }
const statusOf = (popup: AuthorizationPopover): string => popup.root.querySelector('.authorization-status')!.textContent!

it('does not send before preview, preserves prompt on dismissal, and discloses recipient', async () => {
  let resolve!: (v: any) => void
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const closed = vi.fn()
  openWith({ preview: () => new Promise(r => { resolve = r }), send, onClose: closed })
  const dialog = document.querySelector<HTMLDialogElement>('.overlay-authorization')!
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(send).not.toHaveBeenCalled()
  resolve({ ok: true, preview: basePreview('read') })
  await vi.waitFor(() => expect(dialog.textContent).toContain('model.example'))
  // 非模态卡片不抢焦点；Esc 只在焦点已经进入卡片时由 overlay 接管。
  dialog.focus()
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  expect(send).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalled()
})

it('opens at the initial level and previews read with empty references and no write tools', async () => {
  const preview = vi.fn(async (_references: string[], level: AgentPermissionLevel) => ({ ok: true as const, preview: basePreview(level) }))
  const popup = openWith({ initialLevel: 'read', preview })
  await ready(popup)
  expect(preview).toHaveBeenLastCalledWith([], 'read')
  expect(radio(popup, 'read').getAttribute('aria-checked')).toBe('true')
  expect(radio(popup, 'reference').getAttribute('aria-checked')).toBe('false')
  expect(popup.root.querySelector('.authorization-level-hint')!.textContent).toBe('只读发起篇，不提供写工具。')
  expect(popup.root.querySelector('.authorization-scope-text')!.textContent).toBe('范围：仅本篇')
  expect(statusOf(popup)).toContain('工具：无')
  expect(statusOf(popup)).not.toContain('补发起篇')
  expect(statusOf(popup)).not.toContain('建笔记')
  popup.close()
})

it('switches levels, re-previews each time, defaults to the visible parent directory, and read clears references', async () => {
  const entries: TreeEntry[] = [
    { name: 'folder', relPath: 'folder', kind: 'dir', children: [
      { name: 'origin.md', relPath: 'folder/origin.md', kind: 'note' },
      { name: 'peer.md', relPath: 'folder/peer.md', kind: 'note' }
    ] }
  ]
  const preview = vi.fn(async (references: string[], level: AgentPermissionLevel) => ({
    ok: true as const,
    preview: basePreview(level, { origin: 'folder/origin.md', sources: [source('folder/origin.md'), ...(references.length ? [source('folder/peer.md')] : [])] })
  }))
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const popup = openWith({ origin: 'folder/origin.md', entries, preview, send })
  await ready(popup)
  expect(preview).toHaveBeenLastCalledWith([], 'read')

  radio(popup, 'reference').click()
  await vi.waitFor(() => expect(preview).toHaveBeenLastCalledWith(['folder'], 'reference'))
  expect(popup.root.querySelector('.authorization-level-hint')!.textContent).toBe('可参考本目录笔记，不提供写工具。')
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder"]')!.checked).toBe(true)
  expect(statusOf(popup)).toContain('读库')
  expect(statusOf(popup)).toContain('搜库')
  expect(statusOf(popup)).not.toContain('补发起篇')

  radio(popup, 'write').click()
  await vi.waitFor(() => expect(preview).toHaveBeenLastCalledWith(['folder'], 'write'))
  expect(popup.root.querySelector('.authorization-level-hint')!.textContent).toBe('可补写、建、改名、挪；每次写操作仍逐次确认。')
  expect(statusOf(popup)).toContain('补发起篇')
  expect(statusOf(popup)).toContain('建笔记')
  expect(statusOf(popup)).toContain('改名')
  expect(statusOf(popup)).toContain('挪')

  radio(popup, 'auto').click()
  await vi.waitFor(() => expect(preview).toHaveBeenLastCalledWith(['folder'], 'auto'))
  expect(popup.root.querySelector('.authorization-level-hint')!.textContent).toBe('自动批准新建；改名、挪、删除仍逐次确认。')

  // 只读档必须清空范围，发送时也不能把旧 references 带上。
  radio(popup, 'read').click()
  await vi.waitFor(() => expect(preview).toHaveBeenLastCalledWith([], 'read'))
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder"]')!.checked).toBe(false)
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder"]')!.disabled).toBe(true)
  await ready(popup)
  sendButton(popup).click()
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }), 'read'))
  popup.close()
})

it('sends the current level; read sends with the level that was previewed', async () => {
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const popup = openWith({ send })
  await ready(popup)
  radio(popup, 'write').click()
  await ready(popup)
  sendButton(popup).click()
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }), 'write')
  popup.close()
})

it('refreshes failed stale confirmation and requires a fresh Enter; IME Enter never sends', async () => {
  const send = vi.fn().mockResolvedValueOnce({ ok: false, error: 'STALE_AUTHORIZATION' }).mockResolvedValueOnce({ ok: true, id: 'task' })
  const load = vi.fn(async (_references: string[], level: AgentPermissionLevel) => ({ ok: true as const, preview: basePreview(level) }))
  const popup = openWith({ preview: load, send })
  await ready(popup)
  popup.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
  expect(send).not.toHaveBeenCalled()
  popup.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  expect(send).toHaveBeenCalledTimes(1)
  await ready(popup)
  popup.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  popup.close()
})

it('Enter on cancel never sends; closed late preview is discarded', async () => {
  let resolve!: (v: any) => void
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const discard = vi.fn(async () => {})
  const popup = openWith({ preview: () => new Promise(r => { resolve = r }), send, discard })
  const cancel = popup.root.querySelector<HTMLButtonElement>('.authorization-cancel')!
  cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  resolve({ ok: true, preview: basePreview('read') })
  await vi.waitFor(() => expect(discard).toHaveBeenCalledWith('p'))
  expect(send).not.toHaveBeenCalled()
})

it('does not steal editor focus on open or on preview, and Enter in the card sends', async () => {
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const editor = document.createElement('textarea')
  document.body.append(editor); editor.focus()
  let finish!: (v: any) => void
  const popup = openWith({ preview: () => new Promise(resolve => { finish = resolve }), send })
  await Promise.resolve()
  expect(document.activeElement).toBe(editor)
  finish({ ok: true, preview: basePreview('read') })
  await ready(popup)
  expect(document.activeElement).toBe(editor)
  popup.root.focus()
  popup.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

  const second = openWith({ preview: () => new Promise(resolve => { finish = resolve }), send })
  await Promise.resolve()
  const cancel = second.root.querySelector<HTMLButtonElement>('.authorization-cancel')!
  cancel.focus(); finish({ ok: true, preview: basePreview('read') })
  await ready(second)
  expect(document.activeElement).toBe(cancel)
  cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(send).toHaveBeenCalledTimes(1)
  popup.close(); second.close()
})

it('translates a machine failure code instead of showing it raw', async () => {
  const popup = openWith({ preview: async () => ({ ok: false as const, error: 'STALE_AUTHORIZATION' }) })
  const status = popup.root.querySelector('.authorization-status')!
  await vi.waitFor(() => expect(status.textContent).toContain('无法准备'))
  expect(status.textContent).toBe('无法准备。内容已改，重新核对。')
  expect(status.textContent).not.toContain('STALE_AUTHORIZATION')
  expect(sendButton(popup).disabled).toBe(true)
  popup.close()
})

it('opens as a non-modal card without focusing or scrolling anything', async () => {
  const editor = document.createElement('textarea')
  document.body.append(editor); editor.focus()
  const focus = vi.spyOn(HTMLElement.prototype, 'focus')
  const popup = openWith()
  expect(popup.root.dataset.modal).toBe('false')
  await vi.waitFor(() => expect(document.activeElement).toBe(editor))
  await ready(popup)
  expect(document.activeElement).toBe(editor)
  expect(focus).not.toHaveBeenCalled()
  focus.mockRestore()
  popup.close()
})

it('leaves Escape to the editor until focus enters the card', async () => {
  const editor = document.createElement('textarea')
  document.body.append(editor); editor.focus()
  const closed = vi.fn()
  const popup = openWith({ onClose: closed })
  await ready(popup)
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  expect(popup.isOpen()).toBe(true)
  popup.root.focus()
  popup.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  expect(popup.isOpen()).toBe(false)
  expect(closed).toHaveBeenCalled()
})

it('summarizes the scope from the preview and toggles the adjustment area', async () => {
  const entries: TreeEntry[] = [
    { name: 'folder', relPath: 'folder', kind: 'dir', children: [
      { name: 'origin.md', relPath: 'folder/origin.md', kind: 'note' },
      { name: 'peer.md', relPath: 'folder/peer.md', kind: 'note' }
    ] }
  ]
  const preview = vi.fn(async (references: string[], level: AgentPermissionLevel) => ({
    ok: true as const,
    preview: basePreview(level, {
      origin: 'folder/origin.md',
      sources: references.length
        ? [source('folder/origin.md'), source('folder/peer.md'), source('folder/deep.md')]
        : [source('folder/origin.md')]
    })
  }))
  const popup = openWith({ origin: 'folder/origin.md', entries, preview })
  await ready(popup)
  const detail = popup.root.querySelector<HTMLElement>('.authorization-scope-detail')!
  const toggle = popup.root.querySelector<HTMLButtonElement>('.authorization-scope-toggle')!
  expect(detail.hidden).toBe(true)
  expect(toggle.textContent).toBe('调整')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(popup.root.querySelector('.authorization-scope-text')!.textContent).toBe('范围：仅本篇')

  toggle.click()
  expect(detail.hidden).toBe(false)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  // 预设与范围树都在展开区里，且默认收起时不可见。
  expect(detail.querySelector('.authorization-presets')).not.toBeNull()
  expect(detail.querySelector('.authorization-choices')).not.toBeNull()

  radio(popup, 'reference').click()
  await vi.waitFor(() => expect(popup.root.querySelector('.authorization-scope-text')!.textContent).toBe('范围：本篇 + 2 篇参考'))
  expect(popup.root.querySelector('.authorization-scope-text')!.textContent).toBe('范围：本篇 + 2 篇参考')

  popup.root.querySelector<HTMLButtonElement>('.authorization-preset-origin')!.click()
  await vi.waitFor(() => expect(preview).toHaveBeenLastCalledWith([], 'reference'))
  expect(popup.root.querySelector('.authorization-scope-text')!.textContent).toBe('范围：仅本篇')
  popup.close()
})

it('computes tool summaries from the level, sources, and delete availability', async () => {
  const cases: { level: AgentPermissionLevel; sources: ReturnType<typeof source>[]; deleteEnabled?: boolean; has: string[]; lacks: string[] }[] = [
    { level: 'read', sources: [source('a.md')], has: ['工具：无'], lacks: ['补发起篇', '读库', '改名'] },
    { level: 'reference', sources: [source('a.md'), source('follow.md', 'follow')], has: ['读库', '搜库'], lacks: ['补发起篇', '建笔记', '改名'] },
    { level: 'write', sources: [source('a.md'), source('b.md')], has: ['补发起篇', '建笔记', '读库', '改名', '挪'], lacks: ['删笔记'] },
    { level: 'auto', sources: [source('a.md'), source('b.md')], deleteEnabled: true, has: ['补发起篇', '建笔记', '删笔记'], lacks: [] }
  ]
  for (const item of cases) {
    const popup = openWith({
      initialLevel: item.level,
      preview: async (_references: string[], level: AgentPermissionLevel) => ({
        ok: true as const,
        preview: basePreview(level, { sources: item.sources, ...(item.deleteEnabled ? { deleteEnabled: true } : {}) })
      })
    })
    await ready(popup)
    const status = statusOf(popup)
    for (const text of item.has) expect(status).toContain(text)
    for (const text of item.lacks) expect(status).not.toContain(text)
    popup.close()
  }
})

it('has no network or MCP controls or copy on the card', async () => {
  const popup = openWith({ initialLevel: 'write' })
  await ready(popup)
  expect(popup.root.querySelector('.authorization-network')).toBeNull()
  expect(popup.root.querySelector('.authorization-mcp')).toBeNull()
  const text = popup.root.textContent!
  expect(text).not.toContain('联网')
  expect(text).not.toContain('MCP')
  expect(text).not.toContain('抓网页')
  expect(text).not.toContain('搜索服务')
  popup.close()
})

it('lists skill names only, and explains what was enabled but not loaded', async () => {
  const withSkills = basePreview('read', {
    skills: [{ id: 'answer-grade', name: '答案批改' }],
    skillsUnavailable: [{ name: '过期规则', reason: 'set-too-large' as const }]
  })
  const popup = openWith({ preview: async () => ({ ok: true as const, preview: withSkills }) })
  await ready(popup)
  const line = popup.root.querySelector<HTMLElement>('.authorization-skills')!
  expect(line.hidden).toBe(false)
  const text = line.textContent!
  expect(text).toContain('本场技能：答案批改')
  expect(text).toContain('已启用但未加载：过期规则')
  expect(text).toContain('原因见设置页「技能」')
  // 合同取舍：原因文本、正文、体量都不在这张卡上。
  expect(text).not.toContain('正文合计超过')
  expect(text).not.toContain(SKILL_REASON_TEXT['set-too-large'])
  expect(line.querySelector('details')).toBeNull()
  expect(line.querySelector('button')).toBeNull()
  popup.close()
})

it('shows memory and skill lines only when the preview carries them', async () => {
  const bare = openWith()
  await ready(bare)
  expect(bare.root.querySelector<HTMLElement>('.authorization-memory')!.hidden).toBe(true)
  expect(bare.root.querySelector<HTMLElement>('.authorization-skills')!.hidden).toBe(true)
  bare.close()

  const withMemory = basePreview('reference', {
    memory: {
      use: true,
      consolidate: true,
      recipient: { modelId: 'summarizer', host: 'memory.example' },
      limits: { seconds: 600, calls: 4, tools: 0 },
      search: { available: true, calls: 2, sharedTools: 6 }
    }
  })
  const popup = openWith({ preview: async () => ({ ok: true as const, preview: withMemory }) })
  await ready(popup)
  const memory = popup.root.querySelector<HTMLElement>('.authorization-memory')!
  expect(memory.hidden).toBe(false)
  expect(memory.textContent).toContain('本场使用独立记忆')
  expect(memory.textContent).toContain('summarizer · memory.example')
  // 一行说完，不再把上限／检索额度铺开。
  expect(memory.textContent).not.toContain('上限')
  expect(memory.textContent).not.toContain('检索')
  popup.close()
})

it('omits attachment roots and their full subtree from scope choices', async () => {
  const popup = openWith({
    entries: [
      { name: 'ordinary', relPath: 'ordinary', kind: 'dir', children: [{ name: 'b.md', relPath: 'ordinary/b.md', kind: 'note' }] },
      { name: 'Note', relPath: 'Note', kind: 'dir', attachmentOf: 'note.md', children: [
        { name: 'sub', relPath: 'Note/sub', kind: 'dir', children: [{ name: 'nested.md', relPath: 'Note/sub/nested.md', kind: 'note' }] }
      ] }
    ]
  })
  expect([...popup.root.querySelectorAll<HTMLInputElement>('.authorization-choices input')].map(input => input.value)).toEqual(['ordinary', 'ordinary/b.md'])
  popup.close()
})

it('does not confirm from a standalone keyCode 229 even when isComposing is false', async () => {
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const popup = openWith({ send })
  await ready(popup)
  popup.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
  expect(send).not.toHaveBeenCalled()
  expect(popup.isOpen()).toBe(true)
  popup.close()
})

it('lets follow notes be referenced and says they cannot be renamed or moved', async () => {
  const popup = openWith({
    initialLevel: 'reference',
    entries: [
      { name: 'b.md', relPath: 'b.md', kind: 'note' },
      { name: 'follow.md', relPath: 'follow.md', kind: 'note', tier: 'follow' }
    ]
  })
  const inputs = [...popup.root.querySelectorAll<HTMLInputElement>('.authorization-choices input')]
  expect(inputs.map(input => input.value)).toEqual(['b.md', 'follow.md'])
  expect(inputs.every(input => !input.disabled)).toBe(true)
  expect(popup.root.textContent).toContain('必须遵循：可参考，不能改名／挪')
  popup.close()
})

it('offers scope presets that clear to the origin and select the visible parent directory entry', async () => {
  const entries: TreeEntry[] = [
    { name: 'folder', relPath: 'folder', kind: 'dir', children: [
      { name: 'origin.md', relPath: 'folder/origin.md', kind: 'note' },
      { name: 'peer.md', relPath: 'folder/peer.md', kind: 'note' },
      { name: 'forbidden.md', relPath: 'folder/forbidden.md', kind: 'note', tier: 'forbidden' },
      { name: 'attachments', relPath: 'folder/attachments', kind: 'dir', attachmentOf: 'folder/origin.md', children: [
        { name: 'inside.md', relPath: 'folder/attachments/inside.md', kind: 'note' }
      ] }
    ] }
  ]
  const load = vi.fn(async (_references: string[], level: AgentPermissionLevel) => ({ ok: true as const, preview: basePreview(level, { origin: 'folder/origin.md' }) }))
  const popup = openWith({ origin: 'folder/origin.md', entries, preview: load, initialLevel: 'reference' })
  await ready(popup)
  // 参考档首开默认本目录；预设仍可清回仅本篇。
  expect(load).toHaveBeenLastCalledWith(['folder'], 'reference')
  const [onlyOrigin, onlyDirectory] = [...popup.root.querySelectorAll<HTMLButtonElement>('.authorization-presets button')]
  expect(onlyOrigin!.textContent).toBe('只读本笔记')
  expect(onlyDirectory!.textContent).toBe('本目录只读')

  onlyDirectory!.click()
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith(['folder'], 'reference'))
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder/peer.md"]')!.checked).toBe(false)
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder/forbidden.md"]')!.disabled).toBe(true)

  onlyOrigin!.click()
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], 'reference'))
  expect([...popup.root.querySelectorAll<HTMLInputElement>('.authorization-choices input')].some(input => input.checked)).toBe(false)
  popup.close()
})

it('does not offer the directory preset at the vault root', async () => {
  const entries: TreeEntry[] = [
    { name: 'a.md', relPath: 'a.md', kind: 'note' },
    { name: 'b.md', relPath: 'b.md', kind: 'note' },
    { name: 'sub', relPath: 'sub', kind: 'dir', children: [{ name: 'deep.md', relPath: 'sub/deep.md', kind: 'note' }] }
  ]
  const load = vi.fn(async (_references: string[], level: AgentPermissionLevel) => ({ ok: true as const, preview: basePreview(level) }))
  const popup = openWith({ entries, preview: load })
  await ready(popup)
  expect(popup.root.querySelector('.authorization-preset-directory')).toBeNull()
  expect([...popup.root.querySelectorAll<HTMLButtonElement>('.authorization-presets button')].map(button => button.textContent)).toEqual(['只读本笔记'])
  // 库根不默认扩大：切到 reference 后范围仍是空。
  radio(popup, 'reference').click()
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], 'reference'))
  expect(popup.root.querySelector('.authorization-scope-text')!.textContent).toBe('范围：仅本篇')
  popup.close()
})

it('disables the directory preset when the parent directory is not selectable', async () => {
  const invisibleEntries: TreeEntry[] = [
    { name: 'a.md', relPath: 'a.md', kind: 'note' },
    { name: 'b.md', relPath: 'b.md', kind: 'note' }
  ]
  const invisible = openWith({ origin: 'missing/origin.md', entries: invisibleEntries, initialLevel: 'reference' })
  await ready(invisible)
  const invisibleButton = invisible.root.querySelector<HTMLButtonElement>('.authorization-preset-directory')!
  expect(invisibleButton.disabled).toBe(true)
  expect(invisibleButton.title).toContain('不可见')
  invisible.close()

  const forbiddenEntries: TreeEntry[] = [
    { name: 'folder', relPath: 'folder', kind: 'dir', tier: 'forbidden', children: [
      { name: 'origin.md', relPath: 'folder/origin.md', kind: 'note' },
      { name: 'peer.md', relPath: 'folder/peer.md', kind: 'note' }
    ] }
  ]
  const forbiddenLoad = vi.fn(async (_references: string[], level: AgentPermissionLevel) => ({ ok: true as const, preview: basePreview(level) }))
  const forbidden = openWith({ origin: 'folder/origin.md', entries: forbiddenEntries, preview: forbiddenLoad, initialLevel: 'reference' })
  await ready(forbidden)
  const forbiddenButton = forbidden.root.querySelector<HTMLButtonElement>('.authorization-preset-directory')!
  expect(forbiddenButton.disabled).toBe(true)
  expect(forbiddenButton.title).toContain('禁止')
  // 切到非只读档也不会静默降级成子笔记：范围保持空。
  radio(forbidden, 'write').click()
  await vi.waitFor(() => expect(forbiddenLoad).toHaveBeenLastCalledWith([], 'write'))
  expect(forbidden.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder/peer.md"]')!.checked).toBe(false)
  forbidden.close()
})

it('does not send Enter from a textarea in the card', async () => {
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const popup = openWith({ send })
  await ready(popup)
  const area = document.createElement('textarea')
  popup.root.append(area)
  area.focus()
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(send).not.toHaveBeenCalled()
  popup.close()
})

it('keeps focus inside while submitting a selected range and after stale reconfirmation', async () => {
  let finish!: (value: any) => void
  const send = vi.fn(() => new Promise<any>(resolve => { finish = resolve }))
  const popup = openWith({ entries: [{ name: 'b.md', relPath: 'b.md', kind: 'note' }], send })
  await ready(popup)
  const input = popup.root.querySelector<HTMLInputElement>('.authorization-choices input')!
  input.focus()
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(popup.root)
  finish({ ok: false, error: 'STALE_AUTHORIZATION' })
  await vi.waitFor(() => expect(statusOf(popup)).toContain('再次确认'))
  expect(document.activeElement).toBe(sendButton(popup))
  popup.close()
})

it('remembers the last scope within the session and restores it on reopen', async () => {
  const entries: TreeEntry[] = [
    { name: 'a.md', relPath: 'a.md', kind: 'note' },
    { name: 'b.md', relPath: 'b.md', kind: 'note' }
  ]
  const firstLoad = vi.fn(async (_references: string[], level: AgentPermissionLevel) => ({ ok: true as const, preview: basePreview(level) }))
  const first = openWith({ entries, preview: firstLoad, initialLevel: 'reference' })
  await ready(first)
  first.root.querySelector<HTMLButtonElement>('.authorization-preset-origin')!.click()
  await vi.waitFor(() => expect(firstLoad).toHaveBeenLastCalledWith([], 'reference'))
  const choose = first.root.querySelector<HTMLInputElement>('.authorization-choices input[value="b.md"]')!
  choose.checked = true
  choose.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(firstLoad).toHaveBeenLastCalledWith(['b.md'], 'reference'))
  first.close()

  const secondLoad = vi.fn(async (_references: string[], level: AgentPermissionLevel) => ({ ok: true as const, preview: basePreview(level) }))
  const second = openWith({ entries, preview: secondLoad, initialLevel: 'write' })
  expect(second.root.querySelector<HTMLInputElement>('.authorization-choices input[value="b.md"]')!.checked).toBe(true)
  await vi.waitFor(() => expect(secondLoad).toHaveBeenLastCalledWith(['b.md'], 'write'))
  second.close()
})

it('exposes setStale to block sending until a fresh preview succeeds', async () => {
  const load = vi.fn(async (_references: string[], level: AgentPermissionLevel) => ({ ok: true as const, preview: basePreview(level) }))
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const popup = openWith({ entries: [{ name: 'b.md', relPath: 'b.md', kind: 'note' }], preview: load, send })
  await ready(popup)
  const status = popup.root.querySelector('.authorization-status')!
  popup.setStale()
  expect(status.textContent).toBe('内容已改，重新核对。')
  expect(sendButton(popup).disabled).toBe(true)
  expect(send).not.toHaveBeenCalled()

  const choose = popup.root.querySelector<HTMLInputElement>('.authorization-choices input[value="b.md"]')!
  choose.checked = true
  choose.dispatchEvent(new Event('change'))
  await ready(popup)
  expect(status.textContent).not.toContain('内容已改，重新核对。')
  expect(load).toHaveBeenCalledTimes(2)
  popup.close()
})

it('keeps each notice first sentence short and machine codes off the card', async () => {
  const expanded = basePreview('auto', {
    memory: {
      use: true,
      consolidate: true,
      recipient: { modelId: 'summarizer', host: 'memory.example' },
      limits: { seconds: 600, calls: 4, tools: 0 },
      search: { available: true, calls: 2, sharedTools: 6 }
    },
    skills: [{ id: 'answer-grade', name: '答案批改' }]
  })
  const popup = openWith({ preview: async () => ({ ok: true as const, preview: expanded }), initialLevel: 'auto' })
  await ready(popup)
  const firstLine = (element: Element): string => element.textContent!.split('。')[0]!
  const characters = (text: string): number => [...text.replace(/\s/g, '')].length
  for (const selector of ['.authorization-disclosure', '.authorization-memory', '.authorization-skills', '.authorization-scope-hint', '.authorization-status', '.authorization-level-hint']) {
    const element = popup.root.querySelector(selector)!
    expect(element.textContent!.length).toBeGreaterThan(0)
    expect(characters(firstLine(element))).toBeLessThanOrEqual(40)
  }
  expect(popup.root.textContent).not.toMatch(/[A-Z]{2,}_[A-Z_]{2,}/)
  popup.close()
})
