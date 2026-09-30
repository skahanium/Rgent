// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { openAuthorizationPopover } from '../../src/renderer/src/authorization-popover.ts'
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
