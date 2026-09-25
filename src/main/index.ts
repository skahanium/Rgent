import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { shouldCloseAfterFlush } from '../shared/flush.ts'
import { IPC, type FlushDonePayload, type NoteWriteRequest, type SetPermissionRequest } from '../shared/ipc.ts'
import { attachVaultProtocol, registerVaultScheme } from './vault-protocol.ts'
import { VaultSession } from './vault.ts'

registerVaultScheme()

const here = path.dirname(fileURLToPath(import.meta.url))

/** 退出前给渲染进程留的写盘窗口。渲染进程没回应也不能把它卡死在这里。 */
const FLUSH_GRACE_MS = 1000

let mainWindow: BrowserWindow | null = null
let vault: VaultSession | null = null
let quitting = false
let flushed = false
let settleFlush: ((close: boolean) => void) | null = null
let flushTimer: NodeJS.Timeout | null = null

function finishFlush(close: boolean): void {
  const settle = settleFlush
  if (!settle) return
  settleFlush = null
  settle(close)
}

function send(channel: string, payload?: unknown): void {
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, payload)
}

function createWindow(): void {
  flushed = false
  flushTimer = null
  settleFlush = null
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    title: 'Rgent',
    backgroundColor: '#f4efe6',
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 关窗前先让渲染进程把脏稿写完。写失败则留下窗口；渲染进程挂了才靠超时关。
  mainWindow.on('close', (event) => {
    if (flushed) return
    event.preventDefault()
    if (settleFlush) return
    const win = mainWindow
    if (!win) return
    flushTimer = setTimeout(() => {
      const alive = Boolean(win && !win.isDestroyed() && !win.webContents.isDestroyed())
      if (!alive) finishFlush(shouldCloseAfterFlush(false, false))
    }, FLUSH_GRACE_MS)
    settleFlush = (close) => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (!close) return
      flushed = true
      if (quitting) app.quit()
      else win.close()
    }
    if (win.webContents.isDestroyed()) finishFlush(shouldCloseAfterFlush(false, false))
    else send(IPC.flushRequest)
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(path.join(here, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开库…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send(IPC.menuOpenVault)
        },
        {
          label: '新建笔记',
          accelerator: 'CmdOrCtrl+N',
          click: () => send(IPC.menuNewNote)
        },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => send(IPC.menuSave)
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  ipcMain.handle(IPC.vaultGet, () => vault?.currentState() ?? { status: 'needs-pick', reason: 'first-run' })
  ipcMain.handle(IPC.vaultPick, async () => {
    if (!vault) return { status: 'needs-pick', reason: 'first-run' }
    return vault.pick(mainWindow)
  })
  ipcMain.handle(IPC.treeList, async () => vault?.tree() ?? [])
  ipcMain.handle(IPC.noteRead, async (_event, relPath: unknown) => {
    const pathInVault = asString(relPath)
    if (!pathInVault) throw new Error('BAD_PATH')
    if (!vault) throw new Error('NO_VAULT')
    return vault.read(pathInVault)
  })
  ipcMain.handle(IPC.noteWrite, async (_event, value: unknown) => {
    const request = value as Partial<NoteWriteRequest> | null
    const pathInVault = asString(request?.relPath)
    const content = asString(request?.content)
    const expectedRevision = asString(request?.expectedRevision)
    if (!pathInVault || content == null || !expectedRevision) return { ok: false, error: 'BAD_PATH' }
    if (!vault) return { ok: false, error: 'NO_VAULT' }
    try {
      const revision = await vault.write(pathInVault, content, expectedRevision)
      return { ok: true, revision }
    } catch (err) {
      return { ok: false, error: err instanceof Error && err.message === 'CONFLICT' ? 'CONFLICT' : 'IO_ERROR' }
    }
  })
  ipcMain.handle(IPC.permissionsGet, async () => vault?.permissions() ?? { status: 'invalid', error: '未选择库' })
  ipcMain.handle(IPC.permissionsSet, async (_event, value: unknown) => {
    const request = value as Partial<SetPermissionRequest> | null
    const relPath = asString(request?.relPath)
    const tier = request?.tier
    if (!relPath || (tier !== 'reference' && tier !== 'follow' && tier !== 'forbidden')) throw new Error('BAD_PERMISSION')
    if (!vault) throw new Error('NO_VAULT')
    return vault.setPermission(relPath, tier)
  })
  ipcMain.handle(IPC.noteCreate, async (_event, name: unknown) => {
    const noteName = asString(name)
    if (!noteName) throw new Error('BAD_PATH')
    if (!vault) throw new Error('NO_VAULT')
    return vault.create(noteName)
  })
  ipcMain.handle(IPC.backlinks, async (_event, relPath: unknown) => {
    const pathInVault = asString(relPath)
    if (!pathInVault) return []
    return vault?.backlinks(pathInVault) ?? []
  })
  ipcMain.handle(IPC.search, async (_event, query: unknown) => {
    const text = asString(query)
    if (text == null) return []
    return vault?.search(text) ?? []
  })
  ipcMain.on(IPC.flushDone, (_event, payload: FlushDonePayload) => {
    const ok = payload != null && payload.ok === true
    finishFlush(shouldCloseAfterFlush(ok, true))
  })
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

app.whenReady().then(() => {
  vault = new VaultSession(app.getPath('userData'), send)
  vault.restore()
  attachVaultProtocol(() => vault)
  registerIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
})

// 必须等渲染进程写完盘再拆库：退出前那次 flush 还要经 noteWrite 落盘。
app.on('will-quit', () => {
  vault?.dispose()
})
