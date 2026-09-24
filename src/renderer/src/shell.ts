import { IPC, type TreeEntry, type VaultState } from '@shared'
import { promptConflict, promptNewNote } from './dialogs.ts'
import { mountEditor, type EditorHost, type NoteHost } from './view/editor.ts'
import { renderTree, titleOf, collectNotePaths, collectRelPaths } from './tree.ts'

type Tab = {
  relPath: string
  content: string
  saved: string
  dirty: boolean
}

const SAVE_MS = 800

export async function start(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="app">
      <header class="top">
        <button type="button" class="tree-toggle" aria-controls="tree-panel" aria-expanded="false">目录</button>
        <p class="brand">Rgent</p>
        <span class="vault-name" hidden></span>
      </header>
      <div class="body">
        <aside id="tree-panel" class="tree-panel" hidden>
          <div class="tree-scroll"></div>
        </aside>
        <section class="stage">
          <div class="tabs" role="tablist"></div>
          <div class="editor-host"></div>
          <p class="empty">从目录打开一篇笔记，或新建笔记。</p>
        </section>
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
  const tabsEl = root.querySelector('.tabs') as HTMLElement
  const editorHostEl = root.querySelector('.editor-host') as HTMLElement
  const emptyEl = root.querySelector('.empty') as HTMLElement

  const tabs: Tab[] = []
  let active: string | null = null
  let tree: TreeEntry[] = []
  let saveTimer: number | null = null
  let conflictOpen = false

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
  window.rgent.onNoteExternalChange(async (payload) => {
    const tab = tabs.find((item) => item.relPath === payload.relPath)
    if (!tab) return
    if (!tab.dirty) {
      tab.content = payload.content
      tab.saved = payload.content
      if (active === tab.relPath) editor.setText(payload.content)
      renderTabs()
      return
    }
    if (tab.content === payload.content) {
      tab.saved = payload.content
      tab.dirty = false
      renderTabs()
      return
    }
    if (conflictOpen) return
    conflictOpen = true
    const choice = await promptConflict()
    conflictOpen = false
    if (choice === 'disk') {
      tab.content = payload.content
      tab.saved = payload.content
      tab.dirty = false
      if (active === tab.relPath) editor.setText(payload.content)
    } else {
      await writeTab(tab)
    }
    renderTabs()
  })

  await applyState(await window.rgent.vaultGet())

  async function applyState(state: VaultState): Promise<void> {
    if (state.status === 'needs-pick') {
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
    if (state.vaultChanged) resetSession()
    await refreshTree()
  }

  function resetSession(): void {
    tabs.length = 0
    active = null
    editor.setText('', noteHost())
    renderTabs()
  }

  async function chooseVault(): Promise<void> {
    const state = await window.rgent.vaultPick()
    await applyState(state)
  }

  async function showPicker(lost: boolean): Promise<void> {
    await applyState({ status: 'needs-pick', reason: lost ? 'missing' : 'first-run' })
  }

  async function refreshTree(): Promise<void> {
    try {
      tree = await window.rgent.treeList()
    } catch {
      tree = []
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
    })
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
      const content = await window.rgent.noteRead(relPath)
      tabs.push({ relPath, content, saved: content, dirty: false })
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
    renderTabs()
    paintTree()
    emptyEl.hidden = true
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
    emptyEl.hidden = tabs.length > 0
  }

  async function closeTab(relPath: string, opts: { save?: boolean } = {}): Promise<void> {
    const tab = tabs.find((item) => item.relPath === relPath)
    if (!tab) return
    if (opts.save !== false && tab.dirty) await writeTab(tab)
    const index = tabs.findIndex((item) => item.relPath === relPath)
    tabs.splice(index, 1)
    if (active === relPath) {
      const next = tabs[index] ?? tabs[index - 1]
      active = next?.relPath ?? null
      editor.setText(next?.content ?? '', noteHost())
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

  async function flushSave(): Promise<void> {
    if (saveTimer != null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    const tab = current()
    if (!tab) return
    tab.content = editor.getText()
    await writeTab(tab)
    renderTabs()
  }

  async function writeTab(tab: Tab): Promise<void> {
    const result = await window.rgent.noteWrite(tab.relPath, tab.content)
    if (result.ok) {
      tab.saved = tab.content
      tab.dirty = false
    }
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
