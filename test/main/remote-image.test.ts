import { describe, expect, it, vi } from 'vitest'
import { RemoteImageService, parseRemoteImageUrl, remoteImageUrl } from '../../src/main/remote-image.ts'
import { attachRemoteImageProtocol } from '../../src/main/remote-image-protocol.ts'
import { protocol } from 'electron'
vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))
const PNG = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0])
const image = () => new Response(PNG, { headers: { 'content-type':'image/png' } })
const redirect = (location: string) => new Response(null, {status:302,headers:{location}})
const publicAddress = {address:'93.184.216.34',family:4 as const}
const dependencies = (request = vi.fn(async () => image())) => ({resolve:vi.fn(async () => [publicAddress]),request})
describe('remote image boundary', () => {
  it('only parses opaque display tokens', () => {
    const token='7b5903b2-85fb-423f-9e3d-bdfad2ae98b9'
    expect(parseRemoteImageUrl(remoteImageUrl(token))).toBe(token)
    expect(parseRemoteImageUrl('rgent-image://media/?t=https://example.com')).toBeNull()
  })
  it('pins each actual request to one checked DNS answer without resolving again', async () => {
    const deps=dependencies(); const service=new RemoteImageService(deps)
    expect((await service.load('https://images.example/p?id=1%2F2')).ok).toBe(true)
    expect(deps.resolve).toHaveBeenCalledTimes(1)
    expect(deps.request).toHaveBeenCalledWith(new URL('https://images.example/p?id=1%2F2'),publicAddress,expect.any(AbortSignal))
  })
  it.each(['127.0.0.1','10.1.2.3','169.254.1.1','100.64.1.1','192.0.2.1','::1','fe80::1','fc00::1','::ffff:127.0.0.1','::ffff:a00:1', 'fec0::1', '64:ff9b:1::a00:1', '100:0:0:1::1', '3fff::1', '5f00::1', '2001:2::1'])('rejects all candidates if any answer is nonpublic: %s',async address => {
    const deps=dependencies(); deps.resolve.mockResolvedValue([publicAddress,{address,family:address.includes(':')?6:4}] as never)
    expect(await new RemoteImageService(deps).load('https://images.example/a')).toEqual({ok:false,error:'INVALID_URL'})
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('allows a public IPv6 and mapped public address',async () => {
    for(const address of ['2606:4700:4700::1111','::ffff:93.184.216.34']) {
      const deps=dependencies(); deps.resolve.mockResolvedValue([{address,family:6}] as never)
      expect((await new RemoteImageService(deps).load('https://images.example/a')).ok).toBe(true)
    }
  })
  it('rechecks DNS on redirects and blocks a rebound answer',async () => {
    const deps=dependencies(vi.fn(async () => redirect('/next')))
    deps.resolve.mockResolvedValueOnce([publicAddress]).mockResolvedValueOnce([{address:'127.0.0.1',family:4}])
    expect(await new RemoteImageService(deps).load('https://images.example/a')).toEqual({ok:false,error:'INVALID_URL'})
    expect(deps.request).toHaveBeenCalledTimes(1)
  })
  it('requires HTTP activation before any network request', async () => {
    const deps=dependencies(); const service=new RemoteImageService(deps)
    expect(await service.load('http://images.example/a')).toMatchObject({ok:false,error:'HTTP_CONFIRM',url:'http://images.example/a'})
    expect(deps.request).not.toHaveBeenCalled()
    expect((await service.load('http://images.example/a',{mode:'explicit',allowHttp:true})).ok).toBe(true)
  })
  it('pauses HTTPS downgrade even if the original HTTP permission was granted',async () => {
    const deps=dependencies(vi.fn(async () => redirect('http://images.example/b')))
    expect(await new RemoteImageService(deps).load('https://images.example/a',{mode:'explicit',allowHttp:true})).toMatchObject({ok:false,error:'HTTP_CONFIRM',url:'http://images.example/b',continuation:expect.any(String)})
    expect(deps.request).toHaveBeenCalledTimes(1)
  })
  it('pauses explicit cross origin redirects; confirmation resumes once and keeps the redirect budget',async () => {
    let count=0; const deps=dependencies(vi.fn(async () => redirect(`https://host${++count}.example/a`)))
    const service=new RemoteImageService(deps); const raw='https://images.example/a'
    let result=await service.load(raw,{mode:'explicit'})
    for(let i=0;i<3;i++) {
      expect(result).toMatchObject({ok:false,error:'REDIRECT_CONFIRM',continuation:expect.any(String)})
      if(result.ok || !('continuation' in result)) throw Error('missing confirmation')
      const continuation=result.continuation
      result=await service.load(raw,{mode:'explicit',continuation})
      expect(await service.load(raw,{mode:'explicit',continuation})).toEqual({ok:false,error:'UNAVAILABLE'})
    }
    expect(result).toEqual({ok:false,error:'UNAVAILABLE'}); expect(deps.request).toHaveBeenCalledTimes(4)
  })
  it('binds continuation to the verified source and refuses cross-source replay', async () => {
    const request = vi.fn().mockResolvedValueOnce(redirect('https://other.example/a')).mockResolvedValue(image())
    const service = new RemoteImageService(dependencies(request))
    const first = await service.load('https://images.example/a', {mode:'explicit',binding:'note A'})
    if (first.ok || !('continuation' in first)) throw Error('missing confirmation')
    expect(await service.load('https://images.example/a', {mode:'explicit',binding:'note B',continuation:first.continuation})).toEqual({ok:false,error:'UNAVAILABLE'})
  })
  it('bounds continuation lifetime across human confirmation',async () => {
    vi.useFakeTimers(); try {
      const service=new RemoteImageService(dependencies(vi.fn(async () => redirect('https://other.example/a'))))
      const first=await service.load('https://images.example/a',{mode:'explicit'})
      vi.advanceTimersByTime(20_001)
      expect(await service.load('https://images.example/a',{mode:'explicit',continuation:!first.ok && 'continuation' in first?first.continuation:''})).toEqual({ok:false,error:'UNAVAILABLE'})
    } finally {vi.useRealTimers()}
  })
  it('rejects oversize, disguised HTML and invalid URLs',async () => {
    expect(await new RemoteImageService(dependencies(),{maxBytes:8}).load('https://images.example/a')).toEqual({ok:false,error:'TOO_LARGE'})
    const deps=dependencies(vi.fn(async () => new Response('<html>',{headers:{'content-type':'image/png'}})))
    const service=new RemoteImageService(deps)
    expect(await service.load('https://images.example/a')).toEqual({ok:false,error:'NOT_IMAGE'})
    for(const url of ['file:///a','https://127.0.0.1/a','https://[::ffff:127.0.0.1]/a','https://u:p@example.com/a']) expect(await service.load(url)).toEqual({ok:false,error:'INVALID_URL'})
  })
  it('cancels DNS waits and active body reads',async () => {
    const controller=new AbortController()
    const deps=dependencies(); deps.resolve.mockImplementation(async () => new Promise(()=>{}))
    const pending=new RemoteImageService(deps).load('https://images.example/a',{mode:'auto',signal:controller.signal})
    controller.abort(); expect(await pending).toEqual({ok:false,error:'UNAVAILABLE'}); expect(deps.request).not.toHaveBeenCalled()
    let cancelled=false; const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true}})
    const controller2=new AbortController(); const deps2=dependencies(vi.fn(async () => new Response(body)))
    const pending2=new RemoteImageService(deps2).load('https://images.example/a',{mode:'auto',signal:controller2.signal})
    await vi.waitFor(()=>expect(deps2.request).toHaveBeenCalled()); controller2.abort()
    expect(await pending2).toEqual({ok:false,error:'UNAVAILABLE'}); expect(cancelled).toBe(true)
  })
  it('keeps four active and at most 32 queued; queued cancellation releases its entry',async () => {
    const releases:Array<()=>void>=[]; const deps=dependencies(vi.fn(async () => {await new Promise<void>(r=>releases.push(r)); return image()}))
    const service=new RemoteImageService(deps); const pending=Array.from({length:36},(_,i)=>service.load(`https://images.example/${i}`))
    await vi.waitFor(()=>expect(releases).toHaveLength(4)); expect(await service.load('https://images.example/busy')).toEqual({ok:false,error:'BUSY'})
    for(let i=0;i<36;i++){releases[i](); if(i<32)await vi.waitFor(()=>expect(releases).toHaveLength(i+5))}
    expect((await Promise.all(pending)).every(x=>x.ok)).toBe(true)
  })
  it('rechecks a queued source after acquiring its slot before DNS or connection', async () => {
    const releases: Array<() => void> = []
    const deps = dependencies(vi.fn(async () => { await new Promise<void>(r => releases.push(r)); return image() }))
    const service = new RemoteImageService(deps)
    const active = Array.from({length:4}, () => service.load('https://images.example/active'))
    await vi.waitFor(() => expect(releases).toHaveLength(4))
    let valid = true
    const validate = vi.fn(async () => valid)
    const queued = service.load('https://images.example/queued', {mode:'auto',validate})
    valid = false
    releases[0]()
    expect(await queued).toEqual({ok:false,error:'UNAVAILABLE'})
    expect(validate).toHaveBeenCalledTimes(1)
    expect(deps.resolve).toHaveBeenCalledTimes(4)
    expect(deps.request).toHaveBeenCalledTimes(4)
    releases.slice(1).forEach(release => release())
    await Promise.all(active)
  })
  it('rechecks source after DNS resolves and rejects stale source without connecting', async () => {
    const deps = dependencies()
    let finishDns!: (answers: typeof publicAddress[]) => void
    deps.resolve.mockImplementation(() => new Promise(resolve => { finishDns = resolve }))
    let valid = true
    const validate = vi.fn(async () => valid)
    const pending = new RemoteImageService(deps).load('https://images.example/a', {mode:'auto',validate})
    await vi.waitFor(() => expect(deps.resolve).toHaveBeenCalled())
    valid = false
    finishDns([publicAddress])
    expect(await pending).toEqual({ok:false,error:'UNAVAILABLE'})
    expect(validate).toHaveBeenCalledTimes(2)
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('rechecks source for the next redirect and confirmed continuation', async () => {
    const deps = dependencies()
    let valid = true
    const validate = vi.fn(async () => valid)
    deps.request.mockImplementationOnce(async () => {valid=false;return redirect('/next')})
    expect(await new RemoteImageService(deps).load('https://images.example/a', {mode:'auto',validate})).toEqual({ok:false,error:'UNAVAILABLE'})
    expect(deps.request).toHaveBeenCalledTimes(1)
    const explicitDeps = dependencies(vi.fn().mockResolvedValueOnce(redirect('https://other.example/a')).mockResolvedValue(image()))
    valid=true
    const service=new RemoteImageService(explicitDeps)
    const first=await service.load('https://images.example/a', {mode:'explicit',validate})
    if(first.ok || !('continuation' in first)) throw Error('missing continuation')
    valid=false
    expect(await service.load('https://images.example/a', {mode:'explicit',validate,continuation:first.continuation})).toEqual({ok:false,error:'UNAVAILABLE'})
    expect(explicitDeps.request).toHaveBeenCalledTimes(1)
  })
  it('cancels unresolved validation without connecting', async () => {
    const controller = new AbortController()
    const validate = vi.fn(async () => new Promise<boolean>(() => {}))
    const deps = dependencies()
    const pending = new RemoteImageService(deps).load('https://images.example/a', {mode:'auto',validate,signal:controller.signal})
    await vi.waitFor(() => expect(validate).toHaveBeenCalled())
    controller.abort()
    expect(await pending).toEqual({ok:false,error:'UNAVAILABLE'})
    expect(deps.resolve).not.toHaveBeenCalled()
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('removes an aborted waiter without consuming a connection slot', async () => {
    const releases: Array<() => void> = []
    const deps = dependencies(vi.fn(async () => { await new Promise<void>(r => releases.push(r)); return image() }))
    const service = new RemoteImageService(deps)
    const first = Array.from({length:4}, () => service.load('https://images.example/a'))
    await vi.waitFor(() => expect(releases).toHaveLength(4))
    const controller = new AbortController()
    const waiting = service.load('https://images.example/cancel', {mode:'auto',signal:controller.signal})
    controller.abort()
    expect(await waiting).toEqual({ok:false,error:'UNAVAILABLE'})
    releases.forEach(release => release())
    await Promise.all(first)
    expect(deps.request).toHaveBeenCalledTimes(4)
  })
  it('expires unresolved DNS within the same load deadline', async () => {
    vi.useFakeTimers()
    try {
      const deps = dependencies()
      deps.resolve.mockImplementation(async () => new Promise(() => {}))
      const pending = new RemoteImageService(deps).load('https://images.example/a')
      await vi.advanceTimersByTimeAsync(20_000)
      expect(await pending).toEqual({ok:false,error:'UNAVAILABLE'})
      expect(deps.request).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('evicts old image bytes beyond the 80 MiB display cache', async () => {
    const large = new Uint8Array(20 * 1024 * 1024)
    large.set(PNG)
    const deps = dependencies(vi.fn(async () => new Response(large)))
    const service = new RemoteImageService(deps)
    const first = await service.load('https://images.example/a')
    for (let i=0;i<4;i++) expect((await service.load('https://images.example/a')).ok).toBe(true)
    expect(first.ok && service.read(first.token)).toBeNull()
  })
  it('display protocol keeps SVG in image context and rejects document navigation',async () => {
    const deps=dependencies(vi.fn(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',{headers:{'content-type':'image/svg+xml'}})))
    const service=new RemoteImageService(deps); const loaded=await service.load('https://images.example/a'); expect(loaded.ok).toBe(true)
    if(!loaded.ok)return; attachRemoteImageProtocol(service); const handler=vi.mocked(protocol.handle).mock.calls.at(-1)![1]
    expect((await handler({url:remoteImageUrl(loaded.token),destination:'document'} as Request)).status).toBe(403)
    const response=await handler({url:remoteImageUrl(loaded.token),destination:'image'} as Request)
    expect(response.headers.get('content-type')).toBe('image/svg+xml'); expect(response.headers.get('content-security-policy')).toContain("sandbox")
  })
})
