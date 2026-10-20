// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { openAuthorizationPopover } from '../../src/renderer/src/authorization-popover.ts'
import { SKILL_REASON_TEXT } from '../../src/shared/skills.ts'
beforeEach(()=>{
  Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(){this.setAttribute('open','')}})
  Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(){this.removeAttribute('open');this.dispatchEvent(new Event('close'))}})
})
afterEach(()=>document.body.replaceChildren())
const preview={id:'p',sessionId:'s',origin:'a.md',sources:[{sourceId:'a',relPath:'a.md',title:'a',revision:'r',objectVersion:'o',sessionId:'s',fingerprint:'x',tier:'reference' as const}],recipient:{modelId:'model',host:'model.example',provider:'custom' as const}}
it('does not send before preview, preserves prompt on dismissal, and discloses recipient',async()=>{
  let resolve!: (v:any)=>void;const send=vi.fn(async()=>({ok:true as const,id:'task'}));const closed=vi.fn()
  openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:()=>new Promise(r=>{resolve=r}),send,onClose:closed})
  const dialog=document.querySelector<HTMLDialogElement>('.overlay-authorization')!
  dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
  expect(send).not.toHaveBeenCalled()
  resolve({ok:true,preview});await vi.waitFor(()=>expect(dialog.textContent).toContain('model.example'))
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
it('single-note default focus confirms with the next Enter and does not override a chosen cancel focus',async()=>{
  const send=vi.fn(async()=>({ok:true as const,id:'task'}))
  let finish!: (v:any)=>void
  const popup=openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:()=>new Promise(resolve=>finish=resolve),send})
  await Promise.resolve()
  expect(document.activeElement).toBe(popup.root)
  finish({ok:true,preview})
  await vi.waitFor(()=>expect(document.activeElement).toBe(popup.root.querySelector('.authorization-send')))
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
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
  expect(status.textContent).toContain('重新核对')
  expect(status.textContent).not.toContain('STALE_AUTHORIZATION')
  popup.close()
})

it('initial confirmation focus does not scroll the recipient and origin out of view', async()=>{
  const focus=vi.spyOn(HTMLElement.prototype,'focus')
  const popup=openAuthorizationPopover({anchor:{left:100,top:100,bottom:120},origin:'a.md',entries:[],preview:async()=>({ok:true as const,preview}),send:async()=>({ok:true as const,id:'task'})})
  await vi.waitFor(()=>expect(document.activeElement).toBe(popup.root.querySelector('.authorization-send')))
  const at=focus.mock.contexts.findIndex((node,i)=>node===popup.root.querySelector('.authorization-send') && focus.mock.calls[i]?.[0]?.preventScroll)
  expect(at).toBeGreaterThanOrEqual(0)
  focus.mockRestore()
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
  expect(load).toHaveBeenLastCalledWith([], false)
  input.checked = true
  input.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], true))
  await vi.waitFor(() => expect(popup.root.querySelector('.authorization-status')!.textContent).toContain('联网只读（抓网页＋搜索）'))
  await vi.waitFor(() => expect(popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.disabled).toBe(false))
  popup.root.querySelector<HTMLButtonElement>('.authorization-send')!.click()
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  expect(send).toHaveBeenCalledWith(expect.anything(), true)
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
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith([], true))
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
