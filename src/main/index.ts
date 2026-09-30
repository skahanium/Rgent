import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, safeStorage, shell } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CloseFlow, timeoutAction, type CloseAction, type CloseDecision } from '../shared/flush.ts'
import { asString, parseEntryCreateRequest, parseFlushDone, parseLifecycleRetryRequest, parseNoteName, parseNoteWriteRequest, parseRelocationCommitRequest, parseRelocationPreviewRequest, parseSetPermissionRequest } from '../shared/ipc-guard.ts'
import { IPC } from '../shared/ipc.ts'
import type { AgentStartRequest, AgentStartResult, LifecycleRetryResult, LimitTier, ModelConfigResult, ModelLimitsSetRequest, ModelProfileSetRequest, ModelProvider, ReadingPreference, ReadingSetResult, RelocationCommitResult, RelocationPreviewResult, ThemeMode, ThemeSetResult } from '../shared/ipc.ts'
import type { RemoteImageGetResult } from '../shared/ipc.ts'
import { isThemeMode, loadReadingPreference, loadThemePreference, saveReadingPreference, saveThemePreference } from './theme-preference.ts'
import { isReadingPreference } from '../shared/reading-preference.ts'
import { attachVaultProtocol } from './vault-protocol.ts'
import { verifyImageSource } from './image-source.ts'
import { RemoteImageService, REMOTE_IMAGE_SCHEME, remoteImageUrl } from './remote-image.ts'
import { attachRemoteImageProtocol } from './remote-image-protocol.ts'
import { VAULT_MEDIA_SCHEME } from '../shared/vault-rel.ts'
import { VaultSession } from './vault.ts'
import { createModelConfigStore, type ModelConfigStore } from './model-config.ts'
import { AgentHost } from './agent-host.ts'
import { modelTierFor } from './permissions.ts'
import { streamModelText } from './model-stream.ts'
import { VaultStructureGate } from './vault-mutation-queue.ts'
import { isTrustedIpcSender } from './ipc-sender.ts'

protocol.registerSchemesAsPrivileged([
  { scheme: VAULT_MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: REMOTE_IMAGE_SCHEME, privileges: { standard: true, secure: true } }
])

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererDevelopmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const rendererEntryUrl = rendererDevelopmentUrl ? new URL(rendererDevelopmentUrl).href
  : pathToFileURL(path.join(here, '../renderer/index.html')).href

/** 退出前给渲染进程留的写盘窗口。渲染进程没回应也不能把它卡死在这里。 */
const FLUSH_GRACE_MS = 1000

let mainWindow: BrowserWindow | null = null
let vault: VaultSession | null = null
let quitting = false
let flushed = false
let rendererGone = false
let closeFlow = new CloseFlow()
let flushTimer: NodeJS.Timeout | null = null
let themeMode: ThemeMode = 'system'
let remoteImages: RemoteImageService | null = null
let modelConfig: ModelConfigStore | null = null
let modelConfigError: string | null = null
let agentHost: AgentHost | null = null
let cancellingForClose = false
const imageControllers = new Map<AbortController, {vault: VaultSession; binding: string; request: import('../shared/ipc.ts').RemoteImageGetRequest}>()
const lifecycleFlushes = new Map<string, (ok: boolean) => void>()
const structureGate = new VaultStructureGate()
const lifecycleErrorCodes = new Set(['BAD_PATH', 'BAD_REQUEST', 'NO_VAULT', 'VAULT_CHANGED', 'STALE_PREVIEW',
  'STALE_RECOVERY', 'EEXIST', 'ENOENT', 'PATH_CHANGED', 'UNSAFE_PATH', 'PERMISSION_DOWNGRADE',
  'PERMISSION_COLLISION', 'PERMISSIONS_INVALID', 'UNSAVED_DRAFT', 'PREVIOUS_TASK_UNSAVED',
  'LIFECYCLE_RECOVERY_REQUIRED', 'STRUCTURE_BUSY', 'OTHER_TASK_RUNNING', 'ATTACHMENT_COLLISION', 'LINK_SCAN_FAILED'])

function lifecycleError(error: unknown, fallback: string): string {
  return error instanceof Error && lifecycleErrorCodes.has(error.message) ? error.message : fallback
}

function blocksStructureWrite(relPath: string): boolean {
  return !!vault?.root && structureGate.blocksWrite(vault.root, relPath)
}

async function flushBeforeStructure(win: BrowserWindow, cleanUnavailablePaths: readonly string[] = []): Promise<boolean> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return false
  const id = randomUUID()
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      lifecycleFlushes.delete(id)
      resolve(false)
    }, 120_000)
    lifecycleFlushes.set(id, (ok) => { clearTimeout(timer); lifecycleFlushes.delete(id); resolve(ok) })
    win.webContents.send(IPC.lifecycleFlushRequest, id, cleanUnavailablePaths)
  })
}

function clearFlushTimer(): void {
  if (!flushTimer) return
  clearTimeout(flushTimer)
  flushTimer = null
}

function send(channel: string, payload?: unknown): void {
  if (channel === IPC.treeChanged || channel === IPC.noteExternalChange || channel === IPC.vaultLost) {
    for (const [controller, active] of imageControllers) {
      const c = active.request.context!
      void active.vault.read(c.noteRelPath).then(snapshot => {
        const proof = verifyImageSource(snapshot,active.request)
        if (!proof.ok || proof.binding!==active.binding || active.vault.sessionId()!==c.sessionId) controller.abort()
      }).catch(()=>controller.abort())
    }
    const current = vault; const token = current?.sessionId()
    for (const task of agentHost?.active() ?? []) {
      if (!current || task.root !== current.root) continue
      const binding = agentHost?.bindingFor(task.root,task.relPath)
      if (binding) void current.noteStatus(task.relPath,binding).then(state => {
        if(current.sessionId()===token && state.status!=='ready') void agentHost?.cancel(task.id,'user').catch(()=>{})
      }).catch(()=>{})
    }
  }
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, payload)
}

async function settleHostBeforeClose(win: BrowserWindow): Promise<boolean> {
  try { await agentHost?.cancelAll('close') } catch { /* pending answer is retained for retry below */ }
  while (agentHost?.hasPending()) {
    try { await agentHost.retryPending() } catch { /* ask the person before discarding generated bytes */ }
    if (!agentHost.hasPending()) break
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '生成内容尚未保存',
      message: '模型已停止，但部分回答或账本写入失败。',
      detail: '可以重试保存、继续编辑，或明确放弃尚未写盘的生成内容。',
      buttons: ['重试保存', '继续编辑', '明确放弃生成内容并关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (response === 1) { quitting = false; return false }
    if (response === 2) { agentHost.discardPending(); break }
  }
  return true
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
  const dark = nativeTheme.shouldUseDarkColors
  // 主进程读不到渲染层的 CSS token，所以窗口外观这两个色值是第二份拷贝：
  // 必须与 src/renderer/src/styles.css 的 --surface-nav 同值（日 #f5f6f8 / 夜 #1d2933）。
  // 见 docs/architecture.md「颜色只有一个来源」那一行的已知例外。
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    title: 'Rgent',
    backgroundColor: dark ? '#1d2933' : '#f5f6f8',
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      // hiddenInset 默认交通灯偏上；将原生控件移到 46px tab 栏的中线。
      trafficLightPosition: { x: 13, y: 16 }
    } : {}),
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: {
        color: dark ? '#1d2933' : '#f5f6f8',
        symbolColor: dark ? '#dfe3e8' : '#1c1f23',
        height: 46
      }
    } : {}),
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // 同上的第二份拷贝：跟随系统切换时两处一起改，别只改上面创建时那一处。
  const updateWindowTheme = (): void => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    const isDark = nativeTheme.shouldUseDarkColors
    win.setBackgroundColor(isDark ? '#1d2933' : '#f5f6f8')
    if (process.platform === 'win32') win.setTitleBarOverlay({
      color: isDark ? '#1d2933' : '#f5f6f8',
      symbolColor: isDark ? '#dfe3e8' : '#1c1f23',
      height: 46
    })
  }
  nativeTheme.on('updated', updateWindowTheme)

  mainWindow.on('closed', () => {
    nativeTheme.off('updated', updateWindowTheme)
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
    if (cancellingForClose) return
    if (agentHost?.active().length || agentHost?.hasPending()) {
      cancellingForClose = true
      void settleHostBeforeClose(win).then((proceed) => {
        if (proceed && !win.isDestroyed()) runCloseAction(closeFlow.request(), win)
      }).finally(() => { cancellingForClose = false })
    } else runCloseAction(closeFlow.request(), win)
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
  })

  const rendererUrl = rendererDevelopmentUrl
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
  const trusted = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    isTrustedIpcSender(event, mainWindow, rendererEntryUrl)
  const registerTrustedHandle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error('BAD_SENDER')
      return listener(event, ...args)
    })
  }
  const registerTrustedOn = (channel: string, listener: Parameters<typeof ipcMain.on>[1]): void => {
    ipcMain.on(channel, (event, ...args) => {
      if (trusted(event)) listener(event, ...args)
    })
  }
  const configResult = (): ModelConfigResult => modelConfig
    ? { ok: true, config: modelConfig.getPublic() }
    : { ok: false, error: modelConfigError ?? 'MODEL_CONFIG_UNAVAILABLE' }
  registerTrustedHandle(IPC.modelConfigGet, (event): ModelConfigResult =>
    trusted(event) ? configResult() : { ok: false, error: 'BAD_SENDER' })
  registerTrustedHandle(IPC.modelProfileSet, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event) || !modelConfig) return { ok: false, error: 'MODEL_CONFIG_UNAVAILABLE' }
    const request = value as Partial<ModelProfileSetRequest> | null
    if (!request || typeof request !== 'object' || !request.fields || typeof request.fields !== 'object' ||
        (request.newKey !== undefined && typeof request.newKey !== 'string')) return { ok: false, error: 'BAD_REQUEST' }
    try {
      modelConfig.updateProfile(request.provider as ModelProvider, request.fields, request.newKey)
      return configResult()
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.modelSelect, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event) || !modelConfig) return { ok: false, error: 'MODEL_CONFIG_UNAVAILABLE' }
    try { modelConfig.select(value as ModelProvider); return configResult() }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.modelKeyDelete, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event) || !modelConfig) return { ok: false, error: 'MODEL_CONFIG_UNAVAILABLE' }
    try { modelConfig.deleteKey(value as ModelProvider); return configResult() }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.modelLimitsSet, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event) || !modelConfig || !value || typeof value !== 'object') return { ok: false, error: 'BAD_REQUEST' }
    const request = value as Partial<ModelLimitsSetRequest>
    try { modelConfig.updateLimits(request.tier as LimitTier, request.limits!); return configResult() }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.agentTasks, (event) => trusted(event)
    ? agentHost?.active().map(({ id, relPath, startedAt }) => ({ id, relPath, startedAt })) ?? [] : [])
  registerTrustedHandle(IPC.agentCancel, async (event, value: unknown) => {
    if (!trusted(event) || typeof value !== 'string' || value.length > 128) return false
    return Boolean(await agentHost?.cancel(value, 'user'))
  })
  registerTrustedHandle(IPC.agentStart, async (event, value: unknown): Promise<AgentStartResult> => {
    if (!trusted(event) || !agentHost || !value || typeof value !== 'object') return { ok: false, error: 'BAD_REQUEST' }
    const request = value as Partial<AgentStartRequest>
    if (typeof request.relPath !== 'string' || typeof request.expectedText !== 'string' ||
        typeof request.promptText !== 'string' || request.promptText.length > 20000 ||
        typeof request.sessionId !== 'string' || typeof request.objectVersion !== 'string' || typeof request.expectedRevision !== 'string' ||
        !request.range || !Number.isSafeInteger(request.range.start) || !Number.isSafeInteger(request.range.end)) {
      return { ok: false, error: 'BAD_REQUEST' }
    }
    if (structureGate.isBusy()) return { ok: false, error: 'NOTE_BUSY' }
    try {
      const task = await agentHost.start(request as AgentStartRequest)
      void task.done.catch(() => {})
      return { ok: true, id: task.id }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'AGENT_START_FAILED' } }
  })
  registerTrustedHandle(IPC.remoteImageGet, async (_event, value: unknown): Promise<RemoteImageGetResult> => {
    if (!remoteImages || !vault || !value || typeof value !== 'object') return { ok: false, error: 'NOT_ALLOWED' }
    const request = value as import('../shared/ipc.ts').RemoteImageGetRequest
    const c = request.context
    if (typeof request.url !== 'string' || !c || typeof c.noteRelPath !== 'string' ||
        typeof c.sessionId !== 'string' || typeof c.objectVersion !== 'string' || typeof c.revision !== 'string' ||
        (c.draftBody !== undefined && (typeof c.draftBody !== 'string' || c.draftBody.length > 16 * 1024 * 1024)) ||
        (request.continuation !== undefined && typeof request.continuation !== 'string')) return { ok: false, error: 'NOT_ALLOWED' }
    try {
      const token = vault.captureSession()
      if (c.sessionId !== token) return { ok: false, error: 'NOT_ALLOWED' }
      const snapshot = await vault.read(c.noteRelPath)
      const proof = verifyImageSource(snapshot, request)
      if (!proof.ok) return { ok: false, error: 'NOT_ALLOWED' }
      const controller = new AbortController()
      const currentVault = vault
      imageControllers.set(controller,{vault:currentVault,binding:proof.binding,request})
      let result: Awaited<ReturnType<RemoteImageService['load']>>
      try {
        result = await remoteImages.load(request.url, { mode: request.mode, allowHttp: request.allowHttp === true,
          continuation: request.continuation, binding: proof.binding, signal: controller.signal,
          validate: async () => {
            try {
              currentVault.assertSession(token)
              const checked = verifyImageSource(await currentVault.read(c.noteRelPath),request)
              return checked.ok && checked.binding===proof.binding
            } catch { return false }
          } })
      } finally { imageControllers.delete(controller) }
      currentVault.assertSession(token)
      const current = await currentVault.read(c.noteRelPath)
      if (!verifyImageSource(current, request).ok) return { ok: false, error: 'NOT_ALLOWED' }
      return result.ok ? { ok: true, src: remoteImageUrl(result.token) } : result
    } catch { return { ok: false, error: 'NOT_ALLOWED' } }
  })
  registerTrustedHandle(IPC.themeGet, () => themeMode)
  registerTrustedHandle(IPC.readingGet, () => loadReadingPreference(app.getPath('userData')))
  registerTrustedHandle(IPC.readingSet, (_event, value: unknown): ReadingSetResult => {
    if (!isReadingPreference(value)) return { ok: false, error: 'BAD_READING' }
    try {
      saveReadingPreference(app.getPath('userData'), value)
      return { ok: true, reading: value as ReadingPreference }
    } catch { return { ok: false, error: 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.themeSet, (_event, value: unknown): ThemeSetResult => {
    if (!isThemeMode(value)) return { ok: false, error: 'BAD_MODE' }
    try {
      saveThemePreference(app.getPath('userData'), value)
      themeMode = value
      nativeTheme.themeSource = value === 'day' ? 'light' : value === 'night' ? 'dark' : 'system'
      return { ok: true, mode: value }
    } catch {
      return { ok: false, error: 'IO_ERROR' }
    }
  })
  registerTrustedHandle(IPC.vaultGet, () => vault?.currentState() ?? { status: 'needs-pick', reason: 'first-run' })
  registerTrustedHandle(IPC.vaultPick, async () => {
    if (!vault) return { status: 'needs-pick', reason: 'first-run' }
    if (structureGate.isBusy()) throw new Error('STRUCTURE_BUSY')
    for(const controller of imageControllers.keys()) controller.abort()
    return vault.pick(mainWindow)
  })
  registerTrustedHandle(IPC.treeList, async () => vault?.tree() ?? [])
  registerTrustedHandle(IPC.noteRead, async (_event, relPath: unknown) => {
    const pathInVault = asString(relPath)
    if (!pathInVault) throw new Error('BAD_PATH')
    if (!vault) throw new Error('NO_VAULT')
    return vault.read(pathInVault)
  })
  registerTrustedHandle(IPC.noteWrite, async (_event, value: unknown) => {
    const request = parseNoteWriteRequest(value)
    if (!request) return { ok: false, error: 'BAD_PATH' }
    if (!vault) return { ok: false, error: 'NO_VAULT' }
    if (blocksStructureWrite(request.relPath)) return { ok: false, error: 'NOTE_BUSY' }
    try {
      const result = await vault.write(request.relPath, request.content, request.expectedRevision, request)
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: err instanceof Error && ['CONFLICT', 'NOTE_MISSING', 'NOTE_REPLACED', 'NOTE_UNREADABLE', 'VAULT_CHANGED', 'LEDGER_BOUNDARY_INVALID'].includes(err.message) ? err.message : 'IO_ERROR' }
    }
  })
  const parseBinding = (value: unknown): import('../shared/ipc.ts').NoteInspectRequest | null => {
    if (!value || typeof value !== 'object') return null
    const r = value as import('../shared/ipc.ts').NoteInspectRequest
    return typeof r.relPath === 'string' && typeof r.sessionId === 'string' && typeof r.objectVersion === 'string' ? r : null
  }
  registerTrustedHandle(IPC.noteInspect, async (_event, value: unknown) => {
    const r = parseBinding(value)
    if (!r || !vault) throw new Error('BAD_REQUEST')
    const state = await vault.noteStatus(r.relPath, r)
    if (state.status !== 'ready') {
      for (const task of agentHost?.active().filter(t => t.root === vault!.root && t.relPath === r.relPath) ?? []) {
        await agentHost?.cancel(task.id, 'user').catch(() => {})
      }
      vault.assertSession(r.sessionId)
    }
    return state
  })
  registerTrustedHandle(IPC.noteAbandon, async (_event, value: unknown) => {
    const r = parseBinding(value)
    if (!r || !vault) return false
    vault.assertSession(r.sessionId)
    if ((await vault.noteStatus(r.relPath, r)).status === 'ready') return false
    const root = vault.root!
    for (const task of agentHost?.active().filter(t => t.root === root && t.relPath === r.relPath) ?? []) await agentHost?.cancel(task.id, 'user').catch(() => {})
    vault.assertSession(r.sessionId)
    const chapters = agentHost?.pendingChapters(root, r.relPath, r.sessionId, r.objectVersion) ?? []
    agentHost?.acknowledgeCopied(root, r.relPath, chapters)
    return true
  })
  registerTrustedHandle(IPC.noteSaveCopyPreview, async (_event, value: unknown) => {
    if (!value || typeof value !== 'object' || !vault || structureGate.isBusy()) return { ok: false, error: 'BAD_REQUEST' }
    const r = value as import('../shared/ipc.ts').SaveCopyPreviewRequest
    if (![r.source,r.target,r.body,r.draftVersion,r.sessionId,r.objectVersion].every(v => typeof v === 'string') || r.body.length > 16*1024*1024) return { ok:false,error:'BAD_REQUEST' }
    try {
      const current = vault; const root = current.root!
      current.assertSession(r.sessionId)
      await agentHost?.whenLaunchesSettled()
      for (const task of agentHost?.active().filter(t=>t.root===root && t.relPath===r.source) ?? []) await agentHost?.cancel(task.id, 'user').catch(()=>{})
      current.assertSession(r.sessionId)
      const chapters = agentHost?.pendingChapters(root,r.source,r.sessionId,r.objectVersion) ?? []
      const preview = await current.previewSaveCopy(r,chapters)

      return {ok:true,preview}
    } catch(error) { return {ok:false,error:error instanceof Error ? error.message : 'IO_ERROR'} }
  })
  registerTrustedHandle(IPC.noteSaveCopyCommit, async (_event,value:unknown) => {
    if (!value || typeof value !== 'object' || !vault || structureGate.isBusy()) return {ok:false,error:'BAD_REQUEST'}
    const r = value as import('../shared/ipc.ts').SaveCopyCommitRequest
    if (![r.id,r.sessionId,r.draftVersion,r.body].every(v=>typeof v==='string') || r.body.length>16*1024*1024) return {ok:false,error:'BAD_REQUEST'}
    const prepared = vault.saveCopyRequestById(r.id)
    const c = prepared ? {relPath:prepared.source,sessionId:prepared.sessionId,objectVersion:prepared.objectVersion} : null
    if (!c || c.sessionId !== r.sessionId) return {ok:false,error:'STALE_PREVIEW'}
    try {
      const current=vault; const root=current.root!
      current.assertSession(r.sessionId)
      const chapters=agentHost?.pendingChapters(root,c.relPath,c.sessionId,c.objectVersion) ?? []
      const result=await current.commitSaveCopy(r,chapters)
      current.assertSession(r.sessionId)
      agentHost?.acknowledgeCopied(root,c.relPath,chapters)
      return {ok:true,...result}
    } catch(error) { return {ok:false,error:error instanceof Error ? error.message : 'IO_ERROR'} }
  })
  registerTrustedHandle(IPC.permissionsGet, async () => vault?.permissions() ?? { status: 'invalid', error: '未选择库' })
  registerTrustedHandle(IPC.permissionsSet, async (_event, value: unknown) => {
    const request = parseSetPermissionRequest(value)
    if (!request) throw new Error('BAD_PERMISSION')
    if (!vault) throw new Error('NO_VAULT')
    return vault.setPermission(request.relPath, request.tier)
  })
  registerTrustedHandle(IPC.noteCreate, async (_event, name: unknown) => {
    const request = typeof name === 'string'
      ? { name: parseNoteName(name), parent: '' }
      : parseEntryCreateRequest(name)
    if (!request?.name) throw new Error('BAD_PATH')
    if (!vault) throw new Error('NO_VAULT')
    return vault.create(request.name, request.parent)
  })
  registerTrustedHandle(IPC.folderCreate, async (_event, value: unknown) => {
    const request = parseEntryCreateRequest(value)
    if (!request || !vault) throw new Error('BAD_PATH')
    return vault.createFolder(request.name, request.parent)
  })
  registerTrustedHandle(IPC.relocationPreview, async (event, value: unknown): Promise<RelocationPreviewResult> => {
    const request = parseRelocationPreviewRequest(value)
    const currentVault = vault
    if (!trusted(event) || !request || !currentVault) return { ok: false, error: 'BAD_PATH' }
    try {
      const token = currentVault.captureSession()
      const root = currentVault.root!
      if (structureGate.isBusy()) throw new Error('STRUCTURE_BUSY')
      await agentHost?.whenLaunchesSettled()
      currentVault.assertSession(token)
      const affected = agentHost?.active().filter((task) => task.root === root &&
        (task.relPath === request.source ||
          (request.kind === 'folder' && task.relPath.startsWith(`${request.source}/`)) ||
          (request.kind === 'note' && task.relPath.startsWith(`${request.source.slice(0, -3)}/`)))) ?? []
      for (const task of affected) { await agentHost?.cancel(task.id, 'user'); currentVault.assertSession(token) }
      if (agentHost?.hasPending(root)) throw new Error('PREVIOUS_TASK_UNSAVED')
      if (!mainWindow || !(await flushBeforeStructure(mainWindow))) throw new Error('UNSAVED_DRAFT')
      currentVault.assertSession(token)
      const preview = await currentVault.previewRelocation(request, token)
      currentVault.assertSession(token)
      return { ok: true, preview: {
        id: preview.id, sessionId: preview.sessionId, kind: preview.kind, source: preview.source, target: preview.target,
        moves: preview.moves,
        linkChanges: preview.linkChanges.map(({ relPath, newPath, changes }) => ({ relPath, newPath, count: changes.length })),
        permissionChanges: preview.permissionChanges
      } }
    } catch (error) { return { ok: false, error: lifecycleError(error, 'PREVIEW_FAILED') } }
  })
  registerTrustedHandle(IPC.relocationCommit, async (event, value: unknown): Promise<RelocationCommitResult> => {
    const request = parseRelocationCommitRequest(value)
    const win = mainWindow
    const currentVault = vault
    if (!trusted(event) || !request || !currentVault || !win || !currentVault.root) return { ok: false, error: 'BAD_REQUEST' }
    const token = currentVault.captureSession()
    const root = currentVault.root
    const preview = currentVault.relocationPreviewById(request.id)
    if (!preview) return { ok: false, error: 'STALE_PREVIEW' }
    if (structureGate.isBusy()) return { ok: false, error: 'STRUCTURE_BUSY' }
    structureGate.begin({
      root,
      exact: [preview.source, ...(request.repairLinks ? preview.linkChanges.map((item) => item.relPath) : [])],
      prefixes: preview.kind === 'folder' ? [preview.source] : [preview.source.slice(0, -3)]
    })
    try {
      await agentHost?.whenLaunchesSettled()
      currentVault.assertSession(token)
      const affected = agentHost?.active().filter((task) => task.root === root && structureGate.affects(root, task.relPath)) ?? []
      if (agentHost?.active().some((task) => task.root === root && !structureGate.affects(root, task.relPath))) {
        throw new Error('OTHER_TASK_RUNNING')
      }
      for (const task of affected) { await agentHost?.cancel(task.id, 'user'); currentVault.assertSession(token) }
      if (agentHost?.hasPending(root)) throw new Error('PREVIOUS_TASK_UNSAVED')
      if (!(await flushBeforeStructure(win))) throw new Error('UNSAVED_DRAFT')
      currentVault.assertSession(token)
      structureGate.seal()
      const outcome = await currentVault.commitRelocation(request.id, request.repairLinks, token)
      currentVault.assertSession(token)
      return { ok: true, moved: outcome.moved.map(({ from, to }) => ({ from, to })), unrepaired: outcome.unrepaired }
    } catch (error) { return { ok: false, error: lifecycleError(error, 'COMMIT_FAILED') } }
    finally { structureGate.finish() }
  })
  registerTrustedHandle(IPC.lifecycleStatus, async (event) => {
    if (!trusted(event) || !vault) throw new Error('NO_VAULT')
    return vault.lifecycleStatus()
  })
  registerTrustedHandle(IPC.lifecycleRetry, async (event, value: unknown): Promise<LifecycleRetryResult> => {
    const request = parseLifecycleRetryRequest(value)
    const currentVault = vault
    const win = mainWindow
    if (!trusted(event) || !request || !currentVault || !win) return { ok: false, error: 'BAD_REQUEST' }
    if (structureGate.isBusy()) return { ok: false, error: 'STRUCTURE_BUSY' }
    let entered = false
    try {
      currentVault.assertSession(request.sessionId)
      const root = currentVault.root!
      const scope = currentVault.lifecycleRecoveryScope(request)
      structureGate.begin({ root, exact: scope.relPaths, prefixes: scope.moved.flatMap((move) => [move.from, move.to]) })
      entered = true
      await agentHost?.whenLaunchesSettled()
      currentVault.assertSession(request.sessionId)
      // An active recovery record already fails all model requests closed.
      // Stop streams; keep unrelated unsaved output in Host memory until policy is stable again.
      try { await agentHost?.cancelAll('user', root) } catch { /* pending paths are checked below */ }
      currentVault.assertSession(request.sessionId)
      if (agentHost?.pendingPaths(root).some((relPath) => structureGate.affects(root, relPath))) {
        throw new Error('PREVIOUS_TASK_UNSAVED')
      }
      // A journal-bound clean tab may still point to an already moved object.
      // Only recovery can exempt these paths; dirty drafts never qualify.
      if (!(await flushBeforeStructure(win, scope.relPaths))) throw new Error('UNSAVED_DRAFT')
      currentVault.assertSession(request.sessionId)
      structureGate.seal()
      const outcome = await currentVault.lifecycleRetry(request)
      currentVault.assertSession(request.sessionId)
      try { await agentHost?.retryPending(root) } catch { /* retain output; structural recovery succeeded */ }
      currentVault.assertSession(request.sessionId)
      return { ok: true, moved: outcome.moved.map(({ from, to }) => ({ from, to })), unrepaired: outcome.unrepaired,
        hostPending: agentHost?.hasPending(root) ?? false }
    } catch (error) { return { ok: false, error: lifecycleError(error, 'LIFECYCLE_RECOVERY_REQUIRED') } }
    finally { if (entered) structureGate.finish() }
  })
  registerTrustedOn(IPC.lifecycleFlushDone, (event, value: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !value || typeof value !== 'object') return
    const response = value as { id?: unknown; ok?: unknown }
    if (typeof response.id === 'string') lifecycleFlushes.get(response.id)?.(response.ok === true)
  })
  registerTrustedHandle(IPC.backlinks, async (_event, relPath: unknown) => {
    const pathInVault = asString(relPath)
    if (!pathInVault) return []
    return vault?.backlinks(pathInVault) ?? []
  })
  registerTrustedHandle(IPC.search, async (_event, query: unknown) => {
    const text = asString(query)
    if (text == null) return []
    return vault?.search(text) ?? []
  })
  registerTrustedOn(IPC.flushDone, (event, payload: unknown) => {
    const win = mainWindow
    if (!win || event.sender !== win.webContents) return
    runCloseAction(closeFlow.flushed(parseFlushDone(payload).ok), win)
  })
}

app.whenReady().then(() => {
  themeMode = loadThemePreference(app.getPath('userData'))
  nativeTheme.themeSource = themeMode === 'day' ? 'light' : themeMode === 'night' ? 'dark' : 'system'
  try { modelConfig = createModelConfigStore(app.getPath('userData'), safeStorage) }
  catch (error) { modelConfigError = error instanceof Error ? error.message : 'MODEL_CONFIG_UNAVAILABLE' }
  vault = new VaultSession(app.getPath('userData'), send, async (previous) => {
    if (structureGate.isBusy()) throw new Error('STRUCTURE_BUSY')
    try { await agentHost?.cancelAll('vault-change', previous) } catch { /* pending retry below */ }
    await agentHost?.retryPending(previous)
    if (agentHost?.hasPending(previous)) throw new Error('生成内容尚未保存，不能换库')
    if (structureGate.isBusy()) throw new Error('STRUCTURE_BUSY')
  })
  vault.restore()
  agentHost = new AgentHost({
    root: () => { try { return vault?.requireUsableRoot() ?? null } catch { return null } },
    session: () => vault?.sessionId() ?? null,
    acceptsObject: (relPath, expected, current) => vault?.acceptsObject(relPath, expected, current) ?? false,
    read: (relPath) => vault!.read(relPath),
    write: (relPath, content, revision, binding) => {
      if (blocksStructureWrite(relPath)) throw new Error('NOTE_BUSY')
      if (!binding) throw new Error('OBJECT_BINDING_REQUIRED')
      return vault!.write(relPath, content, revision, binding)
    },
    tier: modelTierFor,
    credential: () => {
      if (!modelConfig) throw new Error(modelConfigError ?? 'MODEL_CONFIG_UNAVAILABLE')
      const selected = modelConfig.getPublic().selected
      return modelConfig.credential(selected)
    },
    limits: () => {
      if (!modelConfig) throw new Error(modelConfigError ?? 'MODEL_CONFIG_UNAVAILABLE')
      return modelConfig.getPublic().limits.none
    },
    stream: (input, signal) => streamModelText({ ...input, signal }),
    emit: ({ root, ...event }) => {
      if (vault?.root === root && event.sessionId === vault.sessionId()) send(IPC.agentEvent, event)
    }
  })
  attachVaultProtocol(() => vault)
  remoteImages = new RemoteImageService()
  attachRemoteImageProtocol(remoteImages)
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
