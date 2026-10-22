// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { openAuthorizationPopover } from '../../src/renderer/src/authorization-popover.ts'
import { SKILL_REASON_TEXT } from '../../src/shared/skills.ts'
beforeEach(()=>{
  // jsdom 没实现 dialog 的 show/showModal；卡片现在走非模态 show()。
  Object.defineProperty(HTMLDialogElement.prototype,'show',{configurable:true,value:function(){this.setAttribute('open','')}})
  Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(){this.setAttribute('open','')}})
  Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(){this.removeAttribute('open');this.dispatchEvent(new Event('close'))}})
})
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks()})
const preview={id:'p',sessionId:'s',origin:'a.md',sources:[{sourceId:'a',relPath:'a.md',title:'a',revision:'r',objectVersion:'o',sessionId:'s',fingerprint:'x',tier:'reference' as const}],recipient:{modelId:'model',host:'model.example',provider:'custom' as const}}
it('does not send before preview, preserves prompt on dismissal, and discloses recipient',async()=>{
  let resolve!: (v:any)=>void;const send=vi.fn(async()=>({ok:true as const,id:'task'}));const closed=vi.fn()
  openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:()=>new Promise(r=>{resolve=r}),send,onClose:closed})
  const dialog=document.querySelector<HTMLDialogElement>('.overlay-authorization')!
  dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
  expect(send).not.toHaveBeenCalled()
  resolve({ok:true,preview});await vi.waitFor(()=>expect(dialog.textContent).toContain('model.example'))
  // 非模态卡片不抢焦点；Esc 只在焦点已经进入卡片时由 overlay 接管。
  dialog.focus()
  dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
  expect(send).not.toHaveBeenCalled();expect(closed).toHaveBeenCalled()
})
it('refreshes failed stale confirmation and requires a fresh Enter; IME Enter never sends',async()=>{
  const send=vi.fn().mockResolvedValueOnce({ok:false,error:'STALE_AUTHORIZATION'}).mockResolvedValueOnce({ok:true,id:'task'})
  const load=vi.fn(async()=>({ok:true as const,preview}))
  openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:load,send})
  const dialog=document.querySelector<HTMLDialogElement>('.overlay-authorization')!
  await vi.waitFor(()=>expect(dialog.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));expect(send).not.toHaveBeenCalled()
  dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
  await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(2));expect(send).toHaveBeenCalledTimes(1)
  await vi.waitFor(()=>expect(dialog.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
  await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(2))
})
it('Enter on cancel never sends; closed late preview is discarded',async()=>{
  let resolve!: (v:any)=>void;const send=vi.fn(async()=>({ok:true as const,id:'task'}));const discard=vi.fn(async()=>{})
  const popover=openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:()=>new Promise(r=>resolve=r),send,discard})
  const cancel=popover.root.querySelector<HTMLButtonElement>('.authorization-cancel')!
  cancel.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
  resolve({ok:true,preview});await vi.waitFor(()=>expect(discard).toHaveBeenCalledWith('p'))
  expect(send).not.toHaveBeenCalled()
})
it('does not steal editor focus on open or on preview, and Enter in the card sends',async()=>{
  const send=vi.fn(async()=>({ok:true as const,id:'task'}))
  const editor=document.createElement('textarea');document.body.append(editor);editor.focus()
  let finish!: (v:any)=>void
  const popup=openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:()=>new Promise(resolve=>finish=resolve),send})
  await Promise.resolve()
  expect(document.activeElement).toBe(editor)
  finish({ok:true,preview})
  await vi.waitFor(()=>expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  expect(document.activeElement).toBe(editor)
  popup.root.focus()
  popup.root.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
  await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(1))

  const second=openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:()=>new Promise(resolve=>finish=resolve),send})
  await Promise.resolve()
  const cancel=second.root.querySelector<HTMLButtonElement>('.authorization-cancel')!
  cancel.focus();finish({ok:true,preview})
  await vi.waitFor(()=>expect(second.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  expect(document.activeElement).toBe(cancel)
  cancel.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
  expect(send).toHaveBeenCalledTimes(1)
})

it('translates a machine failure code instead of showing it raw',async()=>{
  const popup=openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],
    preview:async()=>({ok:false as const,error:'STALE_AUTHORIZATION'}),send:async()=>({ok:true as const,id:'task'})})
  const status=popup.root.querySelector('.authorization-status')!
  await vi.waitFor(()=>expect(status.textContent).toContain('无法准备'))
  expect(status.textContent).toBe('无法准备。内容已改，重新核对。')
  expect(status.textContent).not.toContain('STALE_AUTHORIZATION')
  // 预览已经失效：发送必须保持禁用，不能拿旧范围继续。
  expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(true)
  popup.close()
})

it('opens as a non-modal card without focusing or scrolling anything', async()=>{
  const editor=document.createElement('textarea');document.body.append(editor);editor.focus()
  const focus=vi.spyOn(HTMLElement.prototype,'focus')
  const popup=openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:async()=>({ok:true as const,preview}),send:async()=>({ok:true as const,id:'task'})})
  expect(popup.root.dataset.modal).toBe('false')
  await vi.waitFor(()=>expect(document.activeElement).toBe(editor))
  await vi.waitFor(()=>expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  expect(document.activeElement).toBe(editor)
  expect(focus).not.toHaveBeenCalled()
  focus.mockRestore()
  popup.close()
})

it('leaves Escape to the editor until focus enters the card',async()=>{
  const editor=document.createElement('textarea');document.body.append(editor);editor.focus()
  const closed=vi.fn()
  const popup=openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:async()=>({ok:true as const,preview}),send:async()=>({ok:true as const,id:'task'}),onClose:closed})
  await vi.waitFor(()=>expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
  expect(popup.isOpen()).toBe(true)
  popup.root.focus()
  popup.root.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
  expect(popup.isOpen()).toBe(false)
  expect(closed).toHaveBeenCalled()
})

it('keeps focus inside while submitting a selected range and after stale reconfirmation',async()=>{
  let finish!: (value:any)=>void
  const send=vi.fn(()=>new Promise<any>(resolve=>finish=resolve))
  const popup=openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[{kind:'note',relPath:'b.md',name:'b'}],preview:async()=>({ok:true as const,preview}),send})
  await vi.waitFor(()=>expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  const input=popup.root.querySelector<HTMLInputElement>('.authorization-choices input')!
  input.focus()
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
  expect(document.activeElement).toBe(popup.root)
  finish({ok:false,error:'STALE_AUTHORIZATION'})
  await vi.waitFor(()=>expect(popup.root.querySelector('.authorization-status')!.textContent).toContain('再次确认'))
  expect(document.activeElement).toBe(popup.root.querySelector('.authorization-send'))
  popup.close()
})


it('omits attachment roots and their full subtree from scope choices', async () => {
  const popup = openAuthorizationPopover({ anchor: { left: 100, top: 100, bottom: 120 }, origin: 'a.md', entries: [
    { name: 'ordinary', relPath: 'ordinary', kind: 'dir', children: [{ name: 'b.md', relPath: 'ordinary/b.md', kind: 'note' }] },
    { name: 'Note', relPath: 'Note', kind: 'dir', attachmentOf: 'note.md', children: [
      { name: 'sub', relPath: 'Note/sub', kind: 'dir', children: [{ name: 'nested.md', relPath: 'Note/sub/nested.md', kind: 'note' }] }
    ] }
  ], preview: async () => ({ ok: true as const, preview }), send: async () => ({ ok: true as const, id: 'task' }) })
  expect([...popup.root.querySelectorAll<HTMLInputElement>('.authorization-choices input')].map(input => input.value)).toEqual(['ordinary', 'ordinary/b.md'])
  popup.close()
})

it('does not confirm from a standalone keyCode 229 even when isComposing is false', async () => {
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const popup = openAuthorizationPopover({ anchor: { left: 100, top: 100, bottom: 120 }, origin: 'a.md', entries: [], preview: async () => ({ ok: true as const, preview }), send })
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  popup.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
  expect(send).not.toHaveBeenCalled()
  expect(popup.isOpen()).toBe(true)
  popup.close()
})

it('lists skill names only, and explains what was enabled but not loaded', async () => {
  const withSkills={...preview,skills:[{id:'answer-grade',name:'答案批改'}],skillsUnavailable:[{name:'过期规则',reason:'set-too-large' as const}]}
  openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:async()=>({ok:true as const,preview:withSkills}),send:async()=>({ok:true as const,id:'task'})})
  const dialog=document.querySelector<HTMLDialogElement>('.overlay-authorization')!
  await vi.waitFor(()=>expect(dialog.querySelector('.authorization-skills')?.textContent).toContain('答案批改'))
  const text=dialog.querySelector('.authorization-skills')!.textContent!
  expect(text).toContain('本场技能：答案批改')
  expect(text).toContain('已启用但未加载：过期规则')
  expect(text).toContain('原因见设置页「技能」')
  expect(text).toContain('账本记有名称与内容哈希')
  // 合同取舍：原因文本、正文、体量都不在这张卡上。
  expect(text).not.toContain('正文合计超过')
  expect(text).not.toContain(SKILL_REASON_TEXT['set-too-large'])
  // 只有名称与原因：卡片里没有正文，也没有可展开的控件。
  expect(text).not.toContain('先核对题号')
  expect(dialog.querySelector('.authorization-skills details')).toBeNull()
  expect(dialog.querySelector('.authorization-skills button')).toBeNull()
})

it('says no skills when the session has none', async () => {
  openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:async()=>({ok:true as const,preview}),send:async()=>({ok:true as const,id:'task'})})
  const dialog=document.querySelector<HTMLDialogElement>('.overlay-authorization')!
  await vi.waitFor(()=>expect(dialog.querySelector('.authorization-skills')?.textContent).toBe('本场无技能。'))
})

it('lets follow notes be referenced and says they cannot be renamed or moved', async () => {
  const popup = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'a.md',
    entries: [
      { name: 'b.md', relPath: 'b.md', kind: 'note' },
      { name: 'follow.md', relPath: 'follow.md', kind: 'note', tier: 'follow' }
    ],
    preview: async () => ({ ok: true as const, preview }),
    send: async () => ({ ok: true as const, id: 'task' })
  })
  const inputs = [...popup.root.querySelectorAll<HTMLInputElement>('.authorization-choices input')]
  expect(inputs.map(input => input.value)).toEqual(['b.md', 'follow.md'])
  expect(inputs.every(input => !input.disabled)).toBe(true)
  expect(popup.root.textContent).toContain('必须遵循：可参考，不能改名／挪')
  popup.close()
})

it('origin-only preview lists append and create, not read search or struct', async () => {
  const popup = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'a.md',
    entries: [],
    preview: async () => ({ ok: true as const, preview }),
    send: async () => ({ ok: true as const, id: 'task' })
  })
  await vi.waitFor(() => expect(popup.root.querySelector('.authorization-status')!.textContent).toContain('补发起篇'))
  const status = popup.root.querySelector('.authorization-status')!.textContent!
  expect(status).toContain('建笔记')
  expect(status).not.toContain('读库')
  expect(status).not.toContain('改名')
  popup.close()
})

it('extra reference preview lists read search and struct; follow-only extras omit struct', async () => {
  const withReference = {
    ...preview,
    sources: [
      ...preview.sources,
      { sourceId: 'b', relPath: 'b.md', title: 'b', revision: 'r', objectVersion: 'o', sessionId: 's', fingerprint: 'y', tier: 'reference' as const }
    ]
  }
  const withFollow = {
    ...preview,
    sources: [
      ...preview.sources,
      { sourceId: 'f', relPath: 'follow.md', title: 'f', revision: 'r', objectVersion: 'o', sessionId: 's', fingerprint: 'z', tier: 'follow' as const }
    ]
  }
  const first = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'a.md',
    entries: [],
    preview: async () => ({ ok: true as const, preview: withReference }),
    send: async () => ({ ok: true as const, id: 'task' })
  })
  await vi.waitFor(() => expect(first.root.querySelector('.authorization-status')!.textContent).toContain('读库'))
  expect(first.root.querySelector('.authorization-status')!.textContent).toContain('改名')
  first.close()
  const second = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'a.md',
    entries: [],
    preview: async () => ({ ok: true as const, preview: withFollow }),
    send: async () => ({ ok: true as const, id: 'task' })
  })
  await vi.waitFor(() => expect(second.root.querySelector('.authorization-status')!.textContent).toContain('读库'))
  expect(second.root.querySelector('.authorization-status')!.textContent).toContain('搜库')
  expect(second.root.querySelector('.authorization-status')!.textContent).not.toContain('改名')
  second.close()
})

it('offers the network checkbox unchecked by default and says fetch plus search when both work', async () => {
  const withNetwork = { ...preview, network: { available: true, search: true, providerHost: 'api.tavily.com' } }
  const load = vi.fn(async (_references: string[], _network: boolean) => ({ ok: true as const, preview: withNetwork }))
  const send = vi.fn(async (_preview: import('../../src/shared/ipc.ts').AgentAuthorizationPreview, _network: boolean) => ({ ok: true as const, id: 'task' }))
  const popup = openAuthorizationPopover({ anchor: { left: 100, top: 100, bottom: 120 }, origin: 'a.md', entries: [], preview: load, send })
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  const disclosure = popup.root.querySelector('.authorization-network')!
  expect(disclosure.textContent).toContain('抓网页＋搜索')
  expect(disclosure.textContent).toContain('api.tavily.com')
  const input = popup.root.querySelector<HTMLInputElement>('.authorization-network input')!
  expect(input.checked).toBe(false)
  expect(load).toHaveBeenLastCalledWith([], false, false)
  input.checked = true
  input.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], true, false))
  await vi.waitFor(() => expect(popup.root.querySelector('.authorization-status')!.textContent).toContain('联网只读（抓网页＋搜索）'))
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.click()
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  expect(send).toHaveBeenCalledWith(expect.anything(), true, false)
  popup.close()
})

it('keeps fetch available when only search is unconfigured, and offers no checkbox when network is off', async () => {
  const unconfigured = { ...preview, network: { available: true, search: false, providerHost: null, reason: 'not-configured' as const } }
  const load = vi.fn(async (_references: string[], _network: boolean) => ({ ok: true as const, preview: unconfigured }))
  const popup = openAuthorizationPopover({ anchor: { left: 100, top: 100, bottom: 120 }, origin: 'a.md', entries: [], preview: load, send: async () => ({ ok: true as const, id: 'task' }) })
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  const disclosure = popup.root.querySelector('.authorization-network')!
  // 抓页仍可勾选；文案只写抓网页，并点明搜索未配置，不能读成「本场也能搜索」。
  const input = popup.root.querySelector<HTMLInputElement>('.authorization-network input')!
  expect(input).not.toBeNull()
  expect(disclosure.textContent).toContain('本场允许联网只读（抓网页）')
  expect(disclosure.textContent).not.toContain('抓网页＋搜索')
  expect(disclosure.textContent).toContain('搜索服务尚未配置')
  input.checked = true
  input.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], true, false))
  await vi.waitFor(() => expect(popup.root.querySelector('.authorization-status')!.textContent).toContain('联网只读（抓网页）'))
  expect(popup.root.querySelector('.authorization-status')!.textContent).not.toContain('抓网页＋搜索')
  popup.close()

  const off = { ...preview, network: { available: false, search: false, providerHost: null, reason: 'off' as const } }
  const second = openAuthorizationPopover({ anchor: { left: 100, top: 100, bottom: 120 }, origin: 'a.md', entries: [], preview: async () => ({ ok: true as const, preview: off }), send: async () => ({ ok: true as const, id: 'task' }) })
  await vi.waitFor(() => expect(second.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  expect(second.root.querySelector('.authorization-network input')).toBeNull()
  expect(second.root.querySelector('.authorization-network')!.textContent).toContain('联网总开关已关闭')
  second.close()
})

const MCP_SERVERS = [{ name: 'deepwiki', host: 'mcp.example', tools: ['search', 'read'] }]
const withBoth = {
  ...preview,
  network: { available: true, search: false, providerHost: null, reason: 'not-configured' as const },
  mcp: { available: true, servers: MCP_SERVERS }
}

it('offers the MCP checkbox unchecked by default, names the servers and tool counts, and sends mcp true', async () => {
  const load = vi.fn(async (_references: string[], _network: boolean, _mcp: boolean) => ({ ok: true as const, preview: withBoth }))
  const send = vi.fn(async (_preview: import('../../src/shared/ipc.ts').AgentAuthorizationPreview, _network: boolean, _mcp: boolean) => ({ ok: true as const, id: 'task' }))
  const popup = openAuthorizationPopover({ anchor: { left: 100, top: 100, bottom: 120 }, origin: 'a.md', entries: [], preview: load, send })
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  const disclosure = popup.root.querySelector('.authorization-mcp')!
  expect(disclosure.textContent).toContain('本场允许只读 MCP（deepwiki：2 个工具）')
  // token、schema 与服务器正文都不在这张卡上。
  expect(disclosure.textContent).not.toContain('mcp.example')
  const input = popup.root.querySelector<HTMLInputElement>('.authorization-mcp input')!
  expect(input.checked).toBe(false)
  expect(load).toHaveBeenLastCalledWith([], false, false)
  input.checked = true
  input.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], false, true))
  await vi.waitFor(() => expect(popup.root.querySelector('.authorization-status')!.textContent).toContain('只读 MCP'))
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.click()
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  expect(send).toHaveBeenCalledWith(expect.anything(), false, true)
  popup.close()
})

it('keeps the network and MCP checkboxes independent', async () => {
  const load = vi.fn(async (_references: string[], _network: boolean, _mcp: boolean) => ({ ok: true as const, preview: withBoth }))
  const send = vi.fn(async (_preview: import('../../src/shared/ipc.ts').AgentAuthorizationPreview, _network: boolean, _mcp: boolean) => ({ ok: true as const, id: 'task' }))
  const popup = openAuthorizationPopover({ anchor: { left: 100, top: 100, bottom: 120 }, origin: 'a.md', entries: [], preview: load, send })
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  // 先勾联网：MCP 仍是未勾。
  popup.root.querySelector<HTMLInputElement>('.authorization-network input')!.click()
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], true, false))
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-mcp input')!.checked).toBe(false)
  // 再勾 MCP：联网保持勾选。
  popup.root.querySelector<HTMLInputElement>('.authorization-mcp input')!.click()
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], true, true))
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-network input')!.checked).toBe(true)
  // 取消联网：MCP 不受影响。
  popup.root.querySelector<HTMLInputElement>('.authorization-network input')!.click()
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], false, true))
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-mcp input')!.checked).toBe(true)
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.click()
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  expect(send).toHaveBeenCalledWith(expect.anything(), false, true)
  popup.close()
})

it('explains why MCP cannot be used and offers no checkbox', async () => {
  const cases = [
    { reason: 'too-many-tools' as const, text: '获准工具清单超过 4 KiB' },
    { reason: 'off' as const, text: 'MCP 服务器都未启用' },
    { reason: 'not-configured' as const, text: '还没有可用的服务器' }
  ]
  for (const item of cases) {
    const popup = openAuthorizationPopover({
      anchor: { left: 100, top: 100, bottom: 120 },
      origin: 'a.md',
      entries: [],
      preview: async () => ({ ok: true as const, preview: { ...preview, mcp: { available: false, servers: [], reason: item.reason } } }),
      send: async () => ({ ok: true as const, id: 'task' })
    })
    await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
    expect(popup.root.querySelector('.authorization-mcp input')).toBeNull()
    expect(popup.root.querySelector('.authorization-mcp')!.textContent).toContain(item.text)
    popup.close()
  }
})

it('offers scope presets that clear to the origin and select the visible parent directory entry', async () => {
  type Entries = import('../../src/shared/ipc.ts').TreeEntry[]
  const entries: Entries = [
    { name: 'folder', relPath: 'folder', kind: 'dir', children: [
      { name: 'origin.md', relPath: 'folder/origin.md', kind: 'note' },
      { name: 'peer.md', relPath: 'folder/peer.md', kind: 'note' },
      { name: 'follow.md', relPath: 'folder/follow.md', kind: 'note', tier: 'follow' },
      { name: 'forbidden.md', relPath: 'folder/forbidden.md', kind: 'note', tier: 'forbidden' },
      { name: 'sub', relPath: 'folder/sub', kind: 'dir', children: [
        { name: 'deep.md', relPath: 'folder/sub/deep.md', kind: 'note' }
      ] },
      { name: 'attachments', relPath: 'folder/attachments', kind: 'dir', attachmentOf: 'folder/origin.md', children: [
        { name: 'inside.md', relPath: 'folder/attachments/inside.md', kind: 'note' }
      ] }
    ] }
  ]
  const load = vi.fn(async (_references: string[]) => ({ ok: true as const, preview }))
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const popup = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'folder/origin.md',
    entries,
    preview: load,
    send
  })
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  // 默认仍是空范围，不因为出现预设而自动勾选。
  expect(load).toHaveBeenLastCalledWith([], false, false)
  const [onlyOrigin, onlyDirectory] = [...popup.root.querySelectorAll<HTMLButtonElement>('.authorization-presets button')]
  expect(onlyOrigin!.textContent).toBe('只读本笔记')
  expect(onlyDirectory!.textContent).toBe('本目录只读')
  expect(onlyDirectory!.disabled).toBe(false)
  // 预设放在范围区，且首开仍是空勾选。
  expect(popup.root.querySelector('.authorization-scope .authorization-presets')).not.toBeNull()
  expect([...popup.root.querySelectorAll<HTMLInputElement>('.authorization-choices input')].some(input => input.checked)).toBe(false)

  onlyDirectory!.click()
  // 与主进程对齐：只勾父目录这一项，由主进程按“目录成员”递归展开；不展开成子笔记列表。
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith(['folder'], false, false))
  const checked = [...popup.root.querySelectorAll<HTMLInputElement>('.authorization-choices input')].filter(input => input.checked).map(input => input.value)
  expect(checked).toEqual(['folder'])
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder/peer.md"]')!.checked).toBe(false)
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder/follow.md"]')!.checked).toBe(false)
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder/forbidden.md"]')!.disabled).toBe(true)
  expect(popup.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder/sub/deep.md"]')!.checked).toBe(false)

  onlyOrigin!.click()
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], false, false))
  expect([...popup.root.querySelectorAll<HTMLInputElement>('.authorization-choices input')].some(input => input.checked)).toBe(false)
  onlyDirectory!.click()
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith(['folder'], false, false))
  // 主进程把 references 绑在这笔 preview 上；send 只带 previewId，所以断言 preview 请求含目录。
  expect(load.mock.calls.at(-1)?.[0]).toEqual(['folder'])
  popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.click()
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  expect(send).toHaveBeenCalledWith(expect.anything(), false, false)
})

it('does not offer the directory preset at the vault root', async () => {
  type Entries = import('../../src/shared/ipc.ts').TreeEntry[]
  const entries: Entries = [
    { name: 'a.md', relPath: 'a.md', kind: 'note' },
    { name: 'b.md', relPath: 'b.md', kind: 'note' },
    { name: 'sub', relPath: 'sub', kind: 'dir', children: [{ name: 'deep.md', relPath: 'sub/deep.md', kind: 'note' }] }
  ]
  const load = vi.fn(async (_references: string[]) => ({ ok: true as const, preview }))
  const popup = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'a.md',
    entries,
    preview: load,
    send: async () => ({ ok: true as const, id: 'task' })
  })
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  expect(load).toHaveBeenLastCalledWith([], false, false)
  // 根目录等于全库：不提供一键扩大范围；只保留“只读本笔记”。
  expect(popup.root.querySelector('.authorization-preset-directory')).toBeNull()
  expect([...popup.root.querySelectorAll<HTMLButtonElement>('.authorization-presets button')].map(button => button.textContent)).toEqual(['只读本笔记'])
  popup.root.querySelector<HTMLButtonElement>('.authorization-preset-origin')!.click()
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], false, false))
  expect([...popup.root.querySelectorAll<HTMLInputElement>('.authorization-choices input')].some(input => input.checked)).toBe(false)
  popup.close()
})

it('disables the directory preset when the parent directory is not selectable', async () => {
  type Entries = import('../../src/shared/ipc.ts').TreeEntry[]
  const invisibleEntries: Entries = [
    { name: 'a.md', relPath: 'a.md', kind: 'note' },
    { name: 'b.md', relPath: 'b.md', kind: 'note' }
  ]
  const invisibleLoad = vi.fn(async (_references: string[]) => ({ ok: true as const, preview }))
  const invisible = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'missing/origin.md',
    entries: invisibleEntries,
    preview: invisibleLoad,
    send: async () => ({ ok: true as const, id: 'task' })
  })
  await vi.waitFor(() => expect(invisible.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  const invisibleButton = invisible.root.querySelector<HTMLButtonElement>('.authorization-preset-directory')!
  expect(invisibleButton.disabled).toBe(true)
  expect(invisibleButton.title).toContain('不可见')
  const invisibleCalls = invisibleLoad.mock.calls.length
  invisibleButton.click()
  await Promise.resolve()
  expect(invisibleLoad).toHaveBeenCalledTimes(invisibleCalls)
  expect([...invisible.root.querySelectorAll<HTMLInputElement>('.authorization-choices input')].some(input => input.checked)).toBe(false)
  invisible.close()

  const forbiddenEntries: Entries = [
    { name: 'folder', relPath: 'folder', kind: 'dir', tier: 'forbidden', children: [
      { name: 'origin.md', relPath: 'folder/origin.md', kind: 'note' },
      { name: 'peer.md', relPath: 'folder/peer.md', kind: 'note' }
    ] }
  ]
  const forbiddenLoad = vi.fn(async (_references: string[]) => ({ ok: true as const, preview }))
  const forbidden = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'folder/origin.md',
    entries: forbiddenEntries,
    preview: forbiddenLoad,
    send: async () => ({ ok: true as const, id: 'task' })
  })
  await vi.waitFor(() => expect(forbidden.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  const forbiddenButton = forbidden.root.querySelector<HTMLButtonElement>('.authorization-preset-directory')!
  expect(forbiddenButton.disabled).toBe(true)
  expect(forbiddenButton.title).toContain('禁止')
  const forbiddenCalls = forbiddenLoad.mock.calls.length
  forbiddenButton.click()
  await Promise.resolve()
  expect(forbiddenLoad).toHaveBeenCalledTimes(forbiddenCalls)
  expect(forbidden.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder"]')!.disabled).toBe(true)
  // 不静默降级成子笔记：peer 仍可手动勾，但预设没有替你勾。
  expect(forbidden.root.querySelector<HTMLInputElement>('.authorization-choices input[value="folder/peer.md"]')!.checked).toBe(false)
  forbidden.close()
})

it('does not send Enter from a textarea in the card', async () => {
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const popup = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'a.md',
    entries: [],
    preview: async () => ({ ok: true as const, preview }),
    send
  })
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  const area = document.createElement('textarea')
  popup.root.append(area)
  area.focus()
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(send).not.toHaveBeenCalled()
  popup.close()
})

it('remembers the last scope within the session and restores it on reopen', async () => {
  type Entries = import('../../src/shared/ipc.ts').TreeEntry[]
  const entries: Entries = [
    { name: 'a.md', relPath: 'a.md', kind: 'note' },
    { name: 'b.md', relPath: 'b.md', kind: 'note' }
  ]
  const firstLoad = vi.fn(async (_references: string[]) => ({ ok: true as const, preview }))
  const first = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'a.md',
    entries,
    preview: firstLoad,
    send: async () => ({ ok: true as const, id: 'task' })
  })
  await vi.waitFor(() => expect(first.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  // 从空范围开始，确保这条用例测的是本条自己写下的记忆。
  first.root.querySelector<HTMLButtonElement>('.authorization-preset-origin')!.click()
  await vi.waitFor(() => expect(firstLoad).toHaveBeenLastCalledWith([], false, false))
  const choose = first.root.querySelector<HTMLInputElement>('.authorization-choices input[value="b.md"]')!
  choose.checked = true
  choose.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(firstLoad).toHaveBeenLastCalledWith(['b.md'], false, false))
  first.close()

  const secondLoad = vi.fn(async (_references: string[]) => ({ ok: true as const, preview }))
  const second = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'a.md',
    entries,
    preview: secondLoad,
    send: async () => ({ ok: true as const, id: 'task' })
  })
  expect(second.root.querySelector<HTMLInputElement>('.authorization-choices input[value="b.md"]')!.checked).toBe(true)
  await vi.waitFor(() => expect(secondLoad).toHaveBeenLastCalledWith(['b.md'], false, false))
  // 清掉记忆，避免影响同一文件后面的用例。
  second.root.querySelector<HTMLButtonElement>('.authorization-preset-origin')!.click()
  await vi.waitFor(() => expect(secondLoad).toHaveBeenLastCalledWith([], false, false))
  second.close()
})

it('exposes setStale to block sending until a fresh preview succeeds', async () => {
  const load = vi.fn(async () => ({ ok: true as const, preview }))
  const send = vi.fn(async () => ({ ok: true as const, id: 'task' }))
  const popup = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'a.md',
    entries: [{ name: 'b.md', relPath: 'b.md', kind: 'note' }],
    preview: load,
    send
  })
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  const status = popup.root.querySelector('.authorization-status')!
  popup.setStale()
  expect(status.textContent).toBe('内容已改，重新核对。')
  expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(true)
  expect(send).not.toHaveBeenCalled()

  const choose = popup.root.querySelector<HTMLInputElement>('.authorization-choices input[value="b.md"]')!
  choose.checked = true
  choose.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  expect(status.textContent).not.toContain('内容已改，重新核对。')
  expect(load).toHaveBeenCalledTimes(2)
  // 清掉记忆，避免影响同一文件后面的用例。
  popup.root.querySelector<HTMLButtonElement>('.authorization-preset-origin')!.click()
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], false, false))
  popup.close()
})

it('keeps each notice first sentence short and machine codes off the card', async () => {
  const expanded = {
    ...preview,
    memory: {
      use: true,
      consolidate: true,
      recipient: { modelId: 'summarizer', host: 'memory.example' },
      limits: { seconds: 600, calls: 4, tools: 0 },
      search: { available: true, calls: 2, sharedTools: 6 }
    },
    network: { available: true, search: true, providerHost: 'api.tavily.com' },
    mcp: { available: true, servers: [{ name: 'deepwiki', host: 'mcp.example', tools: ['search', 'read'] }] }
  }
  const popup = openAuthorizationPopover({
    anchor: { left: 100, top: 100, bottom: 120 },
    origin: 'a.md',
    entries: [],
    preview: async () => ({ ok: true as const, preview: expanded }),
    send: async () => ({ ok: true as const, id: 'task' })
  })
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  const firstLine = (element: Element): string => element.textContent!.split('。')[0]!
  const characters = (text: string): number => [...text.replace(/\s/g, '')].length
  for (const selector of ['.authorization-disclosure', '.authorization-memory', '.authorization-scope-hint', '.authorization-status', '.authorization-network', '.authorization-mcp']) {
    const element = popup.root.querySelector(selector)!
    expect(element.textContent!.length).toBeGreaterThan(0)
    expect(characters(firstLine(element))).toBeLessThanOrEqual(40)
  }
  expect(popup.root.textContent).not.toMatch(/[A-Z]{2,}_[A-Z_]{2,}/)
  popup.close()
})
