import { describe, it, expect } from 'vitest'
import { verifyImageSource } from '../../src/main/image-source.ts'
const snapshot = (content:string) => ({ content,revision:'r',sessionId:'s',objectVersion:'o' })
function request(content:string, region:'body'|'ledger'='body', mode:'auto'|'explicit'='auto') {
  const start=content.indexOf('![图]'), end=content.indexOf(')',start)+1
  return {url:'https://public.example/img', mode, context:{noteRelPath:'a.md',region,start,end,sessionId:'s',revision:'r',objectVersion:'o'}}
}
describe('main-process image source proof',()=> {
  it('permits automatic human HTTPS but not an unaccepted AI image',()=> {
    const human='![图](https://public.example/img)\n'
    expect(verifyImageSource(snapshot(human),request(human)).ok).toBe(true)
    const ai='<!-- rgent:ai:v1 -->\n'+human
    expect(verifyImageSource(snapshot(ai),request(ai)).ok).toBe(false)
    expect(verifyImageSource(snapshot(ai),request(ai,'body','explicit')).ok).toBe(true)
  })
  it('requires per-image consent for ledger, rejects forged body location and changed versions',()=> {
    const raw='正文\n\n<!-- rgent:ledger:v1 -->\n![图](https://public.example/img)\n'
    expect(verifyImageSource(snapshot(raw),request(raw,'ledger')).ok).toBe(false)
    expect(verifyImageSource(snapshot(raw),request(raw,'body')).ok).toBe(false)
    expect(verifyImageSource(snapshot(raw),request(raw,'ledger','explicit')).ok).toBe(true)
    const r=request(raw,'ledger','explicit');r.context.objectVersion='foreign'
    expect(verifyImageSource(snapshot(raw),r).ok).toBe(false)
  })
  it('allows changed drafts only explicitly and only an AST-backed image range',()=> {
    const draft='![图](https://public.example/img)\n'; const r=request(draft)
    const withDraft={...r,context:{...r.context,draftBody:draft}}
    expect(verifyImageSource(snapshot('old\n'),withDraft).ok).toBe(false)
    expect(verifyImageSource(snapshot('old\n'),{...withDraft,mode:'explicit'}).ok).toBe(true)
    expect(verifyImageSource(snapshot(draft),{...r,url:'https://forged.example/img'}).ok).toBe(false)
  })
  it('inherits AI provenance for nested callout and table images',()=> {
    for(const content of ['<!-- rgent:ai:v1 -->\n> [!note]\n> ![图](https://public.example/img)\n','<!-- rgent:ai:v1 -->\n| a |\n| - |\n| ![图](https://public.example/img) |\n']) {
      expect(verifyImageSource(snapshot(content),request(content)).ok).toBe(false)
    }
  })
})


it('verifies BOM-prefixed images using original file offsets in body and ledger', () => {
  const human='\ufeff前文\r\n\r\n![图](https://public.example/img)\n'
  expect(verifyImageSource(snapshot(human),request(human)).ok).toBe(true)
  const ai='\ufeff<!-- rgent:ai:v1 -->\r\n![图](https://public.example/img)\n'
  expect(verifyImageSource(snapshot(ai),request(ai,'body','explicit')).ok).toBe(true)
  expect(verifyImageSource(snapshot(ai),request(ai)).ok).toBe(false)
  const ledger='\ufeff正文\r\n<!-- rgent:ledger:v1 -->\r\n![图](https://public.example/img)\n'
  expect(verifyImageSource(snapshot(ledger),request(ledger,'ledger','explicit')).ok).toBe(true)
})
