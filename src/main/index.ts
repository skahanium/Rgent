import type { LifecycleFlushPhase, RecoveryFlushContext } from '../shared/flush.ts'
import { parseLedgerRepairRequest } from '../shared/ledger.ts'
import { parseStoredVault } from './notes-fs.ts'
import { boundArguments, isVaultChannel, isVaultEvent } from '../shared/vault-binding.ts'
import { VaultCatalog } from './vault-catalog.ts'
import { VaultSwitch } from './vault-switch.ts'
import { parseVaultRestoreReceipt, type VaultTarget } from '../shared/vault-management.ts'
import { readFileSync } from 'node:fs'
import {memoryDependency,sameMemoryDependency,memorySnapshotSignature} from './memory-use.ts'
import {historicalContextPolicy} from './ledger-provenance.ts'
import {WorkingMemoryService} from './working-memory-service.ts'
import {WorkingMemoryConsolidation} from './working-memory-consolidation.ts'
import {memoryAuthorizationState as configuredMemoryAuthorizationState} from './model-config.ts'
import {ReasoningStore} from './reasoning-store.ts'
import {SummaryCache,summaryHash} from './summary-cache.ts'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, safeStorage, shell } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CloseFlow, timeoutAction, type CloseAction, type CloseDecision } from '../shared/flush.ts'
import { asString, parseEntryCreateRequest, parseFlushDone, parseLifecycleRetryRequest, parseNoteName, parseNoteWriteRequest, parseRelocationCommitRequest, parseRelocationPreviewRequest, parseSetPermissionRequest } from '../shared/ipc-guard.ts'
import { IPC, type VaultState } from '../shared/ipc.ts'
import type { ChromeTextSetResult } from '../shared/ipc.ts'
import { loadChromeTextPreference, saveChromeTextPreference } from './theme-preference.ts'
import { isChromeTextPreference } from '../shared/reading-preference.ts'
import type { AssistantResult, AgentStartRequest, AgentStartResult, LifecycleRetryResult, LimitTier, ModelAddRequest, ModelConfigResult, ModelDefaultSetRequest, ModelKeyDeleteRequest, ModelLimitsSetRequest, ModelListRequest, ModelListResult, ModelProviderRemoveRequest, ModelProviderSaveRequest, ModelRemoveRequest, ModelUpdateRequest, ReadingPreference, ReadingSetResult, RelocationCommitResult, RelocationPreviewResult, ThemeMode, ThemeSetResult } from '../shared/ipc.ts'
import type { RemoteImageGetResult } from '../shared/ipc.ts'
import { isThemeMode, loadReadingPreference, loadThemePreference, saveReadingPreference, saveThemePreference } from './theme-preference.ts'
import { loadAssistantHabits, saveAssistantHabits } from './assistant-preference.ts'
import { isReadingPreference } from '../shared/reading-preference.ts'
import { isAssistantHabits } from '../shared/assistant.ts'
import { attachVaultProtocol } from './vault-protocol.ts'
import { verifyImageSource } from './image-source.ts'
import { RemoteImageService, REMOTE_IMAGE_SCHEME, remoteImageUrl } from './remote-image.ts'
import { attachRemoteImageProtocol } from './remote-image-protocol.ts'
import { VAULT_MEDIA_SCHEME } from '../shared/vault-rel.ts'
import { VaultSession } from './vault.ts'
import { fetchModelList } from './model-list.ts'
import { createModelConfigStore, type ModelConfigStore } from './model-config.ts'
import { TaskAuthorizationRegistry, isAuthorizationCommand } from './task-authorization.ts'
import { createScopedAgentTools } from './scoped-agent-tools.ts'
import { createMemoryIpc } from './memory-ipc.ts'

import { AgentHost } from './agent-host.ts'
import { modelTierFor } from './permissions.ts'
import { streamModelText, streamModelStep } from './model-stream.ts'
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

let vaultSwitch: import('./vault-switch.ts').VaultSwitch<import('../shared/vault-management.ts').VaultTarget, VaultState> | null = null
let vaultCatalog: VaultCatalog | null = null
let activeTarget: VaultTarget | null = null
let startupVaultState: Extract<VaultState, {status:'needs-pick'}> | null = null
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

let authorizations: TaskAuthorizationRegistry | null = null
let consolidation:WorkingMemoryConsolidation|null=null
let summaryCache:SummaryCache|null=null
let reasoningStore:ReasoningStore|null=null
function workingService(){return vault?new WorkingMemoryService(vault,()=>modelConfig):null}
const memoryIpc = createMemoryIpc({
  vault: () => vault, config: () => modelConfig, service: () => workingService(),
  engine:()=>consolidation,
  invalidate:()=>{consolidation?.cancel();summaryCache?.invalidateAll()},
  recheck: async (current, session) => {
    current.assertSession(session)
    await Promise.all([current.root ? agentHost?.recheckSources(current.root, session) : undefined])
    current.assertSession(session)
  }
})
let cancellingForClose = false
const memoryAuthorizationPreviews = new Map<string, { sessionId: string; signature: string;search:boolean }>()
const maintenancePreviews=new Map<string,{sessionId:string;objectVersion:string;relPath:string;action:'compress'|'clear';records:{taskId:string;revision:number}[];archive?:{revision:string;bytes:number}}>()
function memoryAuthorizationState(sessionId: string) {
  vault?.assertSession(sessionId)
  if (!vault || !modelConfig) return { signature: 'unavailable', disclosure: undefined }
  try{if(!modelConfig)throw Error();return configuredMemoryAuthorizationState(modelConfig,vault!.memoryContext().vaultKey)}catch{return {signature:'memory-v2-unavailable',disclosure:undefined}}
}
const imageControllers = new Map<AbortController, {vault: VaultSession; binding: string; request: import('../shared/ipc.ts').RemoteImageGetRequest}>()
const lifecycleFlushes = new Map<string, (ok: boolean) => void>()
const structureGate = new VaultStructureGate()
const lifecycleErrorCodes = new Set(['BAD_PATH', 'BAD_REQUEST', 'NO_VAULT', 'VAULT_CHANGED', 'STALE_PREVIEW',
  'STALE_RECOVERY', 'EEXIST', 'ENOENT', 'PATH_CHANGED', 'UNSAFE_PATH', 'PERMISSION_DOWNGRADE',
  'PERMISSION_COLLISION', 'PERMISSIONS_INVALID', 'UNSAVED_DRAFT', 'PREVIOUS_TASK_UNSAVED',
  'LIFECYCLE_RECOVERY_REQUIRED', 'STRUCTURE_BUSY', 'OTHER_TASK_RUNNING', 'ATTACHMENT_COLLISION', 'LINK_SCAN_FAILED'])

function visibleVaultState(): VaultState {
  const state = startupVaultState && !vault?.root ? {...startupVaultState} : vault?.currentState() ?? {status:'needs-pick' as const,reason:'first-run' as const}
  if (state.status === 'needs-pick' && !state.diagnostic && vaultCatalog?.view().diagnostic) state.diagnostic = '设备库目录记录无法读取。原记录已保留，请检查本机存储；仍可手动打开笔记库。'
  if (state.status === 'ready' && activeTarget && vault?.root === activeTarget.path) {
    const entry = vaultCatalog?.view().entries.find(e=>e.rootIdentity===activeTarget!.rootIdentity && e.path===activeTarget!.path)
    state.rootName = entry?.label ?? activeTarget.label
    state.vaultId = entry?.id
    if(entry){const keys=vaultCatalog!.displayKeys({...activeTarget,id:entry.id});state.navigationKey=keys.key;state.legacyNavigationKey=keys.legacy}
  }
  // A temporarily inaccessible root retains its mount for draft recovery.
  // Availability must not be interpreted as an authoritative unmount.
  return state.status === 'needs-pick' ? {...state,sessionId:vault?.sessionId()??null} : state
}

function lifecycleError(error: unknown, fallback: string): string {
  return error instanceof Error && lifecycleErrorCodes.has(error.message) ? error.message : fallback
}

function blocksStructureWrite(relPath: string): boolean {
  return !!vault?.root && structureGate.blocksWrite(vault.root, relPath)
}

async function flushBeforeStructure(win: BrowserWindow, cleanUnavailablePaths: readonly string[] = [], phase?: LifecycleFlushPhase, context?: RecoveryFlushContext): Promise<boolean> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return false
  const id = randomUUID()
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      lifecycleFlushes.delete(id)
      resolve(false)
    }, 120_000)
    lifecycleFlushes.set(id, (ok) => { clearTimeout(timer); lifecycleFlushes.delete(id); resolve(ok) })
    win.webContents.send(IPC.lifecycleFlushRequest, id, cleanUnavailablePaths, phase, context)
  })
}

function clearFlushTimer(): void {
  if (!flushTimer) return
  clearTimeout(flushTimer)
  flushTimer = null
}

async function verifyVaultImage(current:VaultSession,snapshot:import('../shared/ipc.ts').NoteSnapshot,request:import('../shared/ipc.ts').RemoteImageGetRequest){
 const c=request.context;let text:string|undefined
 if(!c||typeof c.sessionId!=='string')return {ok:false as const}
 current.assertSession(c.sessionId)
 if(snapshot.sessionId!==c.sessionId)return {ok:false as const}
 if(c?.ledgerTaskId!==undefined){if(typeof c.ledgerTaskId!=='string'||!Number.isSafeInteger(c.ledgerRevision)||!['prompt','answer'].includes(c.ledgerField??''))return {ok:false as const};text=await current.ledgerImage(c.noteRelPath,c.ledgerTaskId,c.ledgerRevision!,c.ledgerField!)}
 current.assertSession(c.sessionId)
 return verifyImageSource(snapshot,request,text)
}
function send(channel: string, payload?: unknown): void {
  if (channel === IPC.treeChanged || channel === IPC.noteExternalChange || channel === IPC.vaultLost) {
    for (const [controller, active] of imageControllers) {
      const c = active.request.context!
      const imageSession=c.sessionId
      if(typeof imageSession!=='string'){controller.abort();continue}
      try {
        active.vault.assertSession(imageSession)
        void active.vault.runBound(imageSession, async () => {
          const snapshot=await active.vault.read(c.noteRelPath);active.vault.assertSession(imageSession)
          const proof = await verifyVaultImage(active.vault,snapshot,active.request);active.vault.assertSession(imageSession)
          if (!proof.ok || proof.binding!==active.binding) controller.abort()
        }).catch(()=>controller.abort())
      } catch { controller.abort() }
    }
    const current = vault; const token = current?.sessionId()
    if (current?.root && token) {
      void agentHost?.recheckSources(current.root, token).catch(() => {})
    }
  }
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, isVaultEvent(channel) ? { session: vault?.sessionId() ?? null, args: [payload] } : payload)
}

async function settleHostBeforeClose(win: BrowserWindow): Promise<boolean> {
  consolidation?.cancel(undefined,'MEMORY_SESSION_CLOSED')
  memoryIpc.clear()
  memoryAuthorizationPreviews.clear()
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

function requestWindowClose(win: BrowserWindow): void {
  if (cancellingForClose || win.isDestroyed()) return
  if (agentHost?.active().length || agentHost?.hasPending()) {
    cancellingForClose = true
    void settleHostBeforeClose(win).then(proceed => {
      if (proceed && !win.isDestroyed()) runCloseAction(closeFlow.request(), win)
    }).finally(() => { cancellingForClose = false })
  } else runCloseAction(closeFlow.request(), win)
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
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); return }
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
    if (vaultSwitch?.requestClose()) return
    requestWindowClose(win)
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
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) throw new Error('BAD_SENDER')
      const current = vault,session = current?.sessionId() ?? null
      const actual = isVaultChannel(channel) ? boundArguments(args, session) : args
      if (vaultSwitch?.busy && [IPC.agentStart, IPC.agentAuthorizationPreview, IPC.noteCreate, IPC.folderCreate, IPC.relocationPreview, IPC.relocationCommit, IPC.lifecycleRetry, IPC.noteSaveCopyPreview, IPC.noteSaveCopyCommit, IPC.permissionsSet, IPC.memoryConfigSave, IPC.memoryPreviewCommit, IPC.memoryItemEdit, IPC.memoryItemDisable, IPC.memoryItemForget, IPC.memoryJobRetryPreview, IPC.ledgerMaintenance, IPC.ledgerMigrate, IPC.ledgerRepair].includes(channel as never)) throw Error('VAULT_SWITCH_BUSY')
      const result = isVaultChannel(channel) && current ? await current.runBound(session, () => listener(event, ...actual)) : await listener(event, ...actual)
      if (isVaultChannel(channel) && session !== (vault?.sessionId() ?? null)) throw Error('VAULT_CHANGED')
      return result
    })
  }
  const registerTrustedOn = (channel: string, listener: Parameters<typeof ipcMain.on>[1]): void => {
    ipcMain.on(channel, (event, ...args) => {
      if (trusted(event)) listener(event, ...args)
    })
  }
  for (const [channel, operation] of [
    [IPC.memoryGet, 'get'], [IPC.memoryConfigSave, 'config'], [IPC.memoryManualPreview, 'manual'],
    [IPC.memoryPreviewCommit, 'commit'], [IPC.memoryItemEdit, 'edit'], [IPC.memoryItemDisable, 'disable'],
    [IPC.memoryItemForget, 'forget'], [IPC.memoryRestorePreview, 'restore'],
    [IPC.memoryMaintenancePreview,'maintenance'],
    [IPC.memoryJobRetryPreview, 'retry'], [IPC.memoryJobCancel, 'cancel']
  ] as const) registerTrustedHandle(channel, async (event, request) => {
    const currentVault=vault,service=workingService(),session=currentVault?.sessionId(),root=currentVault?.root
    const result=await memoryIpc.handle(`${event.sender.id}:${event.senderFrame!.routingId}`, operation, request,()=>{if(!trusted(event))throw Error('MEMORY_SESSION_CLOSED')})
    if(currentVault&&session)currentVault.assertSession(session)
    if(result.ok&&!['get','manual','restore','retry','maintenance'].includes(operation)){
      if(service&&currentVault&&session&&root){
        await service.recheckDeferred().catch(()=>{});currentVault.assertSession(session)
        await agentHost?.recheckSources(root,session);currentVault.assertSession(session)
      }
      send(IPC.memoryChanged,session)
    }
    return result
  })
  const configResult = (): ModelConfigResult => modelConfig
    ? { ok: true, config: modelConfig.getPublic() }
    : { ok: false, error: modelConfigError ?? 'MODEL_CONFIG_UNAVAILABLE' }
  registerTrustedHandle(IPC.modelConfigGet, (event): ModelConfigResult =>
    trusted(event) ? configResult() : { ok: false, error: 'BAD_SENDER' })
  // 一个供应商一份凭据：保存即 upsert，界面不提供同厂商第二条。写操作一律返回最新公开配置。
  const modelWrite = (run: () => void): ModelConfigResult => {
    if (!modelConfig) return { ok: false, error: 'MODEL_CONFIG_UNAVAILABLE' }
    try { run(); return configResult() }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'IO_ERROR' } }
  }
  const modelFields = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' ? value as Record<string, unknown> : null
  registerTrustedHandle(IPC.modelProviderSave, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelProviderSaveRequest> | null
    if (!request || (request.newKey !== undefined && typeof request.newKey !== 'string')) return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.saveProvider({ provider: request.provider, baseURL: request.baseURL, modelId: request.modelId, contextTokens: request.contextTokens }, request.newKey))
  })
  registerTrustedHandle(IPC.modelProviderRemove, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelProviderRemoveRequest> | null
    if (!request) return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.removeProvider(request.provider))
  })
  registerTrustedHandle(IPC.modelKeyDelete, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelKeyDeleteRequest> | null
    if (!request) return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.deleteKey(request.provider))
  })
  registerTrustedHandle(IPC.modelAdd, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelAddRequest> | null
    if (!request) return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.addModel({ provider: request.provider, modelId: request.modelId, contextTokens: request.contextTokens }))
  })
  registerTrustedHandle(IPC.modelUpdate, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelUpdateRequest> | null
    if (!request || typeof request.modelId !== 'string') return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.updateModel(request.modelId as string, request.contextTokens))
  })
  registerTrustedHandle(IPC.modelRemove, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelRemoveRequest> | null
    if (!request || typeof request.modelId !== 'string') return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.removeModel(request.modelId as string))
  })
  registerTrustedHandle(IPC.modelDefaultSet, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    const request = modelFields(value) as Partial<ModelDefaultSetRequest> | null
    if (!request || (request.modelId !== null && typeof request.modelId !== 'string')) return { ok: false, error: 'BAD_REQUEST' }
    return modelWrite(() => modelConfig!.setDefault(request.modelId as string | null))
  })
  // 「读取模型」：主进程发出，只取模型清单与端点自报的容量；渲染层不碰网络。
  registerTrustedHandle(IPC.modelList, async (event, value: unknown): Promise<ModelListResult> => {
    if (!trusted(event) || !modelConfig) return { ok: false, error: 'MODEL_CONFIG_UNAVAILABLE' }
    const request = modelFields(value) as Partial<ModelListRequest> | null
    if (!request) return { ok: false, error: 'BAD_REQUEST' }
    try {
      const secret = modelConfig.providerSecret(request.provider)
      const result = await fetchModelList(secret)
      return { ok: true, models: result.models, ...(result.truncated ? { truncated: true } : {}) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'MODEL_LIST_FAILED' } }
  })
  registerTrustedHandle(IPC.modelLimitsSet, (event, value: unknown): ModelConfigResult => {
    if (!trusted(event) || !modelConfig || !value || typeof value !== 'object') return { ok: false, error: 'BAD_REQUEST' }
    const request = value as Partial<ModelLimitsSetRequest>
    return modelWrite(() => modelConfig!.updateLimits(request.tier as LimitTier, request.limits!))
  })
  registerTrustedHandle(IPC.agentAuthorizationPreview, async (event, value: unknown): Promise<import('../shared/ipc.ts').AgentAuthorizationResult> => {
    if(!authorizations || !isAuthorizationCommand(value))return {ok:false,error:'BAD_REQUEST'}
    const request=value as import('../shared/ipc.ts').AgentAuthorizationRequest
    if(structureGate.isBusy())return {ok:false,error:'NOTE_BUSY'}
    try {
      const owner = `${event.sender.id}:${event.senderFrame!.routingId}`
      const memory = memoryAuthorizationState(request.sessionId)
      const preview = await authorizations.preview(owner, request)
      const memorySearch=preview.memory?.search?.available===true
      if (memoryAuthorizationState(request.sessionId).signature !== memory.signature) throw Error('STALE_PREVIEW')
      if (memoryAuthorizationPreviews.size >= 128) memoryAuthorizationPreviews.delete(memoryAuthorizationPreviews.keys().next().value!)
      memoryAuthorizationPreviews.set(`${owner}:${preview.id}`, { sessionId: request.sessionId, signature: memory.signature,search:memorySearch })
      const chapters=await vault!.ledgerContexts(request.relPath),note=await vault!.read(request.relPath)
      const validMemories=memory.disclosure?.use?await workingService()!.entries():[]
      const policy=await historicalContextPolicy(note.content,async dep=>preview.sources.some(s=>s.relPath===dep.relPath&&s.objectVersion===dep.objectVersion&&s.fingerprint===dep.bodyHash),undefined,chapters,async dep=>validMemories.some(e=>e.status==='active'&&sameMemoryDependency(dep,memoryDependency(e))))
      const generators=summaryCache?.valid(summaryHash(await vault!.ledgerKey(request.relPath)),chapters.filter(c=>policy.allowedLedgerChapterIds.includes(c.sourceId))).map(b=>({modelId:b.generator.modelId,host:b.generator.host,time:b.generator.time}))??[]
      vault!.assertSession(request.sessionId)
      if(memoryAuthorizationState(request.sessionId).signature!==memory.signature)throw Error('STALE_PREVIEW')
      return {ok:true,preview:{...preview,summaryGenerators:generators.slice(0,64)}}
    }
    catch(error){return {ok:false,error:error instanceof Error?error.message:'AUTHORIZATION_FAILED'}}
  })
  registerTrustedHandle(IPC.agentAuthorizationDiscard, (event, id:unknown) => {
    if(typeof id==='string' && id.length<=128) { const owner = `${event.sender.id}:${event.senderFrame!.routingId}`; authorizations?.discard(owner,id); memoryAuthorizationPreviews.delete(`${owner}:${id}`) }
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
    if (typeof request.previewId !== 'string' || request.previewId.length > 128 || typeof request.relPath !== 'string' || typeof request.expectedText !== 'string' ||
        typeof request.promptText !== 'string' || request.promptText.length > 20000 ||
        typeof request.modelRecordId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(request.modelRecordId) ||
        typeof request.sessionId !== 'string' || typeof request.objectVersion !== 'string' || typeof request.expectedRevision !== 'string' ||
        !request.range || !Number.isSafeInteger(request.range.start) || !Number.isSafeInteger(request.range.end)) {
      return { ok: false, error: 'BAD_REQUEST' }
    }
    if (structureGate.isBusy()) return { ok: false, error: 'NOTE_BUSY' }
    try {
      const owner = `${event.sender.id}:${event.senderFrame!.routingId}`
      const memory = memoryAuthorizationPreviews.get(`${owner}:${request.previewId}`)
      memoryAuthorizationPreviews.delete(`${owner}:${request.previewId}`)
      if (!memory || memory.sessionId !== request.sessionId || memory.signature !== memoryAuthorizationState(request.sessionId).signature) throw Error('STALE_PREVIEW')
      const task = await agentHost.start({...request as AgentStartRequest, authorizationOwner:`${event.sender.id}:${event.senderFrame!.routingId}`, memoryAuthorizationSignature: memory.signature,memorySearchAuthorized:memory.search})
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
      const proof = await verifyVaultImage(vault,snapshot,request)
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
              const checked = await verifyVaultImage(currentVault,await currentVault.read(c.noteRelPath),request)
              return checked.ok && checked.binding===proof.binding
            } catch { return false }
          } })
      } finally { imageControllers.delete(controller) }
      currentVault.assertSession(token)
      const current = await currentVault.read(c.noteRelPath)
      if (!(await verifyVaultImage(currentVault,current,request)).ok) return { ok: false, error: 'NOT_ALLOWED' }
      return result.ok ? { ok: true, src: remoteImageUrl(result.token) } : result
    } catch { return { ok: false, error: 'NOT_ALLOWED' } }
  })
  registerTrustedHandle(IPC.assistantGet, (event): AssistantResult =>
    trusted(event) ? { ok: true, habits: loadAssistantHabits(app.getPath('userData')) } : { ok: false, error: 'BAD_SENDER' })
  registerTrustedHandle(IPC.assistantSet, (event, value: unknown): AssistantResult => {
    if (!trusted(event)) return { ok: false, error: 'BAD_SENDER' }
    if (!isAssistantHabits(value)) return { ok: false, error: 'BAD_ASSISTANT' }
    try {
      saveAssistantHabits(app.getPath('userData'), value)
      return { ok: true, habits: value }
    } catch { return { ok: false, error: 'IO_ERROR' } }
  })
  registerTrustedHandle(IPC.themeGet, () => themeMode)
  registerTrustedHandle(IPC.readingGet, () => loadReadingPreference(app.getPath('userData')))
  registerTrustedHandle(IPC.chromeTextGet, () => loadChromeTextPreference(app.getPath('userData')))
  registerTrustedHandle(IPC.chromeTextSet, (_event, value: unknown): ChromeTextSetResult => {
    if (!isChromeTextPreference(value)) return { ok: false, error: 'BAD_CHROME_TEXT' }
    try {
      saveChromeTextPreference(app.getPath('userData'), value)
      return { ok: true, preference: { ...value } }
    } catch { return { ok: false, error: 'IO_ERROR' } }
  })
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
  registerTrustedHandle(IPC.vaultTransition, (event, value: unknown) => {
    const receipt = parseVaultRestoreReceipt(value)
    if (!receipt) throw Error('BAD_REQUEST')
    return vaultSwitch?.restored(event.senderFrame, receipt, vault?.sessionId() ?? null) ?? false
  })
  registerTrustedHandle(IPC.vaultGet, () => visibleVaultState())
  registerTrustedHandle(IPC.vaultCatalog, () => ({...vaultCatalog!.view(), activeId:activeTarget?.id ?? null}))
  registerTrustedHandle(IPC.vaultCatalogChange, async (event, request: unknown) => {
    const r = request as Record<string, unknown>
    if (!r || typeof r !== 'object' || typeof r.revision !== 'string' || typeof r.id !== 'string' || !['label','pin','remove','relocate'].includes(String(r.action))) throw Error('BAD_REQUEST')
    if (vaultSwitch?.busy) throw Error('VAULT_SWITCH_BUSY')
    if (r.action === 'remove') return vaultCatalog!.remove(r.id, r.revision)
    if (r.action === 'pin' && typeof r.pinned === 'boolean') return vaultCatalog!.update(r.id, {pinned:r.pinned}, r.revision)
    if (r.action === 'label' && typeof r.label === 'string') return vaultCatalog!.update(r.id, {label:r.label}, r.revision)
    if (r.action === 'relocate') {
      const id = r.id, revision = r.revision
      if (activeTarget?.id === r.id) throw Error('ACTIVE_VAULT_RELOCATE')
      if (structureGate.isBusy()) throw Error('STRUCTURE_BUSY')
      return vaultSwitch!.select(async (_run, current) => {
        const session = vault?.sessionId()
        const chosen = await dialog.showOpenDialog(mainWindow!, {title:'重新定位笔记库',properties:['openDirectory']})
        current()
        if (chosen.canceled || !chosen.filePaths[0]) return vaultCatalog!.view()
        if (vault?.sessionId() !== session) throw Error('VAULT_CHANGED')
        if (structureGate.isBusy()) throw Error('STRUCTURE_BUSY')
        if (activeTarget?.id === id) throw Error('ACTIVE_VAULT_RELOCATE')
        return vaultCatalog!.relocate(id, vaultCatalog!.inspect(chosen.filePaths[0]), revision)
      }, event.senderFrame)
    }
    throw Error('BAD_REQUEST')
  })
  registerTrustedHandle(IPC.vaultOpen, async (event, id: unknown) => {
    if (typeof id !== 'string') throw Error('BAD_REQUEST')
    if (vaultSwitch?.busy) throw Error('VAULT_SWITCH_BUSY')
    const entry = vaultCatalog!.view().entries.find(item => item.id === id)
    if (!entry) throw Error('VAULT_TARGET_INVALID')
    const target = vaultCatalog!.inspect(entry.path)
    if (target.rootIdentity !== entry.rootIdentity) throw Error('VAULT_TARGET_CHANGED')
    if (activeTarget?.rootIdentity === target.rootIdentity && activeTarget.path === target.path) return visibleVaultState()
    return vaultSwitch!.run(target, event.senderFrame)
  })
  registerTrustedHandle(IPC.vaultWorkspaceGet, (_event, session: unknown) => {
    if (!vault || typeof session !== 'string') throw Error('VAULT_CHANGED')
    vault.assertSession(session)
    return activeTarget ? vaultCatalog!.workspace(activeTarget) : null
  })
  registerTrustedHandle(IPC.vaultWorkspaceSave, (_event, session: unknown, workspace: unknown) => {
    if (!vault || typeof session !== 'string') throw Error('VAULT_CHANGED')
    vault.assertSession(session)
    if (activeTarget) vaultCatalog!.saveWorkspace(activeTarget, workspace)
    return true
  })
  registerTrustedHandle(IPC.vaultPick, async (event, create: unknown) => {
    if (!vault || !vaultSwitch) return { status: 'needs-pick', reason: 'first-run' }
    if (vaultSwitch.busy || structureGate.isBusy()) throw Error('VAULT_SWITCH_BUSY')
    return vaultSwitch.select(async (run, current) => {
      const session = vault?.sessionId()
      let chosen: string | undefined
      if (create === true) {
        const result = await dialog.showSaveDialog(mainWindow!, {title:'创建空笔记库',buttonLabel:'创建笔记库',defaultPath:'新笔记库'})
        current()
        if (result.canceled) return {...visibleVaultState(),cancelled:true}
        chosen = result.filePath
      } else {
        const result = await dialog.showOpenDialog(mainWindow!, {title:'打开笔记库',properties:['openDirectory','createDirectory']})
        current()
        if (result.canceled || !result.filePaths[0]) return {...visibleVaultState(),cancelled:true}
        chosen = result.filePaths[0]
      }
      if (!chosen) return visibleVaultState()
      if (vault?.sessionId() !== session) throw Error('VAULT_CHANGED')
      if (structureGate.isBusy()) throw Error('STRUCTURE_BUSY')
      const target = create === true ? vaultCatalog!.create(chosen) : vaultCatalog!.inspect(chosen)
      if (!vaultCatalog!.view().diagnostic) vaultCatalog!.register(target)
      if (activeTarget?.rootIdentity === target.rootIdentity && activeTarget.path === target.path) return visibleVaultState()
      return run(target)
    }, event.senderFrame)
  })
  registerTrustedHandle(IPC.treeList, async () => vault?.tree() ?? [])
  registerTrustedHandle(IPC.ledgerMaintenance,async(event,value:unknown)=>{
    const current=vault
    try{if(!value||typeof value!=='object'||Array.isArray(value))throw Error();const r=value as Record<string,unknown>
      if(Object.keys(r).some(k=>!['sessionId','objectVersion','relPath','action','previewId'].includes(k))||typeof r.sessionId!=='string'||typeof r.objectVersion!=='string'||typeof r.relPath!=='string'||!['compress','clear'].includes(String(r.action))||r.previewId!==undefined&&typeof r.previewId!=='string')throw Error()
      if(!current)throw Error();current.assertSession(r.sessionId);if(structureGate.isBusy()||agentHost?.active().length||agentHost?.hasPending())throw Error('STRUCTURE_BUSY')
      const note=await current.read(r.relPath);current.assertSession(r.sessionId);if(!current.acceptsObject(r.relPath,r.objectVersion,note.objectVersion))throw Error('NOTE_REPLACED')
      const owner=`${event.sender.id}:${event.senderFrame!.routingId}`
      if(r.previewId){const key=owner+':'+r.previewId,preview=maintenancePreviews.get(key);maintenancePreviews.delete(key);if(!preview||preview.sessionId!==r.sessionId||preview.objectVersion!==r.objectVersion||preview.relPath!==r.relPath||preview.action!==r.action)throw Error('STALE_PREVIEW');return {ok:true,value:await current.ledgerMaintenanceCommit(preview.relPath,preview.action,preview.records,preview.archive)}}
      const preview=await current.ledgerMaintenancePreview(r.relPath,r.action as 'compress'|'clear');current.assertSession(r.sessionId);const id=randomUUID();if(maintenancePreviews.size>=128)maintenancePreviews.delete(maintenancePreviews.keys().next().value!);maintenancePreviews.set(owner+':'+id,{sessionId:r.sessionId,objectVersion:r.objectVersion,relPath:r.relPath,action:r.action as 'compress'|'clear',records:preview.records,archive:preview.archive});return {ok:true,value:{id,...preview}}
    }catch{return {ok:false,error:'LEDGER_UNAVAILABLE'}}
  })
  const recoveryPreviewOwners=new Map<string,{frame:string;sessionId:string}>()
  registerTrustedHandle(IPC.ledgerRepair,async(event,value:unknown):Promise<import('../shared/ledger.ts').LedgerRepairResult>=>{
    const request=parseLedgerRepairRequest(value),current=vault,win=mainWindow
    if(!request||!current||!win)return {ok:false,error:'BAD_REQUEST'}
    try{
      current.assertSession(request.sessionId)
      const frame=`${event.sender.id}:${event.senderFrame!.routingId}`
      if(request.action==='commit'||request.action==='cancel'){
        const owner=recoveryPreviewOwners.get(request.previewId);recoveryPreviewOwners.delete(request.previewId)
        if(owner?.frame!==frame||owner.sessionId!==request.sessionId)throw Error('STALE_PREVIEW')
        if(request.action==='cancel'){current.ledgerRecoveryCancel(request.previewId);return {ok:true}}
      }
      if(structureGate.isBusy())throw Error('STRUCTURE_BUSY')
      const context={sessionId:request.sessionId,operationId:randomUUID()}
      const root=current.requireUsableRoot()
      const result=await structureGate.recover(root,{
        host:agentHost??undefined,action:request.action,
        isComplete:result=>'status' in result&&result.status==='complete',
        assert:()=>{if(current!==vault||current.requireUsableRoot()!==root)throw Error('VAULT_CHANGED');current.assertSession(request.sessionId)},
        quiesce:async()=>{
          consolidation?.cancel(undefined,'MEMORY_SESSION_CLOSED');await consolidation?.idle()
        },
        prepare:()=>flushBeforeStructure(win,[],`recovery-${request.action}`,context),
        drain:()=>current.idle(),
        release:()=>{if(!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send(IPC.lifecycleFlushRequest,context.operationId,[],'recovery-release',context)}
      },async()=>{
        if(request.action==='preview'){
          const preview=await current.ledgerRecoveryPreview(request.mode)
          if(recoveryPreviewOwners.size>=16)recoveryPreviewOwners.clear()
          recoveryPreviewOwners.set(preview.id,{frame,sessionId:request.sessionId});return preview
        }
        // A recovery authorization never carries old sending or background permits.
        authorizations?.clear();memoryIpc.clear();memoryAuthorizationPreviews.clear()
        const result=request.action==='commit'?await current.ledgerRecoveryCommit(request.previewId):await current.ledgerRecoveryResume(request.revision)
        return result
      })
      return {ok:true,value:result}
    }catch(error){const code=error instanceof Error?error.message:'';return {ok:false,error:['BAD_REQUEST','STALE_PREVIEW','STALE_RECOVERY','VAULT_CHANGED','STRUCTURE_BUSY','UNSAVED_DRAFT','PERMISSIONS_INVALID','LEDGER_RECOVERY_AMBIGUOUS','LEDGER_REGISTRY_INVALID','LIFECYCLE_RECOVERY_REQUIRED'].includes(code)?code:'LEDGER_REGISTRY_INVALID'}}
  })
  registerTrustedHandle(IPC.ledgerReasoning,async(_event,value:unknown):Promise<import('../shared/ledger.ts').LedgerReasoningResult>=>{
    const current=vault
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>;if(Object.keys(r).sort().join()!=='objectVersion,relPath,sessionId,taskId'||typeof r.relPath!=='string'||typeof r.sessionId!=='string'||typeof r.objectVersion!=='string'||typeof r.taskId!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(r.taskId))throw Error('BAD_REQUEST')
      if(!current||!reasoningStore)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      const note=await current.read(r.relPath);current.assertSession(r.sessionId);if(!current.acceptsObject(r.relPath,r.objectVersion,note.objectVersion))throw Error('NOTE_REPLACED')
      const record=await current.ledgerRecord(r.relPath,r.taskId);current.assertSession(r.sessionId)
      return {ok:true,text:record.state==='cleared'?null:record.legacyReasoning??reasoningStore.read(current.memoryContext().vaultKey,r.taskId)}
    }catch{return {ok:false,error:'LEDGER_UNAVAILABLE'}}
  })
  registerTrustedHandle(IPC.ledgerGet,async(_event,value:unknown)=>{
    const current=vault,token=current?.sessionId()
    try{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST')
      const r=value as Record<string,unknown>;if(Object.keys(r).some(k=>!['relPath','sessionId','objectVersion','cursor'].includes(k))||typeof r.relPath!=='string'||typeof r.sessionId!=='string'||typeof r.objectVersion!=='string'||r.cursor!==undefined&&r.cursor!==null&&(typeof r.cursor!=='string'||r.cursor.length>512))throw Error('BAD_REQUEST')
      if(!current)throw Error('NO_VAULT');current.assertSession(r.sessionId)
      const note=await current.read(r.relPath);current.assertSession(r.sessionId);if(!current.acceptsObject(r.relPath,r.objectVersion,note.objectVersion))throw Error('NOTE_REPLACED')
      return {ok:true,value:await current.ledgerPage(r.relPath,(r.cursor??null) as string|null)}
    }catch(e){const code=e instanceof Error?e.message:'';return {ok:false,error:['BAD_REQUEST','NO_VAULT','VAULT_CHANGED','NOTE_REPLACED','LEDGER_REGISTRY_INVALID','LEDGER_OWNERSHIP_UNVERIFIED','LEDGER_RECORD_INVALID','LEDGER_CONFLICT'].includes(code)?code:'LEDGER_UNAVAILABLE',...(code==='LEDGER_REGISTRY_INVALID'&&current?.sessionId()===token?{registryRevision:current?.ledgerRegistryRevision()}: {})}}
  })
  registerTrustedHandle(IPC.ledgerMigrate,async(_event,value:unknown)=>{
    try{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('BAD_REQUEST');const r=value as Record<string,unknown>
      if(Object.keys(r).sort().join()!=='after,sessionId'||typeof r.sessionId!=='string'||r.after!==null&&(typeof r.after!=='string'||r.after.length>4096))throw Error('BAD_REQUEST')
      if(!vault)throw Error('NO_VAULT');vault.assertSession(r.sessionId);if(structureGate.isBusy()||agentHost?.active().length)throw Error('STRUCTURE_BUSY')
      return {ok:true,value:await vault.ledgerMigrateBatch(r.after as string|null)}
    }catch{return {ok:false,error:'LEDGER_MIGRATION_FAILED'}}
  })
  registerTrustedHandle(IPC.noteRead, async (_event, relPath: unknown) => {
    const pathInVault = asString(relPath)
    if (!pathInVault) throw new Error('BAD_PATH')
    if (!vault) throw new Error('NO_VAULT')
    return vault.readOpened(pathInVault)
  })
  registerTrustedHandle(IPC.noteWrite, async (_event, value: unknown) => {
    const request = parseNoteWriteRequest(value)
    if (!request) return { ok: false, error: 'BAD_PATH' }
    if (!vault) return { ok: false, error: 'NO_VAULT' }
    if (blocksStructureWrite(request.relPath)) return { ok: false, error: 'NOTE_BUSY' }
    const current=vault,root=current.root
    try {
      const result = await current.write(request.relPath, request.content, request.expectedRevision, request)
      current.assertSession(request.sessionId)
      // 人自己修好语法并成功保存后，给这篇之前写入失败的生成内容一次补存机会。
      if (root && agentHost?.pendingPaths(root).includes(request.relPath)) {
        void agentHost.retryPending(root, request.relPath).catch(() => { /* 仍未落盘：保留待保存内容 */ })
      }
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: err instanceof Error && ['CONFLICT', 'NOTE_MISSING', 'NOTE_REPLACED', 'NOTE_UNREADABLE', 'VAULT_CHANGED', 'LEDGER_BOUNDARY_INVALID', 'LIFECYCLE_RECOVERY_REQUIRED'].includes(err.message) ? err.message : 'IO_ERROR' }
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
    const current=vault,root=current.root
    const state = await current.noteStatus(r.relPath, r);current.assertSession(r.sessionId)
    if (state.status !== 'ready') {
      for (const task of agentHost?.active().filter(t => t.root === root && t.relPath === r.relPath) ?? []) {
        await agentHost?.cancel(task.id, 'user').catch(() => {})
        current.assertSession(r.sessionId)
      }
      vault.assertSession(r.sessionId)
    }
    return state
  })
  registerTrustedHandle(IPC.noteAbandon, async (_event, value: unknown) => {
    const r = parseBinding(value)
    if (!r || !vault) return false
    const current=vault,root=current.root!
    current.assertSession(r.sessionId)
    const status=await current.noteStatus(r.relPath, r);current.assertSession(r.sessionId)
    if (status.status === 'ready') return false
    for (const task of agentHost?.active().filter(t => t.root === root && t.relPath === r.relPath) ?? []) {await agentHost?.cancel(task.id, 'user').catch(() => {});current.assertSession(r.sessionId)}
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
      ? { name: parseNoteName(name), parent: '', sessionId: undefined }
      : parseEntryCreateRequest(name)
    if (!request?.name) throw new Error('BAD_PATH')
    if (!vault) throw new Error('NO_VAULT')
    if (request.sessionId !== undefined) vault.assertSession(request.sessionId)
    return vault.create(request.name, request.parent)
  })
  registerTrustedHandle(IPC.folderCreate, async (_event, value: unknown) => {
    const request = parseEntryCreateRequest(value)
    if (!request || !vault) throw new Error('BAD_PATH')
    if (request.sessionId !== undefined) vault.assertSession(request.sessionId)
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
      const affected = agentHost?.active().filter((task) => task.root === root && agentHost!.scopePaths(task.id).some(path => structureGate.affects(root, path))) ?? []
      if (agentHost?.active().some((task) => task.root === root && !agentHost!.scopePaths(task.id).some(path => structureGate.affects(root, path)))) {
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
      memoryIpc.clear()
      consolidation?.cancel()
      memoryAuthorizationPreviews.clear()
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

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
else app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus() } })

if (ownsInstance) app.whenReady().then(() => {
  themeMode = loadThemePreference(app.getPath('userData'))
  nativeTheme.themeSource = themeMode === 'day' ? 'light' : themeMode === 'night' ? 'dark' : 'system'
  try { modelConfig = createModelConfigStore(app.getPath('userData'), safeStorage) }
  catch (error) { modelConfigError = error instanceof Error ? error.message : 'MODEL_CONFIG_UNAVAILABLE' }
  vaultCatalog = new VaultCatalog(app.getPath('userData'))
  vault = new VaultSession(app.getPath('userData'), send, undefined,(root,identity)=>vaultCatalog?.view().entries.find(e=>e.path===root&&e.rootIdentity===identity)?.id??null)
  const catalog = vaultCatalog.view()
  if (catalog.diagnostic) startupVaultState = {status:'needs-pick',reason:'missing',diagnostic:'设备库目录记录无法读取。原记录已保留，请检查本机存储；仍可手动打开笔记库。'}
  try {
    const last = catalog.entries.find(item => item.id === catalog.lastVaultId)
    if (last) {
      const target = vaultCatalog.inspect(last.path)
      if (target.rootIdentity !== last.rootIdentity) throw Error('VAULT_REPLACED')
      const state = vault.restoreVerified(target.path, target.rootIdentity)
      if (state.status !== 'ready') throw Error('VAULT_TARGET_CHANGED')
      activeTarget = target
    } else if (catalog.revision === 'missing') {
      let legacy: ReturnType<typeof parseStoredVault> = null
      try { legacy = parseStoredVault(readFileSync(path.join(app.getPath('userData'), 'vault.json'), 'utf8')) } catch {}
      if (legacy) {
        const target = vaultCatalog.inspect(legacy.path)
        vaultCatalog.committed(target)
        const state = vault.restoreVerified(target.path, target.rootIdentity)
        if (state.status !== 'ready') throw Error('VAULT_TARGET_CHANGED')
        activeTarget = target
      }
    }
  } catch {
    startupVaultState = {status:'needs-pick',reason:'missing',diagnostic:'上次使用的笔记库无法打开，可能已移动、无法访问或被同路径的其他目录替换。请手动选择并核对目标。'}
  }
  vaultSwitch = new VaultSwitch({
    check: target => {
      const current = vaultCatalog!.inspect(target.path)
      if (current.rootIdentity !== target.rootIdentity) throw Error('VAULT_TARGET_CHANGED')
      if (structureGate.isBusy()) throw Error('STRUCTURE_BUSY')
    },
    prepare: async (_target, current) => {
      const context={sessionId:vault?.sessionId()??'',operationId:vaultSwitch!.operationId}
      if (mainWindow && !await flushBeforeStructure(mainWindow, [], 'settings', context)) throw Error('VAULT_SWITCH_CANCELLED')
      current()
      await agentHost?.whenLaunchesSettled(); current()
      if (agentHost?.active().length && mainWindow) {
        const choice = await dialog.showMessageBox(mainWindow, {type:'question', title:'切换笔记库', message:'停止当前任务并切换笔记库？', detail:'已经生成的回答会保存。切换后不会自动重新启动这些任务。', buttons:['留在当前库','停止任务并切换'], defaultId:0, cancelId:0})
        current()
        if (choice.response !== 1) throw Error('VAULT_SWITCH_CANCELLED')
      }
      if (mainWindow && !await flushBeforeStructure(mainWindow, [], 'freeze', context)) throw Error('VAULT_SWITCH_CANCELLED')
      current()
      const previous = vault?.root
      consolidation?.cancel(undefined,'MEMORY_SESSION_CLOSED')
      await consolidation?.idle(); current()
      if (previous) {
        try { await agentHost?.cancelAll('vault-change', previous) } catch {}
        current()
        await agentHost?.retryPending(previous); current()
        await agentHost?.whenLaunchesSettled(); current()
        consolidation?.cancel(undefined,'MEMORY_SESSION_CLOSED')
        await consolidation?.idle(); current()
        if (agentHost?.active().length) throw Error('OTHER_TASK_RUNNING')
        if (agentHost?.hasPending(previous)) throw Error('PREVIOUS_TASK_UNSAVED')
      }
    },
    flush: async () => !vault?.root || !!mainWindow && await flushBeforeStructure(mainWindow,[],undefined,{sessionId:vault?.sessionId()??'',operationId:vaultSwitch!.operationId}),
    commit: async target => {
      const state = await vault!.openVerified(target.path, target.rootIdentity)
      activeTarget = target
      startupVaultState = null
      memoryIpc.clear(); memoryAuthorizationPreviews.clear(); maintenancePreviews.clear(); authorizations?.clear()
      for (const controller of imageControllers.keys()) controller.abort()
      try { const entry = vaultCatalog!.committed(target); activeTarget = {...target,id:entry.id,label:entry.label} }
      catch { if (state.status === 'ready') state.diagnostic = '库已打开，但设备库目录未保存。请检查本机存储后重试。' }
      return state.status === 'ready' ? {...visibleVaultState(), vaultChanged:state.vaultChanged, ...(state.diagnostic?{diagnostic:state.diagnostic}:{})} as VaultState : state
    },
    changed: (phase, closePending, operationId) => send(IPC.vaultTransition, {busy:phase!=='idle',session:vault?.sessionId()??null,phase,closePending,operationId}),
    handoff: (state, id, _owner, retry) => {
      const sessionId=vault?.sessionId()??null
      const result:VaultState=state.status==='ready'?{...state,restoreId:id,sessionId:sessionId!}:{...state,restoreId:id,sessionId}
      if (retry) send(IPC.vaultTransition,{busy:true,session:sessionId,phase:'restoring',restoreId:id})
      return {result,sessionId}
    },
    close: () => { if(mainWindow)requestWindowClose(mainWindow) },
    stalled: (phase,ticket) => {
      const win=mainWindow
      if(!win||win.isDestroyed())return
      void dialog.showMessageBox(win,{type:'warning',title:'笔记库交接没有完成',
        message:phase==='restoring'?'新库已提交，但工作区恢复尚未确认。':'新库提交仍未完成，当前操作保持保护。',
        detail:'原库保存结果与库内恢复记录保留。可以重试核验，或取消关闭并保留窗口。明确放弃关闭不会续跑任务或恢复许可。',
        buttons:[phase==='restoring'?'重试恢复':'继续等待核验','取消关闭并保留窗口','明确放弃未保存修改并退出应用'],defaultId:0,cancelId:1,noLink:true
      }).then(({response})=>{
        if(win.isDestroyed()||!vaultSwitch?.isCurrentStall(ticket)||vaultSwitch.phase!==phase)return
        if(response===2){quitting=true;runCloseAction('close',win);return}
        if(response===1)vaultSwitch.cancelClose()
        if(phase==='restoring')vaultSwitch.retryRestore(win.webContents.mainFrame)
        else vaultSwitch.continueWaiting()
      }).catch(()=>{if(vaultSwitch?.isCurrentStall(ticket)){vaultSwitch.cancelClose();vaultSwitch.continueWaiting()}})
    },
    release: () => send(IPC.vaultTransition, {busy:false,session:vault?.sessionId()??null,phase:'idle'})
  })
  authorizations = new TaskAuthorizationRegistry({
    root:()=>{try{return vault?.requireUsableRoot()??null}catch{return null}},
    session:()=>vault?.sessionId()??null,
    tree:()=>vault!.tree(),read:relPath=>vault!.read(relPath),tier:modelTierFor,
    assertOrdinaryNotes: paths => vault!.requireOrdinaryNotes(paths),
    acceptsObject:(relPath,expected,current)=>vault?.acceptsObject(relPath,expected,current)??false,
    ownerValid:owner=>!!mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() &&
      mainWindow.webContents.getURL()===rendererEntryUrl && owner===`${mainWindow.webContents.id}:${mainWindow.webContents.mainFrame.routingId}`,
    memoryAuthorization:async request=>{
      const state=memoryAuthorizationState(request.sessionId)
      const entries=state.disclosure?.use?await workingService()!.entries().catch(()=>[]):[]
      const search=!!state.disclosure?.use&&!!modelConfig&&!!agentHost?.supportsMemorySearch(modelConfig.credential(request.modelRecordId))&&entries.some(e=>e.status==='active')
      if(memoryAuthorizationState(request.sessionId).signature!==state.signature)throw Error('STALE_PREVIEW')
      return {signature:state.signature+':'+memorySnapshotSignature(entries),snapshotSignature:memorySnapshotSignature(entries),search,disclosure:state.disclosure}
    },
    configuration:(extraReferences, modelRecordId,memorySearch)=>{
      if(!modelConfig)throw Error(modelConfigError??'MODEL_CONFIG_UNAVAILABLE')
      const config=modelConfig.getPublic()
      return {credential:modelConfig.credential(modelRecordId),limits:extraReferences||memorySearch ? config.limits.local : config.limits.none}
    }
  })
  reasoningStore=new ReasoningStore(path.join(app.getPath('userData'),'reasoning-v2'))
  const contextCache=new SummaryCache(path.join(app.getPath('userData'),'context-cache-v2'))
  summaryCache=contextCache
  consolidation=new WorkingMemoryConsolidation({
    service:workingService,
    configuration:context=>{
      if(!modelConfig)throw Error('MEMORY_CONFIG_UNAVAILABLE')
      const cfg=modelConfig.getMemoryConfig(context.vaultKey),credential=modelConfig.memoryCredential(context.vaultKey)
      return {enabled:cfg.vault.enabled,signature:JSON.stringify([cfg,credential,modelConfig.getVaultMemoryRevision(context.vaultKey)]),credential,limits:cfg.limits}
    },
    stream:streamModelStep,changed:context=>{if(vault?.sessionId()===context.sessionId)send(IPC.memoryChanged,context.sessionId)}
  })
  agentHost = new AgentHost({
    prepareSource:async (input,grant)=>{
      if(!input.sessionId||!input.objectVersion||!input.expectedRevision)throw Error('BAD_REQUEST')
      if(!grant)throw Error('INVALID_AUTHORIZATION')
      return vault!.prepareTaskSource({...input,sessionId:input.sessionId,objectVersion:input.objectVersion,expectedRevision:input.expectedRevision},grant)
    },
    onTaskStarted:id=>consolidation?.capture(id),
    onTaskStartFailed:id=>consolidation?.discard(id),
    onTaskMaterialDiscarded:id=>consolidation?.discard(id),
    onTaskMaterialSaved:material=>consolidation!.handoff(material),
    onTaskMaterialResult:result=>{void consolidation?.materialResult(result).catch(()=>{/* Saved output remains valid; the consumer owns its bounded failure result. */})},
    summaryAllowed:(relPath,taskIds)=>workingService()!.summaryAllowed(relPath,taskIds),
    memory:{context:()=>vault!.memoryContext(),config:key=>({enabled:modelConfig!.getMemoryConfig(key).vault.enabled,revision:modelConfig!.getVaultMemoryRevision(key)}),entries:ids=>workingService()!.entries(ids)},
    onReasoning:(id,text)=>reasoningStore!.write(vault!.memoryContext().vaultKey,id,text),
    summaries:{cache:contextCache,key:async relPath=>summaryHash(await vault!.ledgerKey(relPath))},
    ledger:{prepare:(relPath,chapter,version,binding)=>{if(!binding)throw Error('BAD_REQUEST');return vault!.ledgerPrepare(relPath,chapter,version,binding)},complete:(relPath,id,revision)=>vault!.ledgerComplete(relPath,id,revision),contexts:relPath=>vault!.ledgerContexts(relPath)},
    assertMemoryAuthorization: input => {
      if (!input.sessionId || input.memoryAuthorizationSignature !== memoryAuthorizationState(input.sessionId).signature) throw Error('STALE_PREVIEW')
    },
    authorize:input=>{
      if(!authorizations || !input.authorizationOwner || !input.previewId || !isAuthorizationCommand(input))throw Error('INVALID_AUTHORIZATION')
      return authorizations.consume((input as import('./agent-host.ts').HostStart).authorizationOwner!,input as AgentStartRequest)
    },
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
      return modelConfig.credential()
    },
    assistant: () => loadAssistantHabits(app.getPath('userData')),
    limits: () => {
      if (!modelConfig) throw new Error(modelConfigError ?? 'MODEL_CONFIG_UNAVAILABLE')
      return modelConfig.getPublic().limits.none
    },
    stream: (input, signal) => streamModelText({ ...input, signal }),
    streamStep: (input, signal) => streamModelStep({ ...input, signal }),
    createReadOnlyTools: (grant, taskId, memory, materials) => createScopedAgentTools(grant, taskId, {
      read: relPath => vault!.read(relPath), tier: modelTierFor,
      validateMemory: dep => memory?.validateDependency(dep) ?? Promise.resolve(false),
      validateMemoryBatch: deps => memory?.validateDependencies(deps) ?? Promise.resolve(deps.map(() => false)), materials,
      acceptsObject: (relPath, expected, current) => vault?.acceptsObject(relPath, expected, current) ?? false
    }),
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
  consolidation?.close()
  vault?.dispose()
})
