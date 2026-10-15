import {describe,it,expect,vi} from 'vitest'
import {vaultMediaUrl} from '../../src/shared/vault-rel.ts'
const mocks=vi.hoisted(()=>({handle:vi.fn(),read:vi.fn()}))
vi.mock('electron',()=>({protocol:{handle:mocks.handle}}))
vi.mock('../../src/main/paths.ts',()=>({readVaultMedia:mocks.read}))
import {attachVaultProtocol} from '../../src/main/vault-protocol.ts'
import type {VaultSession} from '../../src/main/vault.ts'

function attach(session='A',root='/A'){
  attachVaultProtocol(()=>({sessionId:()=>session,requireUsableRoot:()=>root}) as unknown as VaultSession)
  return mocks.handle.mock.calls.at(-1)![1] as (request: {url:string;destination?:string}) => Promise<Response>
}

describe('media mount isolation',()=>{
 it('never resolves an old or unbound URL against the new library',async()=>{
   let session='A';let root='/A'
   mocks.read.mockImplementation((path:string)=>({bytes:Buffer.from(path)}))
   attachVaultProtocol(()=>({sessionId:()=>session,requireUsableRoot:()=>root}) as unknown as VaultSession)
   const handler=mocks.handle.mock.calls.at(-1)![1]
   const old=vaultMediaUrl('same.png','A')
   expect(await (await handler({url:old})).text()).toBe('/A')
   mocks.read.mockClear();session='B';root='/B'
   expect((await handler({url:old})).status).toBe(410)
   expect((await handler({url:vaultMediaUrl('same.png')})).status).toBe(410)
   expect(mocks.read).not.toHaveBeenCalled()
   expect(await (await handler({url:vaultMediaUrl('same.png','B')})).text()).toBe('/B')
 })

 it('keeps SVG in an image destination with nosniff and sandbox CSP',async()=>{
   mocks.read.mockReturnValue({bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')})
   const handler=attach()
   expect((await handler({url:vaultMediaUrl('pic.svg','A'),destination:'document'})).status).toBe(403)
   expect(mocks.read).not.toHaveBeenCalled()
   const response=await handler({url:vaultMediaUrl('pic.svg','A'),destination:'image'})
   expect(response.status).toBe(200)
   expect(response.headers.get('content-type')).toBe('image/svg+xml')
   expect(response.headers.get('x-content-type-options')).toBe('nosniff')
   expect(response.headers.get('content-security-policy')).toContain('sandbox')
   expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
   expect(mocks.read).toHaveBeenCalledWith('/A','pic.svg')
 })

 it('rejects vault URLs that are not pinned to media/',async()=>{
   const handler=attach()
   expect((await handler({url:'rgent-vault://evil/?p=pic.png',destination:'image'})).status).toBe(403)
   expect(mocks.read).not.toHaveBeenCalled()
 })

 it('still denies hidden-segment paths through SecureVaultFs',async()=>{
   mocks.read.mockReturnValue({error:403})
   const handler=attach()
   expect((await handler({url:vaultMediaUrl('.secret.png','A'),destination:'image'})).status).toBe(403)
   expect(mocks.read).toHaveBeenCalledWith('/A','.secret.png')
 })
})
