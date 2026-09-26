import { IPC, type NoteSnapshot, type PermissionState, type PermissionTier, type SearchHit, type TreeEntry, type VaultState } from '@shared'
import { composeSource, partitionSource, preferDiskLedger } from '@markdown'
import { reportFlush } from '../../shared/flush.ts'
import { renderBacklinks } from './backlinks.ts'
import { promptConflict, promptNewNote } from './dialogs.ts'
import { renderSearchResults } from './search.ts'
import { applySaved, pendingWrites, type Tab } from './tabs.ts'
import { mountEditor, type EditorHost, type NoteHost } from './view/editor.ts'
import { renderTree, titleOf, collectNotePaths, collectRelPaths } from './tree.ts'

const SAVE_MS = 800

export async function start(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="app">
      <header class="top">
        <button type="button" class="tree-toggle" aria-controls="tree-panel" aria-expanded="false">目录</button>
        <p class="brand">Rgent</p>
        <span class="vault-name" hidden></span>
        <span class="permission-warning" role="alert" hidden></span>
        <div class="search">
          <input type="search" class="search-input" placeholder="搜标题或正文" aria-label="搜标题或正文" autocomplete="off" />
          <div class="search-panel" hidden></div>
        </div>
      </header>
      <div class="body">
        <aside id="tree-panel" class="tree-panel" hidden>
          <div class="tree-scroll"></div>
        </aside>
        <section class="stage">
          <div class="tabs" role="tablist"></div>
          <div class="editor-host"></div>
          <div class="ledger-view" hidden>
            <div class="ledger-head">
              <span class="ledger-title"></span>
              <button type="button" class="ledger-close" aria-label="关闭账本回顾">×</button>
            </div>
            <pre class="ledger-body"></pre>
          </div>
          <p class="empty">从目录打开一篇笔记，或新建笔记。</p>
        </section>
        <aside class="backlinks" aria-label="反链"></aside>
      </div>
    </div>
    <div class="picker" hidden>
      <div class="picker-card">
        <h1>选择笔记库</h1>
        <p class="picker-copy"></p>
        <button type="button" class="pick-btn">选择文件夹</button>
      </div>
    </div>
  `

  const picker = root.querySelector('.picker') as HTMLElement
  const pickerCopy = root.querySelector('.picker-copy') as HTMLElement
  const pickBtn = root.querySelector('.pick-btn') as HTMLButtonElement
  const treePanel = root.querySelector('#tree-panel') as HTMLElement
  const treeScroll = root.querySelector('.tree-scroll') as HTMLElement
  const treeToggle = root.querySelector('.tree-toggle') as HTMLButtonElement
  const vaultName = root.querySelector('.vault-name') as HTMLElement
  const permissionWarning = root.querySelector('.permission-warning') as HTMLElement
  const tabsEl = root.querySelector('.tabs') as HTMLElement
  const editorHostEl = root.querySelector('.editor-host') as HTMLElement
  const emptyEl = root.querySelector('.empty') as HTMLElement
  const backlinksEl = root.querySelector('.backlinks') as HTMLElement
  const ledgerEl = root.querySelector('.ledger-view') as HTMLElement
  const ledgerTitle = root.querySelector('.ledger-title') as HTMLElement
  const ledgerBody = root.querySelector('.ledger-body') as HTMLElement
  const ledgerClose = root.querySelector('.ledger-close') as HTMLButtonElement
  const searchEl = root.querySelector('.search') as HTMLElement
  const searchInput = root.querySelector('.search-input') as HTMLInputElement
  const searchPanel = root.querySelector('.search-panel') as HTMLElement

  const tabs: Tab[] = []
  let active: string | null = null
  let tree: TreeEntry[] = []
  let saveTimer: number | null = null
  let conflictOpen = false
  let backlinkToken = 0
  let searchTimer: number | null = null
  let searchHits: SearchHit[] = []
  let permissionState: PermissionState = { status: 'ready', entries: [] }
  let saveInFlight: Promise<boolean> | null = null
  let ledgerOpen = false

  const editor: EditorHost = mountEditor(editorHostEl, (text) => {
    const tab = current()
    if (!tab) return
    tab.content = text
    tab.dirty = text !== tab.saved
    renderTabs()
    scheduleSave()
  }, () => {
    void flushSave()
  })

  treeToggle.addEventListener('click', () => {
    const open = treePanel.hasAttribute('hidden')
    treePanel.toggleAttribute('hidden', !open)
    treeToggle.setAttribute('aria-expanded', String(open))
  })

  pickBtn.addEventListener('click', () => {
    void chooseVault()
  })
  ledgerClose.addEventListener('click', () => closeLedger())

  const closeSearch = () => {
    searchPanel.hidden = true
    searchHits = []
  }

  searchInput.addEventListener('input', () => {
    if (searchTimer != null) window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      void runSearch()
    }, 200)
  })
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchInput.value = ''
      closeSearch()
      editor.focus()
      return
    }
    if (event.key === 'Enter') {
      const first = searchHits[0]
      if (!first) return
      event.preventDefault()
      searchInput.value = ''
      closeSearch()
      void openNote(first.relPath)
    }
  })
  document.addEventListener('mousedown', (event) => {
    if (searchPanel.hidden) return
    if (searchEl.contains(event.target as Node)) return
    closeSearch()
  })

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
  window.rgent.onNoteExternalChange(async (payload) => {
    const tab = tabs.find((item) => item.relPath === payload.relPath)
    if (!tab) return
    const live = composeSource(tab.relPath === active ? editor.getText() : tab.content, tab.ledger)
    const snapshot: NoteSnapshot = { content: payload.content, revision: payload.revision }
    if (!tab.dirty) {
      applySource(tab, snapshot)
      if (active === tab.relPath) editor.setText(tab.content)
      renderTabs()
      return
    }
    if (live === payload.content) {
      applySource(tab, snapshot)
      renderTabs()
      return
    }
    if (conflictOpen) return
    conflictOpen = true
    const choice = await promptConflict()
    conflictOpen = false
    if (choice === 'disk') {
      applySource(tab, snapshot)
      if (active === tab.relPath) editor.setText(tab.content)
    } else if (choice === 'window') {
      // 同上：正文听窗口，账本听磁盘。
      tab.ledger = preferDiskLedger(partitionSource(payload.content).ledger, tab.ledger)
      tab.revision = payload.revision
      await writeTab(tab)
    }
    renderTabs()
  })

  await applyState(await window.rgent.vaultGet())

  async function applyState(state: VaultState): Promise<void> {
    if (state.status === 'needs-pick') {
      const ok = await flushSave()
      if (!ok && tabs.some((tab) => tab.dirty)) {
        picker.hidden = false
        pickerCopy.textContent =
          state.reason === 'missing' ? '上次的库找不到了。请重新选一个文件夹。' : '第一次打开，先选一个文件夹当库。空的也行。不选进不去。'
        vaultName.hidden = true
        return
      }
      resetSession()
      picker.hidden = false
      pickerCopy.textContent =
        state.reason === 'missing' ? '上次的库找不到了。请重新选一个文件夹。' : '第一次打开，先选一个文件夹当库。空的也行。不选进不去。'
      vaultName.hidden = true
      return
    }
    picker.hidden = true
    vaultName.hidden = false
    vaultName.textContent = state.rootName
    if (state.vaultChanged) {
      const ok = await flushSave()
      if (!ok) return
      resetSession()
    }
    await refreshTree()
  }

  function resetSession(): void {
    tabs.length = 0
    active = null
    editor.setText('', noteHost())
    renderTabs()
    closeSearch()
    searchInput.value = ''
    void refreshBacklinks()
  }

  async function runSearch(): Promise<void> {
    const query = searchInput.value
    try {
      searchHits = await window.rgent.search(query)
    } catch {
      searchHits = []
    }
    renderSearchResults(searchPanel, searchHits, query, (relPath) => {
      searchInput.value = ''
      closeSearch()
      void openNote(relPath)
    })
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
    editor.setText(tab.content, noteHost())
    editor.focus()
    closeLedger()
    renderTabs()
    paintTree()
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
      button.textContent = `${titleOf(tab.relPath.split('/').pop() ?? tab.relPath)}${tab.dirty ? ' •' : ''}`
      button.addEventListener('click', () => activate(tab.relPath))
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'tab-close'
      close.setAttribute('aria-label', `关闭 ${button.textContent}`)
      close.textContent = '×'
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        void closeTab(tab.relPath)
      })
      const wrap = document.createElement('div')
      wrap.className = 'tab-wrap'
      wrap.append(button, close)
      tabsEl.append(wrap)
    }
    // 账本回顾：入口就放在当前笔记标题旁边，临时、只读、关掉就走，
    // 不占右侧反链（围栏 §账本）。它不是文件，所以不进 tabs 数组。
    if (active) {
      const ledger = document.createElement('button')
      ledger.type = 'button'
      ledger.className = 'ledger-open'
      ledger.textContent = '账本'
      ledger.title = '看这篇笔记的账本回顾'
      ledger.setAttribute('aria-pressed', String(ledgerOpen))
      ledger.addEventListener('click', () => toggleLedger())
      tabsEl.append(ledger)
    }
    emptyEl.hidden = tabs.length > 0
  }

  function toggleLedger(): void {
    if (ledgerOpen) {
      closeLedger()
      return
    }
    const tab = current()
    if (!tab) return
    ledgerOpen = true
    ledgerTitle.textContent = `${titleOf(tab.relPath.split('/').pop() ?? tab.relPath)} · 账本回顾`
    // 账本是旁路原文，只读展示；分场要等写入方（Host 阶段）定下章节写法。
    ledgerBody.textContent =
      tab.ledger && tab.ledger.trim() !== ''
        ? tab.ledger
        : '这篇笔记还没有账本。账本由生成任务写下，写入方属于 Host 阶段。'
    ledgerEl.hidden = false
    renderTabs()
  }

  function closeLedger(): void {
    if (!ledgerOpen) return
    ledgerOpen = false
    ledgerEl.hidden = true
    renderTabs()
  }

  async function closeTab(relPath: string, opts: { save?: boolean } = {}): Promise<void> {
    const tab = tabs.find((item) => item.relPath === relPath)
    if (!tab) return
    if (opts.save !== false && tab.dirty && (!(await writeTab(tab)) || tab.dirty)) return
    const index = tabs.findIndex((item) => item.relPath === relPath)
    tabs.splice(index, 1)
    if (active === relPath) {
      const next = tabs[index] ?? tabs[index - 1]
      active = next?.relPath ?? null
      editor.setText(next?.content ?? '', noteHost())
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
      if (conflictOpen) return false
      conflictOpen = true
      try {
        const disk = await window.rgent.noteRead(tab.relPath)
        const choice = await promptConflict()
        if (choice === 'disk') {
          applySource(tab, disk)
          if (active === tab.relPath) editor.setText(tab.content)
          return true
        }
        if (choice === 'window') {
          // 窗口赢的只是正文：账本以磁盘为准，否则会把外部新追加的章节抹掉。
          tab.ledger = preferDiskLedger(partitionSource(disk.content).ledger, tab.ledger)
          tab.revision = disk.revision
          const currentBody = tab.relPath === active ? editor.getText() : tab.content
          const retry = await window.rgent.noteWrite({
            relPath: tab.relPath,
            content: composeSource(currentBody, tab.ledger),
            expectedRevision: tab.revision
          })
          if (retry.ok) {
            applySaved(tab, currentBody, retry.revision)
            return true
          }
        }
      } catch {
        // 保留脏稿，等人重试。
      } finally {
        conflictOpen = false
      }
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
