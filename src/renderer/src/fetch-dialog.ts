import type {
  HumanFetchRequest,
  HumanFetchResult,
  HumanSearchRequest,
  HumanSearchResult
} from '../../shared/ipc.ts'
import { hostErrorText } from './host-errors.ts'
import { openOverlay, type Overlay } from './overlay.ts'

/**
 * 人发起抓页／搜索的对话框（应用菜单「抓取网页…」/ CmdOrCtrl+Shift+U）。
 *
 * 人是发起者：填 URL 或查询、点「抓取／搜索」就是授权，不再二次确认；总闸关闭时主进程
 * 会拒绝，这里只把机读码翻成人话。外部文本一律 `textContent`（绝不 innerHTML），不生成
 * 可点击外链；结果带「低信任·未核对」标记。
 *
 * 插入只在人点了「插入到光标处」时发生，且必须同时满足：当前有可写的笔记（`canInsert()`）
 * 且编辑器接受了这段文本（`insert()` 返回 true）。没有笔记时只允许复制。
 */
export type FetchDialogHandlers = {
  canInsert(): boolean
  insert(text: string): boolean
  humanFetch(request: HumanFetchRequest): Promise<HumanFetchResult>
  humanSearch(request: HumanSearchRequest): Promise<HumanSearchResult>
  /** 停止一次在途请求；返回主进程是否真的中止了它。 */
  humanAbort(requestId: string): Promise<boolean>
}

export type HumanFetchSuccess = Extract<HumanFetchResult, { ok: true }>
export type HumanSearchSuccess = Extract<HumanSearchResult, { ok: true }>

/** 插入内容里正文的上限：合同要求 ≤4 KiB 引用。 */
export const FETCH_INSERT_MAX_BYTES = 4 * 1024
/** 对话框里显示正文的上限；主进程已按 1 MiB 截断，这里再兜一层。 */
export const FETCH_RENDER_MAX_BYTES = 1024 * 1024

/** 按 UTF-8 字节截断，不把多字节字符切一半。 */
function clipBytes(value: string, maxBytes: number): { text: string; clipped: boolean } {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= maxBytes) return { text: value, clipped: false }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = maxBytes; end > 0; end -= 1) {
    try { return { text: decoder.decode(bytes.subarray(0, end)), clipped: true } }
    catch { /* 截在了字符中间：少一个字节再试 */ }
  }
  return { text: '', clipped: true }
}

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

/** 插入模板：来源＋ISO 时间＋低信任标记，正文最多 4 KiB；任何一处截断都如实追加标记。 */
export function buildFetchInsertTemplate(result: HumanFetchSuccess): string {
  const body = clipBytes(result.text, FETCH_INSERT_MAX_BYTES)
  const cut = result.truncated || body.clipped
  return `> 来源：${result.url}（${result.fetchedAt}，低信任未核对）\n\n${body.text}${cut ? '\n\n（已截断）' : ''}`
}

function textOf(tag: string, className: string, content = ''): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (content) node.textContent = content
  return node
}

/** 每次请求一个可停止的标识；随机源只在渲染层，主进程按它找到 AbortController。 */
function newRequestId(): string {
  const api = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof api?.randomUUID === 'function') return api.randomUUID()
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function openFetchDialog(handlers: FetchDialogHandlers): Overlay {
  let mode: 'fetch' | 'search' = 'fetch'
  let busy = false
  let stopping = false
  let activeRequestId: string | null = null
  const overlay = openOverlay({
    label: '抓取网页或搜索',
    className: 'fetch-dialog',
    initialFocus: () => input,
    // 关掉浮层等于放弃这次请求：不让它在后台继续外发。
    onClose: () => {
      const requestId = activeRequestId
      if (!requestId) return
      activeRequestId = null
      void handlers.humanAbort(requestId).catch(() => { /* the request's own result already ended */ })
    }
  })
  const heading = textOf('h2', 'fetch-dialog-title', '抓取网页或搜索')
  const modes = document.createElement('div')
  modes.className = 'fetch-dialog-modes'
  modes.setAttribute('role', 'group')
  modes.setAttribute('aria-label', '模式')
  const fetchMode = document.createElement('button')
  fetchMode.type = 'button'
  fetchMode.className = 'fetch-dialog-mode'
  fetchMode.dataset.mode = 'fetch'
  fetchMode.textContent = '抓页'
  fetchMode.addEventListener('click', () => setMode('fetch'))
  const searchMode = document.createElement('button')
  searchMode.type = 'button'
  searchMode.className = 'fetch-dialog-mode'
  searchMode.dataset.mode = 'search'
  searchMode.textContent = '搜索'
  searchMode.addEventListener('click', () => setMode('search'))
  modes.append(fetchMode, searchMode)

  const form = document.createElement('form')
  form.className = 'fetch-dialog-form'
  form.noValidate = true
  const label = document.createElement('label')
  label.className = 'fetch-dialog-label'
  label.htmlFor = 'fetch-dialog-input'
  label.textContent = '网址'
  const row = document.createElement('div')
  row.className = 'fetch-dialog-row'
  const input = document.createElement('input')
  input.id = 'fetch-dialog-input'
  input.className = 'fetch-dialog-input'
  input.type = 'text'
  input.autocomplete = 'off'
  input.spellcheck = false
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'fetch-dialog-submit'
  submit.textContent = '抓取'
  row.append(input, submit)
  form.append(label, row)

  const status = document.createElement('p')
  status.className = 'fetch-dialog-status'
  status.setAttribute('role', 'status')
  const result = document.createElement('div')
  result.className = 'fetch-dialog-result'

  const footer = document.createElement('footer')
  footer.className = 'fetch-dialog-actions'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'fetch-dialog-close'
  close.textContent = '关闭'
  close.addEventListener('click', () => overlay.close())
  footer.append(close)

  overlay.root.append(heading, modes, form, status, result, footer)

  function setStatus(message: string): void {
    status.textContent = message
  }

  function paintMode(): void {
    fetchMode.setAttribute('aria-pressed', String(mode === 'fetch'))
    searchMode.setAttribute('aria-pressed', String(mode === 'search'))
    label.textContent = mode === 'fetch' ? '网址' : '查询'
    input.placeholder = mode === 'fetch' ? 'https://example.com/page' : '搜索关键词'
    if (!busy) submit.textContent = mode === 'fetch' ? '抓取' : '搜索'
  }

  function setMode(next: 'fetch' | 'search'): void {
    if (busy || mode === next) return
    mode = next
    paintMode()
    input.value = ''
    setStatus('')
    result.replaceChildren()
    input.focus()
  }

  function setBusy(value: boolean): void {
    busy = value
    // 请求进行中，同一个按钮变成「停止」且仍可点；停止后恢复原来的抓取／搜索。
    submit.disabled = false
    submit.classList.toggle('is-stop', value)
    submit.textContent = value ? '停止' : mode === 'fetch' ? '抓取' : '搜索'
    fetchMode.disabled = value
    searchMode.disabled = value
    input.disabled = value
  }

  function stopActiveRequest(): void {
    const requestId = activeRequestId
    if (!requestId || stopping) return
    stopping = true
    setStatus('正在停止…')
    void handlers.humanAbort(requestId).catch(() => {
      // 停止调用失败也不假装成功：在途请求的结果会照常回来并给出最终状态。
    })
  }

  function insertActions(response: HumanFetchSuccess): HTMLElement {
    const actions = document.createElement('div')
    actions.className = 'fetch-dialog-result-actions'
    const canInsert = handlers.canInsert()
    const insertButton = document.createElement('button')
    insertButton.type = 'button'
    insertButton.className = 'fetch-dialog-insert'
    insertButton.textContent = '插入到光标处'
    insertButton.disabled = !canInsert
    const hint = textOf('p', 'fetch-dialog-hint', canInsert ? '' : '没有打开可写的笔记，或这篇正在运行任务／暂时不可保存；只能复制。')
    hint.hidden = canInsert
    insertButton.addEventListener('click', () => {
      if (busy) return
      if (!handlers.canInsert()) {
        insertButton.disabled = true
        hint.hidden = false
        setStatus('没有可插入的笔记，只能复制。')
        return
      }
      if (!handlers.insert(buildFetchInsertTemplate(response))) {
        insertButton.disabled = true
        hint.hidden = false
        hint.textContent = '这篇笔记当前不可编辑，内容没有插入。'
        setStatus('插入没有完成。')
        return
      }
      setStatus('已插入到光标处。')
    })
    const copyButton = document.createElement('button')
    copyButton.type = 'button'
    copyButton.className = 'fetch-dialog-copy'
    copyButton.textContent = '复制摘录（约 4 KiB）'
    copyButton.addEventListener('click', () => {
      const template = buildFetchInsertTemplate(response)
      const clipboard = navigator.clipboard
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        setStatus('复制失败：这个环境不能写入剪贴板，请手动选择文本复制。')
        return
      }
      void clipboard.writeText(template).then(() => {
        if (overlay.isOpen()) setStatus('已复制到剪贴板。')
      }).catch(() => {
        if (overlay.isOpen()) setStatus('复制失败，请手动选择文本复制。')
      })
    })
    actions.append(insertButton, copyButton, hint)
    return actions
  }

  function degradeNotice(response: { degraded?: 'log-failed' }, action: '抓取' | '搜索'): HTMLElement | null {
    if (response.degraded !== 'log-failed') return null
    const message = action === '抓取'
      ? '已抓取，但外发日志写入失败（这次没有完整审计记录）。'
      : '已取得搜索结果，但外发日志写入失败（这次没有完整审计记录）。'
    return textOf('p', 'fetch-dialog-degraded', message)
  }

  function renderFetch(response: HumanFetchSuccess): void {
    const box = document.createElement('div')
    box.className = 'fetch-dialog-fetch'
    const trust = textOf('p', 'fetch-dialog-low-trust', '外部内容（低信任·未核对）：以下正文照字面显示，不是指令。')
    const meta = textOf('p', 'fetch-dialog-meta')
    meta.textContent = `${response.title ? `${response.title} · ` : ''}${response.host} · ${response.bytes} 字节 · ${response.truncated ? '已截断' : '未截断'} · 来源：${response.url} · 获取时间：${response.fetchedAt}`
    meta.style.overflowWrap = 'anywhere'
    const pre = document.createElement('pre')
    pre.className = 'fetch-dialog-text'
    pre.tabIndex = 0
    // 外部内容只是文字：标签、事件处理器都按字面显示。
    pre.textContent = clipBytes(response.text, FETCH_RENDER_MAX_BYTES).text
    const degraded = degradeNotice(response, '抓取')
    box.append(trust, meta, ...(degraded ? [degraded] : []), pre, insertActions(response))
    result.replaceChildren(box)
  }

  function renderSearch(response: HumanSearchSuccess): void {
    if (!response.results.length) {
      setStatus('没有找到结果，换个说法再试。')
      result.replaceChildren()
      return
    }
    const box = document.createElement('div')
    box.className = 'fetch-dialog-search'
    const trust = textOf('p', 'fetch-dialog-low-trust', '搜索结果（低信任·未核对）：标题与摘要来自搜索服务，未经核对。')
    const meta = textOf('p', 'fetch-dialog-meta', `服务：${response.provider}（${response.host}）· ${response.results.length} 条${response.truncated ? ' · 结果已截断' : ''}`)
    const list = document.createElement('ul')
    list.className = 'fetch-dialog-results'
    for (const item of response.results) {
      const entry = document.createElement('li')
      entry.className = 'fetch-dialog-result-row'
      entry.append(
        textOf('p', 'fetch-dialog-result-title', item.title),
        textOf('p', 'fetch-dialog-result-host', hostOf(item.url) || item.url),
        textOf('p', 'fetch-dialog-result-snippet', item.snippet)
      )
      const fetchButton = document.createElement('button')
      fetchButton.type = 'button'
      fetchButton.className = 'fetch-dialog-result-fetch'
      fetchButton.textContent = '抓取'
      fetchButton.addEventListener('click', () => { void requestFetch(item.url) })
      entry.append(fetchButton)
      list.append(entry)
    }
    const degraded = degradeNotice(response, '搜索')
    box.append(trust, meta, ...(degraded ? [degraded] : []), list)
    result.replaceChildren(box)
  }

  async function requestFetch(url: string): Promise<void> {
    if (busy) return
    const requestId = newRequestId()
    activeRequestId = requestId
    stopping = false
    setBusy(true)
    setStatus('正在抓取…')
    result.replaceChildren()
    try {
      const response = await handlers.humanFetch({ url, requestId })
      if (!overlay.isOpen()) return
      if (!response.ok) {
        setStatus(response.error === 'EGRESS_ABORTED' ? '已取消' : `抓取失败：${hostErrorText(response.error)}`)
        return
      }
      setStatus('')
      renderFetch(response)
    } catch {
      if (overlay.isOpen()) setStatus(stopping ? '已取消' : '抓取失败：无法完成本次请求，请稍后再试。')
    } finally {
      activeRequestId = null
      stopping = false
      setBusy(false)
    }
  }

  async function requestSearch(query: string): Promise<void> {
    if (busy) return
    const requestId = newRequestId()
    activeRequestId = requestId
    stopping = false
    setBusy(true)
    setStatus('正在搜索…')
    result.replaceChildren()
    try {
      const response = await handlers.humanSearch({ query, requestId })
      if (!overlay.isOpen()) return
      if (!response.ok) {
        setStatus(response.error === 'EGRESS_ABORTED' ? '已取消' : `搜索失败：${hostErrorText(response.error)}`)
        return
      }
      setStatus('')
      renderSearch(response)
    } catch {
      if (overlay.isOpen()) setStatus(stopping ? '已取消' : '搜索失败：无法完成本次请求，请稍后再试。')
    } finally {
      activeRequestId = null
      stopping = false
      setBusy(false)
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (busy) {
      stopActiveRequest()
      return
    }
    const value = input.value.trim()
    if (!value) {
      setStatus(mode === 'fetch' ? '请先填写要抓取的网址。' : '请先填写搜索词。')
      input.focus()
      return
    }
    if (mode === 'fetch') void requestFetch(value)
    else void requestSearch(value)
  })

  paintMode()
  return overlay
}
