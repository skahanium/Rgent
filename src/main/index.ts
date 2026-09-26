import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CloseFlow, timeoutAction, type CloseAction, type CloseDecision } from '../shared/flush.ts'
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
let rendererGone = false
let closeFlow = new CloseFlow()
let flushTimer: NodeJS.Timeout | null = null

function clearFlushTimer(): void {
  if (!flushTimer) return
  clearTimeout(flushTimer)
  flushTimer = null
}

function send(channel: string, payload?: unknown): void {
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, payload)
}

function runCloseAction(action: CloseAction, win: BrowserWindow, stalled = false): void {
  if (action === 'none') return
  if (action !== 'flush') clearFlushTimer()
  if (action === 'flush') {
    clearFlushTimer()
    if (win.webContents.isDestroyed()) {
      runCloseAction(closeFlow.rendererGone(), win)
      return
    }
    flushTimer = setTimeout(() => {
      const alive = !rendererGone && !win.isDestroyed() && !win.webContents.isDestroyed()
      // 渲染进程只是挂起（或计时器触发之后才崩）也要给出一条出路，
      // 否则流程停在 flushing，窗口关不掉、Cmd+Q 也被挡住。
      const next = timeoutAction(closeFlow, alive)
      runCloseAction(next, win, next === 'prompt')
    }, FLUSH_GRACE_MS)
    win.webContents.send(IPC.flushRequest)
  } else if (action === 'prompt') {
    const abandon = quitting || process.platform !== 'darwin'
      ? '放弃未保存修改并退出应用'
      : '放弃未保存修改并关闭窗口'
    void dialog.showMessageBox(win, {
      type: 'warning',
      title: stalled ? '保存没有回应' : '笔记尚未保存',
      message: stalled ? '窗口没有在时限内确认写盘结果。' : '写盘失败，仍有未保存的修改。',
      detail: stalled
        ? '可以重试保存、继续编辑，或明确放弃本次未保存的修改。若窗口已无响应，只有后两项可选。'
        : '可以重试保存、继续编辑，或明确放弃本次未保存的修改。',
      buttons: ['重试保存', '继续编辑', abandon],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }).then(({ response }) => {
      const choice: CloseDecision = response === 0 ? 'retry' : response === 2 ? 'discard' : 'continue'
      runCloseAction(closeFlow.decide(choice), win, stalled)
    }).catch(() => {
      runCloseAction(closeFlow.decide('continue'), win)
    })
  } else if (action === 'cancel') {
    quitting = false
  } else if (action === 'close') {
    flushed = true
    if (quitting) app.quit()
    else if (!win.isDestroyed()) win.close()
  }
}

function createWindow(): void {
  flushed = false
  rendererGone = false
  flushTimer = null
  closeFlow = new CloseFlow()
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
  mainWindow.webContents.on('render-process-gone', () => {
    rendererGone = true
    // 渲染进程没了本身就要推进关窗流程：只置标志的话，若它是在超时之后才崩的，
    // CloseFlow 会永远停在 flushing，窗口再也关不掉。空闲态这里返回 'none'，无副作用。
    const win = mainWindow
    if (win) runCloseAction(closeFlow.rendererGone(), win)
  })

  // 关窗前先写盘；失败时由主进程给出重试、继续编辑或明确放弃的选择。
  mainWindow.on('close', (event) => {
    if (flushed) return
    event.preventDefault()
    const win = mainWindow
    if (!win) return
    runCloseAction(closeFlow.request(), win)
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
  ipcMain.on(IPC.flushDone, (event, payload: FlushDonePayload) => {
    const win = mainWindow
    if (!win || event.sender !== win.webContents) return
    const ok = payload != null && payload.ok === true
    runCloseAction(closeFlow.flushed(ok), win)
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
