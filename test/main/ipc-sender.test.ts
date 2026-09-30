import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isTrustedIpcSender } from '../../src/main/ipc-sender.ts'

function fixture(url = 'http://localhost:5173/') {
  const frame = { url, detached: false, isDestroyed: () => false }
  const contents = { mainFrame: frame, getURL: () => url, isDestroyed: () => false }
  const window = { webContents: contents, isDestroyed: () => false }
  return { frame, contents, window, event: { sender: contents, senderFrame: frame }, url }
}

describe('IPC sender guard', () => {
  it('accepts only the current main window and live main frame at the exact configured dev entry', () => {
    const f = fixture()
    expect(isTrustedIpcSender(f.event, f.window, f.url)).toBe(true)
  })
  it('accepts the exact production file entry including encoded filename characters', () => {
    const f = fixture(pathToFileURL('/tmp/Rgent 中文/renderer/index.html').href)
    expect(isTrustedIpcSender(f.event, f.window, f.url)).toBe(true)
    expect(isTrustedIpcSender(f.event, f.window, 'file:///tmp/other/index.html')).toBe(false)
  })
  it('rejects null window/frame, other windows and child or replaced frames even at the same URL', () => {
    const f = fixture()
    expect(isTrustedIpcSender(f.event, null, f.url)).toBe(false)
    expect(isTrustedIpcSender({ ...f.event, senderFrame: null }, f.window, f.url)).toBe(false)
    expect(isTrustedIpcSender(f.event, fixture().window, f.url)).toBe(false)
    expect(isTrustedIpcSender({ ...f.event, senderFrame: { ...f.frame } }, f.window, f.url)).toBe(false)
    f.contents.mainFrame = { ...f.frame }
    expect(isTrustedIpcSender(f.event, f.window, f.url)).toBe(false)
  })
  it.each(['http://localhost:5173/other', 'http://localhost:5173/?x=1', 'http://localhost:5173/#other',
    'http://localhost:5174/', 'https://localhost:5173/', 'https://attacker.test/'])('rejects navigation to %s', (url) => {
    const f = fixture()
    f.frame.url = url
    expect(isTrustedIpcSender(f.event, f.window, f.url)).toBe(false)
    f.frame.url = f.url
    f.contents.getURL = () => url
    expect(isTrustedIpcSender(f.event, f.window, f.url)).toBe(false)
  })
  it.each(['window', 'contents', 'frame'] as const)('rejects destroyed %s', (part) => {
    const f = fixture()
    f[part].isDestroyed = () => true
    expect(isTrustedIpcSender(f.event, f.window, f.url)).toBe(false)
  })
  it('fails closed for detached frames and destroyed-object property access errors', () => {
    const f = fixture()
    f.frame.detached = true
    expect(isTrustedIpcSender(f.event, f.window, f.url)).toBe(false)
    Object.defineProperty(f.event, 'senderFrame', { get: () => { throw new Error('disposed') } })
    expect(isTrustedIpcSender(f.event, f.window, f.url)).toBe(false)
  })
  it('registers every application invoke and event through the shared guard', () => {
    const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/ipcMain\.(?:handle|on)\(IPC\./)
    expect(source).toMatch(/registerTrustedHandle\(IPC\.noteWrite/)
    expect(source).toMatch(/registerTrustedOn\(IPC\.flushDone/)
    expect(source).toMatch(/registerTrustedOn\(IPC\.lifecycleFlushDone/)
  })
})
