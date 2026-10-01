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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
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

/**
 * 一个阶段内部抛错也只记一条失败，后面的独立阶段照常跑，总账不会因为中断而丢。
 * 阶段体不重排缩进：这次只加包裹，减少无关改动。
 */
function stageFailed(name, error) {
  check(`${name}：阶段中断`, false, error instanceof Error ? error.message.slice(0, 160) : String(error))
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
      errors.push(message.params.exceptionDetails.exception?.description ?? JSON.stringify(message.params.exceptionDetails))
    }
    const settle = pending.get(message.id)
    if (settle) {
      pending.delete(message.id)
      settle(message)
    }
  }
  return {
    errors,
    close,
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const mine = ++id
        const timer = setTimeout(() => { pending.delete(mine); reject(new Error(`CDP_TIMEOUT:${method}`)) }, 30_000)
        pending.set(mine, (message) => { clearTimeout(timer); resolve(message) })
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

/** First Enter prepares and displays authorization; only the second confirms. */
async function confirmSlashAuthorization(page, inspect = false) {
  await page.key('Enter', 'Enter', 0, 13)
  const ready = await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`)
  check('本场授权准备就绪后才可确认', ready)
  if (!ready) return false
  if (inspect) {
    check('首次回车只展示本篇范围与实际模型接收方', await page.eval(`(async () => {
      const popup=document.querySelector('.overlay-authorization');
      if(!popup)return false;
      return (await window.rgent.agentTasks()).length===0 && popup.querySelector('.authorization-recipient').textContent.includes('127.0.0.1:') &&
        popup.querySelectorAll('.authorization-manifest li').length===1 && popup.querySelector('.authorization-disclosure').textContent.includes('发送')
    })()`))
    check('口令旁授权浮层具有真实轮廓、可见位置及内部焦点', await page.eval(`(() => {
      const popup=document.querySelector('.overlay-authorization');if(!popup)return false;const r=popup.getBoundingClientRect();const style=getComputedStyle(popup);
      return r.width>=300 && r.width<=450 && r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1 &&
        style.position==='fixed' && parseFloat(style.borderTopWidth)>0 && popup.contains(document.activeElement)
    })()`))
    await page.eval(`document.querySelector('.overlay-authorization')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))`)
    check('输入法组合回车不启动模型任务', await page.eval(`(async () => (await window.rgent.agentTasks()).length===0 && !!document.querySelector('.overlay-authorization[open]'))()`))
    await page.key('Escape','Escape',0,27)
    check('取消授权保留原始口令且焦点回到正文', await waitFor(page, `!document.querySelector('.overlay-authorization[open]') && document.querySelector('.cm-content')?.textContent.includes('/请写两句话') && document.querySelector('.cm-editor')?.contains(document.activeElement)`))
    await page.key('Enter','Enter',0,13)
    if(!await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`))return false
  }
  await page.key('Enter', 'Enter', 0, 13)
  return true
}

/** Three approved notes exercise actual Host tools through the controlled model server. */
async function verifyScopedHost(page, vault, shot, requests) {
  writeFileSync(path.join(vault, '工具发起.md'), '')
  writeFileSync(path.join(vault, '工具参考.md'), '# 参考原文\n\n工具线索：受控正文证据。\n')
  writeFileSync(path.join(vault, '工具其他.md'), '扫描可见，但没有查询命中。\n')
  check('三篇工具夹具进入目录', await waitFor(page, `[...document.querySelectorAll('.tree-note')].filter(n=>/工具发起|工具参考|工具其他/.test(n.innerText)).length===3`))
  await page.eval(`[...document.querySelectorAll('.tree-note')].find(n=>n.innerText.includes('工具发起'))?.click()`)
  await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.innerText.includes('工具发起')`)
  await page.eval(`document.querySelector('.cm-content')?.focus()`)
  await page.call('Input.insertText', { text: '/工具查证' })
  const choose = async () => {
    await page.key('Enter', 'Enter', 0, 13)
    if (!await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`)) return false
    check('新场工具授权默认仅发起篇', await page.eval(`document.querySelectorAll('.authorization-manifest li').length===1 && [...document.querySelectorAll('.authorization-choices input')].every(input=>!input.checked)`))
    // HTMLElement.click() does not focus a checkbox. A refresh disables the initially
    // focused send button, so native mouse clicks must establish focus before refresh.
    for (const [at, name] of ['工具参考.md', '工具其他.md'].entries()) {
      const point = await page.eval(`(() => { const input=[...document.querySelectorAll('.authorization-choices input')].find(input=>input.value===${JSON.stringify(name)}); if(!input || input.disabled)return null;input.scrollIntoView({block:'nearest'});const r=input.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2} })()`)
      if (!point) return false
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      if (!await waitFor(page, `document.querySelectorAll('.authorization-manifest li').length===${at+2} && !!document.querySelector('.authorization-send:not(:disabled)')`)) return false
    }
    return true
  }
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  check('两篇额外参考逐场核对进入固定清单', await choose())
  await shot(page, 'auth-scope-1200')
  await page.key('Escape', 'Escape', 0, 27)
  check('取消工具范围授权保留口令并归还焦点', await waitFor(page, `!document.querySelector('.overlay-authorization[open]') && document.querySelector('.cm-content')?.textContent.includes('/工具查证') && document.querySelector('.cm-editor')?.contains(document.activeElement)`))
  await page.call('Emulation.setDeviceMetricsOverride', { width: 800, height: 560, deviceScaleFactor: 1, mobile: false })
  check('窄窗重新准备三篇范围', await choose())
  check('窄窗范围、主机和内部焦点可辨', await page.eval(`(() => { const popup=document.querySelector('.overlay-authorization');if(!popup)return false;const r=popup.getBoundingClientRect();return r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1 && popup.contains(document.activeElement) && popup.querySelector('.authorization-recipient').textContent.includes('127.0.0.1:') })()`), await page.eval(`(() => {const popup=document.querySelector('.overlay-authorization');if(!popup)return 'no-popup';const r=popup.getBoundingClientRect();return JSON.stringify({bounds:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},viewport:{width:innerWidth,height:innerHeight},focus:document.activeElement?.outerHTML.slice(0,150),recipient:popup.querySelector('.authorization-recipient').textContent})})()`))
  await shot(page, 'auth-scope-800')
  writeFileSync(path.join(vault, '工具参考.md'), '# 参考原文\n\n工具线索：受控正文证据。来源复核。\n')
  await page.key('Enter', 'Enter', 0, 13)
  const refreshed = await waitFor(page, `document.querySelector('.authorization-status')?.textContent.includes('再次确认') && !!document.querySelector('.authorization-send:not(:disabled)') && document.querySelector('.overlay-authorization').contains(document.activeElement)`)
  check('参考原文变化后重新展示清单，第一次确认未发模型请求', refreshed && requests.length === 0 && await page.eval(`(async ()=>(await window.rgent.agentTasks()).length===0)()`), await page.eval(`(async ()=>JSON.stringify({status:document.querySelector('.authorization-status')?.textContent,focus:document.activeElement?.outerHTML.slice(0,150),tasks:await window.rgent.agentTasks()}))()`))
  if (!refreshed) throw Error('授权刷新后未恢复可确认焦点；停止依赖链验收。')
  await page.key('Enter', 'Enter', 0, 13)
  check('工具链运行底栏显示实际模型步且保留停止入口', await waitFor(page, `document.querySelector('.status-task')?.textContent.includes('模型第 3 步') && !!document.querySelector('.status-task-stop')`))
  const done = await waitFor(page, `(async () => {const note=await window.rgent.noteRead('工具发起.md');return note.content.includes('工具查证完成：已核对参考原文。') && (await window.rgent.agentTasks()).length===0})()`)
  check('真实搜库、读库、回答三步写回本篇', done && requests.length === 3 && requests.every(request=>request.tools?.length===2))
  check('首步只发送来源清单，后续请求携带实际命中及原文', requests.length === 3 && !JSON.stringify(requests[0]).includes('受控正文证据') && JSON.stringify(requests[1]).includes('受控正文证据') && JSON.stringify(requests[2]).includes('来源复核'))
  check('工具输出和隐藏推理不落正文', await page.eval(`(async () => { const note=await window.rgent.noteRead('工具发起.md');const body=note.content.split('<!-- rgent:ledger:v1 -->')[0];return !body.includes('受控正文证据') && !body.includes('隐藏工具推理') })()`))
  await page.eval(`document.querySelector('.ledger-open')?.click()`)
  check('同篇账本回顾工具及读取、模型引用来源', await waitFor(page, `(() => {const text=document.querySelector('.ledger-body')?.textContent||'';return text.includes('工具摘要') && (text.includes('search_library')||text.includes('搜库')) && (text.includes('read_library')||text.includes('读库')) && text.includes('实际读取来源：工具其他.md、工具参考.md') && text.includes('模型消息引用来源：工具参考.md')})()`))
  await shot(page, 'tool-ledger-800')
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  await shot(page, 'tool-ledger-1200')
  await page.eval(`document.querySelector('.ledger-close')?.click()`)
  await page.call('Emulation.clearDeviceMetricsOverride', {})
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
    // CDP's 1x emulation produces comparable renderer captures, but scales a
    // Retina native window differently. Clear it before checking OS chrome.
    await page.call('Emulation.clearDeviceMetricsOverride', {})
    await sleep(160)
    nativeShot(mode)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
    if (mode === 'day') await seedVisualModels(page)
    await page.eval(`(() => { const button = document.querySelector('.settings-open'); button?.focus(); button?.click() })()`)
    await waitFor(page, `!!document.querySelector('.overlay-settings[open]')`)
    if (mode === 'day') await probe('设置浮层放大且仍悬浮于工作区', async () => {
      const geometry = JSON.parse(await page.eval(`(() => {
        const panel = document.querySelector('.overlay-settings').getBoundingClientRect()
        const title = document.querySelector('.settings-page-title').getBoundingClientRect()
        return JSON.stringify({ top: Math.round(panel.top), width: Math.round(panel.width), height: Math.round(panel.height), titleTop: Math.round(title.top - panel.top), titleLeft: Math.round(title.left - panel.left) })
      })()`))
      return { ok: geometry.top >= 24 && geometry.top <= 55 && geometry.width >= 980 && geometry.width <= 1050 && geometry.height >= 680 && geometry.height < 800 && geometry.titleTop >= 35 && geometry.titleTop <= 70 && geometry.titleLeft >= 240, detail: JSON.stringify(geometry) }
    })
    check('设置遮罩柔焦且导航仅列出三页与同系图标', await page.eval(`(() => {
      const dialog = document.querySelector('.overlay-settings')
      const blur = getComputedStyle(dialog, '::backdrop').backdropFilter
      const labels = [...dialog.querySelectorAll('.settings-nav button')].map((button) => button.textContent)
      return blur.includes('blur(') && JSON.stringify(labels) === JSON.stringify(['界面','模型','运行']) && dialog.querySelectorAll('.settings-nav .icon').length === 3
    })()`) === true)
    check('阅读排版有真实中英样张和五项可调控件', await waitFor(page, `document.querySelector('.settings-reading-sample')?.textContent.includes('English') && document.querySelectorAll('.settings-reading-controls [data-setting]').length === 5`))
    await shot(page, `reference-${mode}-settings`)
    await page.call('Emulation.clearDeviceMetricsOverride', {})
    await sleep(160)
    nativeShot(`${mode}-settings`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
    await page.eval(`document.querySelector('.settings-main').scrollTop = document.querySelector('.settings-main').scrollHeight`)
    check(`${mode}设置无顶部栏且内容在面板内滚动`, await page.eval(`(() => {
      const dialog = document.querySelector('.overlay-settings')
      const main = dialog.querySelector('.settings-main')
      return !dialog.querySelector('.settings-header, .settings-close') &&
        dialog.querySelector('.settings-nav-heading')?.textContent === '设置' &&
        main.scrollTop > 0 && getComputedStyle(main).overflowY === 'auto'
    })()`) === true)
    await shot(page, `reference-${mode}-settings-reading`)
    await page.eval(`document.querySelector('.settings-main').scrollTop = 0`)
    for (const name of ['模型', '运行']) {
      await page.eval(`([...document.querySelectorAll('.settings-nav button')].find((button) => button.textContent === '${name}'))?.click()`)
      await waitFor(page, `document.querySelector('.settings-page-title')?.textContent === '${name}'`)
      if (name === '模型') {
        await page.eval(`(() => { [...document.querySelectorAll('.settings-connection')].find((card) => card.textContent.includes('密钥已保存'))?.click() })()`)
        await sleep(200)
      }
      await shot(page, `reference-${mode}-settings-${name === '模型' ? 'model' : 'run'}`)
    }
    await page.eval(`([...document.querySelectorAll('.settings-nav button')].find((button) => button.textContent === '界面'))?.click()`)
    if (mode === 'day') {
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 })
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 })
      check('设置面板外真实点击可关闭并返回原焦点', await waitFor(page, `!document.querySelector('.overlay-settings') && document.activeElement?.classList.contains('settings-open')`))
    } else {
      await page.eval(`document.querySelector('.settings-nav-current')?.focus()`)
      await page.key('Escape', 'Escape', 0, 27)
      check('设置面板按 Esc 可关闭并返回原焦点', await waitFor(page, `!document.querySelector('.overlay-settings') && document.activeElement?.classList.contains('settings-open')`))
    }
    if (await page.eval(`!!document.querySelector('.overlay-settings')`)) {
      await page.eval(`document.querySelector('.overlay-settings')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
      await waitFor(page, `!document.querySelector('.overlay-settings')`)
    }
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
    await page.eval(`document.querySelector('.settings-open')?.click()`)
    await waitFor(page, `!!document.querySelector('.overlay-settings[open]')`)
    check('窄窗设置面板保留外边距并由内部滚动', await page.eval(`(() => {
      const dialog = document.querySelector('.overlay-settings').getBoundingClientRect()
      const main = document.querySelector('.settings-main')
      return dialog.left >= 18 && dialog.top >= 18 && dialog.right <= 782 && dialog.bottom <= 542 && main.scrollHeight > main.clientHeight && getComputedStyle(main).overflowY === 'auto'
    })()`) === true)
    await shot(page, `reference-${mode}-settings-narrow`)
    await page.eval(`document.querySelector('.settings-main').scrollTop = document.querySelector('.settings-main').scrollHeight`)
    check(`${mode}窄窗设置仍可滚动且无顶部栏`, await page.eval(`(() => {
      const dialog = document.querySelector('.overlay-settings')
      const main = dialog.querySelector('.settings-main')
      return !dialog.querySelector('.settings-header, .settings-close') &&
        dialog.querySelector('.settings-nav-heading')?.textContent === '设置' &&
        main.scrollTop > 0 && getComputedStyle(main).overflowY === 'auto'
    })()`) === true)
    await shot(page, `reference-${mode}-settings-reading-narrow`)
    await page.eval(`document.querySelector('.settings-main').scrollTop = 0`)
    for (const name of ['模型', '运行']) {
      await page.eval(`([...document.querySelectorAll('.settings-nav button')].find((button) => button.textContent === '${name}'))?.click()`)
      await waitFor(page, `document.querySelector('.settings-page-title')?.textContent === '${name}'`)
      await shot(page, `reference-${mode}-settings-${name === '模型' ? 'model' : 'run'}-narrow`)
    }
    await page.eval(`document.querySelector('.overlay-settings')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
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

/** 同一临时库中走原文编辑、Host、移动、消失与明确另存，不注入生产绕过。 */
async function verifyRawSourceLifecycle(page, vault, modifier, shot) {
  process.stdout.write('\n原文字节与对象边界\n')
  const name = '原文坐标.md'
  const movedName = '原文已移.md'
  const copyName = '原文另存.md'
  const url = 'http://93.184.216.34/source.png'
  const image = `![来源图](${url})`
  const ai = `<!-- rgent:ai:v1 -->\r\n${image} ## 图片标题\r\nAI原文。`
  const body = `\ufeff# 原文坐标\r\n\r\n原文字节。\n\n${ai}\n\n/快速完成\r\n`
  const ledger = '<!-- rgent:ledger:v1 -->\r\n## 原账本\r\n不改历史。\n'
  const original = body + ledger
  writeFileSync(path.join(vault, name), original)
  const appeared = await waitFor(page, `[...document.querySelectorAll('.tree-note')].some((node) => node.textContent.includes('原文坐标'))`)
  check('混合换行夹具进入同一库', appeared)
  if (!appeared) return
  await page.eval(`[...document.querySelectorAll('.tree-note')].find((node) => node.textContent.includes('原文坐标'))?.click()`)
  const opened = await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(name)}`)
  check('BOM 混合换行笔记可在真实窗口打开', opened)
  if (!opened) return
  const projected = body.replace(/\r\n?|\n/g, '\n')
  check('画布LF投影、图片标题与磁盘原文字节各自正确', await page.eval(`(() => {
    const view = document.querySelector('.cm-content')?.cmTile?.root?.view
    return view?.state.doc.toString() === ${JSON.stringify(projected)} &&
      document.querySelector('.cm-line.md-h1')?.textContent.includes('原文坐标') &&
      [...document.querySelectorAll('.outline-mark')].some((node) => node.getAttribute('aria-label')?.includes('图片标题')) &&
      !!document.querySelector('.md-image-slot button')
  })()`) === true && readFileSync(path.join(vault, name), 'utf8') === original)
  await probe('图片出口核验使用原文范围并拒绝AI自动加载及错位范围', async () => {
    const proof = await page.eval(`(async () => {
      const note = await window.rgent.noteRead(${JSON.stringify(name)})
      const start = note.content.indexOf(${JSON.stringify(image)})
      const context = { noteRelPath: ${JSON.stringify(name)}, region: 'body', start, end: start + ${image.length},
        sessionId: note.sessionId, objectVersion: note.objectVersion, revision: note.revision }
      const base = { url: ${JSON.stringify(url)}, context }
      const auto = await window.rgent.remoteImageGet({ ...base, mode: 'auto' })
      const explicit = await window.rgent.remoteImageGet({ ...base, mode: 'explicit' })
      const wrong = await window.rgent.remoteImageGet({ ...base, mode: 'explicit', context: { ...context, start: start - 2, end: context.end - 2 } })
      const unbound = await window.rgent.remoteImageGet({ url: ${JSON.stringify(url)}, mode: 'explicit' })
      return { auto: auto.error, explicit: explicit.error, wrong: wrong.error, unbound: unbound.error }
    })()`)
    return { ok: proof.auto === 'NOT_ALLOWED' && proof.explicit === 'HTTP_CONFIRM' && proof.wrong === 'NOT_ALLOWED' && proof.unbound === 'NOT_ALLOWED', detail: JSON.stringify(proof) }
  })
  const editAt = projected.indexOf('原文字节。') + '原文字节。'.length
  await page.eval(`(() => { const view = document.querySelector('.cm-content').cmTile.root.view; view.dispatch({ changes: { from: ${editAt}, insert: '改' }, selection: { anchor: ${editAt + 1} }, userEvent: 'input.type' }); view.focus() })()`)
  await page.key('s', 'KeyS', modifier, 83)
  const edited = original.replace('原文字节。', '原文字节。改')
  check('编辑保存只增加输入字符，BOM与所有原换行保留', await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(edited)})()`))
  await page.key('z', 'KeyZ', modifier, 90)
  await page.key('s', 'KeyS', modifier, 83)
  check('真实键盘撤销恢复原文完整字节', await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(original)})()`))
  await page.key(process.platform === 'darwin' ? 'Z' : 'y', process.platform === 'darwin' ? 'KeyZ' : 'KeyY', process.platform === 'darwin' ? modifier | 8 : modifier, process.platform === 'darwin' ? 90 : 89)
  await page.key('s', 'KeyS', modifier, 83)
  check('真实键盘重做保持混合换行与BOM', await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(edited)})()`))
  await page.key('z', 'KeyZ', modifier, 90)
  await page.key('s', 'KeyS', modifier, 83)
  await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(original)})()`)
  // 移动按钮用原文单位；图片后的标题和尾文必须与标记一并搬走。
  await page.eval(`(() => { const marker = document.querySelector('.rgent-marker-ai'); marker?.querySelector('.rgent-marker-more-toggle')?.click(); [...(marker?.querySelectorAll('button') ?? [])].find((button) => button.textContent === '上移一段')?.click() })()`)
  await page.key('s', 'KeyS', modifier, 83)
  const swapped = original.replace(`原文字节。\n\n${ai}`, `${ai}\n\n原文字节。`)
  check('身份块搬移保留图、尾文、分隔与账本字节', await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(swapped)})()`))
  await page.key('z', 'KeyZ', modifier, 90)
  await page.key('s', 'KeyS', modifier, 83)
  await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(original)})()`)
  await page.eval(`(() => { const view = document.querySelector('.cm-content').cmTile.root.view; const at = view.state.doc.toString().indexOf('/快速完成') + '/快速完成'.length; view.dispatch({ selection: { anchor: at } }); view.focus() })()`)
  await confirmSlashAuthorization(page)
  const completed = await waitFor(page, `(async () => { const note = await window.rgent.noteRead(${JSON.stringify(name)}); return note.content.includes('受控回答第一句。第二句。') && (await window.rgent.agentTasks()).length === 0 })()`)
  check('混合换行口令按原文落点生成且旧账本保留', completed && readFileSync(path.join(vault, name), 'utf8').includes(ledger))
  const beforeMove = readFileSync(path.join(vault, name), 'utf8')
  const moved = await page.eval(`(async () => { const preview = await window.rgent.relocationPreview({ kind: 'note', source: ${JSON.stringify(name)}, target: ${JSON.stringify(movedName)} }); return preview.ok ? window.rgent.relocationCommit({ id: preview.preview.id, repairLinks: false }) : preview })()`)
  check('生成后结构移动延续原文字节与tab绑定', moved.ok && await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(movedName)}`) && readFileSync(path.join(vault, movedName), 'utf8') === beforeMove)
  if (!moved.ok) return
  rmSync(path.join(vault, movedName))
  const missing = await waitFor(page, `!!document.querySelector('.note-unavailable:not([hidden]) .note-save-copy')`)
  check('外部消失后保留草稿并展示明确另存入口', missing)
  await shot(page, 'note-missing-retained')
  await page.key('s', 'KeyS', modifier, 83)
  check('消失后的保存不会重新创建旧路径', !existsSync(path.join(vault, movedName)))
  if (!missing) return
  await page.eval(`document.querySelector('.note-save-copy')?.click()`)
  const dialog = await waitFor(page, `!!document.querySelector('dialog[open] input')`)
  check('另存目标须由人输入并确认', dialog)
  if (!dialog) return
  await page.eval(`(() => { const dialog = document.querySelector('dialog[open]'); const input = dialog.querySelector('input'); input.value = ${JSON.stringify(copyName)}; input.dispatchEvent(new Event('input', { bubbles: true })); dialog.querySelector('button[value=ok]')?.click() })()`)
  const preview = await waitFor(page, `!!document.querySelector('.save-copy-preview .save-copy-confirm')`)
  check('另存预览展示目标后由明确确认提交', preview)
  await shot(page, 'note-save-copy-preview')
  if (!preview) return
  await page.eval(`document.querySelector('.save-copy-preview .save-copy-confirm').click()`)
  check('明确另存创建新文件并保持旧路径消失与历史字节', await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(copyName)}`) &&
    !existsSync(path.join(vault, movedName)) && existsSync(path.join(vault, copyName)) && readFileSync(path.join(vault, copyName), 'utf8') === beforeMove)
  await shot(page, 'note-save-copy-complete')
  const copied = readFileSync(path.join(vault, copyName), 'utf8')
  await page.eval(`(() => { const view = document.querySelector('.cm-content').cmTile.root.view; const at = view.state.doc.length; view.dispatch({ changes: { from: at, insert: '\\n\\n\\x60\\x60\\x60js\\nunfinished' }, selection: { anchor: at + 8 }, userEvent: 'input.type' }); view.focus() })()`)
  await page.key('s', 'KeyS', modifier, 83)
  check('未闭合正文不会吞入账本或写坏磁盘，窗口保留错误提示', await waitFor(page, `document.querySelector('.status-host-notice')?.textContent.includes('账本边界')`) && readFileSync(path.join(vault, copyName), 'utf8') === copied)
  await page.key('z', 'KeyZ', modifier, 90)
  await page.key('s', 'KeyS', modifier, 83)
  const gone = vault + '-temporarily-moved'
  renameSync(vault, gone)
  try {
    check('整库消失时干净tab、窗口正文及账本仍保留', await waitFor(page, `!!document.querySelector('.note-unavailable:not([hidden]) .note-recheck') && document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(copyName)}`))
    check('整库消失后当前会话拒绝沿旧句柄读取', await page.eval(`window.rgent.noteRead(${JSON.stringify(copyName)}).then(() => false, () => true)`))
    await shot(page, 'vault-missing-retained')
  } finally { renameSync(gone, vault) }
  await page.eval(`document.querySelector('.note-recheck')?.click()`)
  check('原库恢复后重新核验原对象，正文和账本字节保持', await waitFor(page, `document.querySelector('.note-unavailable')?.hidden === true`) && readFileSync(path.join(vault, copyName), 'utf8') === copied)
}

/** 样张夹具：两条带密钥的连接（含同厂商多条）与三个模型，界面才看得出真实形态。 */
async function seedVisualModels(page) {
  await page.eval(`(async () => {
    const deepseek = await window.rgent.modelConnectionAdd({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576, newKey: 'ui-visual-secret' })
    if (!deepseek.ok) return
    const ds = deepseek.config.connections.find((item) => item.provider === 'deepseek' && item.baseURL === 'https://api.deepseek.com' && item.hasKey)
    if (ds) await window.rgent.modelAdd({ connectionId: ds.id, modelId: 'deepseek-reasoner', contextTokens: 131072 })
    await window.rgent.modelConnectionAdd({ provider: 'minimax', baseURL: 'https://api.minimaxi.com/v1', modelId: 'MiniMax-M3', contextTokens: 204800, newKey: 'ui-visual-secret' })
  })()`)
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
    if (process.platform === 'darwin' && shotDir && process.env.RGENT_NATIVE_MAC_SCREENSHOT === '1') {
      const destination = path.join(shotDir, `native-macos-${mode}.png`)
      const result = spawnSync('screencapture', ['-x', destination], { encoding: 'utf8', timeout: 15000 })
      check(`macOS ${mode} 原生桌面截图包含系统交通灯`, result.status === 0 && existsSync(destination), result.stderr?.trim().slice(0, 160) ?? '')
      return
    }
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
    ['.', `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu',
      // 窗口被别的应用挡住时 Chromium 会降频定时器，页内轮询会假超时。
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--remote-debugging-port=${port}`],
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

    // 阶段各自成块后，跨阶段共用的变量提在这里。
    let marked = ''
    const toolLoopRequests = []
    process.stdout.write('\n外壳与主题\n')
    try {
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
        dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        return JSON.stringify({ modes, night, day, system })
      })()`))
      const closed = await waitFor(page, `!document.querySelector('.overlay-settings')`)
      return { ok: state.modes.join(',') === 'day,night,system' && state.night.mode === 'night' && state.night.rendered === 'night' && state.day.mode === 'day' && state.day.rendered === 'day' && state.system === 'system' && closed, detail: JSON.stringify({ ...state, closed }) }
    })
    await probe('排版调节先在样张预览，关闭放弃，保存后应用并持久化', async () => {
      const state = JSON.parse(await page.eval(`(async () => {
        const before = await window.rgent.readingGet()
        const noteBefore = (await window.rgent.noteRead('研究记录.md')).content
        document.querySelector('.settings-open')?.click()
        await new Promise((resolve) => setTimeout(resolve, 120))
        const size = document.querySelector('[data-setting="fontSize"]')
        size.value = String(before.fontSize + 1)
        size.dispatchEvent(new Event('input', { bubbles: true }))
        const preview = getComputedStyle(document.querySelector('.settings-reading-sample')).fontSize
        const workspaceBefore = getComputedStyle(document.querySelector('.cm-editor')).fontSize
        document.querySelector('.overlay-settings')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await new Promise((resolve) => setTimeout(resolve, 120))
        document.querySelector('.settings-open')?.click()
        await new Promise((resolve) => setTimeout(resolve, 120))
        const restored = document.querySelector('[data-setting="fontSize"]').value
        const control = document.querySelector('[data-setting="fontSize"]')
        control.value = String(before.fontSize + 1)
        control.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('.settings-reading-save')?.click()
        await new Promise((resolve) => setTimeout(resolve, 180))
        const saved = await window.rgent.readingGet()
        const workspaceAfter = getComputedStyle(document.querySelector('.cm-editor')).fontSize
        document.querySelector('.overlay-settings')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await new Promise((resolve) => setTimeout(resolve, 120))
        document.querySelector('.ledger-open')?.click()
        const ledgerAfter = getComputedStyle(document.querySelector('.ledger-body')).fontSize
        document.querySelector('.ledger-close')?.click()
        const sourceUnchanged = (await window.rgent.noteRead('研究记录.md')).content === noteBefore
        await window.rgent.readingSet(before)
        document.documentElement.style.setProperty('--reading-font-size', before.fontSize + 'px')
        return JSON.stringify({ before: before.fontSize, preview, workspaceBefore, restored, saved: saved.fontSize, workspaceAfter, ledgerAfter, sourceUnchanged })
      })()`))
      return { ok: state.preview === `${state.before + 1}px` && state.workspaceBefore === `${state.before}px` && state.restored === String(state.before) && state.saved === state.before + 1 && state.workspaceAfter === `${state.before + 1}px` && Math.abs(parseFloat(state.ledgerAfter) - (state.before + 1) * 0.9) < 0.2 && state.sourceUnchanged, detail: JSON.stringify(state) }
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
      await page.eval(`document.querySelector('.overlay-settings').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
      await waitFor(page, `!document.querySelector('.overlay-settings')`)
      await page.eval(`window.rgent.themeSet('night')`)
      await page.eval(`document.querySelector('.settings-open').click()`)
      await waitFor(page, `!!document.querySelector('.overlay-settings[open]')`)
      await shot(page, 'night-settings')
      await page.eval(`document.querySelector('.overlay-settings').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
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

    } catch (error) { stageFailed('外壳与主题', error) }
    process.stdout.write('\n窄窗与长内容\n')
    try {
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

    } catch (error) { stageFailed('窄窗与长内容', error) }
    process.stdout.write('\n键盘可达\n')
    try {
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

    } catch (error) { stageFailed('键盘可达', error) }
    process.stdout.write('\nMarkdown 阅读管线\n')
    try {
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

    } catch (error) { stageFailed('Markdown 阅读管线', error) }
    process.stdout.write('\n画布呈现\n')
    try {
    // 外部写入带标记的正文：宿主会把它当外部改动收进来，然后重开这一篇。
    marked = ['人写的一段。', '', '<!-- rgent:prompt:v1 -->', '把上周的会议整理成周报。', '保留关键决定。', '', '<!-- rgent:ai:v1 -->', '好，这是周报。', ''].join('\n')
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

    } catch (error) { stageFailed('画布呈现', error) }
    process.stdout.write('\n冲突双预览\n')
    try {
    // 点进正文再敲一个字，制造脏稿。必须走 CDP 的真实输入：
    // 合成 MouseEvent 不会被 CM6 当成放光标（实测点不出脏稿）。
    const spot = JSON.parse(await page.eval(`(() => {
      // The prompt block is intentionally locked. Edit the human paragraph instead.
      const line = [...document.querySelectorAll('.cm-line')].find((l) => l.innerText.startsWith('人写的一段'))
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

    } catch (error) { stageFailed('冲突双预览', error) }
    process.stdout.write('\n长文响应\n')
    try {
    await page.eval(`document.querySelector('.conflict [data-action="disk"]')?.click()`)
    await page.call('Emulation.clearDeviceMetricsOverride', {})
    for (let i = 1; i <= 5; i += 1) {
      const paragraphs = Array.from({ length: 450 }, (_, n) => `第 ${n} 段：这是一段用于观察长文输入和滚动响应的混合文字 English ${i}。`)
      writeFileSync(path.join(vault, `长文样例${i}.md`), [`# 长文样例${i}`, '', ...paragraphs].join('\n\n'))
    }
    await probe('五篇长文的打开、输入与滚动都有可记录的响应', async () => {
      const rows = await waitFor(page, `document.querySelectorAll('.tree-note').length >= 8`)
      if (!rows) return false
      const samples = []
      for (let i = 1; i <= 5; i += 1) {
        // 每篇一次 CDP 调用：单次 Runtime.evaluate 的 30s 上限不再被五篇一起吃掉。
        const sample = await page.eval(`(async () => {
          const name = '长文样例${i}'
          const row = [...document.querySelectorAll('.tree-note')].find((n) => n.innerText.includes(name))
          if (!row) return null
          const start = performance.now()
          row.click()
          for (let tick = 0; tick < 120; tick++) {
            if (document.querySelector('.tab[aria-selected="true"]')?.innerText.includes(name) && document.querySelector('.cm-content')?.innerText.includes('第 0 段')) break
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
          const open = performance.now() - start
          const view = document.querySelector('.cm-content')?.cmTile?.root?.view
          if (!view) return null
          const inputStart = performance.now()
          view.dispatch({ changes: { from: view.state.doc.length, insert: '测' } })
          const input = performance.now() - inputStart
          const scrollStart = performance.now()
          view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const scroll = performance.now() - scrollStart
          return { bytes: view.state.doc.length, open: Math.round(open), input: Math.round(input), scroll: Math.round(scroll) }
        })()`)
        if (!sample) break
        samples.push(sample)
      }
      const maxInput = Math.max(...samples.map((sample) => sample.input))
      return { ok: samples.length === 5 && samples.every((sample) => sample.bytes > 18_000 && sample.open < 5000 && sample.scroll < 1000) && maxInput < 250, detail: JSON.stringify(samples) }
    })

    } catch (error) { stageFailed('长文响应', error) }
    process.stdout.write('\nHost 最小环\n')
    try {
    hostServer = createHttpServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += String(chunk) })
      request.on('end', () => {
        const decoded = JSON.parse(body)
        if (body.includes('工具查证') && decoded.tools?.length === 2) {
          toolLoopRequests.push(decoded)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'tools-ui', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
          const results = decoded.messages.filter(message => message.role === 'tool')
          if (!results.length) {
            emit({ tool_calls: [{ index: 0, id: 'ui-search', type: 'function', function: { name: 'search_library', arguments: '{"query":"工具' } }] })
            emit({ tool_calls: [{ index: 0, function: { arguments: '线索"}' } }] }); emit({}, 'tool_calls'); response.end('data: [DONE]\n\n')
          } else if (results.length === 1) {
            const result = JSON.parse(results[0].content)
            const sourceId = result.items.find(item => item.relPath === '工具参考.md')?.sourceId
            emit({ tool_calls: [{ index: 0, id: 'ui-read', type: 'function', function: { name: 'read_library', arguments: JSON.stringify({ sourceId }) } }] }); emit({}, 'tool_calls'); response.end('data: [DONE]\n\n')
          } else {
            const timer = setTimeout(() => { if (response.destroyed) return; emit({ reasoning_content: '隐藏工具推理' }); emit({ content: '工具查证完成：已核对参考原文。' }); emit({}, 'stop'); response.end('data: [DONE]\n\n') }, 1200)
            response.on('close', () => clearTimeout(timer))
          }
          return
        }
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
      const added = await window.rgent.modelConnectionAdd({ provider: 'custom', baseURL: '${hostBaseURL}', modelId: 'test', contextTokens: 20000, newKey: 'ui-fixture-secret' })
      if (!added.ok) return false
      const connection = added.config.connections.find((item) => item.baseURL === '${hostBaseURL}')
      const model = added.config.models.find((item) => item.connectionId === connection?.id)
      if (!connection?.hasKey || !model) return false
      const picked = await window.rgent.modelDefaultSet({ modelId: model.id })
      return picked.ok && picked.config.defaultModelId === model.id
    })()`)
    check('本机模型配置能保存独立密钥并把默认模型指向受控兼容接口', configured === true)
    await page.eval(`document.querySelector('.settings-open')?.click()`)
    await waitFor(page, `!!document.querySelector('.overlay-settings[open]')`)
    await page.eval(`(() => { [...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === '模型')?.click() })()`)
    await page.eval(`(() => { [...document.querySelectorAll('.settings-connection')].find((card) => card.textContent.includes('密钥已保存'))?.click() })()`)
    check('模型设置页列出连接与模型、只显示密钥状态且密码不回填', await waitFor(page, `document.querySelector('.settings-connection.is-active')?.textContent.includes('密钥已保存') && document.querySelector('input[type=password]')?.value === '' && document.querySelectorAll('.settings-model-row').length >= 1 && ![...document.querySelectorAll('button')].some((button) => button.textContent.includes('设为当前模型'))`))
    await page.eval(`(() => { [...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === '运行')?.click() })()`)
    check('运行设置页提供三档有限上限', await waitFor(page, `document.querySelectorAll('.settings-limit-group').length === 3`))
    await page.eval(`document.querySelector('.overlay-settings')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    writeFileSync(path.join(vault, 'Host 环路.md'), '')
    check('新笔记在目录中出现', await waitFor(page, `[...document.querySelectorAll('.tree-note')].some((n) => n.innerText.includes('Host 环路'))`, 8000))
    await page.eval(`(() => { [...document.querySelectorAll('.tree-note')].find((n) => n.innerText.includes('Host 环路'))?.click(); document.querySelector('.cm-content')?.focus() })()`)
    await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.innerText.includes('Host 环路')`)
    await page.call('Input.insertText', { text: '/请写两句话' })
    check('空段内输入的口令留在编辑器', await waitFor(page, `document.querySelector('.cm-content')?.textContent.includes('/请写两句话')`))
    await confirmSlashAuthorization(page, true)
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
    await page.eval(`[...document.querySelectorAll('.tree-note')].find((note) => note.innerText.includes('Host 快速'))?.click()`)
    await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.innerText.includes('Host 快速')`)
    await page.eval(`document.querySelector('.cm-content')?.focus()`)
    await page.call('Input.insertText', { text: '/快速完成' })
    await confirmSlashAuthorization(page)
    const quickFinished = await waitFor(page, `(async () => {
      const note = await window.rgent.noteRead('Host 快速.md')
      return note.content.includes('受控回答第一句。第二句。') && (await window.rgent.agentTasks()).length === 0 && !document.querySelector('.status-task-stop')
    })()`, 8000)
    check('快速流结束后底栏不残留运行任务', quickFinished, quickFinished ? '' : await page.eval(`(async () => JSON.stringify({ note: (await window.rgent.noteRead('Host 快速.md')).content, tasks: await window.rgent.agentTasks(), status: document.querySelector('.status-left')?.innerText }))()`))
    await verifyScopedHost(page, vault, shot, toolLoopRequests)
    await verifyRawSourceLifecycle(page, vault, modifier, shot)
    writeFileSync(path.join(vault, 'Host A.md'), '')
    writeFileSync(path.join(vault, 'Host B.md'), '')
    check('两篇待运行笔记进入目录', await waitFor(page, `[...document.querySelectorAll('.tree-note')].some((n) => n.innerText.includes('Host A')) && [...document.querySelectorAll('.tree-note')].some((n) => n.innerText.includes('Host B'))`, 8000))
    const parallelCheck = async (name, expression, timeout = 4000) => {
      const ok = await waitFor(page, expression, timeout)
      const detail = ok ? '' : await page.eval(`(async () => JSON.stringify({ tasks:await window.rgent.agentTasks(), status:document.querySelector('.status-left')?.innerText, activeTab:document.querySelector('.tab[aria-selected=true]')?.innerText, popup:document.querySelector('dialog[open]')?.className, notes:await Promise.all(['Host A.md','Host B.md'].map(async path=>({path,content:(await window.rgent.noteRead(path)).content}))) }))()`)
      check(name, ok, detail)
      if (!ok) throw new Error(`并行任务前置条件失败：${name}；停止后续依赖断言。`)
    }
    for (const [at, name] of ['Host A', 'Host B'].entries()) {
      await page.eval(`(() => { [...document.querySelectorAll('.tree-note')].find((n) => n.innerText.includes('${name}'))?.click(); document.querySelector('.cm-content')?.focus() })()`)
      await parallelCheck(`${name} 进入当前 tab`, `document.querySelector('.tab[aria-selected=true]')?.innerText.includes('${name}')`)
      await page.call('Input.insertText', { text: '/多任务测试' })
      if (!await confirmSlashAuthorization(page)) throw new Error(`${name} 的本场授权准备失败；停止并行依赖断言。`)
      await parallelCheck(`${name} 启动后任务归属及数量正确`, `(async () => { const tasks=await window.rgent.agentTasks();return tasks.length===${at+1} && ${JSON.stringify(['Host A.md','Host B.md'].slice(0,at+1))}.every(path=>tasks.some(task=>task.relPath===path)) })()`)
    }
    await parallelCheck('异篇并行时底栏显示任务数量', `(async ()=>(await window.rgent.agentTasks()).length===2 && document.querySelector('.status-task-more')?.textContent.includes('2 项'))()`)
    await page.eval(`(() => { [...document.querySelectorAll('.tab-wrap')].find((tab) => tab.textContent.includes('Host A'))?.querySelector('.tab-close')?.click() })()`)
    await parallelCheck('关闭 A 的 tab 不取消其生成', `(async () =>
      ![...document.querySelectorAll('.tab-wrap')].some((tab) => tab.textContent.includes('Host A')) &&
      (await window.rgent.agentTasks()).length === 2
    )()`)
    await page.eval(`(() => { [...document.querySelectorAll('.tree-note')].find((note) => note.innerText.includes('Host A'))?.click() })()`)
    await parallelCheck('重开 A 可回到正在生成的原篇', `(async () => document.querySelector('.tab[aria-selected=true]')?.innerText.includes('Host A') && (await window.rgent.agentTasks()).length === 2)()`)
    await page.eval(`(() => { [...document.querySelectorAll('.tab-wrap')].find((tab) => tab.textContent.includes('Host B'))?.querySelector('.tab')?.click() })()`)
    await page.eval(`document.querySelector('.status-task-more')?.click()`)
    await parallelCheck('任务浮层逐篇给出停止按钮', `document.querySelectorAll('.overlay-tasks .task-row').length === 2`)
    await page.eval(`(() => { [...document.querySelectorAll('.overlay-tasks .task-row')].find((n) => n.textContent.includes('Host A'))?.querySelector('button')?.click() })()`)
    await parallelCheck('停止 A 后 B 仍可继续运行', `(async () => {const tasks=await window.rgent.agentTasks();return tasks.length===1 && tasks[0].relPath==='Host B.md' && document.querySelector('.status-task')?.textContent.includes('Host B')})()`)
    await page.key('Escape', 'Escape', 0, 27)
    await page.eval(`document.querySelector('.cm-content')?.focus()`)
    await page.key('Escape', 'Escape', 0, 27)
    await parallelCheck('Esc 停止当前 B，两个任务均写入取消账本', `(async () => {
      const a = await window.rgent.noteRead('Host A.md')
      const b = await window.rgent.noteRead('Host B.md')
      return a.content.includes('· cancelled') && b.content.includes('· cancelled') && (await window.rgent.agentTasks()).length === 0
    })()`, 8000)

    } catch (error) { stageFailed('Host 最小环', error) }
    process.stdout.write('\n笔记库文件生命周期\n')
    try {
    await page.eval(`document.querySelector('.folder-create')?.click()`)
    check('库根新建文件夹入口可由键盘和鼠标使用', await waitFor(page, `!!document.querySelector('.modal input')`))
    await page.eval(`(() => { const input = document.querySelector('.modal input'); input.value = '生命周期'; document.querySelector('.modal button[value=ok]')?.click() })()`)
    check('新建文件夹进入真实文件树', await waitFor(page, `[...document.querySelectorAll('.tree-dir')].some((node) => node.textContent.includes('生命周期'))`, 8000))
    mkdirSync(path.join(vault, '生命周期', '原'), { recursive: true })
    writeFileSync(path.join(vault, '生命周期', '原.md'), '# 不应改写的正文\r\n')
    writeFileSync(path.join(vault, '生命周期', '原', '图.png'), Buffer.from([1, 2, 3]))
    writeFileSync(path.join(vault, '生命周期', '引用.md'), '见 [[生命周期/原]]。')
    check('文件树显示待改名的笔记', await waitFor(page, `[...document.querySelectorAll('[data-parent="生命周期"] .tree-note')].some((node) => node.querySelector('.tree-label')?.textContent === '原')`, 8000))
    await page.eval(`(() => { const node = [...document.querySelectorAll('[data-parent="生命周期"] .tree-note')].find((n) => n.querySelector('.tree-label')?.textContent === '原'); node?.click(); node?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 220 })) })()`)
    check('文件树右键提供改名和移动', await waitFor(page, `[...document.querySelectorAll('.tier-menu button')].some((n) => n.textContent === '改名') && [...document.querySelectorAll('.tier-menu button')].some((n) => n.textContent === '移动')`))
    await page.eval(`(() => { [...document.querySelectorAll('.tier-menu button')].find((n) => n.textContent === '改名')?.click() })()`)
    await waitFor(page, `!!document.querySelector('.modal input')`)
    await page.eval(`(() => { document.querySelector('.modal input').value = '新'; document.querySelector('.modal button[value=ok]')?.click() })()`)
    check('改名前出现附件与引用预览', await waitFor(page, `document.querySelector('.lifecycle-dialog')?.textContent.includes('生命周期/原 → 生命周期/新') && document.querySelectorAll('.lifecycle-dialog li').length === 2 && document.querySelector('.lifecycle-check')?.textContent.includes('1 篇')`, 8000))
    await page.eval(`document.querySelector('.lifecycle-actions button:last-child')?.click()`)
    check('提交后笔记、附件及引用一起更新', await waitFor(page, `!document.querySelector('.lifecycle-dialog') && [...document.querySelectorAll('.tree-note')].some((node) => node.textContent.includes('新'))`, 8000) &&
      existsSync(path.join(vault, '生命周期', '新.md')) && existsSync(path.join(vault, '生命周期', '新', '图.png')) &&
      readFileSync(path.join(vault, '生命周期', '新.md'), 'utf8') === '# 不应改写的正文\r\n' &&
      readFileSync(path.join(vault, '生命周期', '引用.md'), 'utf8') === '见 [[生命周期/新]]。')
    check('打开的 tab 跟随路径变化', await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === '生命周期/新.md'`, 8000))
    writeFileSync(path.join(vault, '生命周期', '脏.md'), '旧正文')
    await waitFor(page, `[...document.querySelectorAll('.tree-note')].some((node) => node.textContent.includes('脏'))`)
    await page.eval(`(() => { [...document.querySelectorAll('.tree-note')].find((node) => node.textContent.includes('脏'))?.click(); document.querySelector('.cm-content')?.focus() })()`)
    await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === '生命周期/脏.md'`)
    await page.call('Input.insertText', { text: '手写' })
    const dirtyMove = await page.eval(`(async () => {
      const prepared = await window.rgent.relocationPreview({ kind: 'note', source: '生命周期/脏.md', target: '生命周期/已存.md' })
      return prepared.ok ? await window.rgent.relocationCommit({ id: prepared.preview.id, repairLinks: false }) : prepared
    })()`)
    check('结构提交先保存打开的草稿', dirtyMove.ok === true &&
      readFileSync(path.join(vault, '生命周期', '已存.md'), 'utf8').includes('手写'))
    writeFileSync(path.join(vault, '生命周期', '运行.md'), '')
    await waitFor(page, `[...document.querySelectorAll('.tree-note')].some((node) => node.textContent.includes('运行'))`)
    await page.eval(`(() => { [...document.querySelectorAll('.tree-note')].find((node) => node.textContent.includes('运行'))?.click(); document.querySelector('.cm-content')?.focus() })()`)
    await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === '生命周期/运行.md'`)
    await page.call('Input.insertText', { text: '/多任务停止' })
    await confirmSlashAuthorization(page)
    const beforeMoveTask = await waitFor(page, `(async () => (await window.rgent.agentTasks()).some((item) => item.relPath === '生命周期/运行.md'))()`, 5000)
    writeFileSync(path.join(vault, '生命周期', '不相关.md'), '保持不动')
    const unrelatedMove = await page.eval(`(async () => {
      const prepared = await window.rgent.relocationPreview({ kind: 'note', source: '生命周期/不相关.md', target: '生命周期/不应移动.md' })
      return prepared.ok ? await window.rgent.relocationCommit({ id: prepared.preview.id, repairLinks: false }) : prepared
    })()`)
    check('其他笔记生成期间拒绝结构提交且不取消其任务', !unrelatedMove.ok && unrelatedMove.error === 'OTHER_TASK_RUNNING' &&
      existsSync(path.join(vault, '生命周期', '不相关.md')) && !existsSync(path.join(vault, '生命周期', '不应移动.md')) &&
      await page.eval(`(async () => (await window.rgent.agentTasks()).some((item) => item.relPath === '生命周期/运行.md'))()`))
    const taskMove = beforeMoveTask ? await page.eval(`(async () => {
      const prepared = await window.rgent.relocationPreview({ kind: 'note', source: '生命周期/运行.md', target: '生命周期/已停止.md' })
      return prepared.ok ? await window.rgent.relocationCommit({ id: prepared.preview.id, repairLinks: false }) : prepared
    })()`) : { ok: false }
    const taskGone = await waitFor(page, `(async () => !(await window.rgent.agentTasks()).some((item) => item.relPath === '生命周期/运行.md'))()`)
    const movedTaskSource = existsSync(path.join(vault, '生命周期', '已停止.md'))
      ? readFileSync(path.join(vault, '生命周期', '已停止.md'), 'utf8') : ''
    check('移动运行任务的笔记先停止并写入取消账本', taskMove.ok === true && taskGone && movedTaskSource.includes('· cancelled'),
      JSON.stringify({ beforeMoveTask, taskMove, taskGone, moved: movedTaskSource.length > 0, cancelled: movedTaskSource.includes('· cancelled') }))
    writeFileSync(path.join(vault, '生命周期', '过期.md'), '第一版')
    const stale = await page.eval(`window.rgent.relocationPreview({ kind: 'note', source: '生命周期/过期.md', target: '生命周期/拒绝.md' })`)
    writeFileSync(path.join(vault, '生命周期', '过期.md'), '外部第二版')
    const staleResult = stale.ok ? await page.eval(`window.rgent.relocationCommit({ id: '${stale.preview.id}', repairLinks: false })`) : stale
    check('预览后的外部修改使移动失败且保留原文', staleResult.ok === false && !existsSync(path.join(vault, '生命周期', '拒绝.md')) &&
      readFileSync(path.join(vault, '生命周期', '过期.md'), 'utf8') === '外部第二版')
    check('废纸篓验证门未通过前没有删除入口', (await page.eval(`!([...document.querySelectorAll('.tier-menu button')].some((n) => n.textContent.includes('删除')))`)) === true)

    } catch (error) { stageFailed('笔记库文件生命周期', error) }
    process.stdout.write('\n文件操作恢复状态\n')
    try {
    const native = require(path.join(root, 'out', 'main', 'rgent_fs.node'))
    const handle = native.openRoot(vault)
    const hash = (bytes) => require('node:crypto').createHash('sha256').update(bytes).digest('hex')
    const fingerprint = (relPath) => {
      const leaf = native.resolve(handle, relPath).at(-1)
      return { relPath, id: leaf.id, kind: leaf.kind, ...(leaf.kind === 'file' ? { hash: hash(native.read(handle, relPath)) } : {}) }
    }
    try {
      mkdirSync(path.join(vault, '生命周期', '复原'))
      writeFileSync(path.join(vault, '生命周期', '复原.md'), '不应泄露到状态接口的正文\r\n')
      writeFileSync(path.join(vault, '生命周期', '复原', '附件.png'), Buffer.from([7, 8, 9]))
      await waitFor(page, `[...document.querySelectorAll('.tree-note')].some((node) => node.textContent.includes('复原'))`)
      await page.eval(`[...document.querySelectorAll('.tree-note')].find((node) => node.textContent.includes('复原'))?.click()`)
      await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === '生命周期/复原.md'`)
      const parts = ['生命周期', '生命周期/复原.md', '生命周期/复原', '生命周期/复原/附件.png'].map(fingerprint)
      const moves = [{ from: '生命周期/复原.md', to: '生命周期/已恢复.md', id: parts[1].id },
        { from: '生命周期/复原', to: '生命周期/已恢复', id: parts[2].id }]
      const policy = existsSync(path.join(vault, '.rgent-permissions')) ? readFileSync(path.join(vault, '.rgent-permissions'), 'utf8') : null
      const journal = JSON.stringify({ version: 1, active: { kind: 'move',
        intent: { kind: 'note', source: moves[0].from, target: moves[0].to, moves },
        fingerprints: parts, permissionBefore: policy, permissionAfter: policy, linkRepairs: [], repairLinks: false } }) + '\n'
      const unrelatedPrompt = '/多任务恢复'
      writeFileSync(path.join(vault, '生命周期', '无关生成.md'), unrelatedPrompt)
      const unrelatedTask = await page.eval(`(async () => {
        const note = await window.rgent.noteRead('生命周期/无关生成.md')
        const request={ ...${JSON.stringify({ relPath: '生命周期/无关生成.md',
          range: { start: 0, end: unrelatedPrompt.length }, expectedText: unrelatedPrompt, promptText: '多任务恢复' })},
          expectedRevision: note.revision, sessionId: note.sessionId, objectVersion: note.objectVersion }
        const authorization=await window.rgent.agentAuthorizationPreview({...request,references:[]})
        return authorization.ok ? window.rgent.agentStart({...request,previewId:authorization.preview.id}) : authorization
      })()` )
      check('恢复竞态夹具中的无关任务开始并已产生回答', unrelatedTask.ok && await waitFor(page,
        `(async () => (await window.rgent.noteRead('生命周期/无关生成.md')).content.includes('受控回答第一句。'))()`))
      writeFileSync(path.join(vault, '.rgent-lifecycle'), journal)
      native.move(handle, moves[0].from, moves[0].to, moves[0].id)
      check('中断操作出现可访问的状态入口', await waitFor(page, `!document.querySelector('.lifecycle-warning').hidden`))
      await page.eval(`document.querySelector('.lifecycle-warning').focus(); document.querySelector('.lifecycle-warning').click()`)
      check('恢复浮层展示已移动与待移动，关闭为默认焦点', await waitFor(page, `document.querySelector('.lifecycle-recovery')?.textContent.includes('已移动') && document.querySelector('.lifecycle-recovery')?.textContent.includes('待移动') && document.activeElement?.textContent === '关闭'`))
      const status = await page.eval(`window.rgent.lifecycleStatus()`)
      check('恢复状态不泄露正文、记录原文或绝对路径', status.status === 'pending' && typeof status.revision === 'string' &&
        !JSON.stringify(status).includes('不应泄露') && !JSON.stringify(status).includes(vault) && !JSON.stringify(status).includes('permissionBefore'))
      await page.call('Emulation.setDeviceMetricsOverride', { width: 800, height: 560, deviceScaleFactor: 1, mobile: false })
      check('窄窗恢复浮层在窗口内且内容可滚动', await page.eval(`(() => { const d = document.querySelector('.lifecycle-recovery'); const r = d.getBoundingClientRect(); return r.left >= 18 && r.right <= 782 && r.top >= 18 && r.bottom <= 542 && getComputedStyle(d).overflowY === 'auto' })()`))
      await shot(page, 'lifecycle-recovery-narrow')
      await page.key('Escape', 'Escape', 0, 27)
      check('恢复浮层关闭后焦点返回状态入口', await waitFor(page, `!document.querySelector('.lifecycle-recovery') && document.activeElement?.classList.contains('lifecycle-warning')`))
      await page.call('Emulation.clearDeviceMetricsOverride', {})
      writeFileSync(path.join(vault, '生命周期', '复原', '外部新增.txt'), '仅此临时夹具')
      await page.eval(`document.querySelector('.lifecycle-warning').click()`)
      await waitFor(page, `document.querySelector('.lifecycle-recovery')?.textContent.includes('无法核验')`)
      await page.eval(`document.querySelector('.lifecycle-retry').focus(); document.querySelector('.lifecycle-retry').click()`)
      check('成员变化拒绝重试并保留记录与附件原位', await waitFor(page, `document.querySelector('.lifecycle-recovery [role=status]')?.textContent.includes('恢复记录')`) &&
        readFileSync(path.join(vault, '.rgent-lifecycle'), 'utf8') === journal && existsSync(path.join(vault, '生命周期', '复原', '附件.png')))
      check('失败重试后键盘焦点仍在恢复浮层', await page.eval(`document.querySelector('.lifecycle-recovery').contains(document.activeElement)`))
      rmSync(path.join(vault, '生命周期', '复原', '外部新增.txt'))
      await page.eval(`document.querySelector('.lifecycle-retry').click()`)
      check('安全重试续跑附件且正文与权限保持不变', await waitFor(page, `document.querySelector('.lifecycle-recovery [role=status]')?.textContent === '文件操作已完成。'`) &&
        readFileSync(path.join(vault, '生命周期', '已恢复.md'), 'utf8') === '不应泄露到状态接口的正文\r\n' &&
        existsSync(path.join(vault, '生命周期', '已恢复', '附件.png')) &&
        JSON.parse(readFileSync(path.join(vault, '.rgent-lifecycle'), 'utf8')).active === null &&
        (!policy || readFileSync(path.join(vault, '.rgent-permissions'), 'utf8') === policy))
      const unrelatedSaved = await waitFor(page, `(async () => {
        const source = (await window.rgent.noteRead('生命周期/无关生成.md')).content
        const [body,ledger] = source.split('<!-- rgent:ledger:v1 -->')
        const chapters = [...(ledger||'').matchAll(/^<!-- rgent:ledger-task:v1 id="([^"\\r\\n]+)"(?: sources="v1")? -->\\r?$/gm)]
        const chapter = chapters.length===1 ? ledger.slice(chapters[0].index) : ''
        const status = /^## [^\\r\\n]+ · (cancelled|failed)\\r?$/m.exec(chapter)?.[1]
        const stopped = status==='cancelled' || status==='failed' && /^中止原因：LIFECYCLE_RECOVERY_REQUIRED\\r?$/m.test(chapter)
        return body.includes('受控回答第一句。') && chapter.includes('受控回答第一句。') && chapters.length===1 && chapters[0][1]===${JSON.stringify(unrelatedTask.id)} && stopped && (await window.rgent.agentTasks()).length===0
      })()`)
      check('恢复后补存无关任务的回答与一章账本', unrelatedSaved, unrelatedSaved ? '' : await page.eval(`(async () => JSON.stringify({taskId:${JSON.stringify(unrelatedTask.id)},tasks:await window.rgent.agentTasks(),source:(await window.rgent.noteRead('生命周期/无关生成.md')).content}))()`))
      const recoveredUnrelatedSource = await page.eval(`(async ()=>(await window.rgent.noteRead('生命周期/无关生成.md')).content)()`)

      check('成功重试后焦点转到浮层关闭按钮', await page.eval(`document.querySelector('.lifecycle-recovery').contains(document.activeElement) && document.activeElement.textContent === '关闭'`))
      await page.key('Escape', 'Escape', 0, 27)
      check('重试后 tab、文件树与状态一起更新', await waitFor(page, `document.querySelector('.lifecycle-warning').hidden && document.querySelector('.tab[aria-selected=true]')?.dataset.rel === '生命周期/已恢复.md'`))
      check('状态入口隐藏后关闭浮层回到可见工作区控件', await waitFor(page, `document.activeElement?.classList.contains('tree-toggle')`))
      const duplicate = await page.eval(`window.rgent.lifecycleRetry(${JSON.stringify({ sessionId: status.sessionId, revision: status.revision })})`)
      check('重复恢复提交因修订过期而拒绝且任务账本保持幂等', !duplicate.ok && duplicate.error === 'STALE_RECOVERY' && recoveredUnrelatedSource === await page.eval(`(async ()=>(await window.rgent.noteRead('生命周期/无关生成.md')).content)()`))
      const damaged = '{"version":1,"active":"broken"}'
      writeFileSync(path.join(vault, '.rgent-lifecycle'), damaged)
      await waitFor(page, `!document.querySelector('.lifecycle-warning').hidden`)
      await page.eval(`document.querySelector('.lifecycle-warning').click()`)
      check('损坏记录显错且没有强制清除入口', await waitFor(page, `document.querySelector('.lifecycle-recovery')?.textContent.includes('损坏') && !document.querySelector('.lifecycle-retry')`) &&
        readFileSync(path.join(vault, '.rgent-lifecycle'), 'utf8') === damaged)
      await shot(page, 'lifecycle-record-invalid')
      await page.key('Escape', 'Escape', 0, 27)
    } finally { native.closeRoot(handle) }

    } catch (error) { stageFailed('文件操作恢复状态', error) }
    process.stdout.write('\n收尾\n')
    try {
    check('整轮没有未捕获异常', page.errors.length === 0, page.errors.slice(0, 1).join(''))

    } catch (error) { stageFailed('收尾', error) }
  } finally {
    if (child.exitCode == null) {
      child.kill()
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(3000).then(() => { if (child.exitCode == null) child.kill('SIGKILL') })
      ])
    }
    // Windows 退出后句柄可能还握着临时目录一两秒（EPERM）。临时目录是运行卫生，
    // 不是验收项：重试几次，仍不行只告警，不让它把整轮结果改成失败。
    let cleaned = false
    for (let attempt = 0; attempt < 5 && !cleaned; attempt += 1) {
      try { rmSync(workdir, { recursive: true, force: true }); cleaned = true }
      catch { await sleep(400) }
    }
    if (!cleaned) process.stdout.write(`  ! 临时目录未能删除（${workdir}），不影响本轮检查结论\n`)
    if (hostServer) await new Promise((resolve) => hostServer.close(resolve))
  }

  process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  // 启动或收尾阶段抛错也必须给出总账，不能只剩一段堆栈。
  process.stdout.write(`\n共 ${results.length} 条，失败 ${failures + 1} 条。\n`)
  process.exitCode = 1
})
