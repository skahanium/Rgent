import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { requestPinnedImage } from '../../src/main/remote-image-transport.ts'

afterEach(() => vi.restoreAllMocks())
describe('Node direct image socket', () => {
  it('keeps the original TLS name and URL while lookup only returns the vetted address', async () => {
    let seenUrl: URL | undefined
    let seen: Record<string, unknown> | undefined
    vi.spyOn(https, 'request').mockImplementation(((url: URL, options: Record<string,unknown>, received: (incoming: PassThrough) => void) => {
      seenUrl=url; seen=options
      const request = new EventEmitter() as EventEmitter & {end:()=>void}
      request.end=()=> {
        const incoming=Object.assign(new PassThrough(),{statusCode:200,headers:{'content-type':'image/png'}})
        received(incoming); incoming.end(Buffer.from([1,2,3]))
      }
      return request
    }) as never)
    const response=await requestPinnedImage(new URL('https://images.example/signed?token=abc'),{address:'93.184.216.34',family:4},new AbortController().signal)
    expect(seenUrl?.href).toBe('https://images.example/signed?token=abc')
    expect(seen).toMatchObject({agent:false,autoSelectFamily:false,servername:'images.example',rejectUnauthorized:true,method:'GET',headers:{accept:'image/*','accept-encoding':'identity'}})
    expect(Object.keys(seen!.headers as object)).toEqual(['accept','accept-encoding'])
    const callback=vi.fn()
    ;(seen!.lookup as Function)('images.example',{},callback)
    expect(callback).toHaveBeenCalledWith(null,'93.184.216.34',4)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([1,2,3]))
  })
  it('rejects an invalid upstream status without throwing from the response callback', async () => {
    let received!: (incoming: PassThrough) => void
    vi.spyOn(https, 'request').mockImplementation(((_url: URL, _options:unknown, callback:(incoming:PassThrough)=>void) => {
      received=callback
      const request=new EventEmitter() as EventEmitter & {end:()=>void}
      request.end=()=>{}
      return request
    }) as never)
    const pending=requestPinnedImage(new URL('https://images.example/a'),{address:'93.184.216.34',family:4},new AbortController().signal)
    const incoming=Object.assign(new PassThrough(),{statusCode:999,headers:{}})
    expect(()=>received(incoming)).not.toThrow()
    await expect(pending).rejects.toThrow('Invalid image response')
    expect(incoming.destroyed).toBe(true)
  })
  it('makes HTTP direct and propagates socket errors without proxy, cookies, auth or referrer', async () => {
    let seen:Record<string,unknown>|undefined
    vi.spyOn(http,'request').mockImplementation(((_url:URL, options:Record<string,unknown>)=> {
      seen=options
      const request=new EventEmitter() as EventEmitter & {end:()=>void}
      request.end=()=>queueMicrotask(()=>request.emit('error',new Error('socket failed')))
      return request
    }) as never)
    await expect(requestPinnedImage(new URL('http://images.example/a'),{address:'93.184.216.34',family:4},new AbortController().signal)).rejects.toThrow('socket failed')
    expect(seen).toMatchObject({agent:false})
    expect(seen).not.toHaveProperty('servername')
    expect(Object.keys(seen!.headers as object)).toEqual(['accept','accept-encoding'])
  })
})
