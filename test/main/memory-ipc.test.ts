import { describe, expect, it } from 'vitest'
import { parseMemoryRequest, publicMemoryError } from '../../src/main/memory-ipc.ts'

describe('memory IPC boundary', () => {
  it('requires a session and rejects renderer supplied authority', () => {
    expect(parseMemoryRequest('get', {})).toBeNull()
    expect(parseMemoryRequest('get', {sessionId:'session', root:'/secret'})).toBeNull()
    expect(parseMemoryRequest('get', {sessionId:'session'})).toEqual({sessionId:'session'})
  })
  it('requires bounded content, raw offsets and binding for manual preview', () => {
    const request={sessionId:'session',relPath:'note.md',objectVersion:'object',revision:'a'.repeat(64),kind:'body',start:0,end:5}
    expect(parseMemoryRequest('manual',request)).toEqual(request)
    expect(parseMemoryRequest('manual',{...request,end:Infinity})).toBeNull()
    expect(parseMemoryRequest('manual',{...request,relPath:'/private/note.md'})).toBeNull()
    expect(parseMemoryRequest('manual',{...request,sources:[]})).toBeNull()
  })
  it('does not expose arbitrary disk errors or stack traces', () => {
    expect(publicMemoryError(new Error('EIO /Users/private/key'))).toBe('MEMORY_UNAVAILABLE')
    expect(publicMemoryError(new Error('MEMORY_PIN_FAILED:EIO /private/secret'))).toBe('MEMORY_PIN_FAILED')
    expect(publicMemoryError(new Error('MEMORY_SOURCE_CHANGED'))).toBe('MEMORY_SOURCE_CHANGED')
  })
})
