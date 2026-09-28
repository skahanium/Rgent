import { IPC, type NoteSnapshot, type PermissionState, type PermissionTier, type SearchHit, type TreeEntry, type VaultState } from '@shared'
import { composeSource, partitionSource } from '@markdown'
import { reportFlush } from '../../shared/flush.ts'
import { renderBacklinks } from './backlinks.ts'
import { promptNewNote } from './dialogs.ts'
import { promptConflict } from './conflict.ts'
import { openOverlay } from './overlay.ts'
import { createSearchOverlay } from './search-overlay.ts'
import { createSettingsOverlay } from './settings.ts'
import { applySaved, pendingWrites, type Tab } from './tabs.ts'
import { mountEditor, type EditorHost, type NoteHost } from './view/editor.ts'
import { renderReadOnlyMarkdown } from './view/read-only.ts'
import { icon } from './icons.ts'
import { outlineLabel, outlineMarks } from './outline.ts'
import { installShortcuts, shortcutLabel } from './shortcuts.ts'
import { renderStatusbar, statusModel, wordsOf } from './statusbar.ts'
import { reconcileNote, type ReconcileResult } from './note-reconcile.ts'
import { renderTree, titleOf, collectNotePaths, collectRelPaths } from './tree.ts'
import type { Theme } from './theme.ts'

const SAVE_MS = 800

export async function start(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="app">
      <header class="top">
        <button type="button" class="tree-toggle" aria-controls="tree-panel" aria-expanded="false" aria-label="目录"></button>
        <div class="tabs" role="tablist" aria-label="打开中的笔记"></div>
        <span class="permission-warning" role="alert" hidden></span>
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
  const statusEl = root.querySelector('.status') as HTMLElement
  const tabsEl = root.querySelector('.tabs') as HTMLElement
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
    setMode: (mode) => window.rgent.themeSet(mode)
  })
  let saveInFlight: Promise<boolean> | null = null
  let ledgerOpen = false
  let countedPath: string | null = null
  let countedSource: string | null = null
  let countedWords = 0

  const editor: EditorHost = mountEditor(editorHostEl, (text) => {
    const tab = current()
    if (!tab) return
    tab.content = text
    tab.dirty = text !== tab.saved
    renderTabs()
    updateStatus()
    scheduleSave()
  })

  installShortcuts({
    onSearch: () => { if (!conflictDecisionOpen) searchOverlay.open() },
    onSave: () => void flushSave()
  })
  shortcutHint.textContent = shortcutLabel('k')
  searchOpen.addEventListener('click', () => { if (!conflictDecisionOpen) searchOverlay.open() })
  settingsOpen.prepend(icon('settings'))
  settingsOpen.addEventListener('click', () => { if (!conflictDecisionOpen) settingsOverlay.open() })

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

  treeToggle.addEventListener('click', () => {
    const open = treePanel.classList.contains('is-collapsed')
    treePanel.classList.toggle('is-collapsed', !open)
    treeToggle.setAttribute('aria-expanded', String(open))
  })

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
    void refreshTree()
  })
  window.rgent.onVaultLost(() => {
    void showPicker(true)
  })
  window.rgent.onFlushRequest(() => {
    void reportFlush(flushSave, (payload) => window.rgent.flushDone(payload))
  })
  window.rgent.onNoteExternalChange(() => {
    // 别的笔记被外部改了，可能多了或少了指向当前这篇的链接。
    void refreshBacklinks()
  })
  window.rgent.onNoteExternalChange((payload) => {
    const tab = tabs.find((item) => item.relPath === payload.relPath)
    if (!tab) return
    const epoch = vaultEpoch
    // 事件负载只提示需要复核；排队后必须重新读盘，不能采用排队前的旧快照。
    void runExclusiveConflict(() => reconcileTab(tab, epoch)).then(() => {
      renderTabs()
      updateStatus()
    }).catch(() => { /* 读写失败时保留窗口稿，后续保存仍会复核修订值。 */ })
  })

  function reconcileTab(tab: Tab, epoch = vaultEpoch): Promise<ReconcileResult> {
    return reconcileNote(tab, {
      isCurrent: () => vaultEpoch === epoch && tabs.includes(tab),
      read: () => window.rgent.noteRead(tab.relPath),
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
    vaultNameText = state.rootName
    updateStatus()
    if (state.vaultChanged) {
      const ok = await flushSave()
      if (!ok) return
      resetSession()
    }
    await refreshTree()
  }

  function resetSession(): void {
    vaultEpoch += 1
    // 底栏跟着库与 tab 走，重置之后统一刷一次。
    queueMicrotask(() => updateStatus())
    tabs.length = 0
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
    if (current.status === 'ready') {
      const ok = await flushSave()
      if (!ok) {
        window.alert('写盘失败，先处理后再换库。')
        return
      }
    }
    const state = await window.rgent.vaultPick()
    await applyState(state)
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
    try {
      const [nextTree, nextPermissions] = await Promise.all([window.rgent.treeList(), window.rgent.permissionsGet()])
      tree = nextTree
      permissionState = nextPermissions
    } catch {
      tree = []
      permissionState = { status: 'invalid', error: '无法读取权限名单' }
    }
    const present = collectNotePaths(tree)
    for (const tab of [...tabs]) {
      if (!present.has(tab.relPath) && !tab.dirty) {
        await closeTab(tab.relPath, { save: false })
      }
    }
    paintTree()
    syncEditorHost()
  }

  function paintTree(): void {
    renderTree(treeScroll, tree, active, (relPath) => {
      void openNote(relPath)
    }, (relPath, tier) => { void changePermission(relPath, tier) })
    permissionWarning.hidden = permissionState.status !== 'invalid'
    if (permissionState.status === 'invalid') permissionWarning.textContent = `AI 门禁暂停：${permissionState.error}。请检查库根 .rgent-permissions。`
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
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }

  function noteHost(): NoteHost {
    const present = collectRelPaths(tree)
    return {
      noteRelPath: active ?? '',
      vaultHas: (relPath) => present.has(relPath),
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
    try {
      const source = await window.rgent.noteRead(relPath)
      const part = partitionSource(source.content)
      tabs.push({
        relPath,
        content: part.body,
        ledger: part.ledger,
        saved: part.body,
        revision: source.revision,
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
      })
    )
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
    // 账本是旁路原文，只读展示；分场要等写入方（Host 阶段）定下章节写法。
    const ledgerSource = tab.ledger?.replace(/^<!-- rgent:ledger:v1 -->\s*\r?\n?/, '') ?? ''
    if (ledgerSource.trim()) renderReadOnlyMarkdown(ledgerBody, ledgerSource, noteHost())
    else ledgerBody.textContent = '这篇笔记还没有账本。账本由生成任务写下，写入方属于 Host 阶段。'
    ledgerEl.hidden = false
    renderTabs()
  }

  function closeLedger(restoreFocus = false): void {
    if (!ledgerOpen) return
    ledgerOpen = false
    ledgerEl.hidden = true
    renderTabs()
    if (restoreFocus) ledgerOpenButton.focus()
  }

  async function closeTab(relPath: string, opts: { save?: boolean } = {}): Promise<void> {
    const tab = tabs.find((item) => item.relPath === relPath)
    if (!tab) return
    if (opts.save !== false && tab.dirty && (!(await writeTab(tab)) || tab.dirty)) return
    const index = tabs.findIndex((item) => item.relPath === relPath)
    tabs.splice(index, 1)
    if (active === relPath) {
      closeLedger()
      const next = tabs[index] ?? tabs[index - 1]
      active = next?.relPath ?? null
      editor.setText(next?.content ?? '', noteHost(), next?.selection)
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

  async function performFlushSave(): Promise<boolean> {
    if (saveTimer != null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    let ok = true
    let wrote = false
    for (let pass = 0; pass < 3; pass += 1) {
      const writes = pendingWrites(tabs, active, editor.getText())
      if (writes.length === 0) break
      for (const write of writes) {
        const tab = tabs.find((item) => item.relPath === write.relPath)
        if (!tab) continue
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

  async function writeTab(tab: Tab, body = tab.relPath === active ? editor.getText() : tab.content): Promise<boolean> {
    const result = await window.rgent.noteWrite({
      relPath: tab.relPath,
      content: composeSource(body, tab.ledger),
      expectedRevision: tab.revision
    })
    if (result.ok) {
      applySaved(tab, body, result.revision)
      void refreshBacklinks()
      return true
    }
    if (result.error === 'CONFLICT') {
      const outcome = await runExclusiveConflict(() => reconcileTab(tab))
      renderTabs()
      updateStatus()
      return outcome === 'disk' || outcome === 'saved' || outcome === 'unchanged'
    }
    return false
  }

  function applySource(tab: Tab, source: NoteSnapshot): void {
    const part = partitionSource(source.content)
    tab.content = part.body
    tab.ledger = part.ledger
    tab.saved = part.body
    tab.revision = source.revision
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
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }
}
