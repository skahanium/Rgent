import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '../../src/shared/ipc.ts'

/** index.ts 的联网配置接线：只关 native 也必须撤掉活动任务的联网能力。
 *  AgentHost 用替身，只观察 `revokeNetworkForAll` 是否被调用；不碰真实任务。 */
const state = vi.hoisted(() => ({
  data: '',
  handles: new Map<string, Function>(),
  win: null as any,
  revokedNetwork: 0,
  dialogs: 0
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class BrowserWindow extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      id: 1,
      mainFrame: { routingId: 10, url: '', detached: false, isDestroyed: () => false },
      isDestroyed: () => false,
      getURL: () => this.webContents.mainFrame.url,
      send: vi.fn(),
      setWindowOpenHandler: () => {}
    })
    constructor() { super(); state.win = this }
    static getAllWindows() { return state.win && !state.win.destroyed ? [state.win] : [] }
    isDestroyed() { return this.destroyed }
    loadFile(file: string) { this.webContents.mainFrame.url = new URL('file://' + file).href; return Promise.resolve() }
    loadURL(url: string) { this.webContents.mainFrame.url = url; return Promise.resolve() }
    close() { this.destroyed = true; this.emit('closed') }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPath: () => state.data,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    quit: vi.fn()
  })
  return {
    app, BrowserWindow,
    ipcMain: { handle: (name: string, fn: Function) => state.handles.set(name, fn), on: vi.fn() },
    dialog: {
      showMessageBox: vi.fn(async () => { state.dialogs += 1; return { response: 0 } }),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      showSaveDialog: vi.fn()
    },
    Menu: { buildFromTemplate: (value: unknown) => value, setApplicationMenu: vi.fn() },
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system' }),
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
    shell: { openExternal: vi.fn() }
  }
})

vi.mock('../../src/main/ipc-sender.ts', () => ({ isTrustedIpcSender: () => true }))
vi.mock('../../src/main/agent-host.ts', () => ({
  AgentHost: class {
    active() { return [] }
    hasPending() { return false }
    whenLaunchesSettled() { return Promise.resolve() }
    cancelAll() { return Promise.resolve() }
    retryPending() { return Promise.resolve() }
    clearNetworkPreviews() {}
    discardPending() {}
    revokeNetworkForAll() { state.revokedNetwork += 1; return 0 }
    revokeMcpForAll() { return 0 }
  }
}))

const event = () => ({ sender: state.win.webContents, senderFrame: state.win.webContents.mainFrame })
const invoke = (channel: string, ...args: unknown[]) => state.handles.get(channel)!(event(), ...args)

let root = ''
beforeEach(async () => {
  vi.resetModules()
  state.handles.clear()
  state.win = null
  state.revokedNetwork = 0
  state.dialogs = 0
  root = mkdtempSync(path.join(os.tmpdir(), 'rgent-native-revoke-'))
  state.data = path.join(root, 'device')
  mkdirSync(state.data)
  await import('../../src/main/index.ts')
  await vi.waitFor(() => expect(state.win).toBeTruthy())
})
afterEach(() => { state.win?.emit('will-quit'); rmSync(root, { recursive: true, force: true }) })

it('只关 native 配置也触发 revokeNetworkForAll，且没有新增对话框', async () => {
  // 先打开 native；这一步本身也算配置变化，会撤一次，先记下基线。
  const enabled = await invoke(IPC.networkConfig, { nativeSearch: { minimax: true } })
  expect(enabled).toMatchObject({ ok: true, config: { nativeSearch: { minimax: true } } })
  state.revokedNetwork = 0
  const disabled = await invoke(IPC.networkConfig, { nativeSearch: { minimax: false } })
  expect(disabled).toMatchObject({ ok: true, config: { nativeSearch: { minimax: false } } })
  expect(state.revokedNetwork).toBe(1)
  expect(state.dialogs).toBe(0)
})
