// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { compile, planWidgets } from '../../src/markdown/index.ts'
import { EditorState } from '@codemirror/state'
import { markdownField } from '../../src/renderer/src/view/editor.ts'
import { createImageElement, ImageWidget } from '../../src/renderer/src/view/widgets/image.ts'

describe('Markdown external image presentation', () => {
  it.each(['ai', 'human'] as const)('keeps local source loading faithful for %s', source => {
    const widget=new ImageWidget({range:{start:0,end:15},url:'附件/图.png',alt:'图',base:'note',source},
      {noteRelPath:'笔记.md',vaultHas:()=>true,openNote:()=>{}})
    const node=widget.toDOM()
    if(source==='ai') {
      expect(node.querySelector('img')).toBeNull()
      const details=node.querySelector('details')!
      details.open=true; details.dispatchEvent(new Event('toggle'))
      expect(details.textContent).toContain('未采纳 AI 正文')
      expect(details.textContent).toContain('附件/图.png')
      ;(node.querySelector('button') as HTMLButtonElement).click()
    }
    expect(node.querySelector('img')?.getAttribute('src')).toBe('rgent-vault://media/?p=%E9%99%84%E4%BB%B6%2F%E5%9B%BE.png')
  })
  it('does not reuse a loaded image DOM across a changed static source epoch', () => {
    const image={range:{start:0,end:15},url:'图.png',alt:'图',base:'note' as const,source:'ai' as const}
    const base={noteRelPath:'笔记.md',vaultHas:()=>true,openNote:()=>{}}
    const old=new ImageWidget(image,{...base,imageEpoch:'session/object/old'})
    const current=new ImageWidget(image,{...base,imageEpoch:'session/object/new'})
    expect(old.eq(current)).toBe(false)
    expect(old.eq(new ImageWidget(image,{...base,imageEpoch:'session/object/old'}))).toBe(true)
  })
  it('does not activate a destroyed local AI placeholder', () => {
    const widget=new ImageWidget({range:{start:0,end:15},url:'图.png',alt:'图',base:'note',source:'ai'},
      {noteRelPath:'笔记.md',vaultHas:()=>true,openNote:()=>{}})
    const node=widget.toDOM(); const button=node.querySelector('button') as HTMLButtonElement
    expect(node.querySelector('img')).toBeNull()
    widget.destroy(node); button.click()
    expect(node.querySelector('img')).toBeNull()
  })
  it.each(['ai', 'human'] as const)('inherits source for vault wiki image embeds: %s', source => {
    const raw=(source==='ai'?'<!-- rgent:ai:v1 -->\n':'')+'![[附件/图.png]]\n'
    const parsed=compile(raw)
    const image=planWidgets(parsed.index,raw,[{from:0,to:raw.length}]).find(p=>p.kind==='image')!
    expect(image.kind==='image' && image.image.source).toBe(source)
  })

  it.each(['ai', 'ledger', undefined] as const)('never auto requests an untrusted source: %s', async source => {
    const load = vi.fn(async () => ({ ok: true as const, src: 'rgent-image://media/?t=abc' }))
    const node = createImageElement('图', 'https://images.example/a', true, load, undefined, { source })
    expect(load).not.toHaveBeenCalled()
    const details = node.querySelector('details')!
    details.open = true
    details.dispatchEvent(new Event('toggle'))
    expect(details.textContent).toContain('https://images.example/a')
    ;(node.querySelector('button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith(expect.objectContaining({ mode: 'explicit' })))
  })
  it('does not apply a late result after widget destruction', async () => {
    let resolve!: (result: { ok: true; src: string }) => void
    const node = createImageElement('图', 'https://images.example/a', true,
      () => new Promise(r => { resolve = r }), undefined, { source: 'human' })
    new ImageWidget({range:{start:0,end:1},url:'https://images.example/a',alt:'图',base:'note'},
      {noteRelPath:'a.md',vaultHas:()=>false,openNote:()=>{}}).destroy(node)
    resolve({ok:true,src:'rgent-image://media/?t=late'})
    await Promise.resolve()
    expect(node.querySelector('img')).toBeNull()
  })
  it('shows the redirect target before resuming with its continuation', async () => {
    const load = vi.fn().mockResolvedValueOnce({ok:false,error:'REDIRECT_CONFIRM',url:'https://other.example/a',continuation:'once'})
      .mockResolvedValueOnce({ok:true,src:'rgent-image://media/?t=abc'})
    const node = createImageElement('图', 'https://images.example/a', true, load, undefined, {source:'ai'})
    ;(node.querySelector('button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(node.textContent).toContain('图片将转向另一来源'))
    const details = node.querySelector('details')!
    details.open = true
    details.dispatchEvent(new Event('toggle'))
    expect(details.textContent).toContain('https://other.example/a')
    ;(node.querySelector('button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({mode:'explicit',continuation:'once'})))
  })
  it('loads HTTPS through the typed image entry and never displays the raw URL', async () => {
    const load = vi.fn(async () => ({ ok: true as const, src: 'rgent-image://media/?t=abc' }))
    const node = createImageElement('截图', 'https://images.example/p?token=secret', true, load, undefined, { source: 'human' })
    await vi.waitFor(() => expect(node.querySelector('img')?.getAttribute('src')).toBe('rgent-image://media/?t=abc'))
    expect(load).toHaveBeenCalledWith({ url: 'https://images.example/p?token=secret', allowHttp: false, mode: 'auto' })
    expect(node.textContent).not.toContain('secret')
  })

  it('keeps HTTP inert until the image button is clicked', async () => {
    const load = vi.fn(async () => ({ ok: true as const, src: 'rgent-image://media/?t=abc' }))
    const node = createImageElement('旧图', 'http://images.example/p.png', true, load, undefined, { source: 'human' })
    expect(load).not.toHaveBeenCalled()
    ;(node.querySelector('button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith({ url: 'http://images.example/p.png', allowHttp: true, mode: 'explicit' }))
  })

  it('uses a concise inline failure instead of a large URL card', async () => {
    const load = vi.fn(async () => ({ ok: false as const, error: 'NOT_IMAGE' as const }))
    const node = createImageElement('', 'https://images.example/very-long-secret-address', false, load, undefined, { source: 'human' })
    await vi.waitFor(() => expect(node.textContent).toContain('地址没有返回图片'))
    expect(node.classList.contains('md-image-inline')).toBe(true)
    expect(node.textContent).not.toContain('very-long-secret-address')
  })

  it('refreshes verified context when retrying after a note save', async () => {
    let revision='old'
    const load=vi.fn().mockResolvedValueOnce({ok:false,error:'NOT_ALLOWED'}).mockResolvedValueOnce({ok:true,src:'rgent-image://media/?t=abc'})
    const widget=new ImageWidget({range:{start:0,end:20},url:'https://images.example/a',alt:'图',base:'note',source:'human'},
      {noteRelPath:'a.md',vaultHas:()=>false,openNote:()=>{},remoteImageGet:load,
        imageContext: range => ({noteRelPath:'a.md',region:'body',...range,revision})})
    const node=widget.toDOM()
    await vi.waitFor(()=>expect(node.querySelector('button')).not.toBeNull())
    revision='new'
    ;(node.querySelector('button') as HTMLButtonElement).click()
    await vi.waitFor(()=>expect(load).toHaveBeenLastCalledWith(expect.objectContaining({context:expect.objectContaining({revision:'new'})})))
  })
  it('keeps the figure rendered when the caret enters the prose immediately after it', () => {
    const doc = '![图](https://images.example/p.png)后文。\n'
    const at = doc.indexOf('后文')
    const before = EditorState.create({ doc, extensions: [markdownField] })
    const after = before.update({ selection: { anchor: at } }).state
    let images = 0
    after.field(markdownField).decorations.between(0, doc.length, (_from, _to, deco) => {
      if (deco.spec.widget instanceof ImageWidget) images += 1
    })
    expect(images).toBe(1)
  })
})
