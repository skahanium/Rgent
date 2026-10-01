import { IPC, type AgentEvent, type AgentTaskView, type LifecycleStatus, type NoteSnapshot, type PermissionState, type PermissionTier, type PublicModelConfig, type RelocationPreviewView, type SearchHit, type TreeEntry, type VaultState } from '@shared'
import { composeSource, partitionSource } from '@markdown'
import { reportFlush } from '../../shared/flush.ts'
import { renderBacklinks } from './backlinks.ts'
import { openLifecycleStatus, promptNewNote, promptText } from './dialogs.ts'
import { promptConflict } from './conflict.ts'
import { openOverlay } from './overlay.ts'
import { createSearchOverlay } from './search-overlay.ts'
import { createSettingsOverlay } from './settings.ts'
import { applySaved, pendingWrites, hasUnavailableDraft, type Tab } from './tabs.ts'
import { mountEditor, type EditorHost, type NoteHost } from './view/editor.ts'
import { renderReadOnlyMarkdown, disposeReadOnlyImages } from './view/read-only.ts'
import { icon } from './icons.ts'
import { outlineLabel, outlineMarks } from './outline.ts'
import { installShortcuts, shortcutLabel } from './shortcuts.ts'
import { renderStatusbar, statusModel, wordsOf, type StatusModelModule } from './statusbar.ts'
import { PROVIDER_LABELS } from '../../shared/model-endpoints.ts'
import { reconcileNote, type ReconcileResult } from './note-reconcile.ts'
import { mergeHostBody } from './host-merge.ts'
import { openAuthorizationPopover } from './authorization-popover.ts'
import { hostErrorText } from './host-errors.ts'
import { slashAtCaret } from './slash.ts'
import { renderTree, titleOf, collectRelPaths, type TreeAction } from './tree.ts'
import type { Theme } from './theme.ts'

const SAVE_MS = 800
const LIFECYCLE_ERRORS: Record<string, string> = {
  COPY_PARENT_CHANGED: '新文件已创建，但目标目录身份无法确认。请检查目标；窗口稿和待保存任务已保留，请勿重试覆盖。',
  COPY_VERIFY_FAILED: '新文件发布后的内容或身份无法确认。请检查目标；窗口稿和待保存任务已保留。',
  SOURCE_AVAILABLE: '原对象已能核验，请重新查看当前笔记后处理保存。',
  LEDGER_BASIS_UNAVAILABLE: '无法核对原账本依据，窗口稿仍保留，另存未提交。',
  LEDGER_BOUNDARY_INVALID: '正文语法遮住了账本边界，尚未保存。请闭合代码块或注释，并在 HTML 块后保留空行；窗口稿和原账本仍保留。',
  STALE_PREVIEW: '文件或引用在预览后发生变化，请重新预览再提交。',
  STALE_RECOVERY: '恢复记录已变化，请重新查看状态再重试。',
  VAULT_CHANGED: '笔记库已切换，本次操作已停止。',
  OTHER_TASK_RUNNING: '本库还有其他笔记的运行任务，请先停止并保存其生成内容，再进行文件操作。',
  EEXIST: '目标位置已有同名文件或文件夹。',
  PERMISSION_DOWNGRADE: '这次移动会使部分对象的 AI 权限意外降档，已阻止提交。',
  PERMISSION_COLLISION: '目标位置的显式权限规则发生冲突，已阻止提交。',
  PERMISSIONS_INVALID: '权限名单无法核验，请先修复库根的 .rgent-permissions。',
  UNSAVED_DRAFT: '有草稿尚未保存，请先处理保存冲突。',
  PREVIOUS_TASK_UNSAVED: '运行任务的内容尚未保存，请先处理再修改文件位置。',
  LIFECYCLE_RECOVERY_REQUIRED: '文件操作中断且无法自动核对。恢复记录仍在库中；AI 访问已暂停，请人工检查。',
  STRUCTURE_BUSY: '另一个文件位置操作正在进行，请稍后重试。'
}
const lifecycleErrorText = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return LIFECYCLE_ERRORS[message] ?? message
}
const ROOT_UNAVAILABLE_NOTICE = '笔记库暂时无法读取，窗口稿和账本已保留。恢复原库后重新核验；换库前须处理或明确舍弃。'

export async function start(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="app">
      <header class="top">
        <button type="button" class="tree-toggle" aria-controls="tree-panel" aria-expanded="false" aria-label="目录"></button>
        <div class="tabs" role="tablist" aria-label="打开中的笔记"></div>
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
            <button type="button" class="folder-create" aria-label="在库根新建文件夹">新建文件夹</button>
          </div>
          <div class="tree-scroll"></div>
          <div class="tree-settings"><button type="button" class="settings-open" aria-label="设置" title="设置"><span class="settings-open-label">设置</span></button></div>
        </aside>
        <section class="stage" id="note-panel" role="tabpanel" aria-label="正文">
          <button type="button" class="ledger-open" aria-pressed="false" hidden>账本</button>
          <div class="ledger-view" hidden>
            <div class="ledger-head">
              <span class="ledger-title"></span>
              <button type="button" class="ledger-close" aria-label="关闭账本回顾">×</button>
            </div>
            <div class="ledger-body"></div>
          </div>
          <div class="note-unavailable" role="status" hidden><span></span><button type="button" class="note-recheck">重新核验</button><button type="button" class="note-save-copy">另存为新笔记</button><button type="button" class="note-discard">明确舍弃并关页</button></div>
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
  const treeScroll = root.querySelector('.tree-scroll') as HTMLElement
  const treeToggle = root.querySelector('.tree-toggle') as HTMLButtonElement
  const permissionWarning = root.querySelector('.permission-warning') as HTMLElement
  const lifecycleWarning = root.querySelector('.lifecycle-warning') as HTMLButtonElement
  const statusEl = root.querySelector('.status') as HTMLElement
  const tabsEl = root.querySelector('.tabs') as HTMLElement
  const unavailableEl = root.querySelector('.note-unavailable') as HTMLElement
  const copyButton = root.querySelector('.note-save-copy') as HTMLButtonElement
  const discardButton = root.querySelector('.note-discard') as HTMLButtonElement
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
  const folderCreate = root.querySelector('.folder-create') as HTMLButtonElement
  const settingsOpen = root.querySelector('.settings-open') as HTMLButtonElement
  const ledgerOpenButton = root.querySelector('.ledger-open') as HTMLButtonElement
  const shortcutHint = root.querySelector('.shortcut-hint') as HTMLElement


  const tabs: Tab[] = []
  let active: string | null = null
  let tree: TreeEntry[] = []
  let saveTimer: number | null = null
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
  let vaultEpoch = 0
  let vaultSession: string | null = null
  let recoveryState: LifecycleStatus | null = null
  let recoveryOverlay: ReturnType<typeof openLifecycleStatus> | null = null
  let conflictDecisionOpen = false
  let permissionState: PermissionState = { status: 'ready', entries: [] }
  let vaultNameText: string | null = null
  // 声明放在状态区：applyState 会在定义点之前调用 closeVaultPicker，
  // 用 let 声明在后面会撞 TDZ（实测 ReferenceError）。
  let vaultPicker: ReturnType<typeof openOverlay> | null = null
  const searchOverlay = createSearchOverlay({
    search: (query) => window.rgent.search(query),
    onOpenNote: (relPath) => void openNote(relPath)
  })
  const settingsOverlay = createSettingsOverlay({
    getMode: () => window.rgent.themeGet(),
    setMode: (mode) => window.rgent.themeSet(mode),
    getReading: () => window.rgent.readingGet(),
    setReading: (reading) => window.rgent.readingSet(reading),
    getConfig: () => window.rgent.modelConfigGet(),
    saveProvider: (request) => window.rgent.modelProviderSave(request),
    removeProvider: (request) => window.rgent.modelProviderRemove(request),
    deleteKey: (request) => window.rgent.modelKeyDelete(request),
    addModel: (request) => window.rgent.modelAdd(request),
    updateModel: (request) => window.rgent.modelUpdate(request),
    removeModel: (request) => window.rgent.modelRemove(request),
    readModels: (request) => window.rgent.modelList(request),
    setLimits: (request) => window.rgent.modelLimitsSet(request),
    onModelConfigChanged: () => { void refreshModelModule() },
    onClose: () => { void refreshModelModule() }
  })
  // 底栏模型模块：设置页只配置，这里才是「用哪个模型」的入口。
  let modelConfigSnapshot: PublicModelConfig | null = null
  let modelModuleCache: { config: PublicModelConfig; module: StatusModelModule } | null = null
  const modelModule = (): StatusModelModule | undefined => {
    const config = modelConfigSnapshot
    if (!config) return undefined
    if (modelModuleCache?.config === config) return modelModuleCache.module
    const groups = config.providers
      .filter((provider) => provider.modelCount > 0)
      .map((provider) => ({
        label: provider.hasKey ? PROVIDER_LABELS[provider.provider] : `${PROVIDER_LABELS[provider.provider]}（缺密钥）`,
        items: config.models.filter((model) => model.provider === provider.provider).map((model) => ({ id: model.id, label: model.modelId }))
      }))
    const module: StatusModelModule = {
      groups,
      value: config.defaultModelId,
      signature: JSON.stringify({ groups, value: config.defaultModelId }),
      onChange: (modelId) => {
        void window.rgent.modelDefaultSet({ modelId }).then((result) => {
          if (!result.ok) { hostNotice = hostErrorText(result.error); updateStatus() }
          else { modelConfigSnapshot = result.config; hostNotice = ''; updateStatus() }
        }).catch(() => { hostNotice = hostErrorText('IO_ERROR'); updateStatus() })
      },
      onConfigure: () => settingsOverlay.open('模型')
    }
    modelModuleCache = { config, module }
    return module
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

  installShortcuts({
    onSearch: () => { if (!conflictDecisionOpen) searchOverlay.open() },
    onSave: () => void flushSave()
  })
  shortcutHint.textContent = shortcutLabel('k')
  searchOpen.addEventListener('click', () => { if (!conflictDecisionOpen) searchOverlay.open() })
  folderCreate.addEventListener('click', () => { void createRootFolder() })
  settingsOpen.prepend(icon('settings'))
  settingsOpen.addEventListener('click', () => { if (!conflictDecisionOpen) settingsOverlay.open() })
  // 底栏模型模块首次取一次配置；之后由设置页写入与面板关闭时刷新。
  void refreshModelModule()
  lifecycleWarning.addEventListener('click', () => { if (!conflictDecisionOpen) void showRecoveryStatus() })

  editor.onStateChange(() => {
    const tab = current()
    if (tab) tab.selection = editor.selectionRange()
    updateStatus()
    renderOutline()
  })
  window.addEventListener('rgent:theme', (event) => {
    editor.setTheme((event as CustomEvent<Theme>).detail === 'night')
  })
  editor.setTheme(document.documentElement.dataset.theme === 'night')

  editor.view.dom.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
    const selection = editor.selectionRange()
    if (selection.anchor !== selection.head) return
    const submission = slashAtCaret(editor.getText(), selection.head)
    if (!submission || conflictDecisionOpen || document.querySelector('dialog[open]')) return
    event.preventDefault()
    void submitSlash(submission)
  }, { capture: true })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !active || document.querySelector('dialog[open]')) return
    const task = [...activeTasks.values()].find((item) => item.relPath === active)
    if (!task) return
    event.preventDefault()
    void window.rgent.agentCancel(task.id)
  }, true)

  treeToggle.addEventListener('click', () => {
    const open = treePanel.classList.contains('is-collapsed')
    treePanel.classList.toggle('is-collapsed', !open)
    treeToggle.setAttribute('aria-expanded', String(open))
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
    void chooseVault()
  })
  window.rgent.onMenu(IPC.menuNewNote, () => {
    void createNote()
  })
  window.rgent.onMenu(IPC.menuSave, () => {
    void flushSave()
  })
  window.rgent.onTreeChanged(() => {
    void refreshLifecycle().then(() => refreshTree()).then(() => checkOpenNotes())
  })
  window.rgent.onVaultLost(() => {
    void showPicker(true)
  })
  window.rgent.onFlushRequest(() => {
    void reportFlush(flushSave, (payload) => window.rgent.flushDone(payload))
  })
  window.rgent.onLifecycleFlushRequest((id, cleanUnavailablePaths) => {
    const flush = cleanUnavailablePaths.length
      ? Promise.resolve(saveInFlight).then(() => performFlushSave(cleanUnavailablePaths)) : flushSave()
    void flush.then((ok) => window.rgent.lifecycleFlushDone(id, ok), () => window.rgent.lifecycleFlushDone(id, false))
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
    for (const tab of tabs) tab.relPath = remap(tab.relPath)
    if (active) active = remap(active)
    const revisions = [...hostRevisions.entries()]
    hostRevisions.clear()
    for (const [relPath, revision] of revisions) hostRevisions.set(remap(relPath), revision)
    syncEditorHost()
    renderTabs()
    paintTree()
    void refreshMovedTabs()
  }
  window.rgent.onNoteExternalChange(() => {
    // 别的笔记被外部改了，可能多了或少了指向当前这篇的链接。
    void refreshBacklinks()
  })
  window.rgent.onNoteExternalChange((payload) => {
    if (payload.sessionId && payload.sessionId !== vaultSession) return
    const tab = tabs.find((item) => item.relPath === payload.relPath)
    if (!tab) return
    const epoch = vaultEpoch
    // 事件负载只提示需要复核；排队后必须重新读盘，不能采用排队前的旧快照。
    void runExclusiveConflict(() => reconcileTab(tab, epoch)).then(() => {
      renderTabs()
      updateStatus()
    }).catch(() => { /* 读写失败时保留窗口稿，后续保存仍会复核修订值。 */ })
  })
  window.rgent.onAgentEvent((event) => {
    onHostEvent(event)
  })

  void window.rgent.agentTasks().then((tasks) => {
    for (const task of tasks) {
      if (!endedTaskIds.has(task.id)) activeTasks.set(task.id, task)
    }
    syncActiveLocks()
    updateStatus()
  }).catch(() => {})

  async function submitSlash(submission: { range: { start: number; end: number }; prompt: string }): Promise<void> {
    const tab=current();if(!tab || authorizationPopover || conflictDecisionOpen)return
    if(tab.availability || !tab.sessionId || !tab.objectVersion)return
    if([...activeTasks.values()].some(task=>task.relPath===tab.relPath)){hostNotice='这篇笔记已有正在运行的任务。';updateStatus();return}
    if(!await flushSave()){hostNotice='先保存所有窗口稿，才能准备本场范围。';updateStatus();return}
    if(current()!==tab || !tabs.includes(tab))return
    const draft=editor.getText()
    if(draft.slice(submission.range.start,submission.range.end)!==`/${submission.prompt}`)return
    const request=()=>({relPath:tab.relPath,range:submission.range,expectedText:draft.slice(submission.range.start,submission.range.end),promptText:submission.prompt,
      sessionId:tab.sessionId!,objectVersion:tab.objectVersion!,expectedRevision:tab.revision})
    let displayedRequest:ReturnType<typeof request>|null=null
    const coords=editor.view.coordsAtPos(editor.view.state.selection.main.head)??editor.view.dom.getBoundingClientRect()
    authorizationPopover=openAuthorizationPopover({discard:id=>window.rgent.agentAuthorizationDiscard(id),origin:tab.relPath,entries:tree,anchor:coords,
      returnFocus:()=>editor.view.contentDOM,
      onClose:()=>{authorizationPopover=null},
      preview:async references=>{
        if(current()!==tab || !tabs.includes(tab) || editor.getText()!==draft)return {ok:false,error:'STALE_AUTHORIZATION'}
        if(!await flushSave())return {ok:false,error:'UNSAVED_DRAFT'}
        displayedRequest=request()
        return window.rgent.agentAuthorizationPreview({...displayedRequest,references})
      },
      send:async preview=>{
        if(!displayedRequest || current()!==tab || !tabs.includes(tab) || editor.getText()!==draft)return {ok:false,error:'STALE_AUTHORIZATION'}
        if(!await flushSave())return {ok:false,error:'UNSAVED_DRAFT'}
        const result=await window.rgent.agentStart({...displayedRequest,previewId:preview.id})
        if(!result.ok)return result
        if(!endedTaskIds.has(result.id))activeTasks.set(result.id,{id:result.id,relPath:tab.relPath,startedAt:Date.now()})
        hostNotice='';syncActiveLocks();updateStatus()
        void runExclusiveConflict(()=>syncHostTab(tab,vaultEpoch))
        return result
      }
    })
  }

  function onHostEvent(event: AgentEvent): void {
    if (event.sessionId && event.sessionId !== vaultSession) return
    if (event.persisted && event.revision) hostRevisions.set(event.relPath, event.revision)
    if (event.status === 'running') {
      if (!endedTaskIds.has(event.id)) activeTasks.set(event.id, { id: event.id, relPath: event.relPath, startedAt: activeTasks.get(event.id)?.startedAt ?? Date.now(), activity: event.activity })
    } else {
      endedTaskIds.add(event.id)
      activeTasks.delete(event.id)
      if (event.status === 'failed') hostNotice = `生成失败：${hostErrorText(event.reason ?? '未知错误')}`
      else if (event.status === 'cancelled') hostNotice = `已停止：${event.relPath}`
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
        conflictDecisionOpen = true
        try {
          return await promptConflict({
            title: titleOf(tab.relPath.split('/').pop() ?? tab.relPath),
            windowText: windowBody,
            diskText: diskBody
          })
        } finally {
          conflictDecisionOpen = false
        }
      },
      write: (request) => window.rgent.noteWrite(request),
      applyDisk: (snapshot) => {
        applySource(tab, snapshot)
        if (active === tab.relPath) editor.setText(tab.content)
      },
      applySaved: (body, ledger, revision) => {
        tab.ledger = ledger
        applySaved(tab, body, revision)
        void refreshBacklinks()
      }
    })
  }

  await applyState(await window.rgent.vaultGet())

  async function applyState(state: VaultState): Promise<void> {
    if (state.status === 'needs-pick' || state.vaultChanged) vaultEpoch += 1
    if (state.status === 'needs-pick') {
      if (tabs.length) {
        for (const tab of tabs) markUnavailable(tab, 'unavailable')
        hostNotice = ROOT_UNAVAILABLE_NOTICE
        closeVaultPicker()
        updateStatus()
        return
      }
      vaultSession = null
      const ok = await flushSave()
      if (!ok && tabs.some((tab) => tab.dirty)) {
        vaultNameText = null
        updateStatus()
        showVaultPicker(state.reason)
        return
      }
      resetSession()
      vaultNameText = null
      updateStatus()
      showVaultPicker(state.reason)
      return
    }
    closeVaultPicker()
    const sessionChanged = !!vaultSession && !!state.sessionId && vaultSession !== state.sessionId
    vaultSession = state.sessionId ?? null
    vaultNameText = state.rootName
    updateStatus()
    if (state.vaultChanged || sessionChanged) {
      // chooseVault flushed the old vault before vaultPick switched the root.
      // Never send an old tab's path through noteWrite after the new root is active.
      resetSession()
    }
    await refreshLifecycle()
    await refreshTree()
  }

  function resetSession(): void {
    vaultEpoch += 1
    recoveryState = null
    recoveryOverlay?.close(); recoveryOverlay = null
    lifecycleWarning.hidden = true
    // 底栏跟着库与 tab 走，重置之后统一刷一次。
    queueMicrotask(() => updateStatus())
    tabs.length = 0
    activeTasks.clear()
    endedTaskIds.clear()
    hostRevisions.clear()
    syncActiveLocks()
    active = null
    editor.setText('', noteHost())
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

  async function chooseVault(): Promise<void> {
    const current = await window.rgent.vaultGet()
    if (current.status === 'ready' || tabs.length) {
      const ok = await flushSave()
      if (!ok) {
        window.alert('写盘失败，先处理后再换库。')
        return
      }
    }
    try {
      const state = await window.rgent.vaultPick()
      await applyState(state)
    } catch (error) {
      hostNotice = error instanceof Error ? hostErrorText(error.message) : '换库失败，请先保存当前生成内容。'
      updateStatus()
    }
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

  function showVaultPicker(reason: 'first-run' | 'missing'): void {
    if (vaultPicker?.isOpen()) return
    const overlay = openOverlay({
      label: '选择笔记库',
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
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'pick-btn'
    button.textContent = '选择文件夹'
    button.addEventListener('click', () => {
      void chooseVault()
    })
    card.append(heading, copy, button)
    overlay.root.append(card)
  }

  async function refreshTree(): Promise<void> {
    const epoch = vaultEpoch
    try {
      const [nextTree, nextPermissions] = await Promise.all([window.rgent.treeList(), window.rgent.permissionsGet()])
      if (epoch !== vaultEpoch) return
      tree = nextTree
      permissionState = nextPermissions
    } catch {
      if (epoch !== vaultEpoch) return
      tree = []
      permissionState = { status: 'invalid', error: '无法读取权限名单' }
    }
    // A tree listing cannot prove that a missing object is safe to discard.
    // Retain even clean tabs and their verified ledger until object inspection
    // offers explicit recovery/save-copy or the person discards the draft.
    paintTree()
    syncEditorHost()
  }

  async function refreshLifecycle(): Promise<LifecycleStatus | null> {
    const epoch = vaultEpoch
    try {
      const status = await window.rgent.lifecycleStatus()
      if (epoch !== vaultEpoch || (vaultSession && status.sessionId !== vaultSession)) return null
      recoveryState = status
      lifecycleWarning.hidden = status.status === 'ready'
      lifecycleWarning.textContent = status.status === 'invalid' ? '恢复记录无法核验 · 查看' : '文件操作待核验 · 查看'
      return status
    } catch { return null }
  }

  async function showRecoveryStatus(): Promise<void> {
    const status = await refreshLifecycle()
    if (!status || conflictDecisionOpen) return
    recoveryOverlay?.close()
    const epoch = vaultEpoch
    recoveryOverlay = openLifecycleStatus(status, async (request) => {
      const result = await window.rgent.lifecycleRetry(request)
      if (epoch !== vaultEpoch) throw new Error('VAULT_CHANGED')
      const next = await refreshLifecycle()
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
    renderTree(treeScroll, tree, active, (relPath) => {
      void openNote(relPath)
    }, (relPath, tier) => { void changePermission(relPath, tier) }, (entry, action) => { void handleTreeAction(entry, action) })
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
      const overlay = openOverlay({ label: '选择目标文件夹', onClose: () => finish(null), initialFocus: () => select })
      overlay.root.classList.add('lifecycle-dialog')
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
      const overlay = openOverlay({ label: '核对文件变更', onClose: () => finish(null), initialFocus: () => cancel })
      overlay.root.classList.add('lifecycle-dialog')
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
        const name = await promptText(action === 'new-note' ? '新建笔记' : '新建文件夹', '名称', '', '创建')
        if (!name || epoch !== vaultEpoch) return
        const parent = entry.relPath
        const created = action === 'new-note'
          ? await window.rgent.noteCreateAt({ name, parent })
          : await window.rgent.folderCreate({ name, parent })
        if (epoch !== vaultEpoch) return
        await refreshTree()
        if (action === 'new-note') await openNote(created)
        return
      }
      if (!(await flushSave())) { window.alert('有草稿尚未保存，请先处理保存冲突。'); return }
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
      if (result.unrepaired.length) window.alert(`文件已移动；以下引用因内容变化未修复：\n${result.unrepaired.join('\n')}`)
    } catch (error) {
      if (epoch === vaultEpoch) window.alert(lifecycleErrorText(error))
    }
    finally { if (epoch === vaultEpoch) void refreshLifecycle() }
  }

  async function createRootFolder(): Promise<void> {
    const name = await promptText('新建文件夹', '名称', '', '创建')
    if (!name) return
    try {
      await window.rgent.folderCreate({ name, parent: '' })
      await refreshTree()
    } catch (error) { window.alert(lifecycleErrorText(error)) }
  }

  async function changePermission(relPath: string, tier: PermissionTier): Promise<void> {
    if (permissionState.status === 'invalid') {
      window.alert('权限名单损坏或无法读取，请先在库根修复 .rgent-permissions。')
      return
    }
    try {
      permissionState = await window.rgent.permissionsSet({ relPath, tier })
      await refreshTree()
    } catch (error) {
      window.alert(lifecycleErrorText(error))
    }
  }

  function noteHost(): NoteHost {
    const present = collectRelPaths(tree)
    const tab = current()
    return {
      noteRelPath: active ?? '',
      imageEpoch: tab ? `${tab.sessionId}/${tab.objectVersion}/${tab.revision}` : '',
      vaultHas: (relPath) => present.has(relPath),
      imageContext: (range, region = 'body') => tab ? {
        noteRelPath: tab.relPath, region,
        start: range.start + (region === 'ledger' ? partitionSource(composeSource(tab.content,tab.ledger)).body.length : 0),
        end: range.end + (region === 'ledger' ? partitionSource(composeSource(tab.content,tab.ledger)).body.length : 0),
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

  async function openNote(relPath: string): Promise<void> {
    const existing = tabs.find((tab) => tab.relPath === relPath)
    if (existing) {
      activate(relPath)
      return
    }
    const epoch = vaultEpoch
    try {
      const source = await window.rgent.noteRead(relPath)
      if (epoch !== vaultEpoch || source.sessionId !== vaultSession) return
      const part = partitionSource(source.content)
      tabs.push({
        relPath,
        content: part.body,
        ledger: part.ledger,
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

  function activate(relPath: string): void {
    const tab = tabs.find((item) => item.relPath === relPath)
    if (!tab) return
    if (active && active !== relPath) {
      const prev = current()
      if (prev) prev.content = editor.getText()
    }
    active = relPath
    editor.setText(tab.content, noteHost(), tab.selection)
    syncActiveLocks()
    editor.focus()
    closeLedger()
    renderTabs()
    paintTree()
    updateStatus()
    renderOutline()
    emptyEl.hidden = true
    void refreshBacklinks()
  }

  function current(): Tab | undefined {
    return tabs.find((tab) => tab.relPath === active)
  }

  function renderTabs(): void {
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
        const next = tabs[(at + step + tabs.length) % tabs.length]
        if (!next) return
        activate(next.relPath)
        tabsEl.querySelector<HTMLButtonElement>(`.tab[data-rel="${CSS.escape(next.relPath)}"]`)?.focus()
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
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'tab-new'
    add.setAttribute('aria-label', '新建笔记')
    add.title = '新建笔记'
    add.append(icon('plus'))
    add.addEventListener('click', () => void createNote())
    tabsEl.append(add)
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
      return
    }
    const marks = outlineMarks(editor.headings(), editor.viewport(), editor.caret())
    const previousScroll = outlineEl.scrollTop
    outlineEl.hidden = marks.length === 0
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
    const currentMark = outlineEl.querySelector<HTMLElement>(".outline-mark[aria-current='true']")
    if (currentMark && (currentMark.offsetTop < outlineEl.scrollTop || currentMark.offsetTop + currentMark.offsetHeight > outlineEl.scrollTop + outlineEl.clientHeight)) {
      outlineEl.scrollTop = currentMark.offsetTop - outlineEl.clientHeight / 2
    }
  }

  /** 底栏：行列、字数、库名。字数只算正文，标记行不算。 */
  function updateStatus(): void {
    paintUnavailable()
    const tab = current()
    const info = tab ? editor.selectionInfo() : null
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
        vaultName: vaultNameText,
        noteOpen: tab != null
      }, modelModule())
    )
    const left = statusEl.querySelector('.status-left')
    if (hostNotice && left) {
      const notice = document.createElement('span')
      notice.className = 'status-item status-host-notice'
      notice.setAttribute('role', 'status')
      notice.textContent = hostNotice
      left.append(notice)
    }
    if (activeTasks.size && left) {
      if (activeTasks.size === 1) {
        const task = [...activeTasks.values()][0]!
        const label = document.createElement('span')
        label.className = 'status-item status-task'
        label.textContent = `${titleOf(task.relPath.split('/').pop() ?? task.relPath)} · ${task.activity || '生成中'}`
        const stop = document.createElement('button')
        stop.type = 'button'
        stop.className = 'status-task-stop'
        stop.textContent = '停止'
        stop.setAttribute('aria-label', `停止 ${task.relPath} 的任务`)
        stop.addEventListener('click', () => { void window.rgent.agentCancel(task.id) })
        left.append(label, stop)
      } else {
        const more = document.createElement('button')
        more.type = 'button'
        more.className = 'status-task-more'
        more.textContent = `${activeTasks.size} 项生成中`
        more.addEventListener('click', openTaskOverlay)
        left.append(more)
      }
    }
  }

  function openTaskOverlay(): void {
    if (taskOverlay?.isOpen()) return
    const overlay = openOverlay({ label: '运行中的任务', initialFocus: () => overlay.root.querySelector<HTMLElement>('button') })
    taskOverlay = overlay
    overlay.root.classList.add('overlay-tasks')
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
      stop.addEventListener('click', () => { void window.rgent.agentCancel(task.id) })
      row.append(name, stop)
      taskOverlay.root.append(row)
    }
    if (!activeTasks.size) taskOverlay.close()
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
    // 账本是同文件的旁路原文，只读展示；Host 按任务追加的章节也走同一视图。
    const ledgerSource = tab.ledger ?? ''
    if (ledgerSource.trim()) renderReadOnlyMarkdown(ledgerBody, ledgerSource, noteHost())
    else ledgerBody.textContent = '这篇笔记还没有账本。完成一次生成任务后，可在这里回顾。'
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

  async function closeTab(relPath: string, opts: { save?: boolean } = {}): Promise<void> {
    const tab = tabs.find((item) => item.relPath === relPath)
    if (!tab) return
    if (opts.save !== false && tab.availability) { hostNotice='请先另存，或明确舍弃这份窗口稿。'; updateStatus(); return }
    if (opts.save !== false && tab.dirty && (!(await writeTab(tab)) || tab.dirty)) return
    const index = tabs.findIndex((item) => item.relPath === relPath)
    tabs.splice(index, 1)
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
    if (saveTimer != null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      void flushSave()
    }, SAVE_MS)
  }

  function flushSave(): Promise<boolean> {
    if (saveInFlight) {
      return saveInFlight.then((ok) => ok && tabs.some((tab) => tab.dirty) ? flushSave() : ok)
    }
    const task = performFlushSave()
    saveInFlight = task
    return task.finally(() => {
      if (saveInFlight === task) saveInFlight = null
    })
  }

  async function performFlushSave(cleanUnavailablePaths: readonly string[] = []): Promise<boolean> {
    if (saveTimer != null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    let ok = !hasUnavailableDraft(tabs, cleanUnavailablePaths)
    let wrote = false
    for (let pass = 0; pass < 3; pass += 1) {
      const writes = pendingWrites(tabs, active, editor.getText())
      if (writes.length === 0) break
      for (const write of writes) {
        const tab = tabs.find((item) => item.relPath === write.relPath)
        if (!tab || tab.availability) continue
        wrote = true
        if (!(await writeTab(tab, write.body))) ok = false
      }
      if (!ok) break
    }
    renderTabs()
    if (ok && wrote) void refreshBacklinks()
    if (ok && tabs.some((tab) => tab.dirty)) scheduleSave()
    return ok && !tabs.some((tab) => tab.dirty)
  }

  async function writeTab(tab: Tab, body = tab.relPath === active ? editor.getText() : tab.content, attempt = 0): Promise<boolean> {
    if (tab.availability || !tab.sessionId || !tab.objectVersion || tab.sessionId !== vaultSession) return false
    const epoch = vaultEpoch
    const result = await window.rgent.noteWrite({
      sessionId: tab.sessionId, objectVersion: tab.objectVersion,
      relPath: tab.relPath,
      content: composeSource(body, tab.ledger),
      expectedRevision: tab.revision
    })
    if (epoch !== vaultEpoch || !tabs.includes(tab)) return false
    if (result.ok) {
      tab.objectVersion = result.objectVersion
      tab.sessionId = result.sessionId
      applySaved(tab, body, result.revision)
      if (hostNotice === LIFECYCLE_ERRORS.LEDGER_BOUNDARY_INVALID) { hostNotice = ''; updateStatus() }
      syncEditorHost()
      void refreshBacklinks()
      return true
    }
    if (['NOTE_MISSING','NOTE_REPLACED','NOTE_UNREADABLE'].includes(result.error)) {
      markUnavailable(tab, result.error === 'NOTE_MISSING' ? 'missing' : result.error === 'NOTE_REPLACED' ? 'replaced' : 'unavailable')
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
      if (outcome === 'merged' && tab.dirty && attempt < 3) return writeTab(tab, tab.relPath === active ? editor.getText() : tab.content, attempt + 1)
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
      const result = await window.rgent.noteSaveCopyPreview({ sessionId:tab.sessionId, objectVersion:tab.objectVersion,
        source, target, body, draftVersion })
      if (epoch !== vaultEpoch || !tabs.includes(tab)) return
      if (!result.ok) throw new Error(result.error)
      const accepted = await new Promise<boolean>(resolve => {
        let answer=false
        const panel=openOverlay({label:'确认另存',onClose:()=>resolve(answer)})
        panel.root.classList.add('save-copy-preview')
        const title=document.createElement('h2'); title.textContent='另存为新笔记'
        const description=document.createElement('p'); description.textContent=`${source} → ${result.preview.target}`
        const note=document.createElement('p'); note.textContent=result.preview.warning
        const tasks=document.createElement('p'); tasks.textContent=result.preview.pendingTaskIds.length ? `将以原任务 ID 保留 ${result.preview.pendingTaskIds.length} 份未落盘完整回答到新笔记账本；任务不重启。` : '最后核验的原账本将一并保留。'
        const cancel=document.createElement('button'); cancel.textContent='取消'; cancel.onclick=()=>panel.close()
        const save=document.createElement('button'); save.className='save-copy-confirm'; save.textContent='确认另存'; save.onclick=()=>{answer=true;panel.close()}
        panel.root.append(title,description,note,tasks,cancel,save)
      })
      if (!accepted || epoch !== vaultEpoch || !tabs.includes(tab)) return
      const currentBody = tab.relPath === active ? editor.getText() : tab.content
      const saved=await window.rgent.noteSaveCopyCommit({id:result.preview.id,sessionId:tab.sessionId,draftVersion,body:currentBody})
      if (epoch !== vaultEpoch || !tabs.includes(tab)) return
      if (!saved.ok) throw new Error(saved.error)
      const selection=tab.selection
      applySource(tab,saved.snapshot); tab.relPath=saved.relPath
      hostRevisions.delete(source)
      for(const id of saved.taskIds) { activeTasks.delete(id); endedTaskIds.add(id) }
      if(active===source) { active=saved.relPath; editor.setText(tab.content,noteHost(),selection) }
      closeLedger(); syncActiveLocks(); renderTabs(); updateStatus(); await refreshTree()
    } catch(error) { if(epoch===vaultEpoch) window.alert(lifecycleErrorText(error)) }
  }
  async function discardMissing(): Promise<void> {
    const tab=current(); const epoch=vaultEpoch
    if(!tab?.availability || !tab.sessionId || !tab.objectVersion) return
    if(!window.confirm('明确舍弃这篇原对象的窗口稿及尚未落盘的生成内容？磁盘同名文件不会改动。')) return
    const ok=await window.rgent.noteAbandon({relPath:tab.relPath,sessionId:tab.sessionId,objectVersion:tab.objectVersion})
    if(ok && epoch===vaultEpoch) await closeTab(tab.relPath,{save:false})
  }

  function applySource(tab: Tab, source: NoteSnapshot): void {
    const part = partitionSource(source.content)
    tab.content = part.body
    tab.ledger = part.ledger
    tab.saved = part.body
    tab.revision = source.revision
    tab.sessionId = source.sessionId
    tab.objectVersion = source.objectVersion
    delete tab.availability
    tab.dirty = false
  }

  async function createNote(): Promise<void> {
    let state = await window.rgent.vaultGet()
    if (state.status !== 'ready') {
      await chooseVault()
      state = await window.rgent.vaultGet()
      if (state.status !== 'ready') return
    }
    const name = await promptNewNote()
    if (!name) return
    try {
      const relPath = await window.rgent.noteCreate(name)
      await refreshTree()
      await openNote(relPath)
    } catch (err) {
      window.alert(lifecycleErrorText(err))
    }
  }
}
