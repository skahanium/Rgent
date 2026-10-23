import { ledgerEmptyText, ledgerErrorText } from '../../shared/ledger-errors.ts'
import type { VaultWorkspace } from '../../shared/vault-management.ts'
import type { MemoryView, MemoryManualRequest, MemoryResult } from '../../shared/memory.ts'
import { memoryErrorText, renderMemoryPreview, ledgerRememberCommand, type MemoryPageHandlers } from './memory-ui.ts'
import type { SkillsPageHandlers } from './settings-skills.ts'
import type { SkillsResult } from '../../shared/skills.ts'
import { networkEvidenceText, skillsEvidenceText } from './ledger-evidence.ts'
import { IPC, type AgentEvent, type AgentPermissionLevel, type AgentTaskView, type LifecycleStatus, type NoteSnapshot, type PermissionState, type PermissionTier, type PublicModelConfig, type RelocationPreviewView, type SearchHit, type TreeEntry, type VaultState } from '@shared'
import { composeSource, partitionSource } from '@markdown'
import { RecoveryDraftGate, reportFlush, saveWorkspacePosition } from '../../shared/flush.ts'
import { renderBacklinks } from './backlinks.ts'
import { openLifecycleStatus, promptNewNote, promptText } from './dialogs.ts'
import { openFetchDialog } from './fetch-dialog.ts'
import { promptConflict } from './conflict.ts'
import { modalOpen, openOverlay } from './overlay.ts'
import { clearNotices, pushNotice } from './notice.ts'
import { renderTaskDock } from './task-dock.ts'
import { createSearchOverlay } from './search-overlay.ts'
import { createSettingsOverlay } from './settings.ts'
import { applySaved, pendingWrites, hasUnavailableDraft, taskModelId, type Tab } from './tabs.ts'
import { mountEditor, type EditorHost, type NoteHost } from './view/editor.ts'
import { renderReadOnlyMarkdown, disposeReadOnlyImages } from './view/read-only.ts'
import { icon } from './icons.ts'
import { outlineLabel, outlineMarks } from './outline.ts'
import { installShortcuts, shortcutLabel } from './shortcuts.ts'
import { modelModuleGroups, renderStatusbar, statusModel, wordsOf, type StatusModelModule } from './statusbar.ts'

import { reconcileNote, type ReconcileResult } from './note-reconcile.ts'
import { mergeHostBody } from './host-merge.ts'
import { openAuthorizationPopover, resetScopeMemory } from './authorization-popover.ts'
import { installWriteConfirm } from './write-confirm.ts'
import { hostErrorMessage, hostErrorText } from './host-errors.ts'
import { pendingSlash } from './slash.ts'
import { createFileBrowser, titleOf, collectRelPaths, type TreeAction } from './tree.ts'
import { confirmTrash } from './trash-confirm.ts'
import { createSidebarSizer } from './sidebar.ts'
import { applyResolvedTheme, type Theme } from './theme.ts'

const SAVE_MS = 800
/** 生命周期专属码。与 host-errors 重叠的码以 host-errors 为权威，这里不再复写。 */
const LIFECYCLE_ERRORS: Record<string, string> = {
  COPY_PARENT_CHANGED: '新文件已创建，但目标目录身份无法确认。请检查目标；窗口稿和待保存任务已保留，请勿重试覆盖。',
  COPY_VERIFY_FAILED: '新文件发布后的内容或身份无法确认。请检查目标；窗口稿和待保存任务已保留。',
  SOURCE_AVAILABLE: '原对象已能核验，请重新查看当前笔记后处理保存。',
  LEDGER_BASIS_UNAVAILABLE: '无法核对原账本依据，窗口稿仍保留，另存未提交。',
  BAD_SENDER:'原调用窗口已变更，正文未提交，请重新预览。',
  STALE_PREVIEW: '文件或引用在预览后发生变化，请重新预览再提交。',
  STALE_RECOVERY: '恢复记录已变化，请重新查看状态再重试。',
  EEXIST: '目标位置已有同名文件或文件夹。',
  PERMISSION_DOWNGRADE: '这次移动会使部分对象的 AI 权限意外降档，已阻止提交。',
  PERMISSION_COLLISION: '目标位置的显式权限规则发生冲突，已阻止提交。',
  PATH_RESERVED: '从界面新建同名笔记会接替旧记录。想找回原对象，请把它原样放回，再到设置的「笔记库」重扫核验。',
  PLATFORM_UNPROVEN: '这台电脑上的系统废纸篓还没有可证明的删除实现，没有执行删除。',
  TRASH_INCOMPLETE: '系统报告原路径仍被占用，删除没有完成。请检查该文件后再试。',
  ATTACHMENT_COLLISION: '同名位置是一个普通文件，不是附件夹，不能和笔记一起移动；请先处理那个文件。'
}
export const lifecycleErrorText = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  // 主进程的拒绝经 Electron `invoke` 回来会包一层「Error invoking remote method 'x': Error: CODE」，
  // 直接查表会落空，把中文说明漏成原始串（实测：同路径新建被拒时人只看到 PATH_RESERVED）。
  const marker = raw.lastIndexOf('Error: ')
  const code = raw.startsWith('Error invoking remote method') && marker >= 0 ? raw.slice(marker + 'Error: '.length).trim() : raw
  return hostErrorMessage(code) ?? LIFECYCLE_ERRORS[code] ?? raw
}
const ROOT_UNAVAILABLE_NOTICE = '笔记库暂时无法读取，窗口稿和账本已保留。恢复原库后重新核验；换库前须处理或明确舍弃。'

/**
 * 不可逆风险（删除落点不符、路径冲突）保留模态：短标题只说发生了什么，
 * 原文、路径与落点都进可复制的详情，不再用原生 alert 糊成一整段。
 */
function openCopyableNotice(title: string, detail: string): void {
  const overlay = openOverlay({ label: title, className: 'modal copyable-notice' })
  const heading = document.createElement('h2')
  heading.textContent = title
  const body = document.createElement('p')
  body.className = 'copyable-notice-detail'
  body.textContent = detail
  const hint = document.createElement('p')
  hint.className = 'copyable-notice-hint'
  hint.setAttribute('role', 'status')
  const actions = document.createElement('div')
  actions.className = 'modal-actions'
  const selectBody = (): void => {
    const range = document.createRange()
    range.selectNodeContents(body)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  const copyButton = document.createElement('button')
  copyButton.type = 'button'
  copyButton.textContent = '复制详情'
  copyButton.addEventListener('click', () => {
    const clipboard = navigator.clipboard
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      selectBody()
      hint.textContent = '这个环境不能写入剪贴板；详情已选中，请手动复制。'
      return
    }
    void clipboard.writeText(detail).then(() => {
      if (overlay.isOpen()) hint.textContent = '已复制。'
    }).catch(() => {
      selectBody()
      if (overlay.isOpen()) hint.textContent = '复制失败；详情已选中，请手动复制。'
    })
  })
  const done = document.createElement('button')
  done.type = 'button'
  done.textContent = '知道了'
  done.addEventListener('click', () => overlay.close())
  actions.append(copyButton, done)
  overlay.root.append(heading, body, hint, actions)
}

/** 放弃窗口稿仍是不可逆动作，保留模态；文案短，默认焦点放在「保留」。 */
function confirmDiscardWindowDraft(): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false
    const overlay = openOverlay({ label: '明确舍弃窗口稿', className: 'modal discard-dialog', onClose: () => resolve(answer) })
    const heading = document.createElement('h2')
    heading.textContent = '明确舍弃这篇窗口稿？'
    const copy = document.createElement('p')
    copy.textContent = '这篇原对象的窗口稿及尚未落盘的生成内容会一起舍弃；磁盘同名文件不会改动。'
    const actions = document.createElement('div')
    actions.className = 'modal-actions'
    const keep = document.createElement('button')
    keep.type = 'button'
    keep.textContent = '保留窗口稿'
    keep.addEventListener('click', () => overlay.close())
    const discard = document.createElement('button')
    discard.type = 'button'
    discard.className = 'discard-confirm'
    discard.textContent = '明确舍弃'
    discard.addEventListener('click', () => { answer = true; overlay.close() })
    actions.append(keep, discard)
    overlay.root.append(heading, copy, actions)
    queueMicrotask(() => keep.focus())
  })
}

export async function start(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="app">
      <header class="top">
        <button type="button" class="tree-toggle" aria-controls="tree-panel" aria-expanded="false" aria-label="目录"></button>
        <div class="tabs" role="tablist" aria-label="打开中的笔记"><button type="button" class="tab-new" aria-label="新建笔记" title="新建笔记"></button></div>
        <span class="permission-warning" role="alert" hidden></span>
        <button type="button" class="lifecycle-warning" hidden>文件操作待核验 · 查看</button>
      </header>
      <div class="body">
        <aside id="tree-panel" class="tree-panel is-collapsed" aria-label="笔记目录">
          <div class="tree-tools">
            <button type="button" class="search-open">
              <span class="search-open-label">搜索笔记</span>
              <kbd class="shortcut-hint"></kbd>
            </button>
          </div>
          <div class="tree-scroll"></div>
          <div class="sidebar-resizer" aria-label="调整侧栏宽度" hidden></div>
        </aside>
        <section class="stage" id="note-panel" role="tabpanel" aria-label="正文">
          <button type="button" class="memory-selection-open" hidden>记住选区</button>
          <button type="button" class="ledger-open" aria-pressed="false" hidden>账本</button>
          <div class="ledger-view" hidden>
            <div class="ledger-head">
              <span class="ledger-title"></span>
              <button type="button" class="ledger-close" aria-label="关闭账本回顾">×</button>
            </div>
            <div class="ledger-body"></div>
          </div>
          <div class="note-unavailable" role="status" hidden><span></span><button type="button" class="note-recheck">重新核验</button><button type="button" class="note-save-copy">另存为新笔记</button><button type="button" class="note-discard">明确舍弃并关页</button></div>
          <p class="workspace-recovery" role="status" hidden><span></span><button type="button">重试恢复位置</button></p>
          <div class="editor-host"></div>
          <nav class="outline" aria-label="标题索引" hidden></nav>
          <div class="outline-tooltip" hidden></div>
          <p class="empty">从目录打开一篇笔记，或新建笔记。</p>
        </section>
        <aside class="backlinks" aria-label="反链"></aside>
      </div>
      <footer class="status" aria-label="状态栏"></footer>
    </div>
  `

  const treePanel = root.querySelector('#tree-panel') as HTMLElement
  const bodyEl = root.querySelector('.body') as HTMLElement
  const sidebarHandle = root.querySelector('.sidebar-resizer') as HTMLElement
  const treeScroll = root.querySelector('.tree-scroll') as HTMLElement
  const treeToggle = root.querySelector('.tree-toggle') as HTMLButtonElement
  const permissionWarning = root.querySelector('.permission-warning') as HTMLElement
  const lifecycleWarning = root.querySelector('.lifecycle-warning') as HTMLButtonElement
  const statusEl = root.querySelector('.status') as HTMLElement
  const tabsEl = root.querySelector('.tabs') as HTMLElement
  const tabNew = root.querySelector('.tab-new') as HTMLButtonElement
  tabNew.append(icon('plus'))
  tabNew.addEventListener('click', () => void createNote())
  const unavailableEl = root.querySelector('.note-unavailable') as HTMLElement
  const copyButton = root.querySelector('.note-save-copy') as HTMLButtonElement
  const discardButton = root.querySelector('.note-discard') as HTMLButtonElement
  const workspaceRecovery = root.querySelector('.workspace-recovery') as HTMLElement
  workspaceRecovery.querySelector('button')!.addEventListener('click',()=>{if(!restoringWorkspace&&!transitionBusy)void queryRestoreState()})
  const editorHostEl = root.querySelector('.editor-host') as HTMLElement
  const emptyEl = root.querySelector('.empty') as HTMLElement
  const outlineEl = root.querySelector('.outline') as HTMLElement
  const outlineTooltip = root.querySelector('.outline-tooltip') as HTMLElement
  const backlinksEl = root.querySelector('.backlinks') as HTMLElement
  const ledgerEl = root.querySelector('.ledger-view') as HTMLElement
  const ledgerTitle = root.querySelector('.ledger-title') as HTMLElement
  const ledgerBody = root.querySelector('.ledger-body') as HTMLElement
  const ledgerClose = root.querySelector('.ledger-close') as HTMLButtonElement
  const searchOpen = root.querySelector('.search-open') as HTMLButtonElement
  // 设置入口固定在底栏最左：只有图标，命中区域够大（围栏 frontend.md §编辑画布与辅助信息）。
  const settingsOpen = document.createElement('button')
  settingsOpen.type = 'button'
  settingsOpen.className = 'settings-open'
  settingsOpen.setAttribute('aria-label', '设置')
  settingsOpen.title = '设置'
  settingsOpen.append(icon('settings'))
  const memorySelection = root.querySelector('.memory-selection-open') as HTMLButtonElement
  const memoryToggle = document.createElement('button')
  memoryToggle.type = 'button'; memoryToggle.className = 'status-memory'; memoryToggle.append(icon('memory'))
  memoryToggle.setAttribute('aria-label', '当前库记忆'); memoryToggle.setAttribute('aria-pressed', 'false')
  const memoryChange=document.createElement('button');memoryChange.type='button';memoryChange.className='status-item status-memory-change';memoryChange.hidden=true;memoryChange.onclick=()=>settingsOverlay.open('记忆')
  let memorySnapshot: MemoryView | null = null
  let memoryReadSerial = 0
  let memoryBusy = false
  let memoryOverlay: ReturnType<typeof openOverlay> | null = null
  const ledgerOpenButton = root.querySelector('.ledger-open') as HTMLButtonElement
  const shortcutHint = root.querySelector('.shortcut-hint') as HTMLElement


  const fileBrowser = createFileBrowser(treeScroll, {
    onOpenNote: (path) => { void openNote(path) },
    onSetTier: (path, tier) => { void changePermission(path, tier) },
    onAction: (entry, action) => { void handleTreeAction(entry, action) },
    canTrash: window.rgent.humanTrashOnThisPlatform
  })
  const sidebarSizer = createSidebarSizer({
    body: bodyEl, panel: treePanel, handle: sidebarHandle, toggle: treeToggle, backlinks: backlinksEl,
    getPreferredWidth: () => fileBrowser.preferredWidth,
    setPreferredWidth: (width) => fileBrowser.setPreferredWidth(width)
  })

  // The gate starts before the initial vaultGet, and belongs to one apply call.
  let restoringWorkspace = true
  let stateSerial = 0
  let restoreQuerySerial=0
  let restoreQueryPending=false
  let restoreQuerySession:string|null|undefined
  let restoreQueryOperationId:string|null=null
  let currentRestoreId:string|null=null
  let transitionBusy = false
  let transitionId:string|null=null
  let releasedSession: string | null | undefined
  root.inert = true
  let workspaceTimer: number | null = null
  let restoredSession: string | null = null
  const tabs: Tab[] = []
  let active: string | null = null
  let renderedActive: string | null = null
  // 窗口收窄或警告占用顶栏时，仍保证当前项在 tab 栏自己的可视区内。
  new ResizeObserver(() => revealActiveTab()).observe(tabsEl)
  let tree: TreeEntry[] = []
  let saveTimer: number | null = null
  const clearDebounceTimers = (): void => {
    if (saveTimer != null) { window.clearTimeout(saveTimer); saveTimer = null }
    if (workspaceTimer != null) { window.clearTimeout(workspaceTimer); workspaceTimer = null }
  }
  // 冲突串行化：一次只问一个，后来的排队——旧实现用全局标志直接丢掉，
  // 第二条冲突的通知就永远没人处理了。
  let conflictChain: Promise<void> = Promise.resolve()

  function runExclusiveConflict<T>(run: () => Promise<T>): Promise<T> {
    const next = conflictChain.then(run, run)
    conflictChain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
  let backlinkToken = 0
  let treeRefreshToken = 0
  let vaultEpoch = 0
  let vaultSession: string | null = null
  let recoveryState: LifecycleStatus | null = null
  let lifecycleSerial = 0
  const recoveryDraftGate = new RecoveryDraftGate()
  let recoveryOverlay: ReturnType<typeof openLifecycleStatus> | null = null
  let conflictDecisionOpen = false
  // 横幅「核对」里人选过一次听窗口/听磁盘：只对同一份对照兑现一次，之后重新出横幅。
  let pendingConflictChoice: { relPath: string; windowBody: string; diskBody: string; choice: 'window' | 'disk' } | null = null
  const conflictNotices = new Map<string, { epoch: number; dismiss: () => void }>()
  let deferredVaultBodyConflict = false
  let permissionState: PermissionState = { status: 'ready', entries: [] }
  let vaultNameText: string | null = null
  let networkEnabled = false
  // 同会话沿用上次手动档位；自动档只对本场有效，成功启动后回落成可写。
  let sessionLevel: AgentPermissionLevel = 'read'
  // 首次打开联网总闸之前先出一次非模态披露；这里只记浏览偏好，不是授权证明。
  const NETWORK_ACK_KEY = 'rgent.network.acknowledged'
  // 声明放在状态区：applyState 会在定义点之前调用 closeVaultPicker，
  // 用 let 声明在后面会撞 TDZ（实测 ReferenceError）。
  let vaultPicker: ReturnType<typeof openOverlay> | null = null
  const searchOverlay = createSearchOverlay({
    search: (query) => window.rgent.search(query),
    onOpenNote: (relPath) => void openNote(relPath)
  })
  const settingsOverlay = createSettingsOverlay({
    vault: {
      recovery:{state:()=>window.rgent.lifecycleStatus(),repair:async request=>{const result=await window.rgent.ledgerRepair(request);await refreshLifecycle();return result}},
      // 外部消失的重扫与核验：只有人能点，成功恢复后重读树与已开窗口，让对象重新可用。
      externalRecovery:{
        scan:async()=>vaultSession?window.rgent.recoveryScan({sessionId:vaultSession}):{ok:false,error:'NO_VAULT'} as const,
        confirm:async relPath=>{
          const result:import('../../shared/ipc.ts').RecoveryConfirmResult=vaultSession?await window.rgent.recoveryConfirm({sessionId:vaultSession,relPath}):{ok:false,error:'NO_VAULT'}
          if(result.ok&&result.restored){await refreshTree();await checkOpenNotes()}
          return result
        },
        // 放弃恢复只清库内记录并释放路径：该路径若还有标签页，按「文件已不在」处理，
        // 不把释放后的路径重新当成原对象。
        abandon:async relPath=>{
          const result:import('../../shared/ipc.ts').RecoveryAbandonResult=vaultSession?await window.rgent.recoveryAbandon({sessionId:vaultSession,relPath}):{ok:false,error:'NO_VAULT'}
          if(result.ok){
            await refreshTree()
            const tab=tabs.find(item=>item.relPath===relPath)
            if(tab)markUnavailable(tab,'missing')
          }
          return result
        }
      },
      get: () => window.rgent.vaultCatalog(),
      open: id => changeVault(() => window.rgent.vaultOpen(id)),
      pick: create => changeVault(() => window.rgent.vaultPick(create)),
      change: async request => {
        const view = await window.rgent.vaultCatalogChange(request)
        if(view.state)await applyState(view.state)
        const state = view.state??await window.rgent.vaultGet()
        if (state.status === 'ready') { vaultNameText = state.rootName; updateStatus() }
        return {...view,activeId:state.status==='ready'?state.vaultId??null:view.entries.find(e=>e.id===request.id)?.id??null,activeUnavailable:state.status!=='ready'}
      }
    },
    memory: memoryHandlers,
    skills: skillsHandlers,
    getMode: () => window.rgent.themeGet(),
    setMode: async (mode) => {
      const result = await window.rgent.themeSet(mode)
      if (result.ok) applyResolvedTheme(result.mode)
      return result
    },
    getReading: () => window.rgent.readingGet(),
    setReading: (reading) => window.rgent.readingSet(reading),
    getChromeText: () => window.rgent.chromeTextGet(),
    setChromeText: (value) => window.rgent.chromeTextSet(value),
    getAssistant: () => window.rgent.assistantGet(),
    setAssistant: (habits) => window.rgent.assistantSet(habits),
    getConfig: () => window.rgent.modelConfigGet(),
    saveProvider: (request) => window.rgent.modelProviderSave(request),
    removeProvider: (request) => window.rgent.modelProviderRemove(request),
    deleteKey: (request) => window.rgent.modelKeyDelete(request),
    addModel: (request) => window.rgent.modelAdd(request),
    updateModel: (request) => window.rgent.modelUpdate(request),
    removeModel: (request) => window.rgent.modelRemove(request),
    readModels: (request) => window.rgent.modelList(request),
    setDefaultModel: (request) => window.rgent.modelDefaultSet(request),
    setLimits: (request) => window.rgent.modelLimitsSet(request),
    // 「联网」页：总闸保存即生效，密钥保存后不显示；DeepSeek 来源与抓页服务只写设备配置。
    // 模型自带联网在勾选时先探测（只发 ping，不带笔记内容），成功才写配置。
    network: () => ({
      get: () => window.rgent.networkConfig(),
      setEnabled: async enabled => {
        const result = await window.rgent.networkConfig({ enabled })
        if (result.ok) { networkEnabled = result.config.enabled; updateStatus() }
        return result
      },
      setDeepSeekKeySource: source => window.rgent.networkConfig({ deepseekKeySource: source }),
      setFetch: service => window.rgent.networkConfig({ fetch: service }),
      setNativeSearch: minimax => window.rgent.networkConfig({ nativeSearch: { minimax } }),
      probe: () => window.rgent.networkNativeProbe(),
      saveProvider: request => window.rgent.networkProviderSave(request),
      clearProvider: provider => window.rgent.networkProviderClear(provider ? { provider } : undefined),
      stats: () => window.rgent.networkStats(),
      clearStats: () => window.rgent.networkStatsClear(),
      egressLog: limit => window.rgent.networkEgressLog({ limit })
    }),
    // 远端只读 MCP：配置读写与「连接并列出工具」；只有人点击才会外发。
    mcp: () => ({
      get: () => window.rgent.mcpConfig(),
      save: request => window.rgent.mcpServerSave(request),
      remove: request => window.rgent.mcpServerRemove(request),
      discover: request => window.rgent.mcpDiscover(request)
    }),
    onModelConfigChanged: () => { void refreshModelModule(); void refreshMemory() },
    onClose: () => {
      void refreshModelModule(); void refreshMemory()
      const serial = stateSerial
      if (vaultSession || restoringWorkspace || transitionBusy) return
      void window.rgent.vaultGet().then(state => {
        if (serial === stateSerial && !vaultSession && !restoringWorkspace && !transitionBusy && !modalOpen() && state.status === 'needs-pick') showVaultPicker(state.reason, state.diagnostic)
      }).catch(() => {})
    }
  })
  function memoryHandlers(): MemoryPageHandlers | null {
    const sessionId = vaultSession
    if (!sessionId) return null
    const accept = (result: MemoryResult<MemoryView>): MemoryResult<MemoryView> => {
      if (vaultSession !== sessionId) return { ok: false, error: 'VAULT_CHANGED' }
      if (result.ok && result.value.sessionId === sessionId) { memoryReadSerial++; memorySnapshot = result.value; updateStatus() }
      return result
    }
    return {
      get: () => window.rgent.memoryGet({ sessionId }).then(accept),
      models: () => window.rgent.modelConfigGet(),
      save: r => window.rgent.memoryConfigSave({ ...r, sessionId }).then(accept),
      edit: r => window.rgent.memoryItemEdit({ ...r, sessionId }).then(accept),
      disable: r => window.rgent.memoryItemDisable({ ...r, sessionId }).then(accept),
      forget: r => window.rgent.memoryItemForget({ ...r, sessionId }).then(accept),
      restore: r => window.rgent.memoryRestorePreview({ ...r, sessionId }),
      retry: r => window.rgent.memoryJobRetryPreview({ ...r, sessionId }),
      cancel: r => window.rgent.memoryJobCancel({ ...r, sessionId }).then(accept),
      maintenance: r => window.rgent.memoryMaintenancePreview({ ...r, sessionId }),
      commit: r => window.rgent.memoryPreviewCommit({ ...r, sessionId }).then(accept)
    }
  }
  function skillsHandlers(): SkillsPageHandlers | null {
    const sessionId = vaultSession
    if (!sessionId) return null
    const accept = (result: SkillsResult): SkillsResult => (vaultSession !== sessionId ? { ok: false, error: 'VAULT_CHANGED' } : result)
    return {
      get: () => window.rgent.skillsGet({ sessionId }).then(accept),
      save: request => window.rgent.skillsSave({ ...request, sessionId }).then(accept),
      setEnabled: request => window.rgent.skillsSetEnabled({ ...request, sessionId }).then(accept)
    }
  }
  async function refreshMemory(): Promise<void> {
    if (!vaultSession) { memorySnapshot = null; updateStatus(); return }
    const session = vaultSession, serial = ++memoryReadSerial
    const result = await window.rgent.memoryGet({ sessionId: session }).catch(() => null)
    if (session !== vaultSession || serial !== memoryReadSerial) return
    if (result?.ok) memorySnapshot = result.value
    else memorySnapshot = null
    updateStatus()
  }
  memoryToggle.addEventListener('mousedown', event => event.preventDefault())
  memoryToggle.addEventListener('click', () => {
    if (!memorySnapshot || memoryBusy || memorySnapshot.sessionId !== vaultSession) return
    memoryBusy = true; updateStatus()
    const session = vaultSession!, snapshot = memorySnapshot
    void window.rgent.memoryConfigSave({ sessionId: session, target: 'vault', vault: { ...snapshot.config.vault, enabled: !snapshot.config.vault.enabled } }).then(result => {
      if (session !== vaultSession) return
      if (result.ok) { memoryReadSerial++; memorySnapshot = result.value; hostNotice = '' }
      else hostNotice = memoryErrorText(result.error)
    }).catch(() => { if (session === vaultSession) hostNotice = memoryErrorText('MEMORY_UNAVAILABLE') }).finally(() => { if (session === vaultSession) { memoryBusy = false; updateStatus() } })
  })
  // 设备默认由助手设置保存；底栏只为当前笔记保存下一场临时选择。
  let modelConfigSnapshot: PublicModelConfig | null = null
  const modelModule = (): StatusModelModule | undefined => {
    const config = modelConfigSnapshot
    if (!config) return undefined
    const tab = current()
    const groups = modelModuleGroups(config)
    const value = taskModelId(tab, config.defaultModelId)
    const invalid = value !== null && !groups.some(group => group.items.some(item => item.id === value))
    const unavailableLabel = !tab ? '打开笔记后选择' : invalid ? '模型不可用，请重新选择' : groups.length === 0 ? undefined : value === null ? '未选' : undefined
    return {
      groups, value, disabled: !tab, unavailableLabel,
      signature: JSON.stringify({ groups, value, disabled: !tab, unavailableLabel }),
      onChange: modelId => {
        if (!tab || !tabs.includes(tab) || tab !== current() || tab.availability) return
        tab.temporaryModelId = modelId
        hostNotice = ''; updateStatus()
      },
      onConfigure: () => settingsOverlay.open('助手')
    }
  }
  const refreshModelModule = async (): Promise<void> => {
    const result = await window.rgent.modelConfigGet().catch(() => null)
    if (!result || !result.ok) return
    modelConfigSnapshot = result.config
    updateStatus()
  }
  let saveInFlight: Promise<boolean> | null = null
  let ledgerOpen = false
  let countedPath: string | null = null
  let countedSource: string | null = null
  let countedWords = 0
  const activeTasks = new Map<string, AgentTaskView>()
  const endedTaskIds = new Set<string>()
  const hostRevisions = new Map<string, string>()
  let taskOverlay: ReturnType<typeof openOverlay> | null = null
  let hostNotice = ''
  let authorizationPopover: ReturnType<typeof openAuthorizationPopover> | null = null

  const editor: EditorHost = mountEditor(editorHostEl, (text) => {
    const tab = current()
    if (!tab) return
    tab.content = text
    tab.dirty = text !== tab.saved
    renderTabs()
    updateStatus()
    if (!tab.availability) scheduleSave()
  })

  /** 菜单「抓取网页…」与 ⌘⇧U／Ctrl+Shift+U 共用这一个入口：只开对话框，不代替人提交。
   *  人点「抓取／搜索」才是授权；库交接与已有模态期间不开，避免把当前浮层顶掉。 */
  function openHumanNetworkDialog(): void {
    if (vaultBusy()) {
      hostNotice = '笔记库正在切换，暂时不能抓取网页或搜索。'
      updateStatus()
      return
    }
    if (conflictDecisionOpen || modalOpen()) return
    openFetchDialog({
      canInsert: () => canInsertNetworkResult(),
      insert: text => editor.insertAtSelection(text),
      humanFetch: request => window.rgent.networkHumanFetch(request),
      humanSearch: request => window.rgent.networkHumanSearch(request),
      humanAbort: requestId => window.rgent.networkHumanAbort({ requestId })
    })
  }

  installShortcuts({
    onSearch: () => { if (!restoringWorkspace && !transitionBusy && !settingsOverlay.isBusy() && !conflictDecisionOpen) searchOverlay.open() },
    onSave: () => { if (!restoringWorkspace && !transitionBusy && !settingsOverlay.isBusy()) void flushSave() },
    onFetchWeb: () => { openHumanNetworkDialog() }
  })
  shortcutHint.textContent = shortcutLabel('k')
  searchOpen.addEventListener('click', () => { if (!conflictDecisionOpen && !settingsOverlay.isBusy()) searchOverlay.open() })
  // 图标在创建处已放入，这里只接线（模板时代那行 prepend 会让齿轮出现两次）
  settingsOpen.addEventListener('click', () => { if (!conflictDecisionOpen) settingsOverlay.open() })
  // 底栏模型模块首次取一次配置；之后由设置页写入与面板关闭时刷新。
  void refreshModelModule()
  void refreshNetworkGate()
  lifecycleWarning.addEventListener('click', () => { if (!conflictDecisionOpen) void showRecoveryStatus() })

  memorySelection.addEventListener('mousedown', event => event.preventDefault())
  memorySelection.addEventListener('click', () => { const range = editor.selectionRange(); void rememberSelection('body', Math.min(range.anchor, range.head), Math.max(range.anchor, range.head)) })

  editor.onStateChange(() => {
    const tab = current()
    if (tab) tab.selection = editor.selectionRange()
    updateStatus()
    renderOutline()
    scheduleWorkspace()
  })
  editor.onViewportChange(() => { renderOutline() })
  window.addEventListener('rgent:theme', (event) => {
    editor.setTheme((event as CustomEvent<Theme>).detail === 'night')
  })
  editor.setTheme(document.documentElement.dataset.theme === 'night')

  editor.view.dom.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229 || editor.view.compositionStarted) return
    const selection = editor.selectionRange()
    if (selection.anchor !== selection.head) return
    const submission = pendingSlash(editor.getText(), selection.head, editor.slashCommandStart())
    if (!submission || conflictDecisionOpen || modalOpen()) return
    event.preventDefault()
    void submitSlash(submission)
  }, { capture: true })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || editor.view.compositionStarted || modalOpen()) return
    // 授权卡是非模态：modalOpen() 看不见它。卡开着时 Esc 归卡片／取消，不能顺便清掉「暂停中」。
    if (authorizationPopover) return
    const tab = current()
    const task = tab && [...activeTasks.values()].find((item) => item.relPath === tab.relPath)
    if (task) {
      event.preventDefault()
      void abortCurrent()
      return
    }
    if (tab?.pausedByUser && tab.pausedRestart) {
      event.preventDefault()
      endPaused()
    }
  }, true)

  treeToggle.addEventListener('click', () => {
    const open = treePanel.classList.contains('is-collapsed')
    if (!open) fileBrowser.captureScroll()
    sidebarSizer.setExpanded(open)
    scheduleWorkspace()
  })

  copyButton.addEventListener('click', () => { void saveMissingCopy() })
  discardButton.addEventListener('click', () => { void discardMissing() })
  root.querySelector('.note-recheck')!.addEventListener('click', () => { void checkOpenNotes().then(() => {
    if (tabs.every(tab => !tab.availability) && hostNotice === ROOT_UNAVAILABLE_NOTICE) hostNotice = ''
    renderTabs(); updateStatus(); void refreshTree()
  }) })
  ledgerOpenButton.addEventListener('click', () => toggleLedger())
  ledgerClose.addEventListener('click', () => closeLedger(true))

  window.rgent.onMenu(IPC.menuOpenVault, () => {
    if (restoringWorkspace || transitionBusy || settingsOverlay.isBusy()) return
    showVaultManager()
  })
  window.rgent.onMenu(IPC.menuNewNote, () => {
    if (restoringWorkspace || transitionBusy || settingsOverlay.isBusy()) return
    void createNote()
  })
  window.rgent.onMenu(IPC.menuSave, () => {
    if (restoringWorkspace || transitionBusy || settingsOverlay.isBusy()) return
    void flushSave()
  })
  // 人发起抓页／搜索：菜单快捷键只负责开对话框；人点「抓取／搜索」即授权，不再二次确认。
  window.rgent.onMenu(IPC.menuFetchWeb, () => { openHumanNetworkDialog() })
  window.rgent.onTreeChanged(() => {
    void refreshLifecycle().then(() => refreshTree()).then(() => checkOpenNotes())
  })
  window.rgent.onVaultLost(() => {
    void showPicker(true)
  })
  window.rgent.onFlushRequest(() => {
    void reportFlush(async()=>{const workspace=await saveWorkspace();const body=await flushSave();return workspace&&body}, (payload) => window.rgent.flushDone(payload))
  })
  // The release may name the new mount before its ready reply reaches applyState.
  window.rgent.onVaultTransition((busy,session,state)=>{
    if(busy&&!state.restoreId&&restoreQueryPending){
      // A restoring/closePending update belongs to the same query, unless its binding changed.
      const superseded=state.phase==='preparing'||session!==restoreQuerySession||
        !!(state.operationId&&restoreQueryOperationId&&state.operationId!==restoreQueryOperationId)
      if(superseded){restoreQuerySerial++;restoreQueryPending=false;currentRestoreId=null;restoringWorkspace=false}
      else if(state.operationId)restoreQueryOperationId??=state.operationId
    }
    transitionId=busy?(state.operationId??transitionId):null
    releasedSession = !busy && session !== vaultSession ? session : undefined
    transitionBusy = busy || releasedSession !== undefined
    if(busy&&state.phase){
      hostNotice=state.phase==='preparing'?'正在准备切换笔记库。':state.phase==='committing'?'正在提交新库绑定。':'正在恢复新库工作区。'
      if(state.closePending)hostNotice+='关闭请求已登记，将在当前交接结束后处理。'
      updateStatus()
    }
    syncInteractionGate()
    if(state.restoreId)void queryRestoreState(state.restoreId,session)
  })
  window.rgent.onLifecycleFlushRequest((id, cleanUnavailablePaths, phase, context) => {
    if (phase?.startsWith('recovery-')||phase==='root-recovery-protect') {
      if (!context) { window.rgent.lifecycleFlushDone(id,false); return }
      if(phase==='root-recovery-protect'){const tab=current();if(tab){tab.content=editor.getText();tab.selection=editor.selectionRange();tab.scrollTop=editor.view.scrollDOM.scrollTop}clearDebounceTimers()}
      const deps = {session:()=>vaultSession,composing:()=>restoringWorkspace||editor.view.compositionStarted,
        changed:syncRecoveryInput,settled:()=>Promise.resolve(saveInFlight),save:()=>flushSave(context.operationId),dirty:()=>tabs.some(tab=>tab.dirty||!!tab.availability)}
      void (async()=>{
        if (phase==='recovery-release') await refreshLifecycle()
        const ok=await recoveryDraftGate.handle(phase as import('../../shared/flush.ts').RecoveryFlushPhase,context,deps)
        if (phase==='recovery-release') { if(context.sessionId===vaultSession&&!bodyWritesPaused()&&tabs.some(tab=>tab.dirty))scheduleSave() }
        else if(phase==='root-recovery-protect')window.rgent.lifecycleFlushDone(id,ok,tabs.filter(t=>t.sessionId===context.sessionId&&t.objectVersion).map(t=>({relPath:t.relPath,objectVersion:t.objectVersion!})))
        else window.rgent.lifecycleFlushDone(id,ok)
      })().catch(()=>window.rgent.lifecycleFlushDone(id,false))
      return
    }
    if(context&&(!transitionBusy||context.operationId!==transitionId||(context.sessionId||null)!==vaultSession)){window.rgent.lifecycleFlushDone(id,false);return}
    if (phase === 'settings') { window.rgent.lifecycleFlushDone(id, !restoringWorkspace && settingsOverlay.prepareVaultChange()); return }
    if (phase === 'freeze') { if(restoringWorkspace || editor.view.compositionStarted){window.rgent.lifecycleFlushDone(id,false);return} releasedSession=undefined;transitionBusy=true;syncInteractionGate(); window.rgent.lifecycleFlushDone(id,true);return }
    const workspaceSave = saveWorkspace()
    const flush = cleanUnavailablePaths.length
      ? Promise.resolve(saveInFlight).then(() => performFlushSave(cleanUnavailablePaths)) : flushSave()
    void Promise.all([workspaceSave,flush]).then(([workspace,ok]) => window.rgent.lifecycleFlushDone(id, workspace&&ok), () => window.rgent.lifecycleFlushDone(id, false))
  })
  window.rgent.onNoteRelocated(({ moved, sessionId }) => {
    if (sessionId && sessionId !== vaultSession) return
    applyRelocation(moved)
    void refreshLifecycle()
  })

  function applyRelocation(moved: { from: string; to: string }[]): void {
    const remap = (relPath: string): string => {
      const match = moved.find((item) => relPath === item.from || relPath.startsWith(`${item.from}/`))
      return match ? `${match.to}${relPath.slice(match.from.length)}` : relPath
    }
    fileBrowser.relocate(moved)
    for (const tab of tabs) tab.relPath = remap(tab.relPath)
    if (active) active = remap(active)
    const revisions = [...hostRevisions.entries()]
    hostRevisions.clear()
    for (const [relPath, revision] of revisions) hostRevisions.set(remap(relPath), revision)
    // 冲突横幅跟着对象走；还没兑现的「听窗口/听磁盘」对旧路径无效了。
    const conflictEntries = [...conflictNotices.entries()]
    conflictNotices.clear()
    for (const [relPath, entry] of conflictEntries) conflictNotices.set(remap(relPath), entry)
    pendingConflictChoice = null
    syncEditorHost()
    renderTabs()
    void refreshTree()
    void refreshMovedTabs()
  }
  window.rgent.onNoteExternalChange(() => {
    // 别的笔记被外部改了，可能多了或少了指向当前这篇的链接。
    void refreshBacklinks()
  })
  window.rgent.onNoteExternalChange((payload) => {
    if (payload.sessionId && payload.sessionId !== vaultSession) return
    const tab = tabs.find((item) => item.relPath === payload.relPath)
    if (!tab||tab.sessionId!==vaultSession) return
    const epoch = vaultEpoch
    // 事件负载只提示需要复核；排队后必须重新读盘，不能采用排队前的旧快照。
    void runExclusiveConflict(() => reconcileTab(tab, epoch)).then(() => {
      renderTabs()
      updateStatus()
    }).catch(() => { /* 读写失败时保留窗口稿，后续保存仍会复核修订值。 */ })
  })
  // 「建」的人确认：主进程发起请求，这里只摆一张卡并回一个是否同意。
  // 路径按 requestId 记账，后开不能覆盖先开；确认 IPC 失败／超时都不当成功。
  const writeConfirmEffects = new Map<string, { delete?: string; create?: string }>()
  installWriteConfirm({
    onRequest: handler => window.rgent.onAgentWriteRequest(preview => {
      writeConfirmEffects.set(preview.requestId, {
        ...(preview.kind === 'delete' ? { delete: preview.relPath } : {}),
        ...(preview.kind === 'create' ? { create: preview.relPath } : {})
      })
      handler(preview)
    }),
    decide: async decision => {
      const pending = writeConfirmEffects.get(decision.requestId)
      writeConfirmEffects.delete(decision.requestId)
      const result = await window.rgent.agentWriteConfirm(decision)
      if (decision.approved && result && pending?.delete) await closeTrashedTabs(pending.delete, { includeAttachment: false })
      // AI 的「建」也要走同一个打开入口：否则文件树里点新笔记会复用同路径那个不可用的旧 tab。
      if (decision.approved && result && pending?.create) await openCreatedNote(pending.create)
      return result
    }
  })

  window.rgent.onMemoryChanged(session => {
    if (session !== vaultSession) return
    void refreshMemory()
    window.dispatchEvent(new CustomEvent('rgent:memory', { detail: session }))
  })
  window.rgent.onAgentEvent((event) => {
    onHostEvent(event)
    if (event.status !== 'running') void refreshMemory()
  })

  void window.rgent.agentTasks().then((tasks) => {
    for (const task of tasks) {
      if (!endedTaskIds.has(task.id)) activeTasks.set(task.id, task)
    }
    syncActiveLocks()
    updateStatus()
  }).catch(() => {})

  async function submitSlash(submission: { range: { start: number; end: number }; prompt: string }, initials?: { level?: AgentPermissionLevel }): Promise<void> {
    const tab=current();if(!tab || authorizationPopover || conflictDecisionOpen)return
    if(tab.availability || !tab.sessionId || !tab.objectVersion)return
    const selectedModelId = taskModelId(tab, modelConfigSnapshot?.defaultModelId ?? null)
    if (!selectedModelId || !modelConfigSnapshot || !modelModuleGroups(modelConfigSnapshot).some(group => group.items.some(item => item.id === selectedModelId))) {
      hostNotice = '请选择可用模型；设备默认可在设置的「助手」页保存。'; updateStatus(); return
    }
    if([...activeTasks.values()].some(task=>task.relPath===tab.relPath)){hostNotice='这篇笔记已有正在运行的任务。';updateStatus();return}
    if(!await flushSave()){hostNotice='先保存所有窗口稿，才能准备本场范围。';updateStatus();return}
    if(current()!==tab || !tabs.includes(tab))return
    const draft=editor.getText()
    if(draft.slice(submission.range.start,submission.range.end)!==`/${submission.prompt}`)return
    const request=()=>({modelRecordId:taskModelId(tab, modelConfigSnapshot?.defaultModelId ?? null) ?? '',relPath:tab.relPath,range:submission.range,expectedText:draft.slice(submission.range.start,submission.range.end),promptText:submission.prompt,
      sessionId:tab.sessionId!,objectVersion:tab.objectVersion!,expectedRevision:tab.revision})
    let displayedRequest:ReturnType<typeof request>|null=null
    const coords=editor.view.coordsAtPos(editor.view.state.selection.main.head)??editor.view.dom.getBoundingClientRect()
    authorizationPopover=openAuthorizationPopover({discard:id=>window.rgent.agentAuthorizationDiscard(id),origin:tab.relPath,entries:tree,anchor:coords,
      returnFocus:()=>editor.view.contentDOM,
      initialLevel:initials?.level ?? sessionLevel,
      onClose:()=>{authorizationPopover=null},
      preview:async (references,level)=>{
        if(current()!==tab || !tabs.includes(tab) || editor.getText()!==draft)return {ok:false,error:'STALE_AUTHORIZATION'}
        if(!await flushSave())return {ok:false,error:'UNSAVED_DRAFT'}
        displayedRequest=request()
        return window.rgent.agentAuthorizationPreview({...displayedRequest,references,level})
      },
      send:async (preview,level)=>{
        if(!displayedRequest || current()!==tab || !tabs.includes(tab) || editor.getText()!==draft || taskModelId(tab, modelConfigSnapshot?.defaultModelId ?? null)!==displayedRequest.modelRecordId)return {ok:false,error:'STALE_AUTHORIZATION'}
        if(!await flushSave())return {ok:false,error:'UNSAVED_DRAFT'}
        const result=await window.rgent.agentStart({...displayedRequest,previewId:preview.id,level})
        if(!result.ok)return result
        // 档位记进暂停重启；自动档绝不带到下一场。
        tab.pausedRestart={promptText:displayedRequest.promptText,modelRecordId:displayedRequest.modelRecordId,level}
        sessionLevel=level==='auto'?'write':level
        tab.pausedByUser=false
        if(!endedTaskIds.has(result.id))activeTasks.set(result.id,{id:result.id,relPath:tab.relPath,startedAt:Date.now()})
        hostNotice='';syncActiveLocks();updateStatus()
        void runExclusiveConflict(()=>syncHostTab(tab,vaultEpoch))
        return result
      }
    })
  }

  function onHostEvent(event: AgentEvent): void {
    if (event.sessionId && event.sessionId !== vaultSession) return
    // 自动档的新建没有确认卡：给一条可打开落点的非模态通知，标题只取文件名。
    if (event.created?.relPath) {
      const created = event.created.relPath
      pushNotice({
        title: `已新建《${titleOf(created.slice(created.lastIndexOf('/') + 1))}》`,
        detail: '已按自动档创建；可以打开查看。',
        tone: 'info',
        action: { label: '打开', run: () => { void openCreatedNote(created) } }
      })
    }
    if (event.persisted && event.revision) hostRevisions.set(event.relPath, event.revision)
    if (event.status === 'running') {
      if (!endedTaskIds.has(event.id)) activeTasks.set(event.id, { id: event.id, relPath: event.relPath, startedAt: activeTasks.get(event.id)?.startedAt ?? Date.now(), activity: event.activity })
    } else {
      endedTaskIds.add(event.id)
      activeTasks.delete(event.id)
      const owner = tabs.find((item) => item.relPath === event.relPath)
      if (event.status === 'cancelled' && owner?.pausedByUser && owner.pausedRestart) {
        hostNotice = `已停止：${event.relPath}`
      } else {
        if (owner) { delete owner.pausedRestart; owner.pausedByUser = false }
        if (event.status === 'failed') hostNotice = `生成失败：${hostErrorText(event.reason ?? '未知错误')}`
        else if (event.status === 'cancelled') hostNotice = `已停止：${event.relPath}`
      }
    }
    syncActiveLocks()
    updateStatus()
    renderTaskOverlay()
    if (!event.persisted) return
    const tab = tabs.find((item) => item.relPath === event.relPath)
    if (tab) void runExclusiveConflict(() => syncHostTab(tab, vaultEpoch))
  }

  function syncActiveLocks(): void {
    editor.setActiveTaskIds(new Set([...activeTasks.values()]
      .filter((task) => task.relPath === active)
      .map((task) => task.id)))
  }

  async function syncHostTab(tab: Tab, epoch: number): Promise<'merged' | ReconcileResult> {
    if (epoch !== vaultEpoch || !tabs.includes(tab)) return 'stale'
    const snapshot = await readBoundTab(tab)
    if (epoch !== vaultEpoch || !tabs.includes(tab)) return 'stale'
    if (snapshot.revision === tab.revision) return 'unchanged'
    // Only a revision reported by Host may be merged automatically. External
    // writes still need the user's existing two-preview conflict decision.
    if (snapshot.revision !== hostRevisions.get(tab.relPath)) return reconcileTab(tab, epoch)
    const part = partitionSource(snapshot.content)
    const draft = tab.relPath === active ? editor.getText() : tab.content
    const merged = tab.dirty ? mergeHostBody(tab.saved, draft, part.body) : part.body
    if (merged === null) {
      return reconcileTab(tab, epoch)
    }
    tab.content = merged
    tab.saved = part.body
    tab.ledger = part.ledger
    tab.revision = snapshot.revision
    tab.objectVersion = snapshot.objectVersion
    tab.sessionId = snapshot.sessionId
    tab.dirty = merged !== part.body
    if (active === tab.relPath) editor.applyExternalText(merged)
    // Host 已把两份正文合上：之前的冲突横幅不再成立。
    dismissConflictNotice(tab.relPath)
    if (tab.dirty) scheduleSave()
    if (ledgerOpen && active === tab.relPath) {
      ledgerOpen = false
      toggleLedger()
    }
    renderTabs()
    updateStatus()
    renderOutline()
    return 'merged'
  }

  function reconcileTab(tab: Tab, epoch = vaultEpoch): Promise<ReconcileResult> {
    return reconcileNote(tab, {
      isCurrent: () => vaultEpoch === epoch && tabs.includes(tab),
      read: () => readBoundTab(tab),
      draft: () => tab.relPath === active ? editor.getText() : tab.content,
      choose: async (windowBody, diskBody) => {
        // A switch is still preparing: replacing its retained settings overlay
        // would discard settings drafts before a new vault has committed.
        if (settingsOverlay.isBusy()) {
          deferredVaultBodyConflict = true
          return 'continue'
        }
        // 人刚在横幅点过「核对」并选了听窗口/听磁盘：只对同一份对照兑现一次。
        const pending = pendingConflictChoice
        if (pending && pending.relPath === tab.relPath && pending.windowBody === windowBody && pending.diskBody === diskBody) {
          pendingConflictChoice = null
          return pending.choice
        }
        // 自动路径不再弹模态：先出可点横幅，保存仍被拒、草稿保留；点「核对」才进核对浮层。
        showConflictNotice(tab, epoch)
        return 'continue'
      },
      write: (request) => window.rgent.noteWrite(request),
      applyDisk: (snapshot) => {
        applySource(tab, snapshot)
        if (active === tab.relPath) editor.setText(tab.content)
        dismissConflictNotice(tab.relPath)
      },
      applySaved: (body, ledger, revision) => {
        tab.ledger = ledger
        applySaved(tab, body, revision)
        dismissConflictNotice(tab.relPath)
        void refreshBacklinks()
      }
    })
  }

  /** 冲突横幅：同一篇笔记反复冲突只保留一条，动作换成最新一次。 */
  function showConflictNotice(tab: Tab, epoch: number): void {
    const dismiss = pushNotice({
      key: `conflict:${tab.relPath}`,
      title: '这篇笔记和磁盘不一致',
      detail: '保存已暂缓；核对后再继续。',
      tone: 'warning',
      action: { label: '核对', run: () => reviewConflict(tab, epoch) }
    })
    conflictNotices.set(tab.relPath, { epoch, dismiss })
  }

  function dismissConflictNotice(relPath: string): void {
    const entry = conflictNotices.get(relPath)
    if (!entry) return
    conflictNotices.delete(relPath)
    entry.dismiss()
  }

  /** 只有人点横幅上的「核对」才打开现有核对浮层（promptConflict）。 */
  function reviewConflict(tab: Tab, epoch: number): void {
    if (conflictDecisionOpen || epoch !== vaultEpoch || !tabs.includes(tab) || tab.availability) return
    conflictDecisionOpen = true
    void (async () => {
      try {
        const snapshot = await readBoundTab(tab).catch(() => null)
        if (!snapshot) {
          // 读不到磁盘了（消失/被替换/换库）：横幅已经没有可核对的对照，撤掉。
          dismissConflictNotice(tab.relPath)
          return
        }
        if (epoch !== vaultEpoch || !tabs.includes(tab) || tab.availability) return
        const windowBody = tab.relPath === active ? editor.getText() : tab.content
        const diskBody = partitionSource(snapshot.content).body
        // 磁盘已经和窗口稿一致（或草稿已空）时不必再核对，照常重跑一次让保存自行收敛。
        if (!tab.dirty || windowBody === diskBody) {
          await runExclusiveConflict(() => reconcileTab(tab, epoch))
          // 保存收敛可能改了 dirty/revision：重绘 tab 与底栏，别让脏点留到下次重绘。
          renderTabs(); updateStatus()
          return
        }
        const choice = await promptConflict({
          title: titleOf(tab.relPath.split('/').pop() ?? tab.relPath),
          windowText: windowBody,
          diskText: diskBody
        })
        if (choice === 'continue' || epoch !== vaultEpoch || !tabs.includes(tab)) return
        const pending = { relPath: tab.relPath, windowBody, diskBody, choice }
        pendingConflictChoice = pending
        try {
          await runExclusiveConflict(() => reconcileTab(tab, epoch))
        } finally {
          if (pendingConflictChoice === pending) pendingConflictChoice = null
        }
        // 选「听磁盘/听窗口」后状态已经落定：立即重绘 tab 与底栏，脏点不能等下一次重绘才消失。
        renderTabs(); updateStatus()
      } finally {
        conflictDecisionOpen = false
      }
    })()
  }

  await applyState(await window.rgent.vaultGet())

  /** Query ownership starts at the gesture/event, before vaultGet can yield. */
  async function queryRestoreState(restoreId?:string, targetSession?:string|null):Promise<void> {
    const query=++restoreQuerySerial,serial=++stateSerial,sourceSession=vaultSession
    const expectedSession=restoreId?targetSession:sourceSession
    restoreQuerySession=expectedSession;restoreQueryOperationId=transitionId
    currentRestoreId=restoreId??null;restoreQueryPending=true;restoringWorkspace=true
    vaultEpoch++
    clearDebounceTimers()
    syncInteractionGate()
    const current=()=>root.isConnected&&restoreQueryPending&&query===restoreQuerySerial&&serial===stateSerial&&
      vaultSession===sourceSession&&currentRestoreId===(restoreId??null)
    let timer:ReturnType<typeof setTimeout>|undefined
    try{
      const next=await Promise.race([window.rgent.vaultGet(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('WORKSPACE_QUERY_TIMEOUT')),10_000)})])
      if(!current())return
      if((next.sessionId??null)!==expectedSession)throw Error('VAULT_CHANGED')
      // Same-session retries must not replay a commit flag over retained drafts.
      if(timer){clearTimeout(timer);timer=undefined}
      const state=next.status==='ready'?{...next,vaultChanged:next.sessionId!==sourceSession&&next.vaultChanged}:next
      await applyState({...state,...(restoreId?{restoreId}:{})})
    }catch{
      if(!current())return
      hostNotice=restoreId?'无法核验新库，交接保护仍保持。请在关闭提示中重试恢复。':'当前库位置核验未完成，原位置记录和窗口稿已保留。请重试恢复位置。'
      workspaceRecovery.querySelector('span')!.textContent=hostNotice;workspaceRecovery.hidden=false;updateStatus()
    }finally{
      if(timer)clearTimeout(timer)
      if(current()){
        restoreQuerySerial++;restoreQueryPending=false;currentRestoreId=null
        restoringWorkspace=false;syncInteractionGate()
      }
    }
  }

  async function applyState(state: VaultState): Promise<void> {
    restoreQuerySerial++;restoreQueryPending=false;currentRestoreId=state.restoreId??null
    const serial = ++stateSerial
    let cleanupSerial=serial, diagnosed=false
    let restoreTimer:ReturnType<typeof setTimeout>|undefined
    restoringWorkspace = true
    // Consume the release only after this restore owns the interaction gate.
    if (releasedSession !== undefined && state.sessionId === releasedSession) { releasedSession=undefined;transitionBusy=false }
    clearDebounceTimers()
    syncInteractionGate()
    vaultEpoch += 1
    workspaceRecovery.hidden=true
    const restore = async () => {
      if (state.status === 'needs-pick') {
        diagnosed=true
        if(state.restoreId&&state.sessionId!==undefined&&state.sessionId!==vaultSession){if(!state.protectedSessionId)resetSession();else for(const tab of tabs)markUnavailable(tab,'replaced');vaultSession=state.sessionId}
        if (tabs.length) {
          for (const tab of tabs) markUnavailable(tab, 'unavailable')
          hostNotice = ROOT_UNAVAILABLE_NOTICE
          closeVaultPicker()
          updateStatus()
          return
        }
        settingsOverlay.close(); memoryOverlay?.close(); memorySnapshot = null; memoryBusy = false
        vaultSession = state.sessionId ?? null
        const ok = await flushSave()
        if (serial !== stateSerial) return
        if (!ok && tabs.some((tab) => tab.dirty)) {
          vaultNameText = null
          updateStatus()
          showVaultPicker(state.reason, state.diagnostic)
          return
        }
        resetSession()
        fileBrowser.setVault(null)
        sidebarSizer.refresh()
        vaultNameText = null
        updateStatus()
        showVaultPicker(state.reason, state.diagnostic)
        return
      }
      if (settingsOverlay.isOpen() && (state.vaultChanged || state.sessionId !== vaultSession)) settingsOverlay.close()
      closeVaultPicker()
      const sessionChanged = !!vaultSession && !!state.sessionId && vaultSession !== state.sessionId
      if (sessionChanged || state.vaultChanged) { settingsOverlay.close(); memoryOverlay?.close(); memorySnapshot = null; memoryBusy = false }
      vaultSession = state.sessionId ?? null
      void refreshMemory()
      vaultNameText = state.rootName
      updateStatus()
      if (state.vaultChanged || sessionChanged) {
        // chooseVault flushed the old vault before vaultPick switched the root.
        // Never send an old tab's path through noteWrite after the new root is active.
        if(state.protectedSessionId){for(const tab of tabs)markUnavailable(tab,'replaced');hostNotice='原库窗口稿和待保存回答已保留。请逐篇另存正文或明确舍弃；根关联不复制历史。';renderTabs()}else resetSession()
      }
      fileBrowser.setVault(state.navigationKey ?? null,state.legacyNavigationKey)
      sidebarSizer.refresh()
      if(!await refreshLifecycle())diagnosed=true
      if (serial !== stateSerial) return
      if(!await refreshTree())diagnosed=true
      if (serial !== stateSerial) return
      if(tabs.some(t=>t.sessionId&&t.sessionId!==vaultSession)){restoredSession=null;diagnosed=true}
      if (vaultSession && restoredSession !== vaultSession&&!tabs.some(t=>t.sessionId&&t.sessionId!==vaultSession)) {
        const session = vaultSession
        const restored = await restoreWorkspace(session, serial)
        if (serial !== stateSerial || session !== vaultSession) return
        if (restored) restoredSession = session
        else diagnosed=true
      }
      if (state.diagnostic) { diagnosed=true;hostNotice = state.diagnostic; updateStatus() }
    }
    try {
      await Promise.race([restore(),new Promise<never>((_,reject)=>{restoreTimer=setTimeout(()=>reject(Error('WORKSPACE_RESTORE_TIMEOUT')),10_000)})])
    } catch {
      if(serial!==stateSerial)return
      // Invalidate every pending tree/note/position continuation before releasing input.
      cleanupSerial=++stateSerial;vaultEpoch++;restoredSession=null;diagnosed=true
    } finally {
      if(restoreTimer)clearTimeout(restoreTimer)
      if(cleanupSerial===stateSerial){
        if(diagnosed){
          hostNotice=(state.diagnostic?state.diagnostic+' ':'')+'工作区恢复未完整确认，已保留原位置记录和窗口稿。请重试恢复位置；关闭时仍须核对保存结果。'
          workspaceRecovery.querySelector('span')!.textContent=hostNotice
          workspaceRecovery.hidden=false;updateStatus()
        }
        restoringWorkspace=false;syncInteractionGate()
        if(state.restoreId)await window.rgent.vaultTransitionDone({id:state.restoreId,sessionId:state.sessionId??null,outcome:diagnosed?'diagnosed':'ready'}).catch(()=>false)
      }
    }
  }

  function syncInteractionGate(): void { root.inert = restoringWorkspace || transitionBusy }
  function bodyWritesPaused(): boolean { return recoveryState?.status==='invalid'||recoveryState?.operation?.kind==='ledger-repair' }
  /** 库交接期间不开联网对话框：与其它菜单动作同一把闸。 */
  function vaultBusy(): boolean { return restoringWorkspace || transitionBusy || settingsOverlay.isBusy() }
  /** 插入条件：有活动 tab、对象可用、编辑器可写、该篇没有活动任务、正文写入未被暂停。 */
  function canInsertNetworkResult(): boolean {
    const tab = current()
    return !!tab && !tab.availability && !editor.view.state.readOnly && !bodyWritesPaused() &&
      ![...activeTasks.values()].some(task => task.relPath === tab.relPath)
  }
  function syncRecoveryInput(): void {
    editor.setReadOnly(bodyWritesPaused()||recoveryDraftGate.held(vaultSession))
    if(bodyWritesPaused())clearDebounceTimers()
  }

  function workspaceSnapshot(): VaultWorkspace {
    const tab = current()
    if (tab) { tab.selection = editor.selectionRange(); tab.scrollTop = editor.view.scrollDOM.scrollTop }
    return {version:1,tabs:tabs.filter(t=>t.sessionId===vaultSession).map(t=>({relPath:t.relPath,selection:t.selection,scrollTop:t.scrollTop})),active,
      sidebarHidden:treePanel.classList.contains('is-collapsed'),...fileBrowser.workspaceScroll()}
  }
  async function saveWorkspace(): Promise<boolean> {
    if (!root.isConnected || restoringWorkspace || tabs.some(t=>t.sessionId&&t.sessionId!==vaultSession) || vaultSession && restoredSession !== vaultSession) return false
    if (!vaultSession) return true
    const session = vaultSession
    return saveWorkspacePosition(()=>window.rgent.vaultWorkspaceSave(session,workspaceSnapshot()),()=>{if(session===vaultSession){hostNotice='工作区位置未保存，已留在当前库。请检查本机存储后重试保存或切换。';updateStatus()}})
  }
  function scheduleWorkspace(): void {
    if (restoringWorkspace || tabs.some(t=>t.sessionId&&t.sessionId!==vaultSession) || !vaultSession || restoredSession !== vaultSession) return
    if (workspaceTimer !== null) window.clearTimeout(workspaceTimer)
    workspaceTimer = window.setTimeout(()=>{workspaceTimer=null;if(root.isConnected)void saveWorkspace()},400)
  }
  async function restoreWorkspace(session: string, serial: number): Promise<boolean> {
    const currentRestore = () => vaultSession === session && stateSerial === serial
    try {
      const workspace = await window.rgent.vaultWorkspaceGet(session)
      if (!currentRestore()) return false
      if (!workspace) return true
      for (const item of workspace.tabs) {
        if (!currentRestore()) return false
        await openNote(item.relPath, serial)
        if (!currentRestore()) return false
        let tab = tabs.find(t=>t.relPath===item.relPath)
        if (!tab) { tab = {relPath:item.relPath,content:'',ledger:null,saved:'',revision:'',dirty:false,availability:'unavailable'};tabs.push(tab) }
      }
      for (const item of workspace.tabs) {
        const tab = tabs.find(t => t.relPath === item.relPath)
        if (tab) { tab.selection = item.selection; tab.scrollTop = item.scrollTop }
      }
      sidebarSizer.setExpanded(!workspace.sidebarHidden)
      fileBrowser.restoreWorkspaceScroll(workspace.treeScroll, workspace.resourceScroll)
      const selected = workspace.active ?? workspace.tabs[0]?.relPath
      // The restored selection must not be replaced by the last tab opened during restoration.
      active = null
      if (selected) activate(selected)
      renderTabs()
      return true
    } catch { if(currentRestore()){hostNotice='工作区位置无法恢复，笔记仍可正常打开。';updateStatus()};return false }
  }
  editor.view.scrollDOM.addEventListener('scroll', scheduleWorkspace, {passive:true})
  treeScroll.addEventListener('scroll', scheduleWorkspace, {capture:true,passive:true})
  window.addEventListener('pagehide',()=>{void saveWorkspace()})

  function resetSession(): void {
    clearDebounceTimers()
    resetScopeMemory()
    // 换库即新的一场：档位也回到默认只读，不把上一个库的手动档带进新库。
    sessionLevel = 'read'
    vaultEpoch += 1
    // 换库后旧横幅的「核对」已经指向不存在的窗口稿，连同待兑现的选择一起作废；
    // 其余通知也在描述上一个库的操作，不能跟着进新库。
    clearNotices()
    conflictNotices.clear()
    pendingConflictChoice = null
    recoveryState = null
    syncRecoveryInput()
    recoveryOverlay?.close(); recoveryOverlay = null
    lifecycleWarning.hidden = true
    renderTaskDock({ kind: 'hidden' })
    // 底栏跟着库与 tab 走，重置之后统一刷一次。
    queueMicrotask(() => updateStatus())
    tabs.length = 0
    activeTasks.clear()
    endedTaskIds.clear()
    hostRevisions.clear()
    syncActiveLocks()
    active = null
    editor.setText('', noteHost())
    sidebarSizer.setExpanded(false)
    renderTabs()
    void refreshBacklinks()
  }


  /**
   * 只在打开/切换笔记时刷新。索引在主进程里是惰性重建的，所以查的时候就是新的；
   * 不挂在每次按键或每次自动写盘上，免得打字一直触发全库重扫。
   */
  async function refreshBacklinks(): Promise<void> {
    const token = ++backlinkToken
    const relPath = active
    if (!relPath) {
      renderBacklinks(backlinksEl, [], () => {}, '打开一篇笔记')
      return
    }
    const groups = await window.rgent.backlinks(relPath).catch(() => [])
    if (token !== backlinkToken) return
    renderBacklinks(
      backlinksEl,
      groups,
      (target) => {
        void openNote(target)
      },
      '还没有谁链到这篇'
    )
  }

  async function changeVault(operation: () => Promise<VaultState>): Promise<void> {
    if (restoringWorkspace) throw Error('VAULT_SWITCH_BUSY')
    deferredVaultBodyConflict = false
    try {
      const state = await operation()
      if(state.cancelled)throw Error('VAULT_SWITCH_CANCELLED')
      await applyState(state)
    } catch (error) {
      const state = await window.rgent.vaultGet().catch(()=>null)
      if(state?.status==='ready' && state.sessionId!==vaultSession)await applyState(state)
      syncInteractionGate()
      if (deferredVaultBodyConflict && error instanceof Error && error.message.includes('UNSAVED_DRAFT')) throw Error('VAULT_SWITCH_BODY_CONFLICT')
      throw error
    } finally {
      deferredVaultBodyConflict = false
    }
  }
  async function chooseVault(): Promise<void> {
    try { await changeVault(()=>window.rgent.vaultPick()) }
    catch (error) {
      if(error instanceof Error && error.message.includes('VAULT_SWITCH_CANCELLED'))return
      hostNotice='未能切换笔记库。当前内容已保留，请检查目标文件夹或先处理保存问题。';updateStatus()
    }
  }
  function showVaultManager(): void {
    if (restoringWorkspace || transitionBusy || settingsOverlay.isBusy()) return
    closeVaultPicker()
    settingsOverlay.open('笔记库')
  }

  async function showPicker(lost: boolean): Promise<void> {
    await applyState({ status: 'needs-pick', reason: lost ? 'missing' : 'first-run' })
  }

  /**
   * 选库浮层：不可 Esc 关闭——没库进不去，必须给个答复。
   * 与设置、搜索共用同一套浮层语言（围栏 §浮层与特殊状态）。
   */

  function closeVaultPicker(): void {
    vaultPicker?.close()
    vaultPicker = null
  }

  function showVaultPicker(reason: 'first-run' | 'missing', diagnostic?: string): void {
    if (vaultPicker?.isOpen()) return
    const overlay = openOverlay({
      label: '选择笔记库',
      className: 'overlay-picker',
      dismissable: false,
      initialFocus: () => overlay.root.querySelector<HTMLElement>('.pick-btn')
    })
    vaultPicker = overlay
    const card = document.createElement('div')
    card.className = 'picker-card'
    const heading = document.createElement('h1')
    heading.textContent = '选择笔记库'
    const copy = document.createElement('p')
    copy.className = 'picker-copy'
    copy.textContent =
      reason === 'missing'
        ? '上次的库找不到了。请重新选一个文件夹。'
        : '第一次打开，先选一个文件夹当库。空的也行。不选进不去。'
    if (diagnostic) copy.textContent = diagnostic
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'pick-btn'
    button.textContent = '选择文件夹'
    button.addEventListener('click', () => {
      void chooseVault()
    })
    const manage=document.createElement('button');manage.type='button';manage.className='pick-btn';manage.textContent='已登记的笔记库';manage.onclick=showVaultManager
    const actions = document.createElement('div')
    actions.className = 'picker-actions'
    actions.append(button, manage)
    card.append(heading, copy, actions)
    overlay.root.append(card)
  }

  async function refreshTree(): Promise<boolean> {
    const token = ++treeRefreshToken
    const epoch = vaultEpoch
    try {
      const [nextTree, nextPermissions] = await Promise.all([window.rgent.treeList(), window.rgent.permissionsGet()])
      if (epoch !== vaultEpoch || token !== treeRefreshToken) return false
      tree = nextTree
      permissionState = nextPermissions
      fileBrowser.update(tree, active)
    } catch {
      if (epoch !== vaultEpoch || token !== treeRefreshToken) return false
      permissionState = { status: 'invalid', error: '无法读取目录或权限名单' }
      fileBrowser.fail('目录暂时无法读取，已保留浏览位置。请恢复笔记库后重试。')
      paintPermissionWarning()
      syncEditorHost()
      return false
    }
    // A tree listing cannot prove that a missing object is safe to discard.
    // Retain even clean tabs and their verified ledger until object inspection
    // offers explicit recovery/save-copy or the person discards the draft.
    paintTree()
    syncEditorHost()
    return true
  }

  async function refreshLifecycle(): Promise<LifecycleStatus | null> {
    const epoch = vaultEpoch,serial=++lifecycleSerial
    try {
      const status = await window.rgent.lifecycleStatus()
      if (epoch !== vaultEpoch || serial!==lifecycleSerial || (vaultSession && status.sessionId !== vaultSession)) return null
      const wasPaused=bodyWritesPaused()
      recoveryState = status
      syncRecoveryInput()
      // A newer lifecycle query may supersede the release query. Resume the
      // retained drafts when that current query actually opens the write gate.
      if(wasPaused&&!bodyWritesPaused()&&tabs.some(tab=>tab.dirty))scheduleSave()
      lifecycleWarning.hidden = status.status === 'ready'
      lifecycleWarning.textContent = status.status === 'invalid' ? '恢复记录无法核验 · 查看' : '文件操作待核验 · 查看'
      return status
    } catch { return null }
  }

  async function showRecoveryStatus(): Promise<void> {
    const status = await refreshLifecycle()
    if (!status || conflictDecisionOpen) return
    if(status.operation?.kind==='ledger-repair'){settingsOverlay.open('笔记库');return}
    recoveryOverlay?.close()
    const epoch = vaultEpoch
    recoveryOverlay = openLifecycleStatus(status, async (request) => {
      const result = await window.rgent.lifecycleRetry(request)
      if (epoch !== vaultEpoch) throw new Error('VAULT_CHANGED')
      // 续跑 IPC 已返回后，并发的 lifecycleStatus 会抬高 serial，冲掉这次刷新。
      // 成功不能因此说成失败：先走常规刷新，空了再直接读一次现状。
      let next = await refreshLifecycle()
      if (!next && epoch === vaultEpoch) {
        try {
          const status = await window.rgent.lifecycleStatus()
          if (epoch === vaultEpoch && (!vaultSession || status.sessionId === vaultSession)) next = status
        } catch { /* 下面按 VAULT_CHANGED 处理 */ }
      }
      if (!next) throw new Error('VAULT_CHANGED')
      if (result.ok) {
        await refreshMovedTabs()
        await refreshTree()
      }
      return { status: next, message: result.ok
        ? [result.unrepaired.length ? `移动已完成；以下引用未修复：${result.unrepaired.join('、')}` : '文件操作已完成。',
          result.hostPending ? '仍有生成内容等待保存，内容已保留；退出或换库前须处理。' : ''].filter(Boolean).join(' ')
        : lifecycleErrorText(result.error) }
    }, () => treeToggle)
  }

  function paintTree(): void {
    fileBrowser.setActive(active)
    paintPermissionWarning()
  }

  function paintPermissionWarning(): void {
    permissionWarning.hidden = permissionState.status !== 'invalid'
    if (permissionState.status === 'invalid') permissionWarning.textContent = `AI 门禁暂停：${permissionState.error}。请检查库根 .rgent-permissions。`
  }

  async function refreshMovedTabs(): Promise<void> {
    const epoch = vaultEpoch
    for (const tab of [...tabs]) {
      if (tab.dirty) continue
      try {
        const relPath = tab.relPath
        const revision = tab.revision
        const source = await readBoundTab(tab)
        if (epoch !== vaultEpoch) return
        if (!tabs.includes(tab) || tab.relPath !== relPath || tab.revision !== revision || tab.dirty) continue
        applySource(tab, source)
        if (active === tab.relPath) {
          const selection = editor.selectionRange()
          editor.setText(tab.content, noteHost(), selection)
        }
      } catch { /* Tree refresh will retain an unresolved tab for explicit recovery. */ }
    }
    renderTabs()
    renderOutline()
    void refreshBacklinks()
  }

  function folderOptions(entries: TreeEntry[], depth = 0): { path: string; label: string }[] {
    return entries.flatMap((entry) => entry.kind === 'dir'
      ? [{ path: entry.relPath, label: `${'　'.repeat(depth)}${entry.name}` }, ...folderOptions(entry.children ?? [], depth + 1)]
      : [])
  }

  function chooseDestination(source: string): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (path: string | null): void => { if (!settled) { settled = true; resolve(path) } }
      const overlay = openOverlay({ label: '选择目标文件夹', className: 'lifecycle-dialog', onClose: () => finish(null), initialFocus: () => select })
      const heading = document.createElement('h2')
      heading.textContent = '移动到'
      const description = document.createElement('p')
      description.textContent = source
      const select = document.createElement('select')
      select.setAttribute('aria-label', '目标文件夹')
      for (const option of [{ path: '', label: '笔记库根目录' }, ...folderOptions(tree)]) {
        if (option.path === source || option.path.startsWith(`${source}/`)) continue
        const element = document.createElement('option')
        element.value = option.path
        element.textContent = option.label
        select.append(element)
      }
      const actions = document.createElement('div')
      actions.className = 'lifecycle-actions'
      const cancel = document.createElement('button')
      cancel.type = 'button'; cancel.textContent = '取消'; cancel.addEventListener('click', () => overlay.close())
      const next = document.createElement('button')
      next.type = 'button'; next.textContent = '查看预览'
      next.addEventListener('click', () => { const value = select.value; overlay.close(); finish(value) })
      actions.append(cancel, next)
      overlay.root.append(heading, description, select, actions)
    })
  }

  async function confirmRelocation(preview: RelocationPreviewView): Promise<{ repairLinks: boolean } | null> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: { repairLinks: boolean } | null): void => { if (!settled) { settled = true; resolve(value) } }
      const overlay = openOverlay({ label: '核对文件变更', className: 'lifecycle-dialog', onClose: () => finish(null), initialFocus: () => cancel })
      const heading = document.createElement('h2')
      heading.textContent = '核对文件变更'
      const intro = document.createElement('p')
      intro.textContent = `${preview.source} → ${preview.target}`
      const list = document.createElement('ul')
      for (const move of preview.moves) {
        const item = document.createElement('li')
        item.textContent = `${move.from} → ${move.to}`
        list.append(item)
      }
      const permissions = document.createElement('p')
      permissions.textContent = preview.permissionChanges.length
        ? `将同步迁移 ${preview.permissionChanges.length} 条显式权限规则。`
        : '没有需要迁移的显式权限规则。'
      const checkboxLabel = document.createElement('label')
      checkboxLabel.className = 'lifecycle-check'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = preview.linkChanges.length > 0
      checkbox.disabled = preview.linkChanges.length === 0
      checkboxLabel.append(checkbox, document.createTextNode(`修复 ${preview.linkChanges.length} 篇笔记中的全路径引用（逐篇核对修订值）`))
      const actions = document.createElement('div')
      actions.className = 'lifecycle-actions'
      const cancel = document.createElement('button')
      cancel.type = 'button'; cancel.textContent = '取消'; cancel.addEventListener('click', () => overlay.close())
      const accept = document.createElement('button')
      accept.type = 'button'; accept.textContent = '确认变更'
      accept.addEventListener('click', () => { overlay.close(); finish({ repairLinks: checkbox.checked }) })
      actions.append(cancel, accept)
      overlay.root.append(heading, intro, list, permissions, checkboxLabel, actions)
    })
  }

  async function handleTreeAction(entry: TreeEntry, action: TreeAction): Promise<void> {
    if (entry.kind !== 'note' && entry.kind !== 'dir') return
    const epoch = vaultEpoch
    try {
      if (action === 'new-note' || action === 'new-folder') {
        const sessionId = vaultSession
        if (!sessionId || !fileBrowser.canCreate) throw new Error('VAULT_CHANGED')
        const name = await promptText(action === 'new-note' ? '新建笔记' : '新建文件夹', '名称', '', '创建')
        if (!name || epoch !== vaultEpoch) return
        const parent = entry.relPath
        const created = action === 'new-note'
          ? await window.rgent.noteCreateAt({ name, parent, sessionId })
          : await window.rgent.folderCreate({ name, parent, sessionId })
        if (epoch !== vaultEpoch || sessionId !== vaultSession) return
        await refreshTree()
        if (action === 'new-note') await openCreatedNote(created)
        return
      }
      if (action === 'trash') {
        if (entry.kind !== 'note' || !window.rgent.humanTrashOnThisPlatform) return
        if (!(await flushSave())) { pushNotice({ title:'有草稿尚未保存', detail:'请先处理保存冲突，再做这次操作。', tone:'warning' }); return }
        const prepared = await window.rgent.noteTrashPreview({ relPath: entry.relPath })
        if (epoch !== vaultEpoch) return
        if (!prepared.ok) throw new Error(prepared.error)
        if (vaultSession && prepared.preview.sessionId !== vaultSession) return
        const allow = await confirmTrash(prepared.preview)
        if (epoch !== vaultEpoch) return
        const result = await window.rgent.noteTrashCommit({ id: prepared.preview.id, allow })
        if (epoch !== vaultEpoch) return
        if (!result.ok) {
          // 落点核验不符或原路径冲突时，错误里带着系统实际落点：摆出来，人才能去废纸篓找回。
          // 这是不可逆风险，保留模态；标题只写发生了什么，原文与落点都进可复制的详情。
          const text = lifecycleErrorText(result.error)
          if (result.landing) openCopyableNotice('删除没有完成，请核对落点', `${text}\n本次落点：${result.landing}`)
          else pushNotice({ title:'删除没有完成', detail:text, tone:'error' })
          return
        }
        if (result.cancelled) return
        await closeTrashedTabs(entry.relPath, { includeAttachment: !result.orphan })
        await refreshTree()
        const notices = ['笔记已移入系统废纸篓']
        if (result.orphan) notices.push(result.orphanReason === 'attachment-missing'
          ? '同名附件夹在确认前已不在原路径，没有一起送入；笔记本身已移入系统废纸篓。'
          : '同名附件夹没能一起送入；它仍在库里时可恢复笔记后一并处理，或去 Finder 处理。')
        if (result.landingVerified === 'unverified') notices.push('系统没有给出可核对的落点：删除已按记录处理，但落点身份未核验。')
        if (result.degraded.includes('record-limit') || result.degraded.includes('record-failed')) notices.push('消失记录未能写入磁盘：笔记已进废纸篓，但重启后路径占位与来源失效可能不再保留。')
        if (result.degraded.includes('ledger-failed')) notices.push('账本留痕未能写入，删除本身已完成。')
        hostNotice = notices.join(' ')
        updateStatus()
        return
      }
      if (!(await flushSave())) { pushNotice({ title:'有草稿尚未保存', detail:'请先处理保存冲突，再做这次操作。', tone:'warning' }); return }
      const source = entry.relPath
      const parts = source.split('/')
      const oldName = parts.pop() ?? ''
      let parent = parts.join('/')
      let name = oldName
      if (action === 'rename') {
        const entered = await promptText('改名', '新名称', entry.kind === 'note' ? titleOf(oldName) : oldName, '查看预览')
        if (!entered) return
        name = entry.kind === 'note' && !entered.toLowerCase().endsWith('.md') ? `${entered}.md` : entered
      } else {
        const selected = await chooseDestination(source)
        if (selected === null) return
        parent = selected
      }
      const target = parent ? `${parent}/${name}` : name
      if (target === source || epoch !== vaultEpoch) return
      const outcome = await window.rgent.relocationPreview({ kind: entry.kind === 'note' ? 'note' : 'folder', source, target })
      if (epoch !== vaultEpoch) return
      if (!outcome.ok) throw new Error(outcome.error)
      if (vaultSession && outcome.preview.sessionId !== vaultSession) return
      const choice = await confirmRelocation(outcome.preview)
      if (!choice || epoch !== vaultEpoch) return
      const result = await window.rgent.relocationCommit({ id: outcome.preview.id, repairLinks: choice.repairLinks })
      if (epoch !== vaultEpoch) return
      if (!result.ok) throw new Error(result.error)
      applyRelocation(result.moved)
      await refreshTree()
      if (result.unrepaired.length) {
        pushNotice({
          title: '文件已移动，部分引用没有修复',
          detail: `以下引用因内容变化没有自动修复：\n${result.unrepaired.join('\n')}`,
          tone: 'warning'
        })
      }
    } catch (error) {
      if (epoch === vaultEpoch) pushNotice({ title:'文件操作没有完成', detail:lifecycleErrorText(error), tone:'error' })
    }
    finally { if (epoch === vaultEpoch) void refreshLifecycle() }
  }

  async function changePermission(relPath: string, tier: PermissionTier): Promise<void> {
    if (permissionState.status === 'invalid') {
      pushNotice({ title:'权限名单损坏或无法读取', detail:'请先在库根修复 .rgent-permissions 后重试。', tone:'error' })
      return
    }
    try {
      permissionState = await window.rgent.permissionsSet({ relPath, tier })
      await refreshTree()
    } catch (error) {
      pushNotice({ title:'权限没有改成', detail:lifecycleErrorText(error), tone:'error' })
    }
  }

  function noteHost(ledger?:{taskId:string;revision:number;field:'answer'|'prompt'}): NoteHost {
    const present = collectRelPaths(tree)
    const tab = current()
    return {
      sessionId: tab?.sessionId ?? vaultSession ?? undefined,
      noteRelPath: active ?? '',
      imageEpoch: tab ? `${tab.sessionId}/${tab.objectVersion}/${tab.revision}` : '',
      vaultHas: (relPath) => present.has(relPath),
      imageContext: (range, region = 'body') => tab ? {
        noteRelPath: tab.relPath, region,
        ...(ledger?{ledgerTaskId:ledger.taskId,ledgerRevision:ledger.revision,ledgerField:ledger.field}:{}),
        start: range.start + (region === 'ledger' ? tab.content.length : 0),
        end: range.end + (region === 'ledger' ? tab.content.length : 0),
        sessionId: tab.sessionId, objectVersion: tab.objectVersion, revision: tab.revision,
        ...(tab.dirty ? { draftBody: tab.relPath === active ? editor.getText() : tab.content } : {})
      } : undefined,
      remoteImageGet: (request) => window.rgent.remoteImageGet(request),
      openNote: (relPath) => {
        void openNote(relPath)
      }
    }
  }

  function syncEditorHost(): void {
    editor.setNoteHost(noteHost())
  }

  async function openNote(relPath: string, restoreSerial?: number): Promise<void> {
    if (restoringWorkspace && restoreSerial !== stateSerial) return
    const existing = tabs.find((tab) => tab.relPath === relPath)
    if (existing) {
      activate(relPath)
      return
    }
    const epoch = vaultEpoch
    const serial = stateSerial
    try {
      const source = await window.rgent.noteRead(relPath)
      if (epoch !== vaultEpoch || serial !== stateSerial || source.sessionId !== vaultSession) return
      const part = partitionSource(source.content)
      tabs.push({
        relPath,
        content: part.body,
        ledger: part.ledger,
        ledgerStatus: source.ledger,
        saved: part.body,
        revision: source.revision,
        objectVersion: source.objectVersion, sessionId: source.sessionId,
        dirty: false
      })
      activate(relPath)
    } catch {
      /* missing notes stay as broken links */
    }
  }

  function activate(relPath: string, focusEditor = true): void {
    const tab = tabs.find((item) => item.relPath === relPath)
    if (!tab) return
    if (active && active !== relPath) {
      const prev = current()
      if (prev) { prev.content = editor.getText(); prev.selection = editor.selectionRange(); prev.scrollTop = editor.view.scrollDOM.scrollTop }
    }
    active = relPath
    editor.setText(tab.content, noteHost(), tab.selection)
    const session = vaultSession
    requestAnimationFrame(() => { if (session === vaultSession && active === relPath && tab.scrollTop !== undefined) editor.view.scrollDOM.scrollTop = tab.scrollTop })
    scheduleWorkspace()
    syncActiveLocks()
    if (focusEditor) editor.focus()
    closeLedger()
    renderTabs(true)
    paintTree()
    updateStatus()
    renderOutline()
    emptyEl.hidden = true
    void refreshBacklinks()
  }

  function current(): Tab | undefined {
    return tabs.find((tab) => tab.relPath === active)
  }

  function revealActiveTab(): void {
    const selected = tabsEl.querySelector('.tab[aria-selected="true"]')?.parentElement
    if (!selected) return
    const viewport = tabsEl.getBoundingClientRect()
    const item = selected.getBoundingClientRect()
    // 当前是末尾笔记时，把紧随其后的新建按钮一起带入可视区。
    const right = selected.nextElementSibling === tabNew ? tabNew.getBoundingClientRect().right : item.right
    // 仅滚动 tab 条；scrollIntoView 会连同外层与正文一起寻找滚动祖先。
    if (item.left < viewport.left + 4) tabsEl.scrollLeft += item.left - viewport.left - 4
    else if (right > viewport.right - 4) tabsEl.scrollLeft += right - viewport.right + 4
  }

  function renderTabs(reveal = false): void {
    scheduleWorkspace()
    const scrollLeft = tabsEl.scrollLeft
    const activeChanged = renderedActive !== active
    const wraps = [...tabsEl.querySelectorAll<HTMLElement>(':scope > .tab-wrap')]
    const existing = wraps.map((wrap) => wrap.querySelector<HTMLElement>('.tab')?.dataset.rel ?? '')
    const next = tabs.map((tab) => tab.relPath)
    const sameIdentity = existing.length === next.length && existing.every((rel, index) => rel === next[index])
    if (sameIdentity) {
      for (const [index, tab] of tabs.entries()) {
        const wrap = wraps[index]!
        const button = wrap.querySelector<HTMLButtonElement>('.tab')!
        const label = wrap.querySelector<HTMLElement>('.tab-label')!
        const title = titleOf(tab.relPath.split('/').pop() ?? tab.relPath)
        button.setAttribute('aria-selected', String(tab.relPath === active))
        button.tabIndex = tab.relPath === active ? 0 : -1
        if (label.textContent !== title) label.textContent = title
        button.title = tab.relPath
        let dirty = wrap.querySelector<HTMLElement>('.tab-dirty')
        if (tab.dirty && !dirty) {
          dirty = document.createElement('span')
          dirty.className = 'tab-dirty'
          dirty.setAttribute('aria-label', '未保存')
          dirty.textContent = '•'
          label.after(dirty)
        } else if (!tab.dirty && dirty) dirty.remove()
        wrap.querySelector('.tab-close')?.setAttribute('aria-label', `关闭 ${title}`)
      }
    } else {
      tabsEl.replaceChildren()
      for (const tab of tabs) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'tab'
        button.setAttribute('role', 'tab')
        button.setAttribute('aria-selected', String(tab.relPath === active))
        button.setAttribute('aria-controls', 'note-panel')
        // 一组 tab 只留一个焦点站：当前项进 Tab 键序，其余用左右方向键走。
        button.tabIndex = tab.relPath === active ? 0 : -1
        button.dataset.rel = tab.relPath
        button.append(icon('note', 'icon-type'))
        const label = document.createElement('span')
        label.className = 'tab-label'
        label.textContent = titleOf(tab.relPath.split('/').pop() ?? tab.relPath)
        button.append(label)
        if (tab.dirty) {
          const dot = document.createElement('span')
          dot.className = 'tab-dirty'
          dot.setAttribute('aria-label', '未保存')
          dot.textContent = '•'
          button.append(dot)
        }
        button.title = tab.relPath
        button.addEventListener('click', () => activate(tab.relPath))
        button.addEventListener('keydown', (event) => {
          const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
          if (step === 0) return
          event.preventDefault()
          const at = tabs.findIndex((item) => item.relPath === tab.relPath)
          const nextTab = tabs[(at + step + tabs.length) % tabs.length]
          if (!nextTab) return
          activate(nextTab.relPath, false)
          tabsEl.querySelector<HTMLButtonElement>(`.tab[data-rel="${CSS.escape(nextTab.relPath)}"]`)?.focus()
        })
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'tab-close'
        close.setAttribute('aria-label', `关闭 ${label.textContent}`)
        close.append(icon('close'))
        close.addEventListener('click', (event) => {
          event.stopPropagation()
          void closeTab(tab.relPath)
        })
        const wrap = document.createElement('div')
        wrap.className = 'tab-wrap'
        wrap.append(button, close)
        tabsEl.append(wrap)
      }
      tabsEl.append(tabNew)
    }
    // 编辑、保存和任务状态重绘不把人手动滚动的位置重置到最左。
    tabsEl.scrollLeft = scrollLeft
    renderedActive = active
    if (reveal || activeChanged) revealActiveTab()
    ledgerOpenButton.hidden = !active
    ledgerOpenButton.textContent = ledgerOpen ? '返回正文' : '账本'
    ledgerOpenButton.title = ledgerOpen ? '返回这篇笔记的正文' : '看这篇笔记的账本回顾'
    ledgerOpenButton.setAttribute('aria-pressed', String(ledgerOpen))
    emptyEl.hidden = tabs.length > 0
  }

  /**
   * 标题索引：只取 h1–h3，当前阅读位置由可视范围起点推出。
   * 点一下跳过去；悬停或键盘聚焦显示完整标题。
   */
  function renderOutline(): void {
    outlineTooltip.hidden = true
    if (!current()) {
      outlineEl.hidden = true
      outlineEl.replaceChildren()
      outlineEl.dataset.signature = ''
      return
    }
    const marks = outlineMarks(editor.headings(), editor.viewport(), editor.caret())
    const identity = marks.map((mark) => `${mark.heading.range.start}:${mark.heading.depth}:${outlineLabel(mark.heading)}`).join('|')
    const signature = marks.map((mark) => `${mark.heading.range.start}:${mark.scale}:${mark.current ? 1 : 0}`).join('|')
    outlineEl.hidden = marks.length === 0
    const buttons = [...outlineEl.querySelectorAll<HTMLButtonElement>(':scope > .outline-mark')]
    if (outlineEl.dataset.identity === identity && buttons.length === marks.length) {
      if (outlineEl.dataset.signature === signature) return
      for (const [index, mark] of marks.entries()) {
        const button = buttons[index]!
        button.dataset.scale = String(mark.scale)
        if (mark.current) button.setAttribute('aria-current', 'true')
        else button.removeAttribute('aria-current')
        const rule = button.querySelector<HTMLElement>('.outline-rule')
        if (rule) rule.style.width = `${Math.round(26 * mark.scale)}px`
      }
      outlineEl.dataset.signature = signature
    } else {
      const previousScroll = outlineEl.scrollTop
      outlineEl.replaceChildren()
      for (const mark of marks) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'outline-mark'
        button.dataset.depth = String(mark.heading.depth)
        button.dataset.scale = String(mark.scale)
        if (mark.current) button.setAttribute('aria-current', 'true')
        const rule = document.createElement('span')
        rule.className = 'outline-rule'
        rule.style.width = `${Math.round(26 * mark.scale)}px`
        button.append(rule)
        const title = outlineLabel(mark.heading)
        button.setAttribute('aria-label', title)
        const showTitle = (): void => {
          const stage = outlineEl.parentElement!.getBoundingClientRect()
          const line = button.getBoundingClientRect()
          outlineTooltip.textContent = title
          outlineTooltip.style.top = `${line.top + line.height / 2 - stage.top}px`
          outlineTooltip.hidden = false
        }
        button.addEventListener('mouseenter', showTitle)
        button.addEventListener('mouseleave', () => { outlineTooltip.hidden = true })
        button.addEventListener('focus', showTitle)
        button.addEventListener('blur', () => { outlineTooltip.hidden = true })
        button.addEventListener('click', () => {
          editor.scrollTo(mark.heading.range.start)
          editor.focus()
        })
        outlineEl.append(button)
      }
      outlineEl.scrollTop = previousScroll
      outlineEl.dataset.identity = identity
      outlineEl.dataset.signature = signature
    }
    const currentMark = outlineEl.querySelector<HTMLElement>(".outline-mark[aria-current='true']")
    if (currentMark && (currentMark.offsetTop < outlineEl.scrollTop || currentMark.offsetTop + currentMark.offsetHeight > outlineEl.scrollTop + outlineEl.clientHeight)) {
      outlineEl.scrollTop = currentMark.offsetTop - outlineEl.clientHeight / 2
    }
  }

  async function refreshNetworkGate(): Promise<void> {
    const result = await window.rgent.networkConfig().catch(() => null)
    if (result?.ok) networkEnabled = result.config.enabled === true
    updateStatus()
  }

  /** 非权威浏览偏好：记的是「人已看过首次开启披露」，不是联网授权本身。 */
  function networkAcknowledged(): boolean {
    try { return localStorage.getItem(NETWORK_ACK_KEY) === '1' } catch { return false }
  }
  function markNetworkAcknowledged(): void {
    try { localStorage.setItem(NETWORK_ACK_KEY, '1') } catch { /* 偏好写不进去也不挡开启 */ }
  }

  function applyNetworkGate(enabled: boolean, dismiss?: () => void): void {
    void window.rgent.networkConfig({ enabled }).then((result) => {
      if (result.ok) {
        networkEnabled = result.config.enabled
        if (networkEnabled) markNetworkAcknowledged()
        dismiss?.()
        updateStatus()
      } else { hostNotice = '联网总闸没有改成。'; updateStatus() }
    }).catch(() => { hostNotice = '联网总闸没有改成。'; updateStatus() })
  }

  function toggleNetworkGate(): void {
    // 关闭直接生效、不提示；首次开启前先出非模态披露，人点「开启」才真正写配置。
    if (networkEnabled) { applyNetworkGate(false); return }
    if (networkAcknowledged()) { applyNetworkGate(true); return }
    const dismiss = pushNotice({
      title: '开启联网搜索与抓取？',
      detail: '开启后，检索词与网址会发给外部服务；关闭即撤回。该闸只管搜索与抓取，其他 MCP 不受影响。',
      tone: 'info',
      action: { label: '开启', run: () => { applyNetworkGate(true, dismiss) } }
    })
  }

  function abortCurrent(): void {
    const tab = current()
    const task = tab && [...activeTasks.values()].find((item) => item.relPath === tab.relPath)
    if (!task) return
    if (tab) tab.pausedByUser = true
    void window.rgent.agentCancel(task.id)
  }

  function endPaused(): void {
    const tab = current()
    if (!tab) return
    delete tab.pausedRestart
    tab.pausedByUser = false
    updateStatus()
  }

  /** 今天：插口令＋授权卡。真断点接续未开，以后只换这个函数。 */
  async function resumeOrRestart(): Promise<void> {
    const tab = current()
    if (!tab?.pausedRestart || authorizationPopover || conflictDecisionOpen) return
    if ([...activeTasks.values()].some((task) => task.relPath === tab.relPath)) return
    const { promptText, modelRecordId, level } = tab.pausedRestart
    if (modelRecordId) tab.temporaryModelId = modelRecordId
    const marker = `/${promptText}`
    let text = editor.getText()
    let start = text.endsWith(marker) ? text.length - marker.length : -1
    if (start < 0) {
      const pad = text.length === 0 ? '' : /(?:\r?\n){2}$/.test(text) ? '' : text.endsWith('\n') ? '\n' : '\n\n'
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length }, scrollIntoView: true })
      if (!editor.insertAtSelection(`${pad}${marker}`)) {
        hostNotice = '无法插入口令（这篇可能正被生成占用）。'
        updateStatus()
        return
      }
      text = editor.getText()
      start = text.endsWith(marker) ? text.length - marker.length : text.lastIndexOf(marker)
      if (start < 0 || text.slice(start, start + marker.length) !== marker) {
        hostNotice = '插入的口令与记忆不一致，请手打后再发。'
        updateStatus()
        return
      }
    }
    await submitSlash({ range: { start, end: start + marker.length }, prompt: promptText }, { level })
  }

  /** 底栏：行列、字数、总闸。字数只算正文，标记行不算。库名只写在 #app[data-vault]。 */
  function updateStatus(): void {
    paintUnavailable()
    if (vaultNameText) root.dataset.vault = vaultNameText
    else delete root.dataset.vault
    const tab = current()
    const info = tab ? editor.selectionInfo() : null
    const range = tab ? editor.selectionRange() : null
    memorySelection.hidden = !tab || ledgerOpen || !!tab.availability || !range || range.anchor === range.head
    if (tab && (tab.relPath !== countedPath || tab.content !== countedSource)) {
      countedWords = wordsOf(tab.content, editor.markers())
      countedPath = tab.relPath
      countedSource = tab.content
    }
    renderStatusbar(
      statusEl,
      statusModel({
        line: info?.line ?? 1,
        column: info?.column ?? 1,
        words: tab ? countedWords : 0,
        noteOpen: tab != null
      }, { enabled: networkEnabled, onToggle: toggleNetworkGate }, modelModule())
    )
    const center = statusEl.querySelector<HTMLElement>('.status-center')
    if (center) { center.hidden = false; if (memoryToggle.parentElement !== center) center.append(memoryToggle) }
    memoryToggle.disabled = !memorySnapshot || memoryBusy
    memoryToggle.setAttribute('aria-pressed', String(memorySnapshot?.config.vault.enabled ?? false))
    memoryToggle.title = memorySnapshot ? `当前库记忆${memorySnapshot.config.vault.enabled ? '开启' : '关闭'}${memorySnapshot.status === 'invalid' ? ' · 存储不可用，请查看设置' : ''}` : '当前库记忆不可用，请查看设置'
    memoryToggle.setAttribute('aria-label', memoryToggle.title)
    const left = statusEl.querySelector('.status-left')
    if(left&&tab?.ledgerStatus&&['invalid','unmigrated'].includes(tab.ledgerStatus.status)){
      const diagnostic=document.createElement('button');diagnostic.type='button';diagnostic.className='status-item'
      diagnostic.textContent=tab.ledgerStatus.status==='unmigrated'?'旧历史尚未迁移 · 查看':'历史需要检查 · 查看'
      diagnostic.title='正文仍可编辑；查看账本诊断和恢复步骤';diagnostic.onclick=()=>{if(!ledgerOpen)toggleLedger()};left.append(diagnostic)
    }
    const recentMemory=memorySnapshot?.jobs.filter(j=>j.outcome==='applied').at(-1),changedCount=recentMemory?.entryIds?.length??0
    memoryChange.hidden=changedCount===0;memoryChange.textContent=`记忆 +${changedCount} · 查看`;memoryChange.title='本场新增或更新记忆；在记忆页查看、编辑或预览撤销';if(left&&memoryChange.parentElement!==left)left.append(memoryChange)
    // 只在还没放进固定槽位时移动它：稳定的父子关系才保得住焦点。
    const lead = statusEl.querySelector('.status-lead')
    if (lead && settingsOpen.parentElement !== lead) lead.append(settingsOpen)
    if (hostNotice && left) {
      const notice = document.createElement('span')
      notice.className = 'status-item status-host-notice'
      notice.setAttribute('role', 'status')
      notice.textContent = hostNotice
      left.append(notice)
    }
    const mine = tab ? [...activeTasks.values()].find((task) => task.relPath === tab.relPath) : undefined
    const others = [...activeTasks.values()].filter((task) => task.relPath !== tab?.relPath)
    if (mine) renderTaskDock({ kind: 'generating', onAbort: abortCurrent })
    else if (tab?.pausedByUser && tab.pausedRestart) renderTaskDock({ kind: 'paused', onResume: () => { void resumeOrRestart() }, onEnd: endPaused })
    else if (others.length) renderTaskDock({ kind: 'others', count: others.length, onOpen: openTaskOverlay })
    else renderTaskDock({ kind: 'hidden' })
  }

  function openTaskOverlay(): void {
    if (taskOverlay?.isOpen()) return
    const overlay = openOverlay({ label: '运行中的任务', className: 'overlay-tasks', initialFocus: () => overlay.root.querySelector<HTMLElement>('button') })
    taskOverlay = overlay
    renderTaskOverlay()
  }

  function renderTaskOverlay(): void {
    if (!taskOverlay?.isOpen()) return
    taskOverlay.root.replaceChildren()
    const title = document.createElement('h2')
    title.textContent = '运行中的任务'
    taskOverlay.root.append(title)
    for (const task of activeTasks.values()) {
      const row = document.createElement('div')
      row.className = 'task-row'
      const name = document.createElement('span')
      name.textContent = `${task.relPath} · ${task.activity || '生成中'}`
      const stop = document.createElement('button')
      stop.type = 'button'
      stop.textContent = '停止'
      stop.setAttribute('aria-label', `停止 ${task.relPath} 的任务`)
      stop.addEventListener('click', () => {
        const owner = tabs.find((item) => item.relPath === task.relPath)
        if (owner) owner.pausedByUser = true
        void window.rgent.agentCancel(task.id)
      })
      row.append(name, stop)
      taskOverlay.root.append(row)
    }
    if (!activeTasks.size) taskOverlay.close()
  }

  async function rememberSelection(kind: 'body' | 'ledger', start: number, end: number, taskId?: string): Promise<void> {
    const tab = current(), session = vaultSession
    if (!tab || !session || !tab.objectVersion || !tab.sessionId || tab.availability || memoryOverlay || conflictDecisionOpen || end <= start) return
    const draft = tab.content
    if (!await flushSave() || current() !== tab || vaultSession !== session || tab.content !== draft) { hostNotice = '请先保存并重新核对选区。'; updateStatus(); return }
    const request: MemoryManualRequest = { sessionId: session, relPath: tab.relPath, objectVersion: tab.objectVersion!, revision: tab.revision, kind, start, end, ...(taskId ? { taskId } : {}) }
    const result = await window.rgent.memoryManualPreview(request).catch(() => null)
    if (current() !== tab || vaultSession !== session) return
    if (!result?.ok) { hostNotice = memoryErrorText(result?.error ?? 'MEMORY_UNAVAILABLE'); updateStatus(); return }
    const panel = openOverlay({ label: '记住预览', className: 'overlay-memory', returnFocus: () => editor.view.contentDOM, onClose: () => { if (memoryOverlay === panel) memoryOverlay = null } })
    memoryOverlay = panel
    renderMemoryPreview(panel.root, result.value, {
      commit: r => window.rgent.memoryPreviewCommit({ ...r, sessionId: session }),
      isCurrent: () => panel.isOpen() && vaultSession === session && current() === tab,
      onDone: value => { memorySnapshot = value; hostNotice = ''; panel.close(); updateStatus() },
      onCancel: () => panel.close()
    })
  }


  function toggleLedger(): void {
    if (ledgerOpen) {
      closeLedger(true)
      return
    }
    const tab = current()
    if (!tab) return
    ledgerOpen = true
    ledgerTitle.textContent = `${titleOf(tab.relPath.split('/').pop() ?? tab.relPath)} · 账本回顾`
    ledgerBody.replaceChildren()
    const message=document.createElement('p');message.textContent='正在核对账本归属…';ledgerBody.append(message)
    const captured=tab
    let cursor:string|null=null,loading=false,pageGeneration=0,maintenanceFeedback=''
    let chunkText='',chunkHash:string|null=null,chunkOffset=0,decoder=new TextDecoder()
    const load=document.createElement('button');load.type='button';load.className='settings-action';load.textContent='加载更多历史'
    const renderRecord=(record:import('../../main/ledger-store.ts').LedgerRecord)=>{
      const details=document.createElement('details'),heading=document.createElement('summary'),content=document.createElement('div')
      details.dataset.taskId=record.taskId
      heading.textContent=`${record.chapter?.startedAt??'旧记录'} · ${record.chapter?.status??'只读原文'} · ${record.bodyStatus==='present'?'有正文保存回执':'正文状态无法核验'}`
      details.append(heading,content);ledgerBody.insertBefore(details,load)
      const reasoning=document.createElement('button');reasoning.type='button';reasoning.className='settings-action';reasoning.textContent=record.legacyReasoning?'查看旧推理原文':'查看短期推理';reasoning.onclick=async()=>{reasoning.disabled=true;const result=await window.rgent.ledgerReasoning({sessionId:captured.sessionId!,objectVersion:captured.objectVersion!,relPath:captured.relPath,taskId:record.taskId});if(!ledgerOpen||current()!==captured)return;const text=document.createElement('pre');text.textContent=result.ok?result.text??'短期推理已清理或不可用；原回答与历史仍保留。':'推理读取未能核验，原记录保持。';content.append(text);reasoning.remove()};details.append(reasoning)
      details.addEventListener('toggle',()=>{if(!details.open||content.dataset.rendered)return;content.dataset.rendered='true'
        if(record.chapter){const meta=document.createElement('p'),p=record.chapter.provenance;meta.textContent=p?`模型：${p.model.modelId} · 接收方：${p.model.endpointHost}；工具摘要：${p.tools.map(t=>(t.name==='search_memory'?'检索记忆':t.name)+' '+(t.name==='search_memory'&&/^拒绝 MEMORY_SEARCH_LIMIT × [0-9]+$/.test(t.outcome)?memoryErrorText('MEMORY_SEARCH_LIMIT')+' 未执行次数：'+t.outcome.slice('拒绝 MEMORY_SEARCH_LIMIT × '.length):t.outcome)).join('、')||'无'}；实际读取来源：${p.sources.map(d=>d.relPath).join('、')||'无'}；模型消息引用来源：${p.sentSources?.join('、')||'无'}；${skillsEvidenceText(p)}`:'旧记录元数据无法核验。';content.append(meta);const network=document.createElement('p');network.className='ledger-network-evidence';network.textContent=networkEvidenceText(record.chapter.network);content.append(network);if(record.chapter.metrics?.length){const steps=document.createElement('p');steps.textContent='模型步骤：'+record.chapter.metrics.map(m=>`第 ${m.step} 步`).join('、');content.append(steps)}for(const trace of record.chapter.trace??[]){const item=document.createElement('p');const refusal='：未执行（MEMORY_SEARCH_LIMIT）';item.textContent=trace.startsWith('工具 检索记忆')&&trace.endsWith(refusal)?trace.slice(0,-refusal.length)+'：未执行（'+memoryErrorText('MEMORY_SEARCH_LIMIT')+'）':trace;content.append(item)}const prompt=document.createElement('p');prompt.textContent=`口令：${record.chapter.prompt}`;content.append(prompt);const choice=ledgerRememberCommand(record);if(choice){const remember=document.createElement('button');remember.type='button';remember.className='memory-ledger-remember';remember.textContent='记住口令';remember.onclick=()=>void rememberSelection('ledger',choice.start,choice.end,choice.taskId);content.append(remember)}const answer=document.createElement('div');content.append(answer);renderReadOnlyMarkdown(answer,record.chapter.answer,noteHost({taskId:record.taskId,revision:record.revision,field:'answer'}))}
        else {const raw=document.createElement('div');content.append(raw);if(record.legacyRaw)renderReadOnlyMarkdown(raw,record.legacyRaw);else raw.textContent='此记录的正文已清理。'}
      })
    }
    const fetchPage=async()=>{
      if(loading||!captured.sessionId||!captured.objectVersion)return;loading=true;load.disabled=true;const generation=pageGeneration
      try{const result=await window.rgent.ledgerGet({sessionId:captured.sessionId,objectVersion:captured.objectVersion,relPath:captured.relPath,cursor})
        if(!ledgerOpen||current()!==captured||generation!==pageGeneration)return
        if(!result.ok){message.textContent=ledgerErrorText(result.error);if(['LEDGER_REGISTRY_INVALID','LEDGER_OWNERSHIP_UNVERIFIED','LEDGER_RECOVERY_AMBIGUOUS'].includes(result.error)){const repair=document.createElement('button');repair.type='button';repair.className='settings-action';repair.textContent='在笔记库设置中核验与恢复';repair.onclick=()=>settingsOverlay.open('笔记库');ledgerBody.append(repair)}return}
        const value=result.value;message.textContent=maintenanceFeedback+(value.gaps.length?'部分历史存在清理或正文核验缺口。':'')+(value.maintenanceError?'后台维护未完成，历史保留；请重新核对。':'')
        if(value.chunk){const c=value.chunk;if(c.offset===0){chunkText='';chunkHash=c.hash;chunkOffset=0;decoder=new TextDecoder()}
          if(c.offset!==chunkOffset||c.hash!==chunkHash)throw Error('LEDGER_CONFLICT')
          const bytes=Uint8Array.from(atob(c.data),x=>x.charCodeAt(0));chunkOffset+=bytes.length;chunkText+=decoder.decode(bytes,{stream:chunkOffset<c.total})
          if(chunkOffset===c.total){renderRecord(JSON.parse(chunkText));chunkText='';chunkHash=null}else message.textContent=`长记录已读取 ${chunkOffset}／${c.total} 字节，继续加载可读完整记录。`
        }
        value.records.forEach(renderRecord);cursor=value.cursor;load.hidden=cursor===null
        if(!ledgerBody.querySelector('details')&&!value.chunk&&cursor===null)message.textContent=value.ownership==='unregistered'&&captured.ledgerStatus?.status==='unmigrated'?'旧历史尚未迁移。点击“迁移库内旧账本”后可回顾；原记录保留。':ledgerEmptyText(value.ownership)
      }catch{if(ledgerOpen&&current()===captured&&generation===pageGeneration)message.textContent='账本读取未完成，保留已有回顾；请关闭后重新核对。'}
      finally{if(generation===pageGeneration){loading=false;load.disabled=false}}
    }
    load.addEventListener('click',()=>void fetchPage());ledgerBody.append(load)
    const migrate=document.createElement('button');migrate.type='button';migrate.className='settings-action';migrate.textContent='迁移库内旧账本'
    migrate.addEventListener('click',async()=>{
      if(!(await flushSave()))return
      migrate.disabled=true;let after:string|null=null
      do{const result=await window.rgent.ledgerMigrate({sessionId:captured.sessionId!,after});if(!ledgerOpen||current()!==captured)return
        if(!result.ok){message.textContent='迁移未完成；已核验的原文仍保留，可重新启动迁移。';break}
        message.textContent=`本批已迁移 ${result.value.processed.length} 篇，${result.value.failures.length} 篇待核验。`;after=result.value.after
      }while(after!==null&&ledgerOpen&&current()===captured)
      migrate.disabled=false
    });ledgerBody.append(migrate)
    for(const [action,label]of [['compress','核对旧历史压缩'],['clear','预览清理历史']] as const){const control=document.createElement('button');control.type='button';control.className='settings-action';control.textContent=label
      control.onclick=async()=>{if(!(await flushSave()))return;control.disabled=true;const request={sessionId:captured.sessionId!,objectVersion:captured.objectVersion!,relPath:captured.relPath,action};const result=await window.rgent.ledgerMaintenance(request)
        if(!ledgerOpen||current()!==captured)return;control.disabled=false;if(!result.ok||!('id'in result.value)){message.textContent='维护预览不可用，原记录保留。';return}
        const preview=result.value;message.textContent=`当前历史占用 ${preview.totalBytes} 字节；本次 ${preview.records.length} 场。${preview.warning}`
        const apply=document.createElement('button');apply.type='button';apply.className='settings-action';apply.textContent=action==='clear'?'确认清理列出的历史':'执行已核验压缩';ledgerBody.append(apply)
        apply.onclick=async()=>{apply.disabled=true;const committed=await window.rgent.ledgerMaintenance({...request,previewId:preview.id});if(!ledgerOpen||current()!==captured)return;if(committed.ok&&'success'in committed.value){maintenanceFeedback=`已完成 ${committed.value.success.length} 场；${committed.value.failed.length} 场未完成；实际减少 ${committed.value.savedBytes} 字节。`;message.textContent=maintenanceFeedback;apply.remove();ledgerBody.querySelectorAll('details').forEach(node=>node.remove());pageGeneration++;cursor=null;loading=false;chunkText='';chunkHash=null;chunkOffset=0;decoder=new TextDecoder();void fetchPage();ledgerClose.focus()}else{message.textContent='维护未完成，原记录与正文保持；请重新核对。';apply.remove()}}
      };ledgerBody.append(control)
    }
    void fetchPage()
    ledgerEl.hidden = false
    renderTabs()
  }

  function closeLedger(restoreFocus = false): void {
    if (!ledgerOpen) return
    ledgerOpen = false
    disposeReadOnlyImages(ledgerBody)
    ledgerEl.hidden = true
    renderTabs()
    if (restoreFocus) ledgerOpenButton.focus()
  }

  async function waitNoteGone(relPath: string): Promise<boolean> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try { await window.rgent.noteRead(relPath) }
      catch { return true }
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    return false
  }

  /** 删除成功后关掉目标笔记的标签页；附件夹**确实送进废纸篓**时再关整棵子树的标签页。
   *  附件夹没送进去（孤儿）时子树还在库里，夹里的草稿不该因为一次没完成的第二步被无谓关掉；
   *  那些标签会在文件被外部移走时按既有「文件已消失」路径变成不可保存，稿子仍留着。 */
  async function closeTrashedTabs(relPath: string, opts: { includeAttachment: boolean }): Promise<void> {
    const stem = relPath.replace(/\.md$/i, '')
    const doomed = tabs
      .filter(tab => tab.relPath === relPath || (opts.includeAttachment && tab.relPath.startsWith(`${stem}/`)))
      .map(tab => tab.relPath)
    if (!(await waitNoteGone(relPath))) return
    for (const path of doomed) await closeTab(path, { save: false })
  }

  async function closeTab(relPath: string, opts: { save?: boolean } = {}): Promise<void> {
    const tab = tabs.find((item) => item.relPath === relPath)
    if (!tab) return
    if (opts.save !== false && tab.availability) { hostNotice='请先另存，或明确舍弃这份窗口稿。'; updateStatus(); return }
    if (opts.save !== false && tab.dirty && (!(await writeTab(tab)) || tab.dirty)) return
    const index = tabs.findIndex((item) => item.relPath === relPath)
    tabs.splice(index, 1)
    dismissConflictNotice(relPath)
    pendingConflictChoice = null
    if (active === relPath) {
      closeLedger()
      const next = tabs[index] ?? tabs[index - 1]
      active = next?.relPath ?? null
      editor.setText(next?.content ?? '', noteHost(), next?.selection)
      syncActiveLocks()
      void refreshBacklinks()
    }
    renderTabs()
    paintTree()
  }

  function scheduleSave(): void {
    if(bodyWritesPaused()||recoveryDraftGate.held(vaultSession)||restoringWorkspace)return
    if (saveTimer != null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      if (root.isConnected) void flushSave()
    }, SAVE_MS)
  }

  function flushSave(recoveryOperation?:string): Promise<boolean> {
    if(!root.isConnected||!recoveryDraftGate.maySave(vaultSession,recoveryOperation)||restoringWorkspace)return Promise.resolve(false)
    if (saveInFlight) {
      return saveInFlight.then((ok) => ok && tabs.some((tab) => tab.dirty) ? flushSave(recoveryOperation) : ok)
    }
    const task = performFlushSave([],recoveryOperation)
    saveInFlight = task
    return task.finally(() => {
      if (saveInFlight === task) saveInFlight = null
    })
  }

  async function performFlushSave(cleanUnavailablePaths: readonly string[] = [],recoveryOperation?:string): Promise<boolean> {
    if (saveTimer != null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    if(!recoveryDraftGate.maySave(vaultSession,recoveryOperation)||restoringWorkspace)return false
    if(bodyWritesPaused())return !tabs.some(tab=>tab.dirty)&&!hasUnavailableDraft(tabs,cleanUnavailablePaths)
    let ok = !hasUnavailableDraft(tabs, cleanUnavailablePaths)
    let wrote = false
    for (let pass = 0; pass < 3; pass += 1) {
      const writes = pendingWrites(tabs, active, editor.getText())
      if (writes.length === 0) break
      for (const write of writes) {
        const tab = tabs.find((item) => item.relPath === write.relPath)
        if (!tab || tab.availability || tab.sessionId !== vaultSession) continue
        wrote = true
        if (!(await writeTab(tab, write.body,0,recoveryOperation))) ok = false
      }
      if (!ok) break
    }
    renderTabs()
    if (ok && wrote) void refreshBacklinks()
    if (ok && tabs.some((tab) => tab.dirty)) scheduleSave()
    return ok && !tabs.some((tab) => tab.dirty)
  }

  async function writeTab(tab: Tab, body = tab.relPath === active ? editor.getText() : tab.content, attempt = 0,recoveryOperation?:string): Promise<boolean> {
    if (!recoveryDraftGate.maySave(vaultSession,recoveryOperation) || restoringWorkspace || bodyWritesPaused() || tab.availability || !tab.sessionId || !tab.objectVersion || tab.sessionId !== vaultSession) return false
    const epoch = vaultEpoch
    const result = await window.rgent.noteWrite({
      sessionId: tab.sessionId, objectVersion: tab.objectVersion,
      relPath: tab.relPath,
      content: body,
      expectedRevision: tab.revision
    })
    if (epoch !== vaultEpoch || !tabs.includes(tab)) return false
    if (result.ok) {
      tab.objectVersion = result.objectVersion
      tab.sessionId = result.sessionId
      applySaved(tab, body, result.revision)
      dismissConflictNotice(tab.relPath)
      await refreshLifecycle()
      if(epoch!==vaultEpoch||!tabs.includes(tab))return false
      if (hostNotice === hostErrorText('LEDGER_BOUNDARY_INVALID')) { hostNotice = ''; updateStatus() }
      syncEditorHost()
      void refreshBacklinks()
      return true
    }
    if (['NOTE_MISSING','NOTE_REPLACED','NOTE_UNREADABLE'].includes(result.error)) {
      markUnavailable(tab, result.error === 'NOTE_MISSING' ? 'missing' : result.error === 'NOTE_REPLACED' ? 'replaced' : 'unavailable')
      return false
    }
    if(result.error==='LIFECYCLE_RECOVERY_REQUIRED'){
      await refreshLifecycle()
      if(epoch===vaultEpoch){hostNotice='账本恢复尚未完成，窗口稿已保留。请到笔记库设置继续恢复，完成后保存草稿再离库。';updateStatus()}
      return false
    }
    if (result.error === 'NOTE_BUSY') {
      // A structural commit briefly seals this path after its explicit flush.
      // Keep the draft dirty and try again when the move has settled.
      scheduleSave()
      return false
    }
    if (result.error === 'LEDGER_BOUNDARY_INVALID') {
      hostNotice = lifecycleErrorText(result.error)
      updateStatus()
      return false
    }
    if (result.error === 'CONFLICT') {
      if (!hostRevisions.has(tab.relPath)) {
        const outcome = await runExclusiveConflict(() => reconcileTab(tab))
        renderTabs()
        updateStatus()
        return outcome === 'disk' || outcome === 'saved' || outcome === 'unchanged'
      }
      const outcome = await runExclusiveConflict(() => syncHostTab(tab, vaultEpoch))
      renderTabs()
      updateStatus()
      if (outcome === 'merged' && tab.dirty && attempt < 3) return writeTab(tab, tab.relPath === active ? editor.getText() : tab.content, attempt + 1,recoveryOperation)
      if (outcome === 'merged') return !tab.dirty
      return outcome === 'disk' || outcome === 'saved' || outcome === 'unchanged'
    }
    // A generic write failure may hide an external removal or replacement.
    // Inspect ownership without applying disk text over the retained draft.
    try { await readBoundTab(tab) } catch { /* readBoundTab retains and marks the draft */ }
    return false
  }

  function paintUnavailable(): void {
    const tab = current()
    unavailableEl.hidden = !tab?.availability
    const label = unavailableEl.querySelector('span')!
    label.textContent = tab?.availability === 'missing' ? '文件已消失，窗口稿已保留；原路径不会重建。' : tab?.availability === 'replaced' ? '同名文件已被替换，窗口稿仍属于原对象。' : '暂时无法核验文件；自动保存和生成已暂停。'
  }
  function markUnavailable(tab: Tab, state: import('../../shared/ipc.ts').NoteAvailability): void {
    tab.availability = state
    if (state === 'replaced' || state === 'missing') delete tab.temporaryModelId
    if (tab.relPath === active) tab.content = editor.getText()
    // Do not throw away the last verified ledger or transfer the old draft to a replacement.
    renderTabs(); updateStatus()
  }
  async function readBoundTab(tab: Tab): Promise<NoteSnapshot> {
    const epoch = vaultEpoch
    if (!tab.sessionId || !tab.objectVersion || tab.sessionId !== vaultSession) throw new Error('VAULT_CHANGED')
    const state = await window.rgent.noteInspect({ relPath: tab.relPath, sessionId: tab.sessionId, objectVersion: tab.objectVersion })
    if (epoch !== vaultEpoch || !tabs.includes(tab)) throw new Error('VAULT_CHANGED')
    if (state.status !== 'ready') {
      markUnavailable(tab, state.status === 'unreadable' ? 'unavailable' : state.status)
      throw new Error('NOTE_UNAVAILABLE')
    }
    delete tab.availability
    return state.snapshot
  }
  async function checkOpenNotes(): Promise<void> {
    const epoch = vaultEpoch
    for (const tab of [...tabs]) {
      if (epoch !== vaultEpoch) return
      await runExclusiveConflict(async () => {
        try { await reconcileTab(tab,epoch) } catch { /* preserve the draft on unreadable object */ }
      })
    }
  }
  async function saveMissingCopy(): Promise<void> {
    const tab = current(); const epoch = vaultEpoch
    if (!tab?.availability || !tab.sessionId || !tab.objectVersion) return
    const source = tab.relPath
    const parts = source.split('/'); const oldName = parts.pop()!.replace(/\.md$/i,'')
    let parent = parts.join('/')
    if (parent && !collectRelPaths(tree).has(parent)) {
      const selected = await chooseDestination(source)
      if (selected === null || epoch !== vaultEpoch) return
      parent = selected
    }
    const name = await promptText('另存为新笔记','新名称',`${oldName}-保留稿`,'查看预览')
    if (!name || epoch !== vaultEpoch) return
    const target = `${parent ? parent + '/' : ''}${name.toLowerCase().endsWith('.md') ? name : name+'.md'}`
    const body = tab.relPath === active ? editor.getText() : tab.content
    const draftVersion = crypto.randomUUID()
    try {
      const held=tab.sessionId!==vaultSession
      const result = await window.rgent.noteSaveCopyPreview({ sessionId:held?vaultSession!:tab.sessionId,...(held?{sourceSessionId:tab.sessionId}:{}), objectVersion:tab.objectVersion,
        source, target, body, draftVersion })
      if (epoch !== vaultEpoch || !tabs.includes(tab)) return
      if (!result.ok) throw new Error(result.error)
      const accepted = await new Promise<boolean>(resolve => {
        let answer=false
        const panel=openOverlay({label:'确认另存',className:'save-copy-preview',onClose:()=>resolve(answer)})
        const title=document.createElement('h2'); title.textContent='另存为新笔记'
        const description=document.createElement('p'); description.textContent=`${source} → ${result.preview.target}`
        const note=document.createElement('p'); note.textContent=result.preview.warning
        const tasks=document.createElement('p'); tasks.textContent=result.preview.pendingTaskIds.length ? `将以原任务 ID 保留 ${result.preview.pendingTaskIds.length} 份未落盘完整回答到新笔记账本；任务不重启。` : held?'只保存正文副本；旧待保存回答仍留在原 tab，可单独明确舍弃。':'另存保留当前草稿和恢复关系；原账本不移动，不自动继承未列出的历史。'
        const cancel=document.createElement('button'); cancel.textContent='取消'; cancel.onclick=()=>panel.close()
        const save=document.createElement('button'); save.className='save-copy-confirm'; save.textContent='确认另存'; save.onclick=()=>{answer=true;panel.close()}
        panel.root.append(title,description,note,tasks,cancel,save)
      })
      if (!accepted || epoch !== vaultEpoch || !tabs.includes(tab)) return
      const currentBody = tab.relPath === active ? editor.getText() : tab.content
      const saved=await window.rgent.noteSaveCopyCommit({id:result.preview.id,sessionId:result.preview.sessionId,draftVersion,body:currentBody})
      if (epoch !== vaultEpoch || !tabs.includes(tab)) return
      if (!saved.ok) throw new Error(saved.error)
      const selection=tab.selection
      const destination=held?{...tab}:tab
      applySource(destination,saved.snapshot);destination.relPath=saved.relPath
      if(held){tabs.push(destination);hostNotice='正文副本已保存；原窗口稿和旧待保存回答仍保留，可返回原 tab 明确舍弃。'}
      hostRevisions.delete(source)
      for(const id of saved.taskIds) { activeTasks.delete(id); endedTaskIds.add(id) }
      if(active===source) { active=saved.relPath; editor.setText(destination.content,noteHost(),selection) }
      closeLedger(); syncActiveLocks(); renderTabs(); updateStatus(); await refreshTree()
    } catch(error) { if(epoch===vaultEpoch) pushNotice({ title:'另存没有完成', detail:lifecycleErrorText(error), tone:'error' }) }
  }
  async function discardMissing(): Promise<void> {
    const tab=current(); const epoch=vaultEpoch
    if(!tab?.availability || !tab.sessionId || !tab.objectVersion) return
    if(!(await confirmDiscardWindowDraft())) return
    const ok=await window.rgent.noteAbandon({relPath:tab.relPath,sessionId:tab.sessionId===vaultSession?tab.sessionId:vaultSession!,...(tab.sessionId!==vaultSession?{sourceSessionId:tab.sessionId}:{}),objectVersion:tab.objectVersion})
    if(ok&&epoch===vaultEpoch){await closeTab(tab.relPath,{save:false});if(!tabs.some(t=>t.sessionId&&t.sessionId!==vaultSession)){restoredSession=null;hostNotice='旧窗口稿已逐篇处理。请恢复原工作区位置；恢复前不覆盖位置记录。';workspaceRecovery.querySelector('span')!.textContent=hostNotice;workspaceRecovery.hidden=false;updateStatus()}}
  }

  function applySource(tab: Tab, source: NoteSnapshot): void {
    const part = partitionSource(source.content)
    tab.content = part.body
    tab.ledger = part.ledger
    tab.ledgerStatus = source.ledger
    tab.saved = part.body
    tab.revision = source.revision
    tab.sessionId = source.sessionId
    tab.objectVersion = source.objectVersion
    delete tab.availability
    tab.dirty = false
  }

  /** 旧文件消失后，人又建了同名笔记：不能把新正文交给还占着该路径的坏 tab。
   *  先把旧窗口稿另存为同目录兄弟笔记，再关掉坏 tab、打开新笔记；任何一步失败都保留旧 tab。 */
  async function openCreatedNote(created: string): Promise<void> {
    const held = tabs.find(tab => tab.relPath === created && tab.availability)
    if (!held) { await openNote(created); return }
    const epoch = vaultEpoch
    const session = vaultSession
    const body = held.relPath === active ? editor.getText() : held.content
    let copyPath: string | null = null
    if (body.length > 0) {
      try {
        copyPath = await saveDraftBeside(created, body, epoch)
      } catch {
        if (epoch !== vaultEpoch || session !== vaultSession || !tabs.includes(held)) return
        hostNotice = '同名笔记已建立，但旧标签仍占用该路径，请关闭旧标签后重新打开'
        updateStatus()
        // 新文件已经存在，失败时也要让人在树里看见它；旧 tab 和旧稿原样保留。
        await refreshTree()
        return
      }
      if (epoch !== vaultEpoch || session !== vaultSession || !tabs.includes(held)) return
    }
    await closeTab(created, { save: false })
    hostNotice = copyPath ? `旧稿已另存为 ${copyPath}；原标签已关闭。` : '原标签窗口稿为空，已关闭。'
    updateStatus()
    await refreshTree()
    await openNote(created)
  }

  function restoredDraftName(stem: string, attempt: number): string {
    return attempt === 0 ? `${stem}（恢复的旧稿）` : `${stem}（恢复的旧稿 ${attempt + 1}）`
  }

  function isCreateCollision(error: unknown): boolean {
    const text = error instanceof Error ? error.message : String(error)
    return text.includes('EEXIST') || text.includes('已有同名笔记')
  }

  /** 把旧稿写成同目录的兄弟笔记；名字被占就从「… 2」试到「… 5」。 */
  async function saveDraftBeside(created: string, body: string, epoch: number): Promise<string> {
    const session = vaultSession
    if (!session) throw Error('VAULT_CHANGED')
    const slash = created.lastIndexOf('/')
    const parent = slash < 0 ? '' : created.slice(0, slash)
    const stem = created.slice(slash + 1).replace(/\.md$/i, '')
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let target: string
      try {
        target = await window.rgent.noteCreateAt({ name: restoredDraftName(stem, attempt), parent, sessionId: session })
      } catch (error) {
        lastError = error
        if (isCreateCollision(error)) continue
        throw error
      }
      if (epoch !== vaultEpoch || session !== vaultSession) throw Error('VAULT_CHANGED')
      const source = await window.rgent.noteRead(target)
      if (epoch !== vaultEpoch || session !== vaultSession || source.sessionId !== session) throw Error('VAULT_CHANGED')
      const result = await window.rgent.noteWrite({
        sessionId: source.sessionId, objectVersion: source.objectVersion, relPath: target,
        content: body, expectedRevision: source.revision
      })
      if (epoch !== vaultEpoch || session !== vaultSession) throw Error('VAULT_CHANGED')
      if (!result.ok) throw Error(result.error)
      return target
    }
    throw lastError ?? Error('EEXIST')
  }

  async function createNote(): Promise<void> {
    let state = await window.rgent.vaultGet()
    if (state.status !== 'ready') {
      await chooseVault()
      state = await window.rgent.vaultGet()
      if (state.status !== 'ready') return
    }
    const epoch = vaultEpoch
    const sessionId = vaultSession
    const parent = fileBrowser.selectedFolder
    if (!sessionId || !fileBrowser.canCreate) { pushNotice({ title:'目录暂时无法核验', detail:'请恢复目录后重新选择。', tone:'warning' }); return }
    const name = await promptNewNote()
    if (!name || epoch !== vaultEpoch) return
    try {
      if (!fileBrowser.canCreate || parent !== fileBrowser.selectedFolder) throw new Error('STALE_PREVIEW')
      const relPath = await window.rgent.noteCreateAt({ name, parent, sessionId })
      if (epoch !== vaultEpoch || sessionId !== vaultSession) return
      await refreshTree()
      await openCreatedNote(relPath)
    } catch (err) {
      pushNotice({ title:'新建笔记没有完成', detail:lifecycleErrorText(err), tone:'error' })
    }
  }
}
