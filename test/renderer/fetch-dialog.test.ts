// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFetchInsertTemplate, FETCH_INSERT_MAX_BYTES, openFetchDialog, type FetchDialogHandlers } from '../../src/renderer/src/fetch-dialog.ts'
import type { HumanFetchRequest, HumanFetchResult, HumanSearchRequest, HumanSearchResult } from '../../src/shared/ipc.ts'
import type { Overlay } from '../../src/renderer/src/overlay.ts'

/** 人发起抓页／搜索对话框：外部文本按字面显示，插入受门控，错误说人话。 */

const fetchedAt = '2026-10-21T00:00:00.000Z'
const fetchSuccess = (over: Partial<Extract<HumanFetchResult, { ok: true }>> = {}): HumanFetchResult => ({
  ok: true,
  url: 'https://example.com/page',
  host: 'example.com',
  title: '示例标题',
  text: '第一行\n第二行',
  bytes: 42,
  truncated: false,
  fetchedAt,
  ...over
})
const searchSuccess = (over: Partial<Extract<HumanSearchResult, { ok: true }>> = {}): HumanSearchResult => ({
  ok: true,
  provider: 'brave',
  host: 'api.search.brave.com',
  results: [
    { title: '结果一', url: 'https://one.example/a', snippet: '摘要一' },
    { title: '结果二', url: 'https://two.example/b', snippet: '摘要二' }
  ],
  ...over
})

let clipboardWrite: ReturnType<typeof vi.fn>
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute('open', '') }
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) }
  })
  clipboardWrite = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite }
  })
})

const opened: Overlay[] = []
afterEach(() => {
  for (const overlay of opened.splice(0)) overlay.close()
  document.body.replaceChildren()
  delete (window as unknown as { __pwned?: number }).__pwned
})

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

type Overrides = {
  canInsert?: boolean
  insert?: (text: string) => boolean
  humanFetch?: (request: HumanFetchRequest) => Promise<HumanFetchResult>
  humanSearch?: (request: HumanSearchRequest) => Promise<HumanSearchResult>
  humanAbort?: (requestId: string) => Promise<boolean>
}

function open(over: Overrides = {}) {
  const fetches: HumanFetchRequest[] = []
  const searches: HumanSearchRequest[] = []
  const inserted: string[] = []
  const aborts: string[] = []
  const handlers: FetchDialogHandlers = {
    canInsert: () => over.canInsert ?? true,
    insert: text => { inserted.push(text); return over.insert ? over.insert(text) : true },
    humanFetch: request => {
      fetches.push(request)
      return over.humanFetch ? over.humanFetch(request) : Promise.resolve(fetchSuccess())
    },
    humanSearch: request => {
      searches.push(request)
      return over.humanSearch ? over.humanSearch(request) : Promise.resolve(searchSuccess())
    },
    humanAbort: requestId => {
      aborts.push(requestId)
      return over.humanAbort ? over.humanAbort(requestId) : Promise.resolve(true)
    }
  }
  const overlay = openFetchDialog(handlers)
  opened.push(overlay)
  const input = overlay.root.querySelector<HTMLInputElement>('.fetch-dialog-input')!
  const submit = overlay.root.querySelector<HTMLButtonElement>('.fetch-dialog-submit')!
  const status = overlay.root.querySelector<HTMLElement>('.fetch-dialog-status')!
  const searchMode = overlay.root.querySelector<HTMLButtonElement>('.fetch-dialog-mode[data-mode="search"]')!
  return { overlay, input, submit, status, searchMode, fetches, searches, inserted, aborts }
}

describe('fetch dialog', () => {
  it('renders fetched text literally with title, host, bytes, truncation and low trust', async () => {
    const text = '<img src=x onerror="window.__pwned=1">正文'
    const app = open({ humanFetch: async () => fetchSuccess({ text, truncated: true }) })
    app.input.value = 'https://example.com/page'
    app.submit.click()
    await settle()

    expect(app.fetches).toHaveLength(1)
    expect(app.fetches[0]!.url).toBe('https://example.com/page')
    expect(typeof app.fetches[0]!.requestId).toBe('string')
    expect(app.overlay.root.textContent).toContain('低信任')
    const meta = app.overlay.root.querySelector('.fetch-dialog-meta')!
    expect(meta.textContent).toContain('示例标题')
    expect(meta.textContent).toContain('example.com')
    expect(meta.textContent).toContain('42 字节')
    expect(meta.textContent).toContain('已截断')
    const pre = app.overlay.root.querySelector('pre')!
    expect(pre.textContent).toBe(text)
    expect(pre.innerHTML).toContain('&lt;img')
    expect(app.overlay.root.querySelector('img')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('explains a refused fetch in human words instead of showing the code', async () => {
    const app = open({ humanFetch: async () => ({ ok: false, error: 'EGRESS_INVALID_URL' }) })
    app.input.value = 'http://example.com'
    app.submit.click()
    await settle()
    expect(app.status.textContent).toContain('目标网址不合法')
    expect(app.status.textContent).not.toContain('EGRESS_INVALID_URL')
  })

  it('asks for input before sending anything', async () => {
    const app = open()
    app.submit.click()
    await settle()
    expect(app.fetches).toEqual([])
    expect(app.status.textContent).toContain('请先填写要抓取的网址')
  })

  it('switches to search, lists results, and fetches a chosen page in the same overlay', async () => {
    const app = open({
      humanFetch: async request => fetchSuccess({ url: request.url, host: 'one.example', text: '抓到的正文', title: '结果一' })
    })
    app.searchMode.click()
    app.input.value = '小猫 研究'
    app.submit.click()
    await settle()

    expect(app.searches).toHaveLength(1)
    expect(app.searches[0]!.query).toBe('小猫 研究')
    expect(typeof app.searches[0]!.requestId).toBe('string')
    const rows = app.overlay.root.querySelectorAll('.fetch-dialog-result-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('结果一')
    expect(rows[0]!.textContent).toContain('one.example')
    expect(rows[0]!.textContent).toContain('摘要一')

    rows[0]!.querySelector<HTMLButtonElement>('.fetch-dialog-result-fetch')!.click()
    await settle()

    expect(app.fetches).toHaveLength(1)
    expect(app.fetches[0]!.url).toBe('https://one.example/a')
    expect(app.overlay.root.querySelector('.fetch-dialog-fetch')).not.toBeNull()
    expect(app.overlay.root.querySelector('pre')!.textContent).toBe('抓到的正文')
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
  })

  it('says so when search finds nothing or is not configured', async () => {
    const empty = open({ humanSearch: async () => searchSuccess({ results: [] }) })
    empty.searchMode.click()
    empty.input.value = '没有结果'
    empty.submit.click()
    await settle()
    expect(empty.status.textContent).toContain('没有找到结果')

    const missing = open({ humanSearch: async () => ({ ok: false, error: 'SEARCH_NOT_CONFIGURED' }) })
    missing.searchMode.click()
    missing.input.value = '小猫'
    missing.submit.click()
    await settle()
    expect(missing.status.textContent).toContain('还没有配置搜索服务')
    expect(missing.status.textContent).not.toContain('SEARCH_NOT_CONFIGURED')
  })

  it('disables insertion when no writable note is available and keeps copy usable', async () => {
    const app = open({ canInsert: false })
    app.input.value = 'https://example.com/page'
    app.submit.click()
    await settle()
    const insert = app.overlay.root.querySelector<HTMLButtonElement>('.fetch-dialog-insert')!
    expect(insert.disabled).toBe(true)
    expect(app.overlay.root.querySelector<HTMLElement>('.fetch-dialog-hint')!.hidden).toBe(false)
    expect(app.overlay.root.querySelector<HTMLElement>('.fetch-dialog-hint')!.textContent).toContain('只能复制')
  })

  it('inserts a source line plus at most 4 KiB of text and marks the cut', async () => {
    const longText = '字'.repeat(3000)
    const response = fetchSuccess({ text: longText })
    const app = open({ humanFetch: async () => response })
    app.input.value = 'https://example.com/page'
    app.submit.click()
    await settle()

    const insert = app.overlay.root.querySelector<HTMLButtonElement>('.fetch-dialog-insert')!
    expect(insert.disabled).toBe(false)
    insert.click()

    expect(app.inserted).toHaveLength(1)
    const template = app.inserted[0]!
    expect(template).toBe(buildFetchInsertTemplate(response as Extract<HumanFetchResult, { ok: true }>))
    expect(template.startsWith(`> 来源：https://example.com/page（${fetchedAt}，低信任未核对）\n\n`)).toBe(true)
    expect(template.endsWith('\n\n（已截断）')).toBe(true)
    const body = template.slice(template.indexOf('\n\n') + 2, -'\n\n（已截断）'.length)
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(FETCH_INSERT_MAX_BYTES)
    expect(app.status.textContent).toBe('已插入到光标处。')
  })

  it('reports a refused insertion without claiming success', async () => {
    const app = open({ insert: () => false })
    app.input.value = 'https://example.com/page'
    app.submit.click()
    await settle()
    app.overlay.root.querySelector<HTMLButtonElement>('.fetch-dialog-insert')!.click()
    expect(app.status.textContent).toBe('插入没有完成。')
    expect(app.overlay.root.querySelector<HTMLButtonElement>('.fetch-dialog-insert')!.disabled).toBe(true)
  })

  it('copies the same bounded template and reports clipboard failure', async () => {
    const app = open()
    app.input.value = 'https://example.com/page'
    app.submit.click()
    await settle()
    app.overlay.root.querySelector<HTMLButtonElement>('.fetch-dialog-copy')!.click()
    await settle()
    expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining('> 来源：https://example.com/page'))
    expect(app.status.textContent).toBe('已复制到剪贴板。')

    clipboardWrite.mockRejectedValueOnce(new Error('denied'))
    app.overlay.root.querySelector<HTMLButtonElement>('.fetch-dialog-copy')!.click()
    await settle()
    expect(app.status.textContent).toContain('复制失败')
  })

  it('closes on Escape', async () => {
    const app = open()
    await settle()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(app.overlay.isOpen()).toBe(false)
  })

  it('turns the confirm button into stop and reports cancellation', async () => {
    let resolveFetch: (value: HumanFetchResult) => void = () => {}
    const pending = new Promise<HumanFetchResult>(resolve => { resolveFetch = resolve })
    const app = open({ humanFetch: () => pending })
    app.input.value = 'https://example.com/page'
    app.submit.click()
    expect(app.submit.textContent).toBe('停止')
    const requestId = app.fetches[0]!.requestId
    expect(requestId).toBeTruthy()

    app.submit.click()
    expect(app.aborts).toEqual([requestId])
    expect(app.status.textContent).toBe('正在停止…')

    resolveFetch({ ok: false, error: 'EGRESS_ABORTED' })
    await settle()
    expect(app.status.textContent).toBe('已取消')
    expect(app.submit.textContent).toBe('抓取')
    expect(app.submit.disabled).toBe(false)
  })

  it('shows the audit degradation instead of claiming a complete success', async () => {
    const app = open({ humanFetch: async () => fetchSuccess({ degraded: 'log-failed' }) })
    app.input.value = 'https://example.com/page'
    app.submit.click()
    await settle()
    const warning = app.overlay.root.querySelector('.fetch-dialog-degraded')!
    expect(warning.textContent).toContain('已抓取')
    expect(warning.textContent).toContain('外发日志写入失败')
    expect(warning.textContent).toContain('没有完整审计记录')
    expect(app.overlay.root.querySelector('pre')!.textContent).toBe('第一行\n第二行')
  })

  it('labels the copy button as a bounded excerpt rather than the full text', async () => {
    const app = open()
    app.input.value = 'https://example.com/page'
    app.submit.click()
    await settle()
    expect(app.overlay.root.querySelector<HTMLButtonElement>('.fetch-dialog-copy')!.textContent).toBe('复制摘录（约 4 KiB）')
  })
})
