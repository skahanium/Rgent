import { describe,it,expect } from 'vitest'
import { boundArguments, isVaultChannel, boundEvent } from '../../src/shared/vault-binding.ts'
describe('mount-bound IPC',()=>{
 it('refuses missing or old envelopes rather than resolving a path in the new vault',()=>{
   expect(()=>boundArguments(['same.md'],'B')).toThrow('VAULT_CHANGED')
   expect(()=>boundArguments([{session:'A',args:['same.md']}],'B')).toThrow('VAULT_CHANGED')
   expect(boundArguments([{session:'B',args:['same.md']}],'B')).toEqual(['same.md'])
 })
 it('keeps global preferences separate and scopes memory and file operations',()=>{
   expect(isVaultChannel('model:config:get')).toBe(false);expect(isVaultChannel('note:read')).toBe(true)
   expect(isVaultChannel('memory:get')).toBe(true);expect(isVaultChannel('vault:pick')).toBe(false)
 })
 it('filters old events even if they refer to the same relative path',()=>{
   expect(boundEvent({session:'A',args:['same.md']},'B')).toBe(null)
   expect(boundEvent({session:'B',args:['same.md']},'B')).toEqual(['same.md'])
 })
})
