// @vitest-environment jsdom
import { TableWidget } from '../../src/renderer/src/view/widgets/table.ts'
import { CalloutWidget } from '../../src/renderer/src/view/widgets/callout.ts'
import { compileFragment } from '../../src/markdown/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { renderReadOnlyMarkdown, renderReadOnlyNode, disposeReadOnlyImages } from '../../src/renderer/src/view/read-only.ts'

describe('read-only ledger presentation', () => {
  it('keeps each local ledger image unloaded until its own click', () => {
    const host=document.createElement('div')
    renderReadOnlyMarkdown(host, '![甲](附件/甲.png)\n\n![乙](附件/乙.png)',
      {noteRelPath:'笔记.md',vaultHas:()=>true,openNote:()=>{}})
    expect(host.querySelector('img')).toBeNull()
    const details=host.querySelector('details')!
    details.open=true; details.dispatchEvent(new Event('toggle'))
    expect(details.textContent).toContain('账本')
    expect(details.textContent).toContain('附件/甲.png')
    ;(host.querySelector('button') as HTMLButtonElement).click()
    expect(host.querySelectorAll('img')).toHaveLength(1)
    expect(host.querySelectorAll('button')).toHaveLength(1)
  })
  it.each(['| 图 |\n| --- |\n| ![图](附件/图.png) |', '> [!note] 提示\n> ![图](附件/图.png)'])('inherits AI click-only behavior for nested local images', sourceBlock => {
    const source='<!-- rgent:ai:v1 -->\n'+sourceBlock
    const parsed=compileFragment(source)
    const node=renderReadOnlyNode((parsed.tree as any).children[0],source,
      {noteRelPath:'笔记.md',vaultHas:()=>true,openNote:()=>{}}) as HTMLElement
    expect(node.querySelector('img')).toBeNull()
    ;(node.querySelector('button') as HTMLButtonElement).click()
    expect(node.querySelector('img')?.getAttribute('src')).toContain('rgent-vault://')
  })

  it('keeps an image inside paired inline HTML clickable and ledger inert', async () => {
    const host=document.createElement('div')
    const load=vi.fn(async()=>({ok:true as const,src:'rgent-image://media/?t=abc'}))
    renderReadOnlyMarkdown(host, '前 <strong>![图](https://images.example/a)</strong> 后',
      {noteRelPath:'a.md',vaultHas:()=>false,openNote:()=>{},remoteImageGet:load})
    expect(load).not.toHaveBeenCalled()
    ;(host.querySelector('button') as HTMLButtonElement).click()
    await vi.waitFor(()=>expect(host.querySelector('strong img')).not.toBeNull())
  })
  it('does not apply late ledger responses after projection replacement', async () => {
    const host=document.createElement('div')
    let resolve!: (r:{ok:true;src:string})=>void
    const noteHost={noteRelPath:'a.md',vaultHas:()=>false,openNote:()=>{},remoteImageGet:()=>new Promise<{ok:true;src:string}>(r=>{resolve=r})}
    renderReadOnlyMarkdown(host, '![图](https://images.example/a)', noteHost)
    const old=host.querySelector('.md-image-slot')!
    ;(host.querySelector('button') as HTMLButtonElement).click()
    renderReadOnlyMarkdown(host, '新账本', noteHost)
    resolve({ok:true,src:'rgent-image://media/?t=late'})
    await Promise.resolve()
    expect(old.querySelector('img')).toBeNull()
    disposeReadOnlyImages(host)
  })

  it.each(['| 图 |\n| --- |\n| ![图](https://images.example/a) |', '> [!note] 提示\n> ![图](https://images.example/a)'])('inherits outer AI provenance for nested images', sourceBlock => {
    const source='<!-- rgent:ai:v1 -->\n'+sourceBlock
    const result=compileFragment(source)
    const load=vi.fn(async()=>({ok:true as const,src:'rgent-image://media/?t=abc'}))
    const node=renderReadOnlyNode((result.tree as any).children[0], source,
      {noteRelPath:'a.md',vaultHas:()=>false,openNote:()=>{},remoteImageGet:load})
    expect(load).not.toHaveBeenCalled()
    expect((node as HTMLElement).querySelector('button')).not.toBeNull()
    const details=(node as HTMLElement).querySelector('details')!
    details.open=true; details.dispatchEvent(new Event('toggle'))
    expect(details.textContent).toContain('未采纳 AI 正文')
  })
  it('loads human table/callout images with host context and disposes nested results', async () => {
    for (const block of ['| 图 |\n| --- |\n| ![图](https://images.example/a) |', '> [!note] 提示\n> ![图](https://images.example/a)']) {
      const result=compileFragment(block)
      const load=vi.fn(async()=>({ok:true as const,src:'rgent-image://media/?t=abc'}))
      const host={noteRelPath:'a.md',vaultHas:()=>false,openNote:()=>{},remoteImageGet:load,
        imageContext:(range:{start:number;end:number})=>({noteRelPath:'a.md',region:'body' as const,...range,sessionId:'session'})}
      const widget=result.index.tables.length ? new TableWidget(result.index.tables[0],host) : new CalloutWidget(result.index.callouts[0],host)
      const node=widget.toDOM()
      await vi.waitFor(()=>expect(node.querySelector('img')).not.toBeNull())
      expect(load).toHaveBeenCalledWith(expect.objectContaining({mode:'auto',context:expect.objectContaining({sessionId:'session'})}))
      widget.destroy(node)
    }
  })
  it('renders headings, emphasis and lists without exposing Markdown delimiters', () => {
    const host = document.createElement('div')
    renderReadOnlyMarkdown(host, '## 第一场\n\n**结论**\n\n- A\n- B\n')
    expect(host.querySelector('h2')?.textContent).toBe('第一场')
    expect(host.querySelector('strong')?.textContent).toBe('结论')
    expect([...host.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['A', 'B'])
    expect(host.textContent).not.toContain('**')
  })

  it('keeps unsafe HTML inert', () => {
    const host = document.createElement('div')
    renderReadOnlyMarkdown(host, '文字\n\n<iframe src="https://example.com"></iframe>\n')
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.textContent).toContain('<iframe')
  })

  it('renders paired safe inline HTML in a paragraph while preserving adjacent text', () => {
    const host = document.createElement('div')
    renderReadOnlyMarkdown(host, '前文 <strong>强调</strong> 后文。')
    expect(host.querySelector('p strong')?.textContent).toBe('强调')
    expect(host.textContent).toBe('前文 强调 后文。')
  })

  it('uses the same external image loader and no raw URL in ledger review', async () => {
    const host = document.createElement('div')
    const remoteImageGet = vi.fn(async () => ({ ok: true as const, src: 'rgent-image://media/?t=abc' }))
    renderReadOnlyMarkdown(host, '![旧图](https://images.example/p?secret=1)', {
      noteRelPath: '笔记.md', vaultHas: () => false, openNote: () => {}, remoteImageGet
    })
    expect(remoteImageGet).not.toHaveBeenCalled()
    ;(host.querySelector('button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('img')?.getAttribute('src')).toBe('rgent-image://media/?t=abc'))
    expect(host.textContent).not.toContain('secret=1')
  })

  it('separates a leading image from following prose and headings in read-only review', () => {
    const host = document.createElement('div')
    renderReadOnlyMarkdown(host, '![图](https://images.example/a.png)正文。\n\n![图](https://images.example/b.png)## 标题\n')
    expect(host.querySelectorAll('.md-image-block')).toHaveLength(2)
    expect([...host.querySelectorAll('p')].some((node) => node.textContent === '正文。')).toBe(true)
    expect(host.querySelector('h2')?.textContent).toBe('标题')
    expect(host.textContent).not.toContain('##')
  })
})
