import {describe,it,expect,vi} from 'vitest'
import {vaultMediaUrl} from '../../src/shared/vault-rel.ts'
const mocks=vi.hoisted(()=>({handle:vi.fn(),read:vi.fn()}))
vi.mock('electron',()=>({protocol:{handle:mocks.handle}}))
vi.mock('../../src/main/paths.ts',()=>({readVaultMedia:mocks.read}))
import {attachVaultProtocol} from '../../src/main/vault-protocol.ts'
import type {VaultSession} from '../../src/main/vault.ts'
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
})
