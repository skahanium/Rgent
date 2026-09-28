#!/usr/bin/env node
/**
 * 界面验收：真实窗口 + CDP，按围栏 docs/frontend.md §可访问性与验收 逐条走。
 *
 * 在构建后的真实窗口运行，CI 的 macOS、Windows 两腿也会执行：
 *
 *   pnpm ui:check            # 先 pnpm build，再跑这一套
 *
 * 用的是一次性库（写在临时目录），不动你自己的笔记。每条都打印 通过/失败，
 * 最后给总账；有失败就退出码 1。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const results = []
let failures = 0

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}\n`)
}

/** 一条检查自己出错（元素还没出现之类）也只算这条失败，别把整轮打断。 */
async function probe(name, run) {
  try {
    const value = await run()
    if (typeof value === 'object' && value !== null && 'ok' in value) check(name, value.ok, value.detail ?? '')
    else check(name, value === true)
  } catch (error) {
    check(name, false, error instanceof Error ? error.message.slice(0, 80) : String(error))
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(page, expression, timeout = 12000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await page.eval(expression)) return true
    await sleep(250)
  }
  return false
}

function makePage(send, close) {
  let id = 0
  const pending = new Map()
  const errors = []
  send.onMessage = (raw) => {
    const message = JSON.parse(raw)
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description ?? 'unknown')
    }
    const resolve = pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve(message)
    }
  }
  return {
    errors,
    close,
    call: (method, params) =>
      new Promise((resolve) => {
        const mine = ++id
        pending.set(mine, resolve)
        send.send(JSON.stringify({ id: mine, method, params }))
      }),
    async eval(expression) {
      const message = await this.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      const result = message.result
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed')
      }
      return result?.result?.value
    },
    /** text 只给会产生字符的键：不给 text 的按键不会插入任何字符（实测敲不出脏稿）。 */
    async key(key, code, modifiers = 0, vk = 0, text) {
      const common = { key, code, modifiers, windowsVirtualKeyCode: vk }
      await this.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...common, ...(text ? { text } : {}) })
      await this.call('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
      await sleep(260)
    }
  }
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = list.find((entry) => entry.type === 'page')
  if (!target) throw new Error('没有找到窗口页面')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  const send = {
    onMessage: null,
    send: (payload) => socket.send(payload)
  }
  socket.onmessage = (event) => send.onMessage?.(event.data)
  const page = makePage(send, () => socket.close())
  await page.call('Runtime.enable', {})
  return page
}

const note = ['# 研究记录', '', '第一段正文，用来数字数。', '', '### **设计动机**', '', '普通 *斜体* 与 ~~删除~~。', '', '- 第一项', '- 第二项', '', '```ts', 'const n = 1', '```'].join('\n')
const initialWithLedger = `${note}\n<!-- rgent:ledger:v1 -->\n## 第一场\n\n**账本结论**\n`
const longNote = (() => {
  const lines = ['# 一级标题', '']
  for (let section = 1; section <= 4; section += 1) {
    lines.push(`## 章节${section}`, '')
    for (let para = 0; para < 10; para += 1) lines.push(`章节${section}的第 ${para} 段正文。`, '')
  }
  return lines.join('\n')
})()

const visualOnly = process.env.RGENT_UI_VISUAL_ONLY === '1'

function seedVisualVault(vault) {
  const liveImage = process.env.RGENT_UI_LIVE_IMAGE_URL || 'https://media.example.invalid/file?id=sample%2Fone'
  const research = path.join(vault, '研究记录')
  const assets = path.join(vault, '素材')
  mkdirSync(research)
  mkdirSync(assets)
  writeFileSync(path.join(research, '自然生长.md'), [
    '# 自然生长', '',
    '想让一款笔记软件真正陪伴思考，它要允许未完成的念头停留在正文里。文字是主角，工具只在需要时出现。', '',
    '今天先记下一个问题：打开一篇笔记之后，怎样继续写，同时迅速回到它所依赖的上下文？',
    '<!-- rgent:prompt:v1 -->',
    '把“自然生长”拆成两个可观察的行为，',
    '并结合这篇笔记给我一个例子。',
    '<!-- rgent:ai:v1 -->',
    '可以观察两件事：离开笔记后再回来，能否直接从上次的位置继续写；打开一处引用时，能否顺着它找到当时的讨论，而不丢失当前落点。', '',
    '## 继续写作', '',
    '### 回到落点', '',
    '记录应留在文章里，让后来阅读的人看见问题如何演进。', '',
    '## 阅读线索', '', '从这篇笔记回到问题发生的地方。', '',
    '### 当前片段', '', '保留尚未写完的想法。', '',
    '## 写作节奏', '', '让工具退到文字之后。', '',
    '### 离开与返回', '', '回到此前的光标。', '',
    '## 引用关系', '', '沿着引用找到相关笔记。', '',
    '### 重新核对', '', '确认当时的正文。', '',
    '## 下一步', '', '继续观察自己的工作方式。', '',
    '<!-- rgent:ledger:v1 -->',
    '## 第一场', '', '这是一份只读账本。', ''
  ].join('\n'))
  writeFileSync(path.join(research, '知识的落点.md'), '# 知识的落点\n\n接着阅读 [[研究记录/自然生长]]。\n')
  writeFileSync(path.join(research, '设计片段.md'), '# 设计片段\n\n在 [[研究记录/自然生长]] 中讨论编辑器观察。\n')
  const longParagraph = '今天重新核对 GLM-5.2、Code Arena 与 Agent 工作流的说明：Chinese prose 和 English terms 应在同一行保持均衡间距；写作时仍须能看见原始 Markdown、选择文字、撤销，并在保存后保留全部原文字节。'
  writeFileSync(path.join(research, '长文排版.md'), [
    '# 长文排版验收', '', longParagraph.repeat(2), '',
    `![带查询参数的外链图](${liveImage})图片同一行紧接的正文仍应在图片下方独立显示。`, '',
    '句内图 ![行内图](http://media.example.invalid/icon?version=2) 不应形成大卡片。', '',
    '![加载失败的图片](https://media.example.invalid/missing.png)## 紧接图片的标题', '',
    '![独占行图片](https://media.example.invalid/solo.png)',
    '图片下一行的正文也应独立显示。', '',
    ...Array.from({ length: 8 }, (_, index) => [`## 第 ${index + 1} 节 · 阅读与编辑`, '', longParagraph.repeat(3), '', '### 小节与页边索引', '', longParagraph.repeat(2), '']).flat()
  ].join('\n'))
  writeFileSync(path.join(assets, '研究资料.pdf'), '')
  writeFileSync(path.join(assets, '参考图片.png'), '')
  writeFileSync(path.join(assets, '说明.txt'), '')
}

async function captureVisualBaseline(page, shot, nativeShot) {
  process.stdout.write('\n同内容视觉样例\n')
  // CI 虚拟屏幕会把真实窗口夹到 1024px 左右；比较 1200×800 稿前先固定页面度量。
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  check('视觉对照使用 1200×800 页面度量', await page.eval(`innerWidth === 1200 && innerHeight === 800`) === true)
  const ready = await waitFor(page, `document.querySelectorAll('.tree-dir').length >= 2`)
  check('固定演示库含文件夹和多种文件类型', ready)
  if (!ready) return
  await page.eval(`(() => {
    document.querySelector('.tree-toggle')?.click()
    for (const row of document.querySelectorAll('.tree-dir')) {
      if (row.innerText.includes('研究记录') && row.getAttribute('aria-expanded') === 'false') row.click()
      if (row.innerText.includes('素材') && row.getAttribute('aria-expanded') === 'false') row.click()
    }
  })()`)
  const rows = await waitFor(page, `document.querySelectorAll('.tree-note').length >= 3`)
  check('演示库能显示三篇笔记及附件类型', rows && (await page.eval(`document.querySelectorAll('.tree-file').length >= 3`)) === true)
  const opened = await page.eval(`(async () => {
    for (const title of ['自然生长', '知识的落点', '设计片段']) {
      const row = [...document.querySelectorAll('.tree-note')].find((item) => item.innerText.includes(title))
      row?.click()
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    [...document.querySelectorAll('.tab')].find((item) => item.innerText.includes('自然生长'))?.click()
    return document.querySelectorAll('.tab').length
  })()`)
  check('视觉样例打开三个 tab', opened === 3)
  check('视觉样例包含 AI、反链与三级标题', await waitFor(page, `document.querySelectorAll('.rgent-block-command').length > 0 && document.querySelectorAll('.outline-mark').length >= 3 && document.querySelectorAll('.backlinks-note').length >= 2`))
  await page.eval(`(() => { document.activeElement?.blur(); document.querySelector('.cm-scroller').scrollTop = 0 })()`)
  await waitFor(page, `document.querySelector('.cm-scroller').scrollTop === 0 && document.querySelector('.cm-line.md-h1')?.getBoundingClientRect().top - document.querySelector('.stage').getBoundingClientRect().top >= 85`)
  await probe('宽窗画布留白接近参考图', async () => {
    const gaps = JSON.parse(await page.eval(`(() => {
      const stage = document.querySelector('.stage').getBoundingClientRect()
      const heading = document.querySelector('.cm-line.md-h1').getBoundingClientRect()
      const content = document.querySelector('.cm-content').getBoundingClientRect()
      return JSON.stringify({ top: Math.round(heading.top - stage.top), left: Math.round(heading.left - stage.left), contentWidth: Math.round(content.width), contentLeft: Math.round(content.left - stage.left) })
    })()`))
    return { ok: gaps.top >= 85 && gaps.top <= 120 && gaps.left >= 70 && gaps.left <= 100, detail: JSON.stringify(gaps) }
  })
  await probe('正文标题的字号与字重接近参考图', async () => {
    const state = JSON.parse(await page.eval(`(() => {
      const style = getComputedStyle(document.querySelector('.cm-line.md-h1'))
      return JSON.stringify({ size: parseFloat(style.fontSize), weight: Number(style.fontWeight) })
    })()`))
    return { ok: state.size >= 30 && state.size <= 34 && state.weight <= 500, detail: JSON.stringify(state) }
  })
  await probe('页边索引在画布右缘纵向居中且保持紧凑', async () => {
    const geometry = JSON.parse(await page.eval(`(() => {
      const stage = document.querySelector('.stage').getBoundingClientRect()
      const outline = document.querySelector('.outline').getBoundingClientRect()
      return JSON.stringify({ centerDelta: Math.round((outline.top + outline.bottom - stage.top - stage.bottom) / 2), marks: document.querySelectorAll('.outline-mark').length, height: Math.round(outline.height) })
    })()`))
    return { ok: Math.abs(geometry.centerDelta) <= 24 && geometry.marks >= 9 && geometry.height <= 180, detail: JSON.stringify(geometry) }
  })
  await probe('宽窗普通段落适度拓宽并两端对齐', async () => {
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
    const state = JSON.parse(await page.eval(`(() => {
      const content = document.querySelector('.cm-content').getBoundingClientRect()
      const stage = document.querySelector('.stage').getBoundingClientRect()
      const paragraph = document.querySelector('.cm-line.md-prose')
      return JSON.stringify({ contentWidth: Math.round(content.width), sideGap: Math.round(content.left - stage.left), align: paragraph && getComputedStyle(paragraph).textAlign })
    })()`))
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
    return { ok: state.contentWidth >= 730 && state.contentWidth <= 800 && state.sideGap >= 32 && state.align === 'justify', detail: JSON.stringify(state) }
  })
  await probe('导航和反链的密度接近参考图', async () => {
    const state = JSON.parse(await page.eval(`(() => {
      const tree = document.querySelector('.tree-panel')
      const selected = document.querySelector('.tree-note[aria-current="page"]')
      const tab = document.querySelector('.tab[aria-selected="true"]')
      const back = document.querySelector('.backlinks-note')
      return JSON.stringify({ sidebar: Math.round(tree.getBoundingClientRect().width), treeWeight: Number(getComputedStyle(selected).fontWeight), tabWeight: Number(getComputedStyle(tab).fontWeight), backlinkSize: parseFloat(getComputedStyle(back).fontSize) })
    })()`))
    return { ok: state.sidebar >= 220 && state.sidebar <= 228 && state.treeWeight <= 500 && state.tabWeight <= 500 && state.backlinkSize <= 14, detail: JSON.stringify(state) }
  })

  for (const mode of ['day', 'night']) {
    await page.eval(`window.rgent.themeSet('${mode}')`)
    await waitFor(page, `document.documentElement.dataset.theme === '${mode}'`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
    await sleep(250)
    await shot(page, `reference-${mode}-workspace`)
    nativeShot(mode)
    await page.eval(`document.querySelector('.settings-open')?.click()`)
    await waitFor(page, `!!document.querySelector('.overlay-settings[open]')`)
    if (mode === 'day') await probe('设置浮层的标题和比例接近参考图', async () => {
      const geometry = JSON.parse(await page.eval(`(() => {
        const panel = document.querySelector('.overlay-settings').getBoundingClientRect()
        const title = document.querySelector('.settings-page-title').getBoundingClientRect()
        return JSON.stringify({ top: Math.round(panel.top), width: Math.round(panel.width), height: Math.round(panel.height), titleTop: Math.round(title.top - panel.top), titleLeft: Math.round(title.left - panel.left) })
      })()`))
      return { ok: geometry.top >= 75 && geometry.top <= 130 && geometry.width >= 690 && geometry.width <= 730 && geometry.height >= 535 && geometry.titleTop <= 58 && geometry.titleLeft >= 230, detail: JSON.stringify(geometry) }
    })
    await shot(page, `reference-${mode}-settings`)
    await page.eval(`document.querySelector('.settings-close')?.click()`)
    await waitFor(page, `!document.querySelector('.overlay-settings')`)
    await page.eval(`document.querySelector('.tree-tools button')?.click()`)
    await waitFor(page, `!!document.querySelector('.overlay-search[open]')`)
    await shot(page, `reference-${mode}-search`)
    await page.eval(`document.querySelector('.overlay-search-input').value = '自然生长'; document.querySelector('.overlay-search-input').dispatchEvent(new Event('input', { bubbles: true }))`)
    await waitFor(page, `document.querySelectorAll('.search-hit').length > 0`)
    await page.key('ArrowDown', 'ArrowDown', 0, 40)
    if (mode === 'day') await probe('搜索结果浮层位置接近参考图', async () => {
      const top = Math.round(await page.eval(`document.querySelector('.overlay-search').getBoundingClientRect().top`))
      return { ok: top >= 105 && top <= 150, detail: `顶部 ${top}px` }
    })
    await shot(page, `reference-${mode}-search-results`)
    await page.eval(`document.querySelector('.overlay-search')?.close()`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 800, height: 560, deviceScaleFactor: 1, mobile: false })
    await sleep(250)
    await shot(page, `reference-${mode}-narrow`)
    await page.call('Emulation.clearDeviceMetricsOverride', {})
  }
  await page.eval(`([...document.querySelectorAll('.tree-note')].find((item) => item.innerText.includes('长文排版')))?.click()`)
  check('长文样例含中英混排与外链图片', await waitFor(page, `document.querySelector('.cm-line.md-prose') && document.querySelectorAll('.md-image-slot').length >= 3`))
  await probe('行首图片与同一行后文分块，标题仍被识别', async () => {
    const state = JSON.parse(await page.eval(`(() => {
      const blocks = [...document.querySelectorAll('.md-image-block')]
      const heading = [...document.querySelectorAll('.cm-line')].find((node) => node.textContent.includes('紧接图片的标题'))
      const prose = [...document.querySelectorAll('.cm-line')].find((node) => node.textContent.includes('图片同一行紧接'))
      return JSON.stringify({ blocks: blocks.length, heading: !!heading, headingSize: heading && parseFloat(getComputedStyle(heading).fontSize), rawHeading: heading?.textContent.includes('##'), proseAlign: prose && getComputedStyle(prose).textAlign, separated: !!(blocks[0] && prose && prose.getBoundingClientRect().top >= blocks[0].getBoundingClientRect().bottom) })
    })()`))
    return { ok: state.blocks >= 3 && state.headingSize >= 21 && !state.rawHeading && state.proseAlign === 'justify' && state.separated, detail: JSON.stringify(state) }
  })
  if (process.env.RGENT_UI_LIVE_IMAGE_URL) {
    check('公开 HTTPS 图片在真实窗口解码显示', await waitFor(page, `[...document.querySelectorAll('.md-image-slot img')].some((image) => image.complete && image.naturalWidth > 0)`, 22000))
    await probe('独立图片按自身尺寸铺开且不超过正文画布', async () => {
      const state = JSON.parse(await page.eval(`(() => {
        const image = [...document.querySelectorAll('.md-image-block img')].find((node) => node.complete && node.naturalWidth > 0)
        const width = image?.getBoundingClientRect().width || 0
        const canvas = document.querySelector('.cm-content').getBoundingClientRect().width
        return JSON.stringify({ naturalWidth: image?.naturalWidth || 0, width: Math.round(width), canvas: Math.round(canvas) })
      })()`))
      return { ok: state.naturalWidth > 0 && state.width >= Math.min(state.naturalWidth, state.canvas) * 0.9 && state.width <= state.canvas + 1, detail: JSON.stringify(state) }
    })
  }
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await page.eval(`document.querySelector('.cm-scroller').scrollTop = 0`)
  await probe('长文与图片状态不露出长 URL', async () => {
    const state = JSON.parse(await page.eval(`(() => {
      const content = document.querySelector('.cm-content').getBoundingClientRect()
      const prose = document.querySelector('.cm-line.md-prose')
      const http = [...document.querySelectorAll('.md-image-slot')].find((node) => node.textContent.includes('HTTP'))
      return JSON.stringify({ width: Math.round(content.width), align: prose && getComputedStyle(prose).textAlign, slots: document.querySelectorAll('.md-image-slot').length, httpButton: !!http?.querySelector('button'), inlineHeight: Math.round(http?.getBoundingClientRect().height || 0), rawUrlVisible: document.querySelector('.cm-content').innerText.includes('media.example.invalid') })
    })()`))
    return { ok: state.width >= 730 && state.width <= 800 && state.align === 'justify' && state.slots >= 3 && state.httpButton && state.inlineHeight <= 25 && !state.rawUrlVisible, detail: JSON.stringify(state) }
  })
  for (const mode of ['day', 'night']) {
    await page.eval(`window.rgent.themeSet('${mode}')`)
    await waitFor(page, `document.documentElement.dataset.theme === '${mode}'`)
    await shot(page, `reference-${mode}-longform`)
    await page.eval(`document.querySelectorAll('.outline-mark')[1]?.focus()`)
    await shot(page, `reference-${mode}-outline-focus`)
    await page.eval(`document.querySelectorAll('.outline-mark')[1]?.blur()`)
  }
  await page.call('Emulation.clearDeviceMetricsOverride', {})
  check('同内容日夜截图无运行时异常', page.errors.length === 0, page.errors.slice(0, 1).join(''))
}

async function main() {
  const port = await availablePort()
  const electron = require('electron')
  const workdir = mkdtempSync(path.join(tmpdir(), 'rgent-ui-'))
  const profile = path.join(workdir, 'profile')
  const vault = path.join(workdir, visualOnly ? '本地笔记库' : 'vault')
  mkdirSync(profile)
  mkdirSync(vault)
  writeFileSync(path.join(profile, 'vault.json'), JSON.stringify({ path: vault }))
  writeFileSync(path.join(profile, 'theme.json'), JSON.stringify({ mode: 'night' }))
  if (visualOnly) seedVisualVault(vault)
  else {
    writeFileSync(path.join(vault, '研究记录.md'), initialWithLedger)
    writeFileSync(path.join(vault, '过程稿.md'), longNote)
    writeFileSync(path.join(vault, '一个特别特别长的笔记文件名用来验证省略号.md'), '短文。\n')
    mkdirSync(path.join(vault, '资料'))
  }

  const modifier = process.platform === 'darwin' ? 4 : 2
  const shotDir = process.env.RGENT_UI_SCREENSHOTS
  if (shotDir) mkdirSync(shotDir, { recursive: true })
  const shot = async (page, name) => {
    if (!shotDir) return
    const response = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const data = response.result?.data
    if (data) writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(data, 'base64'))
  }
  const nativeShot = (mode) => {
    if (process.platform !== 'win32' || !shotDir) return
    const destination = path.join(shotDir, `native-windows-${mode}.png`)
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bitmap.Save($env:RGENT_NATIVE_SCREENSHOT, [System.Drawing.Imaging.ImageFormat]::Png)
      } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
      }
    `
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, RGENT_NATIVE_SCREENSHOT: destination }
    })
    check(`Windows ${mode} 原生桌面截图包含系统窗控件`, result.status === 0 && existsSync(destination), result.stderr?.trim().slice(0, 160) ?? '')
  }
  let startupError = ''
  let stderr = ''
  let hostServer = null
  const child = spawn(
    electron,
    ['.', `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`],
    { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['ignore', 'ignore', 'pipe'] }
  )
  child.on('error', (error) => { startupError = error.message })
  child.stderr?.on('data', (data) => { stderr = `${stderr}${String(data)}`.slice(-12000) })

  try {
    let ready = false
    for (let i = 0; i < 60; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (!response.ok) throw new Error(`CDP HTTP ${response.status}`)
        ready = true
        break
      } catch {
        if (startupError || child.exitCode != null) break
        await sleep(500)
      }
    }
    if (!ready) throw new Error(`Electron/CDP 未启动：${startupError || `exit=${child.exitCode ?? '仍在运行'}`}\n${stderr || '子进程没有错误输出'}`)
    const page = await connect(port)

    if (visualOnly) {
      await captureVisualBaseline(page, shot, nativeShot)
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode = failures === 0 ? 0 : 1
      return
    }

    process.stdout.write('\n外壳与主题\n')
    await waitFor(page, `document.querySelectorAll('.tree-row').length > 0`)
    check('本机主题偏好在窗口首帧生效', (await page.eval(`document.documentElement.dataset.theme === 'night' && getComputedStyle(document.documentElement).colorScheme === 'dark' && window.rgent.themeGet().then((mode) => mode === 'night')`)) === true)
    check('窗口起来了，库里三篇都在', (await page.eval(`document.querySelectorAll('.tree-note').length`)) === 3)
    await page.eval(`document.querySelectorAll('.tree-note')[1].click()`)
    await waitFor(page, `document.querySelectorAll('.tab').length > 0`)
    check('顶栏是 tab 条，没有品牌文字', (await page.eval(`!!document.querySelector('.top .tabs') && !document.querySelector('.brand')`)) === true)
    check('tab 有图标与标题', (await page.eval(`!!document.querySelector('.tab .icon') && document.querySelector('.tab').innerText.trim().length > 0`)) === true)
    await probe('tab 与系统窗口控制区处于同一视觉中线', async () => {
      const state = JSON.parse(await page.eval(`(() => {
        const top = document.querySelector('.top').getBoundingClientRect()
        const tab = document.querySelector('.tab-wrap').getBoundingClientRect()
        const toggle = document.querySelector('.tree-toggle').getBoundingClientRect()
        const center = (r) => (r.top + r.bottom) / 2
        return JSON.stringify({ offset: center(tab) - center(top), toggleOffset: center(toggle) - center(top), height: top.height })
      })()`))
      return { ok: Math.abs(state.offset) <= 1.5 && Math.abs(state.toggleOffset - state.offset) <= 1.5 && state.height <= 54, detail: JSON.stringify(state) }
    })
    check('底栏有行列、字数与库名', (await page.eval(`!!document.querySelector('.status-left')?.innerText && !!document.querySelector('.status-vault')?.innerText`)) === true)
    await probe('侧栏底部设置入口在收起与展开时均可用', async () => {
      const state = JSON.parse(await page.eval(`(() => {
        const button = document.querySelector('.settings-open')
        if (!button) return JSON.stringify({ exists: false })
        const collapsed = button.getBoundingClientRect()
        document.querySelector('.tree-toggle').click()
        const expanded = button.getBoundingClientRect()
        const panel = document.querySelector('.tree-panel').getBoundingClientRect()
        const scroll = document.querySelector('.tree-scroll').getBoundingClientRect()
        document.querySelector('.tree-toggle').click()
        return JSON.stringify({ exists: true, collapsedVisible: collapsed.width > 0 && collapsed.height > 0, expandedVisible: expanded.width > collapsed.width, atBottom: expanded.bottom >= panel.bottom - 14, afterScroll: expanded.top >= scroll.bottom - 2, backToCollapsed: button.getBoundingClientRect().width > 0 })
      })()`))
      return { ok: Object.values(state).every(Boolean), detail: JSON.stringify(state) }
    })
    await probe('设置浮层只提供三档主题并能保存切换', async () => {
      const state = JSON.parse(await page.eval(`(async () => {
        document.querySelector('.settings-open')?.click()
        await new Promise((resolve) => setTimeout(resolve, 120))
        const dialog = document.querySelector('.overlay-settings')
        const modes = [...document.querySelectorAll('.settings-choice input')].map((input) => input.value)
        document.querySelector('.settings-choice input[value="night"]')?.click()
        await new Promise((resolve) => setTimeout(resolve, 160))
        const night = { mode: await window.rgent.themeGet(), rendered: document.documentElement.dataset.theme }
        document.querySelector('.settings-choice input[value="day"]')?.click()
        await new Promise((resolve) => setTimeout(resolve, 160))
        const day = { mode: await window.rgent.themeGet(), rendered: document.documentElement.dataset.theme }
        document.querySelector('.settings-choice input[value="system"]')?.click()
        await new Promise((resolve) => setTimeout(resolve, 160))
        const system = await window.rgent.themeGet()
        dialog?.querySelector('.settings-close')?.click()
        return JSON.stringify({ modes, night, day, system })
      })()`))
      const closed = await waitFor(page, `!document.querySelector('.overlay-settings')`)
      return { ok: state.modes.join(',') === 'day,night,system' && state.night.mode === 'night' && state.night.rendered === 'night' && state.day.mode === 'day' && state.day.rendered === 'day' && state.system === 'system' && closed, detail: JSON.stringify({ ...state, closed }) }
    })
    if (shotDir) {
      await page.eval(`window.rgent.themeSet('day')`)
      await page.eval(`document.querySelector('.settings-open').click()`)
      await waitFor(page, `!!document.querySelector('.overlay-settings[open]')`)
      await shot(page, 'day-settings')
      await page.call('Emulation.setDeviceMetricsOverride', { width: 800, height: 560, deviceScaleFactor: 1, mobile: false })
      const fits = await page.eval(`(() => { const r = document.querySelector('.overlay-settings').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })()`)
      check('800×560：设置面板完整留在窗口内', fits === true)
      await shot(page, 'day-settings-narrow')
      await page.call('Emulation.clearDeviceMetricsOverride', {})
      await page.eval(`document.querySelector('.settings-close').click()`)
      await waitFor(page, `!document.querySelector('.overlay-settings')`)
      await page.eval(`window.rgent.themeSet('night')`)
      await page.eval(`document.querySelector('.settings-open').click()`)
      await waitFor(page, `!!document.querySelector('.overlay-settings[open]')`)
      await shot(page, 'night-settings')
      await page.eval(`document.querySelector('.settings-close').click()`)
      await waitFor(page, `!document.querySelector('.overlay-settings')`)
      await page.eval(`window.rgent.themeSet('system')`)
    }
    await page.eval(`document.querySelector('.tree-toggle').click()`)
    await probe('账本入口固定在画布右上角且不增加 tab', async () => {
      const state = JSON.parse(await page.eval(`(() => {
        const button = document.querySelector('.ledger-open')
        const stage = document.querySelector('.stage').getBoundingClientRect()
        const tabCount = document.querySelectorAll('.tab').length
        if (!button) return JSON.stringify({ exists: false })
        const rect = button.getBoundingClientRect()
        button.click()
        const opened = !document.querySelector('.ledger-view')?.hidden
        document.querySelector('.ledger-close')?.click()
        return JSON.stringify({ exists: true, inStage: button.closest('.stage') !== null, top: rect.top - stage.top, right: stage.right - rect.right, opened, sameTabs: document.querySelectorAll('.tab').length === tabCount })
      })()`))
      return { ok: state.exists && state.inStage && state.top >= 0 && state.top <= 28 && state.right >= 0 && state.right <= 28 && state.opened && state.sameTabs, detail: JSON.stringify(state) }
    })
    await probe('阅读态标题不露 Markdown 定界符', async () =>
      (await page.eval(`(() => {
        const line = [...document.querySelectorAll('.cm-line')].find((n) => n.innerText.includes('设计动机'))
        return !!line && line.innerText.trim() === '设计动机' && getComputedStyle(line).fontFamily.includes('sans-serif')
      })()`)) === true
    )
    await probe('账本复用阅读呈现且正文不含账本', async () => {
      const before = readFileSync(path.join(vault, '研究记录.md'), 'utf8')
      await page.eval(`document.querySelector('.ledger-open')?.click()`)
      const state = JSON.parse(await page.eval(`(() => JSON.stringify({ heading: document.querySelector('.ledger-body h2')?.textContent, strong: document.querySelector('.ledger-body strong')?.textContent, editor: document.querySelector('.cm-content')?.innerText, outline: [...document.querySelectorAll('.outline-mark')].map((n) => n.title), editable: !!document.querySelector('.ledger-body [contenteditable]') }))()`))
      await page.eval(`document.querySelector('.ledger-close')?.click()`)
      return { ok: state.heading === '第一场' && state.strong === '账本结论' && !state.editor?.includes('账本结论') && !state.outline.includes('第一场') && !state.editable && readFileSync(path.join(vault, '研究记录.md'), 'utf8') === before, detail: JSON.stringify({ heading: state.heading, strong: state.strong, outline: state.outline }) }
    })

    await page.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await sleep(300)
    const dayTokens = await page.eval(`getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim()`)
    await page.eval(`(() => { document.querySelector('.ledger-open')?.blur(); document.querySelector('.tree-toggle')?.blur() })()`)
    check('账本关闭后入口不保持选中态', (await page.eval(`document.querySelector('.ledger-open')?.getAttribute('aria-pressed') === 'false'`)) === true)
    await shot(page, 'day-workspace')
    await page.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await sleep(400)
    const nightTokens = await page.eval(`getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim()`)
    await shot(page, 'night-workspace')
    check('主题跟随系统：夜间换了一套 token', dayTokens !== nightTokens, `${dayTokens} → ${nightTokens}`)
    check('CM6 也跟着换（画布文字色走 token）', (await page.eval(`getComputedStyle(document.querySelector('.cm-content')).color !== 'rgb(28, 31, 35)'`)) === true)
    // 窗口尺寸要分两件事看：
    // （1）实际窗口不小于验收下限——CI runner 的虚拟显示器只有 1024×768 上下，
    //     系统会把窗口夹小（实测 macOS 1024×677 / Windows 1024×720）。那是环境事实，
    //     不是产品缺陷，所以这里只卡下限。
    // （2）1200×800 的**布局**必须成立——用设备度量模拟去验，不依赖 runner 的屏幕。
    const size = JSON.parse(await page.eval(`JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`))
    check('窗口不小于验收下限 800×560', size.w >= 800 && size.h >= 560, `实际内容区 ${size.w}×${size.h}`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    await probe('1200×800 布局成立（反链、正文、索引、单层顶栏）', async () => {
      const state = JSON.parse(await page.eval(`(() => {
        const back = document.querySelector('.backlinks').getBoundingClientRect()
        const editor = document.querySelector('.editor-host').getBoundingClientRect()
        const top = document.querySelector('.top').getBoundingClientRect()
        return JSON.stringify({
          backlinks: Math.round(back.width),
          editor: Math.round(editor.width),
          top: Math.round(top.height),
          outline: document.querySelectorAll('.outline-mark').length
        })
      })()`))
      return {
        ok: state.backlinks > 120 && state.editor >= 300 && state.top < 90 && state.outline > 0,
        detail: JSON.stringify(state)
      }
    })
    await page.call('Emulation.clearDeviceMetricsOverride', {})
    await sleep(200)
    // 注意：setEmulatedMedia 会整体替换特性列表，所以这条要放在配色模拟之后，
    // 否则会把上面的夜间模拟冲掉（第一版就这么写错了）。
    await page.call('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: 'dark' },
        { name: 'prefers-reduced-motion', value: 'reduce' }
      ]
    })
    await sleep(300)
    const motion = await page.eval(`getComputedStyle(document.querySelector('.tab-wrap')).transitionDuration`)
    check('减少动态效果：过渡归零', motion === '0s', motion)
    check('减少动态效果不影响主题', (await page.eval(`document.documentElement.dataset.theme`)) === 'night')

    process.stdout.write('\n窄窗与长内容\n')
    await page.call('Emulation.setDeviceMetricsOverride', { width: 800, height: 560, deviceScaleFactor: 1, mobile: false })
    await sleep(500)
    const narrow = await page.eval(`(() => {
      const back = document.querySelector('.backlinks').getBoundingClientRect()
      const editor = document.querySelector('.editor-host').getBoundingClientRect()
      return JSON.stringify({ 反链宽: Math.round(back.width), 反链可见: back.width > 0 && back.right <= window.innerWidth + 1, 正文宽: Math.round(editor.width) })
    })()`)
    const narrowState = JSON.parse(narrow)
    check('800×560：右反链与正文都没消失', narrowState.反链可见 && narrowState.正文宽 > 120, narrow)
    const ledgerClear = await page.eval(`(() => { const button = document.querySelector('.ledger-open').getBoundingClientRect(); const line = document.querySelector('.cm-line').getBoundingClientRect(); return line.top >= button.bottom + 6 })()`)
    check('800×560：账本入口不压住首行正文', ledgerClear === true)
    await shot(page, 'night-narrow')
    check('长文件名有省略号', (await page.eval(`(() => { const el = [...document.querySelectorAll('.tree-note .tree-label')].find((n) => n.textContent.includes('特别特别长')); return !el || el.scrollWidth > el.clientWidth ? getComputedStyle(el).textOverflow === 'ellipsis' : true })()`)) === true)
    await probe('文件夹收起仍显示文件夹图标，聚焦时原位变为折叠控件', async () =>
      (await page.eval(`(() => {
        const row = document.querySelector('.tree-dir'); if (!row) return false
        row.click()
        const folder = row.querySelector('.icon-folder'), toggle = row.querySelector('.icon-folder-open')
        const normal = getComputedStyle(folder).display !== 'none' && getComputedStyle(toggle).display === 'none'
        row.focus()
        const focused = getComputedStyle(folder).display === 'none' && getComputedStyle(toggle).display !== 'none'
        return normal && focused && row.getAttribute('aria-expanded') === 'false'
      })()`)) === true
    )
    await page.call('Emulation.clearDeviceMetricsOverride', {})
    await page.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await sleep(300)

    process.stdout.write('\n键盘可达\n')
    await page.eval(`document.querySelector('.tree-note').focus()`)
    check('搜索浮层：快捷键打开且焦点在输入框', await (async () => {
      await page.key('k', 'KeyK', modifier, 75)
      const state = await page.eval(`JSON.stringify({ 浮层: document.querySelectorAll('dialog.overlay[open]').length, 焦点: document.activeElement?.className })`)
      return state.includes('"浮层":1') && state.includes('overlay-search-input')
    })())
    await probe('搜索是有遮罩、可见输入与结果区域的居中浮层', async () => {
      const state = JSON.parse(await page.eval(`(() => {
        const modal = document.querySelector('dialog.overlay-search')
        const input = modal?.querySelector('.overlay-search-input')
        const results = modal?.querySelector('.overlay-search-results')
        const r = modal?.getBoundingClientRect()
        return JSON.stringify({ display: modal && getComputedStyle(modal).display, bg: modal && getComputedStyle(modal).backgroundColor, width: r?.width, x: r?.x, y: r?.y, inputHeight: input?.getBoundingClientRect().height, results: !!results })
      })()`))
      return { ok: state.display !== 'none' && state.width > 300 && state.width < 700 && state.x > 0 && state.y > 0 && state.inputHeight >= 40 && state.results && state.bg !== 'rgba(0, 0, 0, 0)', detail: JSON.stringify(state) }
    })
    await shot(page, 'search-overlay')
    await page.eval(`(() => { const input = document.querySelector('.overlay-search-input'); input.value = '设计动机'; input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await probe('搜索浮层显示实际结果而非空壳', async () => {
      const found = await waitFor(page, `document.querySelectorAll('.overlay-search-results .search-hit').length > 0`)
      await shot(page, 'search-results')
      return found && (await page.eval(`[...document.querySelectorAll('.overlay-search-results .search-hit')].some((n) => n.innerText.includes('研究记录'))`)) === true
    })
    check('搜索浮层：Esc 关闭并把焦点还给触发点', await (async () => {
      await page.key('Escape', 'Escape', 0, 27)
      return (await page.eval(`document.querySelectorAll('dialog.overlay[open]').length === 0 && document.activeElement?.classList.contains('tree-note')`)) === true
    })())
    // 索引在长文上验：先打开长的那篇，再点开其余几篇看多 tab。
    const opened = await page.eval(`(async () => {
      const notes = [...document.querySelectorAll('.tree-note')]
      for (const note of notes) { note.click(); await new Promise((r) => setTimeout(r, 400)) }
      const long = notes.find((n) => n.innerText.includes('过程稿'))
      if (long) { long.click(); await new Promise((r) => setTimeout(r, 700)) }
      return JSON.stringify({ tabs: document.querySelectorAll('.tab').length, scrollable: (() => { const el = document.querySelector('.tabs'); return el.scrollWidth >= el.clientWidth })() })
    })()`)
    const openedState = JSON.parse(opened)
    check('多 tab：三篇都开得出来，tab 条可横向滚动', openedState.tabs === 3 && openedState.scrollable, opened)
    await probe('账本关闭后保持正文光标与滚动位置', async () => {
      const result = JSON.parse(await page.eval(`(() => {
        const scroller = document.querySelector('.cm-scroller')
        scroller.scrollTop = 180
        const selection = window.getSelection()
        const before = { scroll: scroller.scrollTop, anchor: selection?.anchorOffset, focus: selection?.focusOffset }
        document.querySelector('.ledger-open').click()
        document.querySelector('.ledger-close').click()
        const after = window.getSelection()
        return JSON.stringify({ before, afterScroll: scroller.scrollTop, afterAnchor: after?.anchorOffset, afterFocus: after?.focusOffset, ledgerClosed: document.querySelector('.ledger-view').hidden })
      })()`))
      return { ok: result.before.scroll > 0 && result.afterScroll === result.before.scroll && result.ledgerClosed && result.before.anchor === result.afterAnchor && result.before.focus === result.afterFocus, detail: JSON.stringify(result) }
    })
    await sleep(400)
    check('标题索引：短横线分三级、当前项有状态', (await page.eval(`(() => {
      const marks = [...document.querySelectorAll('.outline-mark')]
      if (marks.length < 2) return false
      const widths = new Set(marks.map((m) => m.querySelector('.outline-rule').style.width))
      return widths.size >= 2 && marks.some((m) => m.getAttribute('aria-current') === 'true')
    })()`)) === true)
    check('标题索引：只有 h1–h3', (await page.eval(`[...document.querySelectorAll('.outline-mark')].every((m) => ['1','2','3'].includes(m.dataset.depth))`)) === true)
    await probe('标题索引悬浮在画布右缘且常态只露短线', async () => {
      const position = JSON.parse(await page.eval(`(() => {
        const stage = document.querySelector('.stage').getBoundingClientRect()
        const editor = document.querySelector('.editor-host').getBoundingClientRect()
        const outlineNode = document.querySelector('.outline')
        const outline = outlineNode.getBoundingClientRect()
        const tooltip = document.querySelector('.outline-tooltip')
        const rule = document.querySelector('.outline-rule')?.getBoundingClientRect()
        return JSON.stringify({ stageRight: stage.right, editorBottom: editor.bottom, left: outline.left, right: outline.right, top: outline.top, bottom: outline.bottom, centerDelta: Math.round((outline.top + outline.bottom - stage.top - stage.bottom) / 2), tooltipHidden: tooltip?.hidden, ruleWidth: rule?.width, background: getComputedStyle(outlineNode).backgroundColor })
      })()`))
      return { ok: position.left > position.stageRight - 70 && position.right <= position.stageRight && position.top < position.editorBottom && position.bottom < position.editorBottom && Math.abs(position.centerDelta) <= 24 && position.tooltipHidden && position.ruleWidth > 5 && position.ruleWidth < 35 && position.background === 'rgba(0, 0, 0, 0)', detail: JSON.stringify(position) }
    })
    await probe('标题索引只显示聚焦短线对应的标题', async () => {
      const state = JSON.parse(await page.eval(`(() => {
        const marks = [...document.querySelectorAll('.outline-mark')]
        marks[1].focus()
        const tooltip = document.querySelector('.outline-tooltip')
        const focused = { text: tooltip.textContent, hidden: tooltip.hidden, aria: marks[1].getAttribute('aria-label'), background: getComputedStyle(document.querySelector('.outline')).backgroundColor }
        marks[1].blur()
        return JSON.stringify({ focused, hiddenAfterBlur: tooltip.hidden })
      })()`))
      return { ok: !state.focused.hidden && state.focused.text === state.focused.aria && state.hiddenAfterBlur && state.focused.background === 'rgba(0, 0, 0, 0)', detail: JSON.stringify(state) }
    })
    await probe('正文衬线、标题无衬线', async () => {
      const fonts = JSON.parse(await page.eval(`(() => {
        const body = getComputedStyle(document.querySelector('.cm-scroller')).fontFamily
        const heading = getComputedStyle(document.querySelector('.cm-line.md-heading')).fontFamily
        return JSON.stringify({ body, heading })
      })()`))
      return { ok: fonts.body !== fonts.heading && /sans-serif/.test(fonts.heading), detail: `${fonts.body} → ${fonts.heading}` }
    })
    await probe('切换 tab 后恢复各自光标位置', async () => {
      const point = JSON.parse(await page.eval(`(() => {
        const line = [...document.querySelectorAll('.cm-line')].find((n) => n.innerText.includes('章节1的第 0 段'))
        const box = line?.getBoundingClientRect()
        return JSON.stringify({ x: box ? Math.round(box.left + 24) : 0, y: box ? Math.round(box.top + box.height / 2) : 0 })
      })()`))
      if (!point.x || !point.y) return false
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      const before = await page.eval(`document.querySelector('.status-left')?.innerText`)
      await page.eval(`(() => { const tabs = [...document.querySelectorAll('.tab')]; tabs[0]?.click(); tabs.find((n) => n.innerText.includes('过程稿'))?.click() })()`)
      await sleep(300)
      const after = await page.eval(`document.querySelector('.status-left')?.innerText`)
      return { ok: before === after && /第 [3-9] 行/.test(after), detail: `${before} → ${after}` }
    })

    process.stdout.write('\nMarkdown 阅读管线\n')
    const syntaxNote = [
      '---', 'title: 混合样例', '---', '',
      '### **混合标题**', '',
      '中文 English 😀，*斜体*、~~删除~~、[链接](https://example.com)。', '',
      '- [ ] 待办', '1. 有序项', '', '> 引用段落', '', '---', '',
      '| **列名** | 值 |', '| --- | --- |', '| *一* | ~~二~~ |', '',
      '```ts', 'const answer = 42', '```', '',
      '$x^2$', '', '> [!note] 提示', '> **内容**', '',
      '[[研究记录]]', '', '```mermaid', 'graph LR', 'A-->B', '```', '',
      '安全的 <strong>行内 HTML</strong>。', '', '<iframe src="https://example.com"></iframe>', ''
    ].join('\r\n')
    writeFileSync(path.join(vault, '过程稿.md'), syntaxNote)
    await waitFor(page, `document.querySelector('.cm-content')?.innerText.includes('混合标题')`, 12000)
    await shot(page, 'markdown-syntax')
    await probe('CRLF 混合样例中标题、表格、公式、callout 与 Mermaid 均进入阅读态', async () => {
      const result = JSON.parse(await page.eval(`(() => {
        const lines = [...document.querySelectorAll('.cm-line')]
        const heading = lines.find((n) => n.innerText.includes('混合标题'))
        return JSON.stringify({ heading: heading?.innerText.trim(), table: !!document.querySelector('.md-table th strong'), math: !!document.querySelector('.md-math'), callout: !!document.querySelector('.md-callout strong'), mermaid: !!document.querySelector('.md-mermaid'), iframe: !!document.querySelector('iframe') })
      })()`))
      return { ok: result.heading === '混合标题' && result.table && result.math && result.callout && result.mermaid && !result.iframe, detail: JSON.stringify(result) }
    })
    await probe('公式与 Mermaid 完成实际渲染', async () =>
      await waitFor(page, `!!document.querySelector('.md-math .katex') && !!document.querySelector('.md-mermaid svg')`, 12000)
    )
    await probe('恶意 HTML 显示为源码且没有执行节点', async () => {
      const state = JSON.parse(await page.eval(`JSON.stringify({ html: [...document.querySelectorAll('.md-html')].map((n) => n.textContent), iframe: !!document.querySelector('iframe'), sourceLine: [...document.querySelectorAll('.cm-line')].filter((n) => n.innerText.includes('iframe')).map((n) => n.innerText) })`))
      return { ok: state.html.some((value) => value.includes('<iframe')) && !state.iframe, detail: JSON.stringify(state) }
    })
    await probe('阅读装饰不修改 CRLF 文件字节', async () => readFileSync(path.join(vault, '过程稿.md'), 'utf8') === syntaxNote)
    await probe('点入属性摘要可编辑原始 YAML', async () => {
      const point = JSON.parse(await page.eval(`(() => { const box = document.querySelector('.md-frontmatter')?.getBoundingClientRect(); return JSON.stringify({ x: box ? Math.round(box.left + 32) : 0, y: box ? Math.round(box.top + box.height / 2) : 0 }) })()`))
      if (!point.x || !point.y) return false
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      return (await page.eval(`[...document.querySelectorAll('.cm-line')].some((n) => n.innerText.includes('title: 混合样例'))`)) === true
    })
    await sleep(150)
    await probe('进入标题后显示原始 Markdown 供编辑', async () => {
      const point = JSON.parse(await page.eval(`(() => { const line = [...document.querySelectorAll('.cm-line')].find((n) => n.innerText.includes('混合标题')); const text = line?.querySelector('.md-strong')?.getBoundingClientRect(); return JSON.stringify({ x: text ? Math.round(text.left + text.width / 2) : 0, y: text ? Math.round(text.top + text.height / 2) : 0 }) })()`))
      if (!point.x || !point.y) return false
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      const lines = await page.eval(`[...document.querySelectorAll('.cm-line')].filter((n) => n.innerText.includes('混合标题')).map((n) => n.innerText)`)
      return { ok: lines.some((line) => line.includes('### **混合标题**')), detail: JSON.stringify(lines) }
    })
    await probe('编辑并保存 CRLF 笔记时只改所输入的字', async () => {
      await page.key('End', 'End', 0, 35)
      await page.key('X', 'KeyX', 0, 88, 'X')
      await page.key('s', 'KeyS', modifier, 83)
      for (let i = 0; i < 30 && readFileSync(path.join(vault, '过程稿.md'), 'utf8') === syntaxNote; i += 1) await sleep(200)
      const saved = readFileSync(path.join(vault, '过程稿.md'), 'utf8')
      return { ok: saved !== syntaxNote && saved.replace('X', '') === syntaxNote && !/(?<!\r)\n/.test(saved), detail: `原长 ${syntaxNote.length}，保存长 ${saved.length}，CRLF ${saved.includes('\r\n')}` }
    })

    process.stdout.write('\n画布呈现\n')
    // 外部写入带标记的正文：宿主会把它当外部改动收进来，然后重开这一篇。
    const marked = ['人写的一段。', '', '<!-- rgent:prompt:v1 -->', '把上周的会议整理成周报。', '保留关键决定。', '', '<!-- rgent:ai:v1 -->', '好，这是周报。', ''].join('\n')
    writeFileSync(path.join(vault, '研究记录.md'), marked)
    // 上一段把长文留成了当前 tab，这里显式切回带标记的那一篇。
    await page.eval(`(async () => {
      const target = [...document.querySelectorAll('.tree-note')].find((n) => n.innerText.includes('研究记录'))
      target?.click()
      await new Promise((r) => setTimeout(r, 800))
      return 1
    })()`)
    await waitFor(page, `document.querySelectorAll('.rgent-block-command').length > 0`, 15000)
    const before = readFileSync(path.join(vault, '研究记录.md'), 'utf8')
    await probe('提问前缀由显示层产生', async () =>
      (await page.eval(`(() => { const lines = [...document.querySelectorAll('.cm-line.rgent-block-command')]; return lines.length === 2 && getComputedStyle(lines[0], '::before').content === '">"' && getComputedStyle(lines[1], '::before').content === 'none' })()`)) === true
    )
    await probe('回答缩进正好一个字宽', async () => {
      const delta = await page.eval(`(() => {
        const left = (line) => { const node = [...line.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()); if (!node) return null; const r = document.createRange(); r.selectNodeContents(node); return Math.round(r.getBoundingClientRect().left) }
        const lineOf = (p) => [...document.querySelectorAll('.cm-line')].find((l) => l.innerText.startsWith(p))
        const answer = lineOf('好，这是周报'); const plain = lineOf('人写的一段')
        return answer && plain ? left(answer) - left(plain) : null
      })()`)
      return { ok: delta === 17, detail: `相对缩进 ${delta}px` }
    })
    await probe('chip：采纳、丢弃直露，上移下移进「更多」', async () =>
      (await page.eval(`(() => {
        const marker = [...document.querySelectorAll('.rgent-marker')].find((m) => m.className.includes('marker-ai'))
        return !!marker && marker.innerText.includes('采纳') && marker.innerText.includes('丢弃') && marker.innerText.includes('更多')
      })()`)) === true
    )
    await probe('显示层不改文件', async () => readFileSync(path.join(vault, '研究记录.md'), 'utf8') === before)

    process.stdout.write('\n冲突双预览\n')
    // 点进正文再敲一个字，制造脏稿。必须走 CDP 的真实输入：
    // 合成 MouseEvent 不会被 CM6 当成放光标（实测点不出脏稿）。
    const spot = JSON.parse(await page.eval(`(() => {
      const line = [...document.querySelectorAll('.cm-line')].find((l) => l.innerText.startsWith('把上周'))
      const box = line.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(box.left + 24), y: Math.round(box.top + box.height / 2) })
    })()`))
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    await sleep(250)
    await page.key('End', 'End', 0, 35)
    await page.key('X', 'KeyX', 0, 88, 'X')
    const dirty = (await page.eval(`document.querySelectorAll('.tab-dirty').length`)) > 0
    check('造出脏稿（点进正文敲了一个字）', dirty)
    writeFileSync(path.join(vault, '研究记录.md'), `${marked}磁盘改的一行。\n`)
    const appeared = await waitFor(page, `document.querySelectorAll('dialog.conflict[open]').length > 0`, 12000)
    await probe('脏稿遇上外部改动会弹冲突', async () => appeared)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 800, height: 560, deviceScaleFactor: 1, mobile: false })
    await sleep(300)
    await probe('并排两栏、各自标清是哪一份', async () => {
      const state = JSON.parse(await page.eval(`(() => {
        const heads = [...document.querySelectorAll('.conflict-head')].map((h) => h.textContent)
        const cols = getComputedStyle(document.querySelector('.conflict-grid')).gridTemplateColumns.split(' ').length
        const buttons = [...document.querySelectorAll('.conflict-actions button')].map((b) => b.getBoundingClientRect())
        return JSON.stringify({ heads, cols, aligned: buttons.length === 2 && buttons[0].right < buttons[1].left })
      })()`))
      return { ok: state.cols === 2 && state.heads.length === 2 && state.aligned, detail: `${state.cols} 栏 / ${state.heads.join(' · ')}` }
    })
    await probe('三个动作与各自的舍弃说明', async () =>
      (await page.eval(`document.querySelectorAll('.conflict-action button').length === 3 && document.querySelectorAll('.conflict-note').length === 3`)) === true
    )
    await probe('破坏性选项不是默认焦点', async () =>
      (await page.eval(`document.activeElement?.dataset?.action`)) === 'continue'
    )
    await probe('只强调变化处', async () =>
      (await page.eval(`document.querySelectorAll('.conflict-emph').length > 0`)) === true
    )

    process.stdout.write('\n长文响应\n')
    await page.eval(`document.querySelector('.conflict [data-action="disk"]')?.click()`)
    await page.call('Emulation.clearDeviceMetricsOverride', {})
    for (let i = 1; i <= 5; i += 1) {
      const paragraphs = Array.from({ length: 450 }, (_, n) => `第 ${n} 段：这是一段用于观察长文输入和滚动响应的混合文字 English ${i}。`)
      writeFileSync(path.join(vault, `长文样例${i}.md`), [`# 长文样例${i}`, '', ...paragraphs].join('\n\n'))
    }
    await probe('五篇长文的打开、输入与滚动都有可记录的响应', async () => {
      const rows = await waitFor(page, `document.querySelectorAll('.tree-note').length >= 8`)
      if (!rows) return false
      const samples = JSON.parse(await page.eval(`(async () => {
        const out = []
        for (let i = 1; i <= 5; i++) {
          const row = [...document.querySelectorAll('.tree-note')].find((n) => n.innerText.includes('长文样例' + i))
          if (!row) break
          const start = performance.now()
          row.click()
          for (let tick = 0; tick < 120; tick++) {
            if (document.querySelector('.tab[aria-selected="true"]')?.innerText.includes('长文样例' + i) && document.querySelector('.cm-content')?.innerText.includes('第 0 段')) break
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
          const open = performance.now() - start
          const view = document.querySelector('.cm-content')?.cmTile?.root?.view
          if (!view) break
          const inputStart = performance.now()
          view.dispatch({ changes: { from: view.state.doc.length, insert: '测' } })
          const input = performance.now() - inputStart
          const scrollStart = performance.now()
          view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const scroll = performance.now() - scrollStart
          out.push({ bytes: view.state.doc.length, open: Math.round(open), input: Math.round(input), scroll: Math.round(scroll) })
        }
        return JSON.stringify(out)
      })()`))
      const maxInput = Math.max(...samples.map((sample) => sample.input))
      return { ok: samples.length === 5 && samples.every((sample) => sample.bytes > 18_000 && sample.open < 5000 && sample.scroll < 1000) && maxInput < 250, detail: JSON.stringify(samples) }
    })

    process.stdout.write('\nHost 最小环\n')
    hostServer = createHttpServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += String(chunk) })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"id":"ui","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"受控回答第一句。"},"finish_reason":null}]}\n\n')
        const timer = setTimeout(() => {
          if (response.destroyed) return
          response.write('data: {"id":"ui","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"第二句。"},"finish_reason":null}]}\n\n')
          response.write('data: {"id":"ui","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
          response.end('data: [DONE]\n\n')
        }, body.includes('多任务') ? 10000 : body.includes('快速完成') ? 0 : 1200)
        response.on('close', () => clearTimeout(timer))
      })
    })
    await new Promise((resolve) => hostServer.listen(0, '127.0.0.1', resolve))
    const hostAddress = hostServer.address()
    const hostBaseURL = `http://127.0.0.1:${hostAddress.port}/v1`
    const configured = await page.eval(`(async () => {
      const profile = await window.rgent.modelProfileSet({ provider: 'custom', fields: { baseURL: '${hostBaseURL}', modelId: 'test', contextTokens: 20000 }, newKey: 'ui-fixture-secret' })
      if (!profile.ok || !profile.config.profiles.custom.hasKey) return false
      const selected = await window.rgent.modelSelect('custom')
      return selected.ok && selected.config.selected === 'custom'
    })()`)
    check('本机模型配置能保存密钥状态并选用受控兼容接口', configured === true)
    await page.eval(`document.querySelector('.settings-open')?.click()`)
    await waitFor(page, `!!document.querySelector('.overlay-settings[open]')`)
    await page.eval(`(() => { [...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === '模型')?.click() })()`)
    check('模型设置页只显示密钥状态，密码输入不回填', await waitFor(page, `document.querySelector('.settings-key-state')?.textContent === '密钥已保存' && document.querySelector('input[type=password]')?.value === ''`))
    await page.eval(`(() => { [...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === '运行')?.click() })()`)
    check('运行设置页提供三档有限上限', await waitFor(page, `document.querySelectorAll('.settings-limit-group').length === 3`))
    await page.eval(`document.querySelector('.settings-close')?.click()`)
    writeFileSync(path.join(vault, 'Host 环路.md'), '')
    check('新笔记在目录中出现', await waitFor(page, `[...document.querySelectorAll('.tree-note')].some((n) => n.innerText.includes('Host 环路'))`, 8000))
    await page.eval(`(() => { [...document.querySelectorAll('.tree-note')].find((n) => n.innerText.includes('Host 环路'))?.click(); document.querySelector('.cm-content')?.focus() })()`)
    await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.innerText.includes('Host 环路')`)
    await page.call('Input.insertText', { text: '/请写两句话' })
    check('空段内输入的口令留在编辑器', await waitFor(page, `document.querySelector('.cm-content')?.textContent.includes('/请写两句话')`))
    await page.key('Enter', 'Enter', 0, 13)
    const running = await waitFor(page, `!!document.querySelector('.status-task-stop')`, 4000)
    check('回车后底栏出现当前篇停止入口', running, running ? '' : await page.eval(`(async () => JSON.stringify({ status: document.querySelector('.status-left')?.innerText, note: (await window.rgent.noteRead('Host 环路.md')).content, editor: document.querySelector('.cm-content')?.textContent }))()`))
    check('回答与账本写回同一篇，回答为未采纳块', await waitFor(page, `(async () => {
      const note = await window.rgent.noteRead('Host 环路.md')
      return note.content.includes('受控回答第一句。第二句。') && note.content.includes('<!-- rgent:ai:v1 task-id=') && note.content.includes('<!-- rgent:ledger-task:v1 id=')
    })()`, 10000))
    await page.eval(`document.querySelector('.ledger-open')?.click()`)
    check('同一 tab 的只读账本能回顾口令和回答', await waitFor(page, `document.querySelector('.ledger-body')?.textContent.includes('请写两句话') && document.querySelector('.ledger-body')?.textContent.includes('受控回答第一句。')`))
    await page.eval(`document.querySelector('.ledger-close')?.click()`)
    writeFileSync(path.join(vault, 'Host 快速.md'), '')
    await waitFor(page, `[...document.querySelectorAll('.tree-note')].some((note) => note.innerText.includes('Host 快速'))`)
    await page.eval(`(() => { [...document.querySelectorAll('.tree-note')].find((note) => note.innerText.includes('Host 快速'))?.click(); document.querySelector('.cm-content')?.focus() })()`)
    await page.call('Input.insertText', { text: '/快速完成' })
    await page.key('Enter', 'Enter', 0, 13)
    check('快速流结束后底栏不残留运行任务', await waitFor(page, `(async () => {
      const note = await window.rgent.noteRead('Host 快速.md')
      return note.content.includes('受控回答第一句。第二句。') && (await window.rgent.agentTasks()).length === 0 && !document.querySelector('.status-task-stop')
    })()`, 8000))
    writeFileSync(path.join(vault, 'Host A.md'), '')
    writeFileSync(path.join(vault, 'Host B.md'), '')
    check('两篇待运行笔记进入目录', await waitFor(page, `[...document.querySelectorAll('.tree-note')].some((n) => n.innerText.includes('Host A')) && [...document.querySelectorAll('.tree-note')].some((n) => n.innerText.includes('Host B'))`, 8000))
    for (const name of ['Host A', 'Host B']) {
      await page.eval(`(() => { [...document.querySelectorAll('.tree-note')].find((n) => n.innerText.includes('${name}'))?.click(); document.querySelector('.cm-content')?.focus() })()`)
      await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.innerText.includes('${name}')`)
      await page.call('Input.insertText', { text: '/多任务测试' })
      await page.key('Enter', 'Enter', 0, 13)
      await waitFor(page, `document.querySelector('.status-left')?.innerText.includes('生成中')`)
    }
    check('异篇并行时底栏显示任务数量', await waitFor(page, `document.querySelector('.status-task-more')?.textContent.includes('2 项')`))
    await page.eval(`(() => { [...document.querySelectorAll('.tab-wrap')].find((tab) => tab.textContent.includes('Host A'))?.querySelector('.tab-close')?.click() })()`)
    check('关闭 A 的 tab 不取消其生成', await waitFor(page, `(async () =>
      ![...document.querySelectorAll('.tab-wrap')].some((tab) => tab.textContent.includes('Host A')) &&
      (await window.rgent.agentTasks()).length === 2
    )()`))
    await page.eval(`(() => { [...document.querySelectorAll('.tree-note')].find((note) => note.innerText.includes('Host A'))?.click() })()`)
    check('重开 A 可回到正在生成的原篇', await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.innerText.includes('Host A') && (async () => (await window.rgent.agentTasks()).length === 2)()`))
    await page.eval(`(() => { [...document.querySelectorAll('.tab-wrap')].find((tab) => tab.textContent.includes('Host B'))?.querySelector('.tab')?.click() })()`)
    await page.eval(`document.querySelector('.status-task-more')?.click()`)
    check('任务浮层逐篇给出停止按钮', await waitFor(page, `document.querySelectorAll('.overlay-tasks .task-row').length === 2`))
    await page.eval(`(() => { [...document.querySelectorAll('.overlay-tasks .task-row')].find((n) => n.textContent.includes('Host A'))?.querySelector('button')?.click() })()`)
    check('停止 A 后 B 仍可继续运行', await waitFor(page, `document.querySelector('.status-task')?.textContent.includes('Host B')`))
    await page.key('Escape', 'Escape', 0, 27)
    await page.eval(`document.querySelector('.cm-content')?.focus()`)
    await page.key('Escape', 'Escape', 0, 27)
    check('Esc 停止当前 B，两个任务均写入取消账本', await waitFor(page, `(async () => {
      const a = await window.rgent.noteRead('Host A.md')
      const b = await window.rgent.noteRead('Host B.md')
      return a.content.includes('· cancelled') && b.content.includes('· cancelled') && (await window.rgent.agentTasks()).length === 0
    })()`, 8000))

    process.stdout.write('\n收尾\n')
    check('整轮没有未捕获异常', page.errors.length === 0, page.errors.slice(0, 1).join(''))

  } finally {
    if (child.exitCode == null) {
      child.kill()
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(3000).then(() => { if (child.exitCode == null) child.kill('SIGKILL') })
      ])
    }
    rmSync(workdir, { recursive: true, force: true })
    if (hostServer) await new Promise((resolve) => hostServer.close(resolve))
  }

  process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
