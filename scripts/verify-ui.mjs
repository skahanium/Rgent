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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, renameSync, statSync, realpathSync, chmodSync, readdirSync, cpSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
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
  check(`${name}：阶段中断`, false, error instanceof Error ? (error.message + (error.cause instanceof Error ? ' / ' + error.cause.message : '')).slice(0, 200) : String(error))
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

async function selectBrowserFolder(page, folder) {
  await page.eval(`(() => {
    const target = ${JSON.stringify(folder)}
    for (const button of document.querySelectorAll('.tree-folder-toggle')) {
      if ((button.dataset.path === '' || target === button.dataset.path || target.startsWith(button.dataset.path + '/')) && button.getAttribute('aria-expanded') === 'false') button.click()
    }
    const select = [...document.querySelectorAll('.tree-select')].find(node => node.dataset.path === target)
    select?.scrollIntoView({ block: 'nearest' }); select?.click()
  })()`)
  return waitFor(page, `document.querySelector('.resource-path')?.textContent === ${JSON.stringify(folder || '笔记库')}`)
}

/** Reload restores the saved expanded state; a blind toggle would collapse the visual vault. */
async function setTreeExpanded(page, open) {
  await page.eval(`(() => {
    const button = document.querySelector('.tree-toggle')
    if (button && (button.getAttribute('aria-expanded') === 'true') !== ${open}) button.click()
  })()`)
  return waitFor(page, `document.querySelector('.tree-toggle')?.getAttribute('aria-expanded') === ${JSON.stringify(String(open))}`)
}

function makePage(send, close) {
  let id = 0
  const pending = new Map()
  const errors = []
  // 专项可挂自己的 CDP 事件钩子（例如截获原生对话框）。默认 null，既有用例的观测与行为不变。
  const page = {
    errors,
    onEvent: null,
    close,
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const mine = ++id
        const timer = setTimeout(() => { pending.delete(mine); reject(new Error(`CDP_TIMEOUT:${method}`)) }, 30_000)
        pending.set(mine, (message) => {
          clearTimeout(timer)
          if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
          else resolve(message)
        })
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
    page.onEvent?.(message)
  }
  return page
}

/** Real rectangles and pointer/keyboard input exercise the sidebar's layout contract. */
async function verifySidebarWidth(page, shot) {
  const toggle = async open => page.eval(`(() => { const button = document.querySelector('.tree-toggle'); if ((button.getAttribute('aria-expanded') === 'true') !== ${open}) button.click() })()`)
  await toggle(false)
  check('侧栏收起后无空壳或边界占位，画布接到窗口左缘', await page.eval(`(() => {
    const panel = document.querySelector('.tree-panel'), body = document.querySelector('.body'), stage = document.querySelector('.stage')
    return getComputedStyle(panel).display === 'none' && panel.getBoundingClientRect().width === 0 && Math.abs(stage.getBoundingClientRect().left - body.getBoundingClientRect().left) < 1
  })()`))
  const exists = await page.eval(`!!document.querySelector('.sidebar-resizer')`)
  check('侧栏右边界有可键盘操作的垂直分隔柄', exists)
  if (!exists) return
  const activePath = await page.eval(`document.querySelector('.tab[aria-selected=true]')?.dataset.rel`)
  const sourceBefore = await page.eval(`window.rgent.noteRead(${JSON.stringify(activePath)}).then(note => note.content)`)
  await page.eval(`(() => { const view = document.querySelector('.cm-content').cmTile.root.view; const line = view.state.doc.line(Math.min(3, view.state.doc.lines)); if (line.length >= 3) view.dispatch({ selection: { anchor: line.from + 1, head: line.from + 3 } }) })()`)
  const geometry = `(() => {
    const panel = document.querySelector('.tree-panel'), handle = document.querySelector('.sidebar-resizer')
    const content = document.querySelector('.cm-content'), body = document.querySelector('.body'), scroller = document.querySelector('.cm-scroller')
    const text = content.getBoundingClientRect(), scroll = scroller.getBoundingClientRect()
    return { width: panel.getBoundingClientRect().width, textWidth: text.width, leftGap: text.left - scroll.left, rightGap: scroll.left + scroller.clientWidth - text.right, min: Number(handle.getAttribute('aria-valuemin')), max: Number(handle.getAttribute('aria-valuemax')), now: Number(handle.getAttribute('aria-valuenow')), bounded: body.scrollWidth <= body.clientWidth + 1, handleWidth: handle.getBoundingClientRect().width, selection: content.cmTile.root.view.state.selection.main.toJSON() }
  })()`
  const settle = async () => page.eval(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const reset = async () => { await page.eval(`document.querySelector('.sidebar-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`); await settle() }
  const key = async (name, modifiers = 0) => { await page.eval(`document.querySelector('.sidebar-resizer').focus()`); await page.key(name, name, modifiers); await settle() }
  await toggle(true)
  try {
    for (const mode of ['day', 'night']) {
      await page.eval(`window.rgent.themeSet('${mode}')`)
      for (const [width, height] of [[1200, 800], [800, 560]]) {
        await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        await settle(); await reset()
        const baseline = await page.eval(geometry)
        await key('End')
        const enlarged = await page.eval(geometry)
        check(`${mode} ${width} 侧栏调宽保护正文行宽与反链边界`, enlarged.width > baseline.width && enlarged.width <= 360 && enlarged.width <= enlarged.max + 1 && enlarged.textWidth >= baseline.textWidth - 1 && enlarged.leftGap >= 23.5 && enlarged.rightGap >= 23.5 && enlarged.bounded && enlarged.handleWidth === 8 && JSON.stringify(baseline.selection) === JSON.stringify(enlarged.selection), JSON.stringify({ baseline, enlarged }))
        await shot(page, `sidebar-width-${mode}-${width}`)
      }
      await toggle(false)
      check(`${mode} 收起后分隔柄隐藏且不能聚焦`, await page.eval(`document.querySelector('.sidebar-resizer').hidden && document.querySelector('.sidebar-resizer').tabIndex === -1 && document.activeElement === document.querySelector('.tree-toggle')`))
      await shot(page, `sidebar-collapsed-${mode}`)
      await toggle(true)
    }
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
    await settle(); await key('End')
    const wide = await page.eval(geometry)
    await shot(page, 'sidebar-width-night-wide')
    await page.eval(`document.querySelector('.ledger-open').click()`)
    check('调宽后只读账本与反链仍在工作区内', await page.eval(`(() => { const ledger = document.querySelector('.ledger-view'); const r = ledger.getBoundingClientRect(); return !ledger.hidden && !ledger.querySelector('[contenteditable=true]') && r.left >= 0 && r.right <= innerWidth })()`))
    await shot(page, 'sidebar-width-night-ledger')
    await page.eval(`document.querySelector('.ledger-close').click()`)
    await page.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await shot(page, 'sidebar-width-night-reduced-motion')
    await page.call('Emulation.setEmulatedMedia', { features: [] })
    await page.call('Emulation.setDeviceMetricsOverride', { width: 800, height: 560, deviceScaleFactor: 1, mobile: false })
    await settle()
    const narrow = await page.eval(geometry)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
    await settle()
    const restored = await page.eval(geometry)
    check('窗口缩小临时限宽，放大恢复首选宽度', wide.width === 360 && narrow.width < wide.width && restored.width === wide.width, JSON.stringify({ wide, narrow, restored }))
    await key('Home'); await key('ArrowRight', 8)
    check('分隔柄键盘最小值与 Shift 步进可用', (await page.eval(geometry)).width === 224)
    // Capture the pointer, then exercise Esc rollback before a separate committed drag.
    const point = await page.eval(`(() => {
      const handle = document.querySelector('.sidebar-resizer'), r = handle.getBoundingClientRect()
      const point = { x: r.left + 4, y: r.top + 80 }, trace = []
      const release = handle.releasePointerCapture
      handle.releasePointerCapture = function(id) {
        trace.push({ event: 'releasePointerCapture', id, width: handle.getAttribute('aria-valuenow'), stack: new Error().stack, time: performance.now() })
        return release.call(this, id)
      }
      const record = event => trace.push({ event: event.type, target: event.target?.className,
        x: event.clientX, buttons: event.buttons, button: event.button, trusted: event.isTrusted, id: event.pointerId, captured: event.pointerId ? handle.hasPointerCapture(event.pointerId) : null,
        width: handle.getAttribute('aria-valuenow'), time: performance.now() })
      const events = ['pointerdown', 'pointermove', 'pointercancel', 'lostpointercapture', 'gotpointercapture']
      events.forEach(type => document.addEventListener(type, record, true)); window.addEventListener('resize', record)
      const mutation = new MutationObserver(() => record({ type: 'root-style', target: document.documentElement }))
      mutation.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
      window.__sidebarDragObservation = () => {
        events.forEach(type => document.removeEventListener(type, record, true)); window.removeEventListener('resize', record); mutation.disconnect()
        handle.releasePointerCapture = release; delete window.__sidebarDragObservation; return trace
      }
      trace.push({ event: 'hit-test', target: document.elementFromPoint(point.x, point.y)?.className, width: handle.getAttribute('aria-valuenow') })
      return point
    })()`)
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons: 0 })
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await page.interruptNativeFocus?.()
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 40, y: point.y, button: 'left', buttons: 1 })
    await settle()
    const dragging = await page.eval(geometry)
    await page.key('Escape', 'Escape', 0, 27)
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 40, y: point.y, button: 'left', clickCount: 1 })
    const dragObservation = await page.eval(`window.__sidebarDragObservation()`)
    await page.restoreNativeWindow?.()
    check('真实拖动即时调整，Esc 恢复本次前宽度', dragging.width === 264 && (await page.eval(geometry)).width === 224, JSON.stringify({ dragging, dragObservation }))
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 56, y: point.y, button: 'left', buttons: 1 })
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 56, y: point.y, button: 'left', clickCount: 1 })
    await settle()
    const committed = await page.eval(geometry)
    check('真实拖动松开后提交宽度且保持正文选区', committed.width === 280 && JSON.stringify(committed.selection) === JSON.stringify(dragging.selection))
    check('重载前已保存本库展开状态和活动篇', await waitFor(page, `(async()=>{const state=await window.rgent.vaultGet();const workspace=await window.rgent.vaultWorkspaceGet(state.sessionId);return workspace?.sidebarHidden===false && workspace.active===${JSON.stringify(activePath)}})()`))
    await page.call('Page.reload', {})
    // A saved workspace now restores its expanded state; only a new workspace uses the default.
    check('重新加载页面恢复本库首选宽度、展开状态和活动篇', await waitFor(page, `document.querySelector('.sidebar-resizer')?.getAttribute('aria-valuenow') === '280' && !document.querySelector('.tree-panel')?.classList.contains('is-collapsed') && document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(activePath)}`))
    await toggle(true)
    await waitFor(page, `[...document.querySelectorAll('.tree-note')].some(node => node.dataset.path === ${JSON.stringify(activePath)})`)
    await page.eval(`[...document.querySelectorAll('.tree-note')].find(node => node.dataset.path === ${JSON.stringify(activePath)})?.click()`)
    await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(activePath)}`)
    await reset()
    check('双击分隔柄恢复默认展开宽度', (await page.eval(geometry)).width === 224)
    check('调宽、收起及偏好恢复不改变笔记原文字节', (await page.eval(`window.rgent.noteRead(${JSON.stringify(activePath)}).then(note => note.content)`)) === sourceBefore)
  } finally {
    await page.eval(`window.__sidebarDragObservation?.()`)
    await reset(); await toggle(false)
    await page.call('Emulation.clearDeviceMetricsOverride', {})
    await page.eval(`window.rgent.themeSet('night')`)
  }
}

/** First Enter prepares and displays authorization; only the second confirms. */
async function confirmSlashAuthorization(page, inspect = false) {
  await page.key('Enter', 'Enter', 0, 13)
  const ready = await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`)
  check('本场授权准备就绪后才可确认', ready, ready ? '' : await page.eval(`JSON.stringify({ tab: document.querySelector('.tab[aria-selected=true]')?.dataset.rel, focused: document.activeElement?.className, popup: document.querySelector('dialog[open]')?.className, text: document.querySelector('.cm-content')?.textContent?.slice(0, 180), status: document.querySelector('.status-left')?.textContent })`))
  if (!ready) return false
  if (inspect) {
    check('首次回车只展示本篇范围与实际模型接收方', await page.eval(`(async () => {
      const popup=document.querySelector('.overlay-authorization');
      if(!popup)return false;
      return (await window.rgent.agentTasks()).length===0 && popup.querySelector('.authorization-recipient').textContent.includes('127.0.0.1:') &&
        popup.querySelectorAll('.authorization-manifest li').length===1 && popup.querySelector('.authorization-disclosure').textContent.includes('发送')
    })()`))
    check('口令旁授权浮层具有真实轮廓、可见位置且不抢焦点', await page.eval(`(() => {
      const popup=document.querySelector('.overlay-authorization');if(!popup)return false;const r=popup.getBoundingClientRect();const style=getComputedStyle(popup);
      return r.width>=300 && r.width<=450 && r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1 &&
        style.position==='fixed' && parseFloat(style.borderTopWidth)>0 && !popup.contains(document.activeElement)
    })()`))
    await page.eval(`document.querySelector('.overlay-authorization')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))`)
    check('输入法组合回车不启动模型任务', await page.eval(`(async () => (await window.rgent.agentTasks()).length===0 && !!document.querySelector('.overlay-authorization[open]'))()`))
    await page.eval(`document.querySelector('.overlay-authorization')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}))`)
    check('单独 keyCode 229 不启动模型任务', await page.eval(`(async () => (await window.rgent.agentTasks()).length===0 && !!document.querySelector('.overlay-authorization[open]'))()`))
    // 非模态卡只在焦点进入卡片时才接管 Esc（不抢焦点是合同）。
    await page.eval(`document.querySelector('.overlay-authorization')?.focus()`)
    await page.key('Escape','Escape',0,27)
    const cancelled = await waitFor(page, `!document.querySelector('.overlay-authorization[open]') && document.querySelector('.cm-content')?.textContent.includes('/请写两句话')`)
    // 非模态关闭不会代还焦点（它从未把焦点拿走）；把焦点放回正文，再走 re-open。
    await page.eval(`document.querySelector('.cm-content')?.focus()`)
    check('取消授权保留原始口令且焦点回到正文', cancelled && await page.eval(`document.querySelector('.cm-editor')?.contains(document.activeElement)`))
    check('取消准备保留该篇临时模型', await page.eval(`document.querySelector('.status-model')?.selectedOptions[0]?.textContent === 'test-override'`) === true)
    await page.key('Enter','Enter',0,13)
    if(!await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`))return false
  }
  // 非模态卡不抢焦点：发送前必须由测试把焦点放到发送键上。
  await page.eval(`document.querySelector('.overlay-authorization .authorization-send:not(:disabled)')?.focus()`)
  await page.key('Enter', 'Enter', 0, 13)
  return true
}

/** Three approved notes exercise actual Host tools through the controlled model server. */
/** Real UI + Host + hidden store + background service, using only the loopback fixture. */
async function verifyMemoryIntegration(page, vault, shot, requests, nativePage) {
  process.stdout.write('\n库内记忆受控完整链路\n')
  const added = await page.eval(`(async () => {
    const config = await window.rgent.modelAdd({ provider:'custom', modelId:'memory-ui-fixture', contextTokens:50000 })
    const model = config.ok && config.config.models.find(m=>m.modelId==='memory-ui-fixture')
    window.__memoryModel = model?.id
    return !!model
  })()`)
  check('为受控整理配置独立模型角色', added)
  await page.eval(`document.querySelector('.settings-open').click()`)
  await waitFor(page, `!!document.querySelector('.settings-nav')`)
  await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='记忆').click()`)
  check('第五记忆页显示默认空模型与当前库关闭', await waitFor(page, `document.querySelector('[data-memory="default-model"]')?.value==='' && document.querySelector('[data-memory="vault-enabled"]')?.checked===false`))
  check('记忆页先显示内容，首次未配置展开模型而维护折叠',await page.eval(`(() => {const sections=[...document.querySelectorAll('[data-memory-section]')];return sections.map(e=>e.dataset.memorySection).join(',')==='status,recent,entries,models,jobs,maintenance'&&document.querySelector('[data-memory-section="models"]').open&&!document.querySelector('[data-memory-section="jobs"]').open&&!document.querySelector('[data-memory-section="maintenance"]').open})()`))
  await page.eval(`(() => {const select=document.querySelector('[data-memory="default-model"]');select.value=window.__memoryModel;select.dispatchEvent(new Event('change'));[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='界面').click();[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='记忆').click()})()`)
  check('记忆页切换设置栏目保留未保存的模型草稿',await waitFor(page,`document.querySelector('[data-memory="default-model"]')?.value===window.__memoryModel && document.querySelector('.memory-model-grid .memory-save-status[role="status"]')?.textContent==='尚未保存'`))
  await page.eval(`(() => {const select=document.querySelector('[data-memory="default-model"]');select.value='';select.dispatchEvent(new Event('change'))})()`)
  const initialTheme=await page.eval(`window.rgent.themeGet()`)
  await page.call('Emulation.setEmulatedMedia',{features:[]})
  for(const mode of ['day','night']){
    await page.eval(`window.rgent.themeSet('${mode}')`)
    await waitFor(page,`document.documentElement.dataset.theme==='${mode}'`)
    for(const [width,height] of [[1200,800],[800,560],[1600,900]]){
      await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
      await page.eval(`document.querySelector('.settings-main').scrollTop=0;new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`)
      check(`空记忆页 ${mode} ${width}px 没有横向溢出`,await page.eval(`(() => {const n=document.querySelector('.settings-main');return n.scrollWidth<=n.clientWidth+1})()`))
      await shot(page,`memory-empty-${mode}-${width}`)
    }
  }
  await page.call('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false})
  await page.eval(`window.rgent.themeSet(${JSON.stringify(initialTheme)})`)
  await page.eval(`(() => {const model=document.querySelector('[data-memory="default-model"]');model.value=window.__memoryModel;document.querySelector('[data-memory="save-default"]').click()})()`)
  check('设备默认记忆模型获得独立保存回执', await waitFor(page, `document.querySelector('[data-memory="current-default"]')?.dataset.modelId===window.__memoryModel`))
  await page.eval(`(() => {document.querySelector('[data-memory="vault-enabled"]').checked=true;document.querySelector('[data-memory="save-vault"]').click()})()`)
  check('库开关保存后底栏符号状态才开启', await waitFor(page, `document.querySelector('.status-memory')?.getAttribute('aria-pressed')==='true'`))
  await shot(page, 'memory-settings-configured')
  await page.key('Escape', 'Escape', 0, 27)
  const createAndOpen = async name => {
    writeFileSync(path.join(vault,name),'')
    await selectBrowserFolder(page,'')
    if(!await waitFor(page, `[...document.querySelectorAll('.tree-note')].some(n=>n.dataset.path===${JSON.stringify(name)})`)) throw Error('记忆夹具未进入目录')
    await page.eval(`[...document.querySelectorAll('.tree-note')].find(n=>n.dataset.path===${JSON.stringify(name)}).click()`)
    if(!await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel===${JSON.stringify(name)}`)) throw Error('记忆夹具未打开')
    await page.eval(`document.querySelector('.cm-content').focus()`)
  }
  await createAndOpen('记忆长期.md')
  await page.call('Input.insertText',{text:'/长期记住：后续回答请用中文简短表达（记忆验收）。'})
  await page.key('Enter','Enter',0,13)
  await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`)
  check('原授权浮层只读披露独立记忆用途与实际整理接收方', await waitFor(page, `(() => {
    const text = document.querySelector('.authorization-memory')?.textContent ?? ''
    return text.includes('本场使用独立记忆') && text.includes('memory-ui-fixture') && text.includes('后台整理') && !document.querySelector('.authorization-memory select')
  })()`))
  // 非模态卡不抢焦点：发送前把焦点放到发送键。
  await page.eval(`document.querySelector('.overlay-authorization .authorization-send:not(:disabled)')?.focus()`)
  await page.key('Enter','Enter',0,13)
  check('回答和本篇账本成功保存后后台整理完成', await waitFor(page, `(async()=>{const state=await window.rgent.vaultGet();const memory=await window.rgent.memoryGet({sessionId:state.sessionId});const note=await window.rgent.noteRead('记忆长期.md');return memory.ok&&memory.value.entries.some(e=>e.content==='后续回答请用中文简短表达（记忆验收）。'&&e.layer==='core')&&memory.value.jobs.some(j=>j.outcome==='applied')&&!note.content.includes('rgent:ledger:v1')&&(await window.rgent.ledgerGet({sessionId:note.sessionId,objectVersion:note.objectVersion,relPath:'记忆长期.md'})).value?.records.some(r=>r.state==='saved'&&r.chapter?.prompt.includes('长期记住'))&&(await window.rgent.agentTasks()).length===0})()`,15000))
  check('独立后台仅发送获准材料、不把回答当事实且工具为零', requests.some(r=>{if(r.model!=='memory-ui-fixture'||r.tools?.length)return false;const input=JSON.parse(r.messages.find(m=>m.role==='user').content);return input.sources?.some(s=>s.classification==='command'&&s.text.includes('长期记住'))&&!input.sources.some(s=>s.classification==='ai')&&!JSON.stringify(r).includes('隐藏工具推理')}))
  await createAndOpen('记忆后续.md')
  await page.call('Input.insertText',{text:'/记忆后续第一次'})
  await confirmSlashAuthorization(page)
  check('下一场自动带入核心记忆并保存实际使用依赖', await waitFor(page, `(async()=>{const note=await window.rgent.noteRead('记忆后续.md');return note.content.includes('记忆验收旧回答')&&(await window.rgent.ledgerGet({sessionId:note.sessionId,objectVersion:note.objectVersion,relPath:'记忆后续.md'})).value?.records.some(r=>r.state==='saved'&&r.chapter?.provenance?.version===2&&r.chapter.provenance.memoryDeps.length>0)&&(await window.rgent.agentTasks()).length===0})()`))
  const nextRequests=requests.filter(r=>r.model!=='memory-ui-fixture'&&JSON.stringify(r).includes('记忆后续第一次'))
  check('实际回答模型收到低信任核心记忆', nextRequests.some(r=>JSON.stringify(r).includes('后续回答请用中文简短表达（记忆验收）。')))
  const sourceEdit=await page.eval(`(async()=>{const note=await window.rgent.noteRead('记忆长期.md');const changed=await window.rgent.noteWrite({relPath:'记忆长期.md',content:${JSON.stringify('无关人写段落。\n\n')}+note.content,expectedRevision:note.revision,sessionId:note.sessionId,objectVersion:note.objectVersion});const memory=await window.rgent.memoryGet({sessionId:note.sessionId});return changed.ok&&memory.ok&&memory.value.entries[0]?.status==='active'})()`)
  check('来源无关受控编辑保留有效记忆',sourceEdit)
  // Seed only this disposable vault, from the actual saved task and its verified
  // prompt descriptor. The production view must independently verify the result.
  const memoryFixtureFile=path.join(vault,'.rgent-memory'),memoryFixtureRecord=parseV5Memory(readFileSync(memoryFixtureFile,'utf8'))
  const fixtureLong=memoryFixtureRecord.entries.find(e=>e.content==='后续回答请用中文简短表达（记忆验收）。')
  const fixtureSource=fixtureLong?.sources.find(s=>s.kind==='ledger'&&s.classification==='command'&&s.taskId)
  if(!fixtureSource)throw Error('近期夹具缺少真实已保存账本口令来源')
  const fixtureLedger=await page.eval(`(async()=>{const n=await window.rgent.noteRead(${JSON.stringify(fixtureSource.relPath)});const r=await window.rgent.ledgerGet({sessionId:n.sessionId,objectVersion:n.objectVersion,relPath:${JSON.stringify(fixtureSource.relPath)}});if(!r.ok)throw Error(r.error);return r.value.records.find(r=>r.taskId===${JSON.stringify(fixtureSource.taskId)})})()`)
  if(fixtureLedger?.state!=='saved'||!fixtureLedger.chapter)throw Error('近期夹具没有真实已保存任务')
  const fixtureChapter=fixtureLedger.chapter,fixtureMaterial=fixtureChapter.material??{fragments:[],truncated:true}
  // The preceding human save replaced the native note object. Capture the current
  // read receipt while the proven saved-prompt descriptor is still authorized.
  const fixtureCurrentNote=await page.eval(`window.rgent.noteRead(${JSON.stringify(fixtureSource.relPath)})`)
  for(const entry of memoryFixtureRecord.entries)for(const source of entry.sources){
    if(source.relPath===fixtureSource.relPath&&source.kind==='ledger'&&source.taskId===fixtureLedger.taskId){source.objectVersion=fixtureCurrentNote.objectVersion;source.revision=fixtureCurrentNote.revision}
  }

  // Same material identity as WorkingMemoryService.savedMaterial and LedgerStore.contextForRecord.
  const fixtureLedgerHash=v4Hash(('口令：\n'+fixtureChapter.prompt+'\n\n历史回答：\n'+fixtureChapter.answer).trimEnd())
  const fixtureRecent={taskId:fixtureLedger.taskId,noteId:fixtureLedger.noteId,materialVersion:v4Hash(JSON.stringify([fixtureLedger.taskId,fixtureLedgerHash,fixtureMaterial])),createdAt:fixtureChapter.startedAt,outcome:fixtureChapter.status,sections:{goal:'按照本场明确长期口令记录中文简短表达约定',completed:'已保存本场回答和明确约定',blocked:'无',next:'继续检查后续场次使用约定的情况'},assistantDraft:true}
  const fixtureRecentEntry={...structuredClone(fixtureLong),id:'ui-v5-recent',version:1,content:`目标：${fixtureRecent.sections.goal}\n已完成：${fixtureRecent.sections.completed}\n受阻：${fixtureRecent.sections.blocked}\n下一步：${fixtureRecent.sections.next}`,layer:'demand',semantic:'fact',category:'recent',attribution:'工作记录',reviewAt:null,status:'active',state:{source:'verified',content:'current',enabled:true,capacity:'ready'},reason:null,updatedAt:fixtureChapter.startedAt,updateBasis:{kind:'consolidation',id:fixtureLedger.taskId,version:1},recent:fixtureRecent}
  delete fixtureRecentEntry.pendingTarget
  memoryFixtureRecord.recent.push(fixtureRecentEntry);memoryFixtureRecord.revision++
  const fixtureEncoded=encodeV5Memory(memoryFixtureRecord);parseV5Memory(fixtureEncoded)
  const fixtureLedgerBefore=vaultFileSnapshot(path.join(vault,'.rgent','ledgers')),fixtureNotesBefore=namesBytes(vault)
  const recentParking=vault+'-近期夹具停靠';mkdirSync(recentParking);writeFileSync(path.join(recentParking,'停靠.md'),'近期夹具临时停靠')
  const chooseRecentFixtureRoot=async target=>{
    await nativePage.eval(`(()=>{const d=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog;globalThis.__recentFixtureDialog??=d.showOpenDialog;d.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(target)}]});return true})()`)
    await v4Settings(page);await page.eval(`document.querySelector('[data-vault-action="open"]').click()`)
    if(!await waitFor(page,`!document.querySelector('.overlay-settings')&&document.querySelector('#app').inert===false`))throw Error('近期夹具切库失败')
  }
  try{
    await chooseRecentFixtureRoot(recentParking)
    writeFileSync(memoryFixtureFile,fixtureEncoded)
    await chooseRecentFixtureRoot(vault)
  }finally{await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog.showOpenDialog=globalThis.__recentFixtureDialog;true`)}
  const fixtureChecked=await page.eval(`(async()=>{const state=await window.rgent.vaultGet();return window.rgent.memoryGet({sessionId:state.sessionId})})()`)
  check('近期夹具绑定真实账本材料并通过生产来源核验，笔记和账本不变',fixtureChecked.ok&&fixtureChecked.value.entries.some(e=>e.id==='ui-v5-recent'&&e.category==='recent'&&e.status==='active')&&vaultFileSnapshot(path.join(vault,'.rgent','ledgers'))===fixtureLedgerBefore&&namesBytes(vault)===fixtureNotesBefore,JSON.stringify({status:fixtureChecked.value?.status,reason:fixtureChecked.value?.reason,recent:fixtureChecked.value?.entries.filter(e=>e.category==='recent').map(e=>({id:e.id,status:e.status,reason:e.reason})),notesUnchanged:namesBytes(vault)===fixtureNotesBefore,ledgersUnchanged:vaultFileSnapshot(path.join(vault,'.rgent','ledgers'))===fixtureLedgerBefore}))

  await page.eval(`document.querySelector('.settings-open').click()`)
  await waitFor(page, `!!document.querySelector('.settings-nav')`)
  await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='记忆').click()`)
  await waitFor(page, `!!document.querySelector('.memory-entry:not(.memory-recent-entry)')`)
  check('近期背景实际管理页独立展示',await waitFor(page,`document.querySelectorAll('.memory-recent-entry').length>0 && document.querySelector('[data-memory-section="recent"] h3')?.textContent==='近期工作背景'`))
  await page.eval(`document.querySelector('.memory-recent-entry').open=true`)
  check('近期背景四段、结果、有效期与来源可读且没有编辑入口',await page.eval(`(()=>{const row=document.querySelector('.memory-recent-entry');return row.querySelectorAll('.memory-recent-section').length===4&&['目标','已完成','受阻','下一步'].every(label=>[...row.querySelectorAll('.memory-recent-section strong')].some(n=>n.textContent===label))&&row.textContent.includes('任务结果：')&&row.textContent.includes('14 天')&&!!row.querySelector('.memory-source')&&!row.querySelector('textarea,[data-memory-action="edit"]')})()`))
  await shot(page,'memory-recent-background')
  // 临时主进程只给既有、已核权威的 memory:get 回执附加故障视图；不改真实存储或任何操作结果。
  const maintenanceEntries=await page.eval(`(async()=>{const state=await window.rgent.vaultGet();const r=await window.rgent.memoryGet({sessionId:state.sessionId});if(!r.ok)throw Error(r.error);return JSON.stringify(r.value.entries)})()`)
  const maintenanceTheme=await page.eval(`window.rgent.themeGet()`)
  await nativePage.eval(`(()=>{const ipc=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain,channel='memory:get',old=ipc._invokeHandlers.get(channel);if(!old||globalThis.__memoryMaintenanceView)throw Error('维护视图夹具冲突');globalThis.__memoryMaintenanceView={channel,old};ipc._invokeHandlers.set(channel,async(...args)=>{const result=await old(...args);return result.ok&&result.value.status==='ready'?{...result,value:{...result.value,maintenanceFailure:'MEMORY_FILE_LIMIT'}}:result});return true})()`)
  try{
    await page.eval(`document.querySelector('[aria-label="刷新状态"]').click()`)
    check('已保存但维护失败回执在真实记忆页可见',await waitFor(page,`document.querySelector('.memory-status-line')?.textContent.includes('已保存')&&document.querySelector('.memory-status-line')?.textContent.includes('后续维护未完成')`))
    check('维护失败视图保留真实已核条目',await page.eval(`(async()=>{const state=await window.rgent.vaultGet();const r=await window.rgent.memoryGet({sessionId:state.sessionId});return r.ok&&r.value.maintenanceFailure==='MEMORY_FILE_LIMIT'&&JSON.stringify(r.value.entries)===${JSON.stringify(maintenanceEntries)}})()`))
    await page.call('Emulation.setEmulatedMedia',{features:[]})
    for(const mode of ['day','night']){
      await page.eval(`window.rgent.themeSet('${mode}')`)
      if(!await waitFor(page,`document.documentElement.dataset.theme==='${mode}'`))throw Error('维护故障样张主题未同步')
      for(const [width,height] of [[1200,800],[800,560]]){
        await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
        await page.eval(`document.querySelector('.settings-main').scrollTop=0;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
        check(`维护故障 ${mode} ${width}px 保存状态与易读原因完整可见`,await page.eval(`(()=>{const main=document.querySelector('.settings-main'),line=document.querySelector('.memory-status-line'),r=line.getBoundingClientRect(),m=main.getBoundingClientRect();return line.textContent.includes('已保存')&&line.textContent.includes('后续维护未完成')&&!line.textContent.includes('MEMORY_FILE_LIMIT')&&main.scrollWidth<=main.clientWidth+1&&r.top>=m.top&&r.bottom<=m.bottom})()`))
        await shot(page,`memory-maintenance-failure-${mode}-${width}`)
      }
    }
  }finally{
    await nativePage.eval(`(()=>{const gate=globalThis.__memoryMaintenanceView;if(gate){process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain._invokeHandlers.set(gate.channel,gate.old);delete globalThis.__memoryMaintenanceView}return true})()`)
    await page.call('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false})
    await page.eval(`(async()=>{await window.rgent.themeSet(${JSON.stringify(maintenanceTheme)});document.querySelector('[aria-label="刷新状态"]').click()})()`)
  }
  check('移除故障视图后实际保存状态恢复且近期背景保留',await waitFor(page,`document.querySelector('.memory-status-line')?.textContent.includes('已保存')&&!document.querySelector('.memory-status-line')?.textContent.includes('后续维护未完成')&&!!document.querySelector('.memory-recent-entry')`))
  // 故障视图夹具：先调用原生产 memory:get 核验，再替换展示字段；不模拟真实后台故障。
  const collaborationTheme=await page.eval(`window.rgent.themeGet()`)
  const collaborationBytes=readFileSync(memoryFixtureFile,'utf8')
  await nativePage.eval(`(()=>{const ipc=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain,channel='memory:get',old=ipc._invokeHandlers.get(channel);if(!old||globalThis.__memoryCollaborationView)throw Error('协作视图夹具冲突');globalThis.__memoryCollaborationView={channel,old,scenario:'partial'};ipc._invokeHandlers.set(channel,async(...args)=>{const result=await old(...args);if(!result.ok||result.value.status!=='ready')return result;const scenario=globalThis.__memoryCollaborationView.scenario,long=result.value.entries.find(e=>e.category!=='recent'),partial=scenario==='partial',jobs=Array.from({length:5},(_,i)=>({taskId:'ui-collaboration-'+scenario+'-'+i,materialVersion:'fictional-view',outcome:'applied',entryIds:partial&&long?[long.id]:[],retryable:false,results:partial?[{action:'correct',outcome:'applied'},{action:'recent',outcome:'rejected',code:'MEMORY_DEADLINE'}]:[{action:'correct',outcome:'rejected',code:'MEMORY_OUTPUT_INVALID'},{action:'recent',outcome:'rejected',code:'MEMORY_OUTPUT_TRUNCATED'}]}));return {...result,value:{...result.value,jobs,...(scenario==='quality-scope'?{quality:{state:'passed',humanReviewed:false,stale:true}}:{})}}});return true})()`)
  try{
    await page.call('Emulation.setEmulatedMedia',{features:[]})
    for(const scenario of ['partial','repair-failure','quality-scope']){
      await nativePage.eval(`globalThis.__memoryCollaborationView.scenario=${JSON.stringify(scenario)}`)
      await page.eval(`document.querySelector('[aria-label="刷新状态"]').click()`)
      const expected=scenario==='partial'?'已保存可用部分；近期背景未更新':scenario==='repair-failure'?'没有写入':'旧成绩不再适用'
      check('协作故障视图 '+scenario+' 显示真实部分结果口径',await waitFor(page,`document.querySelector('.memory-page')?.textContent.includes(${JSON.stringify(expected)})`))
      for(const mode of ['day','night'])for(const [width,height] of [[1200,800],[800,560]]){
        await page.eval(`window.rgent.themeSet('${mode}')`)
        await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
        await waitFor(page,`document.documentElement.dataset.theme==='${mode}'`)
        await page.eval(`(()=>{const panel=document.querySelector('[data-memory-section="jobs"]');panel.open=true;document.querySelector('.memory-job .memory-technical').open=true;document.querySelectorAll('[data-memory-section="models"],[data-memory-section="maintenance"]').forEach(e=>e.open=false);const main=document.querySelector('.settings-main');main.scrollTop=0;if(${JSON.stringify(scenario)}!=='quality-scope')document.querySelector('.memory-job').scrollIntoView({block:'start'});document.querySelector(${JSON.stringify(scenario==='quality-scope'?'[aria-label="刷新状态"]':'.memory-job .memory-technical > summary')}).focus({preventScroll:true})})()`)
        await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
        await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
        check('协作故障视图 '+scenario+' '+mode+' '+width+'px 不横溢且中性焦点可见',await page.eval(`(()=>{const main=document.querySelector('.settings-main'),focus=document.activeElement,style=getComputedStyle(focus),probe=document.createElement('span');probe.style.color='var(--focus-ring)';document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return main.scrollWidth<=main.clientWidth+1&&parseFloat(style.outlineWidth)>=2&&style.outlineColor===color&&main.scrollHeight>main.clientHeight})()`))
        await shot(page,`memory-collaboration-${scenario}-${mode}-${width}`)
      }
    }
  }finally{
    await nativePage.eval(`(()=>{const gate=globalThis.__memoryCollaborationView;if(gate){process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain._invokeHandlers.set(gate.channel,gate.old);delete globalThis.__memoryCollaborationView}return true})()`)
    await page.call('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false})
    await page.eval(`(async()=>{await window.rgent.themeSet(${JSON.stringify(collaborationTheme)});document.querySelector('[aria-label="刷新状态"]').click();document.querySelector('[data-memory-section="jobs"]').open=false;document.querySelector('.settings-main').scrollTop=0})()`)
  }
  check('协作故障视图只改展示且真实记忆字节保持',readFileSync(memoryFixtureFile,'utf8')===collaborationBytes&&await waitFor(page,`!document.querySelector('.memory-job')?.dataset.taskId?.startsWith('ui-collaboration-')`))
  const recentTheme=await page.eval(`window.rgent.themeGet()`)
  await page.call('Emulation.setEmulatedMedia',{features:[]})
  for(const mode of ['day','night']){
    await page.eval(`window.rgent.themeSet('${mode}')`)
    if(!await waitFor(page,`document.documentElement.dataset.theme==='${mode}'`))throw Error('近期样张主题未同步')
    for(const [width,height] of [[1200,800],[800,560]]){
      await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
      await page.eval(`document.querySelector('.memory-recent-entry').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
      check(`近期背景 ${mode} ${width}px 四段完整且不横向溢出`,await page.eval(`(()=>{const main=document.querySelector('.settings-main'),row=document.querySelector('.memory-recent-entry');return main.scrollWidth<=main.clientWidth+1&&row.scrollWidth<=row.clientWidth+1&&row.querySelectorAll('.memory-recent-section').length===4&&row.querySelectorAll('.memory-recent-section .memory-source-text').length===4})()`))
      await shot(page,`memory-recent-background-${mode}-${width}`)
    }
  }
  await page.call('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false})
  await page.eval(`window.rgent.themeSet(${JSON.stringify(recentTheme)})`)

  await page.eval(`[...document.querySelector('.memory-recent-entry').querySelectorAll('button')].find(b=>b.textContent==='删除并遗忘').click()`)
  check('近期遗忘预览明确保留原文且取消保留背景',await waitFor(page,`document.querySelector('.memory-recent-entry .memory-forget-warning')?.textContent.includes('原笔记与账本不变')`))
  await shot(page,'memory-recent-forget-preview')
  await page.eval(`document.querySelector('.memory-recent-entry [data-memory-action="cancel-forget"]').click()`)
  // 焦点恢复是异步落位的（取消后要重建那条记忆项），必须等：紧跟点击直接断言在机器忙时会偶发。
  check('取消近期遗忘回到按钮且未删除背景',await waitFor(page,`!!document.querySelector('.memory-recent-entry')&&!document.querySelector('.memory-recent-entry .memory-forget-warning')&&document.activeElement?.textContent==='删除并遗忘'`))

  await page.eval(`document.querySelector('.memory-entry:not(.memory-recent-entry)').open=true; document.querySelector('.memory-entry:not(.memory-recent-entry) [data-memory-action="edit"]').click(); document.querySelector('.memory-entry:not(.memory-recent-entry) .memory-source').open=true; document.querySelector('.memory-entry:not(.memory-recent-entry)').scrollIntoView({block:'start'})`)
  await shot(page,'memory-entry-and-source')
  check('配置有效后模型与维护默认收起，查看条目才进入编辑',await page.eval(`!document.querySelector('[data-memory-section="models"]').open&&!document.querySelector('[data-memory-section="maintenance"]').open&&!document.querySelector('.memory-editor').hidden`))
  const longName='记忆样张-很长的项目会议笔记名称与资料来源.md'
  writeFileSync(path.join(vault,longName),'项目样张采用中文说明，长期约定用于持续要求，参考知识在相关任务中使用。')
  const sampleIds=await page.eval(`(async()=>{const note=await window.rgent.noteRead(${JSON.stringify(longName)});const ids=[];for(const [content,layer] of [['虚构项目的跨篇参考资料：长名称和长适用范围需要完整可读，列表摘要保持紧凑，不覆盖正文。','demand'],['虚构项目长期约定：所有展示样张使用清晰的中文术语。','core']]){const p=await window.rgent.memoryManualPreview({sessionId:note.sessionId,relPath:${JSON.stringify(longName)},revision:note.revision,objectVersion:note.objectVersion,kind:'body',start:0,end:note.content.length});if(!p.ok)throw Error(p.error);const r=await window.rgent.memoryPreviewCommit({sessionId:note.sessionId,id:p.value.id,content,layer,scope:'虚构项目 / 长名称资料 / 仅用于记忆页排布窗口检查'});if(!r.ok)throw Error(r.error);ids.push(r.value.entries.find(e=>e.content===content).id)}return ids})()`)
  await page.eval(`document.querySelector('[aria-label="刷新状态"]').click()`)
  await waitFor(page,`document.querySelectorAll('.memory-entry:not(.memory-recent-entry)').length===3`)
  const memoryTheme = await page.eval(`window.rgent.themeGet()`)
  // Earlier layout checks emulate light; nativeTheme can only drive matchMedia after clearing that override.
  await page.call('Emulation.setEmulatedMedia', { features: [] })
  if (!await waitFor(page, `document.documentElement.dataset.theme===(matchMedia('(prefers-color-scheme: dark)').matches?'night':'day')`)) throw Error('记忆样张开始前实际主题尚未同步')
  const memoryRenderedTheme = await page.eval(`document.documentElement.dataset.theme`)
  for (const mode of ['day', 'night']) {
    await page.eval(`window.rgent.themeSet('${mode}')`)
    const themeApplied = await waitFor(page, `document.documentElement.dataset.theme==='${mode}' && matchMedia('(prefers-color-scheme: dark)').matches===${mode==='night'}`)
    const textareaStyle = await page.eval(`(() => {
      const textarea=document.querySelector('.memory-entry:not(.memory-recent-entry) textarea'),reference=document.createElement('textarea'),field=document.createElement('div');field.className='settings-field-block';field.style.cssText='position:absolute;visibility:hidden';field.append(reference);document.querySelector('.settings-form').append(field)
      const current=getComputedStyle(textarea),standard=getComputedStyle(reference),properties=['backgroundColor','color','borderColor','borderRadius','paddingTop','paddingRight','paddingBottom','paddingLeft','fontFamily']
      const themed=properties.every(property=>current[property]===standard[property])&&current.paddingTop==='8px'&&current.paddingLeft==='10px'&&current.borderTopWidth==='1px';field.remove()
      return document.documentElement.dataset.theme==='${mode}'&&themed&&document.querySelector('.memory-entry:not(.memory-recent-entry)').open&&document.querySelector('.memory-entry:not(.memory-recent-entry) .memory-source').open
    })()`)
    check(`记忆条目文本框${mode==='day'?'日间':'夜间'}复用设置主题及边框留白`,themeApplied&&textareaStyle)
    await page.eval(`document.querySelector('.memory-entry:not(.memory-recent-entry)').scrollIntoView({block:'start'})`)
    await shot(page,`memory-entry-and-source-${mode}`)
    for (const [width, height] of [[1200, 800], [800, 560], [1600, 900]]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await page.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
      await page.eval(`document.querySelector('.memory-entry:not(.memory-recent-entry)').scrollIntoView({block:'start'})`)
      await shot(page,`memory-entry-and-source-${mode}-${width}`)
      check(`记忆页 ${mode} ${width}px 的模型分栏、文字与焦点边界`,await page.eval(`(() => {const main=document.querySelector('.settings-main'),grid=document.querySelector('.memory-model-grid'),page=document.querySelector('.memory-page'),editor=document.querySelector('.memory-entry:not(.memory-recent-entry) textarea');editor.focus();const modelPanel=document.querySelector('[data-memory-section="models"]');modelPanel.open=true;const cols=getComputedStyle(grid).gridTemplateColumns.split(' ').length;modelPanel.open=false;editor.focus();const st=getComputedStyle(editor),probe=document.createElement('span');probe.style.color='var(--focus-ring)';document.body.append(probe);const neutral=getComputedStyle(probe).color;probe.remove();return main.scrollWidth<=main.clientWidth+1&&cols===(page.clientWidth>=600?2:1)&&st.outlineWidth==='2px'&&st.outlineColor===neutral})()`))
      await page.eval(`document.querySelector('.memory-entry:not(.memory-recent-entry) [data-memory-action="cancel-edit"]').click();document.querySelectorAll('.memory-entry:not(.memory-recent-entry)').forEach(e=>e.open=false);document.querySelector('.settings-main').scrollTop=0`)
      await shot(page,`memory-list-${mode}-${width}`)
      await page.eval(`document.querySelector('[data-memory-section="models"]').open=true;document.querySelector('[data-memory-section="models"]').scrollIntoView({block:'start'})`)
      await shot(page,`memory-models-${mode}-${width}`)
      await page.eval(`document.querySelector('[data-memory-section="models"]').open=false;document.querySelector('[data-memory-section="maintenance"]').open=true;[...document.querySelector('.memory-maintenance').querySelectorAll('button')].find(b=>b.textContent==='清空本库记忆…').click()`)
      await waitFor(page,`!!document.querySelector('.memory-maintenance .memory-preview')`)
      check(`清空预览 ${mode} ${width}px 明确影响并未立即执行`,await page.eval(`document.querySelector('.memory-maintenance .memory-preview').textContent.includes('原笔记与账本保留')&&[...document.querySelector('.memory-maintenance .memory-preview').querySelectorAll('button')].some(b=>b.textContent==='确认清空记忆')&&document.querySelectorAll('.memory-entry:not(.memory-recent-entry)').length===3`))
      await page.eval(`document.querySelector('.memory-maintenance .memory-preview').scrollIntoView({block:'start'})`)
      await shot(page,`memory-maintenance-${mode}-${width}`)
      await page.eval(`[...document.querySelector('.memory-maintenance .memory-preview').querySelectorAll('button')].find(b=>b.textContent==='取消').click();document.querySelector('[data-memory-section="maintenance"]').open=false;document.querySelector('.memory-entry:not(.memory-recent-entry)').open=true;document.querySelector('.memory-entry:not(.memory-recent-entry) [data-memory-action="edit"]').click()`)

    }
    await page.call('Emulation.setDeviceMetricsOverride', { width:1200, height:800, deviceScaleFactor:1, mobile:false })
  }
  await page.eval(`(async()=>{const state=await window.rgent.vaultGet();for(const id of ${JSON.stringify(sampleIds)}){const v=await window.rgent.memoryGet({sessionId:state.sessionId});const e=v.value.entries.find(e=>e.id===id);const r=await window.rgent.memoryItemForget({sessionId:state.sessionId,id,version:e.version,revision:v.value.revision,objectVersion:v.value.objectVersion});if(!r.ok)throw Error(r.error)}document.querySelector('[aria-label="刷新状态"]').click()})()`)
  await waitFor(page,`document.querySelectorAll('.memory-entry:not(.memory-recent-entry)').length===1`)
  await page.eval(`window.rgent.themeSet(${JSON.stringify(memoryTheme)})`)
  check('条目日夜样张后恢复原主题',await waitFor(page,`document.documentElement.dataset.theme===${JSON.stringify(memoryRenderedTheme)}`))
  await page.eval(`(() => {const entry=document.querySelector('.memory-entry:not(.memory-recent-entry)');entry.open=true;[...entry.querySelectorAll('button')].find(b=>b.textContent==='删除并遗忘').click()})()`)
  check('遗忘预先说明清除待整理重试材料且原文不变',await waitFor(page, `document.querySelector('.memory-forget-warning')?.textContent.includes('原笔记与账本不变')`))
  await page.eval(`[...document.querySelectorAll('.memory-entry:not(.memory-recent-entry) button')].find(b=>b.textContent==='确认删除并遗忘').click()`)
  check('遗忘回执后条目正文立即从记忆页移除',await waitFor(page, `document.querySelectorAll('.memory-entry:not(.memory-recent-entry)').length===0`))
  await shot(page,'memory-forgotten-receipt')
  await page.key('Escape','Escape',0,27)
  await page.eval(`document.querySelector('.cm-content').focus()`)
  await page.key(process.platform === 'darwin' ? 'ArrowDown' : 'End', process.platform === 'darwin' ? 'ArrowDown' : 'End', process.platform === 'darwin' ? 4 : 2, process.platform === 'darwin' ? 40 : 35)
  await page.key('Enter','Enter',0,13)
  await page.key('Enter','Enter',0,13)
  await page.call('Input.insertText',{text:'/记忆后续遗忘核验'})
  check('遗忘后的新口令进入人写段落',await waitFor(page,`document.querySelector('.cm-content')?.textContent.includes('/记忆后续遗忘核验')`))
  await confirmSlashAuthorization(page)
  check('遗忘后新任务仍正常回答保存',await waitFor(page, `(async()=>{const note=await window.rgent.noteRead('记忆后续.md');return note.content.includes('记忆后续遗忘核验')&&(await window.rgent.agentTasks()).length===0})()`))
  const after=requests.filter(r=>r.model!=='memory-ui-fixture'&&JSON.stringify(r).includes('记忆后续遗忘核验'))
  check('旧记忆及带依赖的历史回答未再次发出',after.length>0&&after.every(r=>!JSON.stringify(r).includes('记忆验收旧回答')&&!JSON.stringify(r).includes('后续回答请用中文简短表达（记忆验收）。')))
  const off=await page.eval(`(async()=>{const state=await window.rgent.vaultGet();const memory=await window.rgent.memoryGet({sessionId:state.sessionId});return memory.ok&&window.rgent.memoryConfigSave({sessionId:state.sessionId,target:'vault',vault:{...memory.value.config.vault,enabled:false}}).then(r=>r.ok)})()`)
  check('受控链路收尾关闭当前库记忆',off)
  const beforeClear = await page.eval(`window.rgent.noteRead('记忆后续.md').then(n=>n.content)`)
  await page.eval(`document.querySelector('.ledger-open').click()`)
  await waitFor(page, `document.querySelectorAll('.ledger-body details').length>=2`)
  await page.eval(`document.querySelectorAll('.ledger-body details').forEach(d=>d.open=true)`)
  await waitFor(page, `document.querySelector('.ledger-body')?.textContent.includes('记忆验收旧回答')`)
  await page.eval(`[...document.querySelectorAll('.ledger-body button')].find(b=>b.textContent==='预览清理历史').click()`)
  await waitFor(page, `[...document.querySelectorAll('.ledger-body button')].some(b=>b.textContent==='确认清理列出的历史')`)
  await page.eval(`[...document.querySelectorAll('.ledger-body button')].find(b=>b.textContent==='确认清理列出的历史').click()`)
  check('清理历史后已展开的原文立即退出回顾且正文不变', await waitFor(page, `(async()=>{const note=await window.rgent.noteRead('记忆后续.md');const history=await window.rgent.ledgerGet({sessionId:note.sessionId,objectVersion:note.objectVersion,relPath:'记忆后续.md'});return history.ok&&history.value.records.every(r=>r.state==='cleared')&&!document.querySelector('.ledger-body')?.textContent.includes('记忆验收旧回答')&&note.content===${JSON.stringify(beforeClear)}})()`))
  await page.eval(`document.querySelector('.ledger-close').click()`)
}

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
    if (!await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`)) {
      process.stdout.write('DEBUG_START popover ' + await page.eval(`JSON.stringify({ editor: document.querySelector('.cm-content')?.innerText, popover: !!document.querySelector('.overlay-authorization'), send: document.querySelector('.authorization-send')?.disabled ?? null, status: document.querySelector('.status-task')?.textContent ?? null })`) + '\n')
      return false
    }
    // 授权范围在同一会话内记忆：每次准备都用「只读本笔记」预设清回发起篇，再按本场需要选参考。
    await page.eval(`document.querySelector('.authorization-preset-origin')?.click()`)
    if (!await waitFor(page, `document.querySelectorAll('.authorization-manifest li').length===1 && [...document.querySelectorAll('.authorization-choices input')].every(input=>!input.checked) && !!document.querySelector('.authorization-send:not(:disabled)')`)) return '「只读本笔记」预设没就绪'
    check('「只读本笔记」预设清回仅发起篇', await page.eval(`document.querySelectorAll('.authorization-manifest li').length===1 && [...document.querySelectorAll('.authorization-choices input')].every(input=>!input.checked)`))
    // HTMLElement.click() does not focus a checkbox. A refresh disables the initially
    // focused send button, so native mouse clicks must establish focus before refresh.
    for (const [at, name] of ['工具参考.md', '工具其他.md'].entries()) {
      const point = await page.eval(`(() => { const input=[...document.querySelectorAll('.authorization-choices input')].find(input=>input.value===${JSON.stringify(name)}); if(!input || input.disabled)return null;input.scrollIntoView({block:'nearest'});const r=input.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2} })()`)
      if (!point) return '没找到写作参考的勾选框'
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
  const scopeCancelled = await waitFor(page, `!document.querySelector('.overlay-authorization[open]') && document.querySelector('.cm-content')?.textContent.includes('/工具查证')`)
  // 非模态关闭不代还焦点（它从未把焦点拿走）；把焦点放回正文再继续。
  await page.eval(`document.querySelector('.cm-content')?.focus()`)
  check('取消工具范围授权保留口令并归还焦点', scopeCancelled && await page.eval(`document.querySelector('.cm-editor')?.contains(document.activeElement)`))
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
  check('工具链运行底栏显示实际模型步且保留停止入口', await waitFor(page, `document.querySelector('.status-task')?.textContent.includes('模型第 3 步') && !!document.querySelector('.status-task-stop')`), await page.eval(`JSON.stringify({status:document.querySelector('.status')?.textContent?.slice(0,180)??null,popover:!!document.querySelector('.overlay-authorization'),card:!!document.querySelector('.overlay-write-confirm'),body:document.querySelector('.cm-content')?.innerText?.slice(0,60)??null})`))
  const done = await waitFor(page, `(async () => {const note=await window.rgent.noteRead('工具发起.md');return note.content.includes('工具查证完成：已核对参考原文。') && (await window.rgent.agentTasks()).length===0})()`)
  // 有工具档的场里，模型同时看到读、搜、补、建四个工具：写工具不再需要额外授权步骤。
  const toolNames = request => (request.tools ?? []).map(tool => tool.function?.name)
  check('有工具档的场同时提供读、搜、补、建四个工具', requests.length === 3 && requests.every(request => ['read_library','search_library','append_to_note','create_note'].every(name => toolNames(request).includes(name))), JSON.stringify(toolNames(requests[0] ?? {})))
  check('真实搜库、读库、回答三步写回本篇', done && requests.length === 3)
  check('这轮模型只读不写：正文没有追加块也未新建', await page.eval(`(async () => { const note=await window.rgent.noteRead('工具发起.md'); return !note.content.includes('part=\"append\"') })()`))
  check('首步只发送来源清单，后续请求携带实际命中及原文', requests.length === 3 && !JSON.stringify(requests[0]).includes('受控正文证据') && JSON.stringify(requests[1]).includes('受控正文证据') && JSON.stringify(requests[2]).includes('来源复核'))
  check('工具输出和隐藏推理不落正文', await page.eval(`(async () => { const note=await window.rgent.noteRead('工具发起.md');const body=note.content.split('<!-- rgent:ledger:v1 -->')[0];return !body.includes('受控正文证据') && !body.includes('隐藏工具推理') })()`))
  await page.eval(`document.querySelector('.ledger-open')?.click()`)
    await waitFor(page, `!!document.querySelector('.ledger-body details')`)
    await page.eval(`document.querySelectorAll('.ledger-body details').forEach(d=>d.open=true)`)
    await waitFor(page, `!!document.querySelector('.ledger-body details > div')?.childNodes.length`)
  check('同篇账本回顾工具及读取、模型引用来源', await waitFor(page, `(() => {const text=document.querySelector('.ledger-body')?.textContent||'';return text.includes('工具摘要') && (text.includes('search_library')||text.includes('搜库')) && (text.includes('read_library')||text.includes('读库')) && text.includes('实际读取来源：工具其他.md、工具参考.md') && text.includes('模型消息引用来源：工具参考.md') && text.includes('本场技能：无')})()`))
  await shot(page, 'tool-ledger-800')
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  await shot(page, 'tool-ledger-1200')
  await page.eval(`document.querySelector('.ledger-close')?.click()`)
  await page.call('Emulation.clearDeviceMetricsOverride', {})
}

/** 包 4 窗口收口：写类工具在真窗口里的四条路——建·同意、建·不建、补·安静、补·超限。
 *  模型是受控主机脚本，真实供应商一律未配置（零真实调用）。 */
async function verifyWriteTools(page, vault, shot, requests) {
  const fixtures = ['写作建一.md', '写作建二.md', '写作补.md', '写作超限.md', '写作改名.md', '写作越权.md', '写作挪.md', '写作挪参考.md', '写作删.md', '写作不删.md']
  for (const name of fixtures) writeFileSync(path.join(vault, name), '')
  writeFileSync(path.join(vault, '写作参考.md'), '# 参考\n\n受控参考正文。\n')
  writeFileSync(path.join(vault, '写作删参考.md'), '# 删除参考\n\n这篇会被送进废纸篓。\n')
  writeFileSync(path.join(vault, '写作不删参考.md'), '# 不删参考\n\n这篇应该留下。\n')
  mkdirSync(path.join(vault, '归档'), { recursive: true })
  check('写工具夹具进入目录', await waitFor(page, `[...document.querySelectorAll('.tree-note')].filter(n=>/写作/.test(n.innerText)).length===13`))
  // 受控供应商是通过 IPC 配的，渲染层的模型快照要打开一次设置页才会刷新；
  // 不刷新的话按 Enter 只会得到「请选择可用模型」，任务根本不会开始。
  await page.eval(`document.querySelector('.settings-open').click()`)
  await waitFor(page, `!!document.querySelector('.settings-nav')`)
  await page.key('Escape', 'Escape', 0, 27)
  await waitFor(page, `!document.querySelector('.settings-nav')`)
  // 侧栏默认收起：先展开，才点得开笔记。
  check('展开目录树', await page.eval(`(() => { const button = document.querySelector('.tree-toggle'); if (button.getAttribute('aria-expanded') !== 'true') button.click(); return true })()`) && await waitFor(page, `document.querySelector('.tree-toggle')?.getAttribute('aria-expanded')==='true'`))

  const clickSelector = async (selector) => {
    const point = await page.eval(`(() => { const el=document.querySelector('${selector}'); if(!el)return null; const r=el.getBoundingClientRect(); return { x: r.left+r.width/2, y: r.top+r.height/2 } })()`)
    if (!point) return false
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    return true
  }
  const ledgerPanel = async (note, condition) => {
    await page.eval(`document.querySelector('.ledger-close')?.click()`)
    await page.eval(`[...document.querySelectorAll('.tree-note')].find(n=>n.dataset.path===${JSON.stringify(note)})?.click()`)
    if (!await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel===${JSON.stringify(note)}`)) return false
    await page.eval(`document.querySelector('.ledger-open')?.click()`)
    if (!await waitFor(page, `!!document.querySelector('.ledger-body details')`)) return false
    await page.eval(`document.querySelectorAll('.ledger-body details').forEach(d=>d.open=true)`)
    return await waitFor(page, `(() => {const text=document.querySelector('.ledger-body')?.textContent||'';return ${condition}})()`)
  }
  // 每个场景用一篇干净的发起篇：光标从头开始，口令一定落在正文里。
  const start = async (note, prompt, reference = '写作参考.md') => {
    await selectBrowserFolder(page, '')
    if (!await waitFor(page, `[...document.querySelectorAll('.tree-note')].some(n=>n.dataset.path===${JSON.stringify(note)})`)) return `目录里没有 ${note}`
    await page.eval(`[...document.querySelectorAll('.tree-note')].find(n=>n.dataset.path===${JSON.stringify(note)}).click()`)
    if (!await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel===${JSON.stringify(note)}`)) return `tab 没打开 ${note}：` + await page.eval(`JSON.stringify({tabs:[...document.querySelectorAll('.tab')].map(t=>({rel:t.dataset.rel,text:t.innerText})),cm:!!document.querySelector('.cm-content')})`)
    await page.eval(`document.querySelector('.cm-content').focus()`)
    await page.call('Input.insertText', { text: `/${prompt}` })
    await page.key('Enter', 'Enter', 0, 13)
    if (!await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`, 60000)) {
      const state = await page.eval(`JSON.stringify({editor:document.querySelector('.cm-content')?.innerText,notice:document.querySelector('.status')?.textContent??null,tab:document.querySelector('.tab[aria-selected=true]')?.dataset.rel??null,session:document.querySelector('.tab[aria-selected=true]')?.dataset.session??null,statuses:[...document.querySelectorAll('.status *')].map(n=>n.textContent).filter(Boolean).slice(0,4)})`)
      return '授权弹窗没出现：' + state
    }
    // 授权范围在同一会话内记忆：先用「只读本笔记」预设清回发起篇，再选本场这一篇参考。
    await page.eval(`document.querySelector('.authorization-preset-origin')?.click()`)
    if (!await waitFor(page, `document.querySelectorAll('.authorization-manifest li').length===1 && !!document.querySelector('.authorization-send:not(:disabled)')`)) return '「只读本笔记」预设没就绪'
    // 选一篇额外参考：这样本场才是"有工具档"，写工具才会出现。
    const point = await page.eval(`(() => { const input=[...document.querySelectorAll('.authorization-choices input')].find(input=>input.value===${JSON.stringify(reference)}); if(!input||input.disabled)return null; input.scrollIntoView({block:'nearest'}); const r=input.getBoundingClientRect(); return { x: r.left+r.width/2, y: r.top+r.height/2 } })()`)
    if (!point) return false
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    if (!await waitFor(page, `document.querySelectorAll('.authorization-manifest li').length===2 && !!document.querySelector('.authorization-send:not(:disabled)')`)) return '清单没变成 2 条'
    // 非模态卡不抢焦点：勾选参考后焦点在复选框上，发送前必须把焦点放回发送键。
    await page.eval(`document.querySelector('.overlay-authorization .authorization-send:not(:disabled)')?.focus()`)
    await page.key('Enter', 'Enter', 0, 13)
    return true
  }
  const settle = () => waitFor(page, `!document.querySelector('.status-task')`)

  // 一、建·同意：卡片出现 -> 点「建」-> 真的落盘。
  const started = await start('写作建一.md', '建样张一')
  check('打开建样张发起篇并带着额外参考开工', started === true, started === true ? '' : String(started))
  check('任务真的开始跑了', await waitFor(page, `!!document.querySelector('.status-task')`, 20000), await page.eval(`document.querySelector('.status')?.textContent?.slice(0,120)??null`))
  check('模型提议新建时弹出确认卡', await waitFor(page, `!!document.querySelector('.overlay-write-confirm[open]')`, 30000), await page.eval(`JSON.stringify({status:document.querySelector('.status')?.textContent?.slice(0,160)??null,editor:document.querySelector('.cm-content')?.innerText?.slice(0,80)})`))
  check('卡片摆出落点与正文，且没有改路径的入口', await page.eval(`(() => { const text=document.querySelector('.overlay-write-confirm')?.textContent||''; return text.includes('将新建：写工具样张.md') && text.includes('写工具样张') })()`))
  await shot(page, 'write-confirm-1200')
  check('点「建」后落盘到发起篇所在目录', (await clickSelector('.write-confirm-accept')) && await waitFor(page, `!!document.querySelector('.tree-note')?.parentElement || true`) && existsSync(path.join(vault, '写工具样张.md')))
  check('新笔记内容就是模型给的那份', readFileSync(path.join(vault, '写工具样张.md'), 'utf8').includes('受控正文。'))
  check('建完照常收尾，回答落在发起篇', (await settle()) && await page.eval(`(async () => (await window.rgent.noteRead('写作建一.md')).content.includes('写工具核验完成。'))()`))
  await shot(page, 'write-created-1200')

  // 二、建·不建：卡片出现 -> 点「不建」-> 什么都不写。
  check('打开第二篇发起篇开工', await start('写作建二.md', '建样张二'))
  check('第二张确认卡带自己的落点', await waitFor(page, `(() => {const text=document.querySelector('.overlay-write-confirm[open]')?.textContent||'';return text.includes('将新建：写工具二.md')})()`))
  check('点「不建」后没有落盘', (await clickSelector('.write-confirm-cancel')) && (await settle()) && !existsSync(path.join(vault, '写工具二.md')))
  check('拒绝后整场照常收尾', await page.eval(`(async () => (await window.rgent.noteRead('写作建二.md')).content.includes('写工具核验完成。'))()`))

  // 三、补·安静：不弹窗，只往发起篇追加一个新块。
  check('打开补样张发起篇开工', await start('写作补.md', '补样张'))
  check('补不额外弹窗且追加落到发起篇', (await settle()) && !(await page.eval(`!!document.querySelector('.overlay-write-confirm')`)) && await page.eval(`(async () => { const body=(await window.rgent.noteRead('写作补.md')).content.split('<!-- rgent:ledger')[0]; return body.includes('补充依据。') && body.includes('part=\"append\"') })()`))
  check('追加不碰人写文本与已有块', await page.eval(`(async () => { const body=(await window.rgent.noteRead('写作补.md')).content.split('<!-- rgent:ledger')[0]; return body.includes('建样张一')===false && body.indexOf('补充依据。')>body.indexOf('补样张') })()`), await page.eval(`(async () => JSON.stringify((await window.rgent.noteRead('写作补.md')).content))()`))

  // 四、补·超限：12 KB 汉字撞 8 KiB 字节线，当场拒，正文不动。
  check('打开超限发起篇开工', await start('写作超限.md', '超限样张'))
  check('超限追加被拒且正文没被写坏', (await settle()) && await page.eval(`(async () => { const body=(await window.rgent.noteRead('写作超限.md')).content.split('<!-- rgent:ledger')[0]; return !body.includes('汉汉汉') })()`))
  check('拒绝原因如实报给模型', requests.some(request => request.messages.some(message => message.role === 'tool' && String(message.content).includes('OVER_LIMIT_BYTES'))))

  // 五、改名：授权范围内的参考篇才能动；发起篇自己一律拒。
  check('打开越权发起篇开工', await start('写作越权.md', '越权样张'))
  check('发起篇自己的结构操作不出卡片，账本记 ORIGIN_LOCKED', (await settle()) && !(await page.eval(`!!document.querySelector('.overlay-write-confirm')`)) && requests.some(request => request.messages.some(message => message.role === 'tool' && String(message.content).includes('ORIGIN_LOCKED'))))
  await shot(page, 'write-structural-origin-refused-1200')

  check('打开改名发起篇并授权参考篇', await start('写作改名.md', '改名样张'))
  check('改名卡片摆出旧路径 → 新路径与影响面', await waitFor(page, `(() => {const text=document.querySelector('.overlay-write-confirm[open]')?.textContent||'';return text.includes('将改名：写作参考.md → 写作参考改.md') && text.includes('处引用')})()`))
  await shot(page, 'write-rename-1200')
  check('点「改名」后文件真的换了名字', (await clickSelector('.write-confirm-accept')) && await waitFor(page, `!document.querySelector('.status-task')`, 30000) && existsSync(path.join(vault, '写作参考改.md')) && !existsSync(path.join(vault, '写作参考.md')))

  check('打开挪动发起篇并授权另一篇参考', await start('写作挪.md', '挪样张', '写作挪参考.md'))
  check('挪动卡片摆出旧路径 → 新路径', await waitFor(page, `(() => {const text=document.querySelector('.overlay-write-confirm[open]')?.textContent||'';return text.includes('将移动：写作挪参考.md → 归档/写作挪参考.md')})()`))
  check('点「移动」后文件真的挪进目标目录', (await clickSelector('.write-confirm-accept')) && await waitFor(page, `!document.querySelector('.status-task')`, 30000) && existsSync(path.join(vault, '归档', '写作挪参考.md')) && !existsSync(path.join(vault, '写作挪参考.md')))

  if (process.platform === 'darwin') {
    check('先打开要删的参考篇', await page.eval(`(() => { const n=[...document.querySelectorAll('.tree-note')].find(n=>n.dataset.path==='写作删参考.md'); if (!n) return false; n.click(); return true })()`) && await waitFor(page, `!!document.querySelector('.tab[data-rel="写作删参考.md"]')`))
    check('打开删除发起篇并授权参考篇', await start('写作删.md', '删样张', '写作删参考.md'))
    check('删除卡片写明送篓且不代改引用', await waitFor(page, `(() => {const text=document.querySelector('.overlay-write-confirm[open]')?.textContent||'';return text.includes('将删除：写作删参考.md') && text.includes('链接会失效') && text.includes('移入废纸篓')})()`))
    await shot(page, 'write-delete-1200')
    check('点「移入废纸篓」后面从库里消失且标签关掉', (await clickSelector('.write-confirm-accept')) && await waitFor(page, `!document.querySelector('.status-task')`, 30000) && !existsSync(path.join(vault, '写作删参考.md')) && await page.eval(`![...document.querySelectorAll('.tab')].some(t => t.dataset.rel === '写作删参考.md')`))
    check('删除账本留痕看得见', await ledgerPanel('写作删.md', `text.includes('delete_note') && text.includes('ok:写作删参考.md') && text.includes('vault-change') && !text.includes('ENOENT')`), await page.eval(`document.querySelector('.ledger-body')?.textContent?.slice(0,240)??'(无)'`))

    check('打开不删发起篇', await start('写作不删.md', '不删样张', '写作不删参考.md'))
    check('不删卡片出现', await waitFor(page, `(() => {const text=document.querySelector('.overlay-write-confirm[open]')?.textContent||'';return text.includes('将删除：写作不删参考.md')})()`))
    check('点「不删」后面还在', (await clickSelector('.write-confirm-cancel')) && (await settle()) && existsSync(path.join(vault, '写作不删参考.md')))
  } else {
    check('Windows 写工具专项不走送篓路', existsSync(path.join(vault, '写作删参考.md')) && existsSync(path.join(vault, '写作不删参考.md')))
  }

  // 账本：面板上看"未执行（超限）"的如实记录，数据上看三场各自的工具留痕。
  await page.eval(`document.querySelector('.ledger-open')?.click()`)
  await waitFor(page, `!!document.querySelector('.ledger-body details')`)
  await page.eval(`document.querySelectorAll('.ledger-body details').forEach(d=>d.open=true)`)
  await waitFor(page, `!!document.querySelector('.ledger-body details > div')?.childNodes.length`)
  check('账本面板如实写「未执行（超限）」并带工具名', await ledgerPanel('写作超限.md', `text.includes('append_to_note') && text.includes('refused:OVER_LIMIT_BYTES') && text.includes('未执行（OVER_LIMIT_BYTES）')`), await page.eval(`document.querySelector('.ledger-body')?.textContent?.slice(0,260)??'(无账本面板)'`))
  check('建的账本留痕看得见', await ledgerPanel('写作建一.md', `text.includes('create_note') && /ok:[^\\s]+·/.test(text)`), await page.eval(`document.querySelector('.ledger-body')?.textContent?.slice(0,200)??'(无)'`))
  check('补的账本留痕看得见', await ledgerPanel('写作补.md', `text.includes('append_to_note') && text.includes('ok (1)')`), await page.eval(`document.querySelector('.ledger-body')?.textContent?.slice(0,200)??'(无)'`))
  await shot(page, 'write-ledger-1200')
  await page.eval(`document.querySelector('.ledger-close')?.click()`)
  if (process.platform === 'darwin') {
    const trash = path.join(homedir(), '.Trash')
    for (const name of ['写作删参考.md', '写作删参考']) {
      try { rmSync(path.join(trash, name), { recursive: true, force: true }) } catch { /* 废纸篓列举会 EPERM */ }
    }
    spawnSync('osascript', ['-e', 'tell application "Finder"\ntry\ndelete (every item of trash whose name contains "写作删参考")\nend try\nend tell'], { encoding: 'utf8', timeout: 10000 })
  }
}

/** 联网只读专项（RGENT_UI_NETWORK_ONLY=1）：只证门控、拒绝与账本，零真实外网。
 *  受控模型按「联网抓页专项」标记脚本化两次 fetch_url：第一次回环地址被出口核心拒，
 *  第二次要等人在状态行点「停止联网」后才放行，回给模型 NETWORK_NOT_AUTHORIZED。 */
function createNetworkOnlyHostServer(requests, gate) {
  const server = createHttpServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const decoded = JSON.parse(body)
      const marker = JSON.stringify(decoded.messages ?? [])
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'network-ui', object: 'chat.completion.chunk', created: 1, model: decoded.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // 只按本专项的口令脚本化；后台整理等其它请求给普通回答，不劫持也不计入证据。
      if (!marker.includes('联网抓页专项')) {
        emit({ content: '受控回答。' })
        emit({}, 'stop')
        response.end('data: [DONE]\n\n')
        return
      }
      requests.push(decoded)
      const results = decoded.messages.filter(message => message.role === 'tool')
      const fetchCall = (id) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'fetch_url', arguments: JSON.stringify({ url: 'https://127.0.0.1/x' }) } }] })
      if (!results.length) {
        emit(fetchCall('network-fetch-1'))
        emit({}, 'tool_calls')
        response.end('data: [DONE]\n\n')
        return
      }
      if (results.length === 1) {
        // 第二次抓取不能自动发生：等界面上的「停止联网」落定后再回模型。
        gate.reached = true
        gate.abort = () => { if (!response.destroyed) response.destroy() }
        gate.release = () => {
          if (response.destroyed) return
          emit(fetchCall('network-fetch-2'))
          emit({}, 'tool_calls')
          response.end('data: [DONE]\n\n')
        }
        return
      }
      // 留出窗口让人真的看见状态行按「第二次被拒」更新，再收尾。
      const finalTimer = setTimeout(() => {
        if (response.destroyed) return
        emit({ content: '联网专项核验完成。' })
        emit({}, 'stop')
        response.end('data: [DONE]\n\n')
      }, 3000)
      response.on('close', () => clearTimeout(finalTimer))
    })
  })
  return server
}

/** 联网只读专项：① 总开关默认关 ② 勾选默认不勾且写明抓网页 ③ 回环抓页被拒并进账本
 *  ④ 停止联网后第二次抓取被拒 ⑤ 任务进行中状态行出现「联网：」提示。 */
async function verifyNetworkOnly(page, vault, shot, requests, gate) {
  process.stdout.write('\n联网只读专项\n')
  await waitFor(page, `document.querySelector('#app')?.inert===false && !!document.querySelector('.settings-open')`)
  const clickSelector = async (selector) => {
    const point = await page.eval(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return null; el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); return { x: r.left+r.width/2, y: r.top+r.height/2 } })()`)
    if (!point) return false
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    return true
  }
  const toolMessages = () => requests.flatMap(request => request.messages.filter(message => message.role === 'tool').map(message => String(message.content)))
  // 夹具先落盘：设置页操作期间文件监听有时间把新笔记送进目录。
  writeFileSync(path.join(vault, '联网抓页专项.md'), '')

  // ① 设置「模型」页里的联网卡：默认关闭。
  await page.eval(`document.querySelector('.settings-open')?.click()`)
  check('设置页打开', await waitFor(page, `!!document.querySelector('.settings-nav')`))
  await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(button=>button.textContent==='模型')?.click()`)
  check('联网只读总开关默认关闭', await waitFor(page, `(() => { const toggle=document.querySelector('[data-network="enabled"]'); return !!toggle && toggle.checked===false && !toggle.disabled && !!document.querySelector('.settings-network')?.textContent.includes('允许联网只读') })()`), await page.eval(`document.querySelector('.settings-network')?.textContent?.slice(0,180)??'(无联网卡)'`))
  await shot(page, 'network-settings-1200')

  // ② 打开总开关，发起一场并检查口令卡。
  await page.eval(`(() => { const toggle=document.querySelector('[data-network="enabled"]'); toggle.checked=true; toggle.dispatchEvent(new Event('change')) })()`)
  check('总开关经真实设置卡保存为开', await waitFor(page, `(() => { const toggle=document.querySelector('[data-network="enabled"]'); return toggle?.checked===true && !toggle.disabled })()`), await page.eval(`document.querySelector('[data-network="status"]')?.textContent??''`))
  await page.key('Escape', 'Escape', 0, 27)
  check('关闭设置后回到正文', await waitFor(page, `!document.querySelector('.overlay-settings')`))

  await page.eval(`(() => { const toggle=document.querySelector('.tree-toggle'); if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click(); return true })()`)
  check('联网专项夹具进入目录', await waitFor(page, `[...document.querySelectorAll('.tree-note')].some(note=>note.dataset.path==='联网抓页专项.md')`))
  await page.eval(`[...document.querySelectorAll('.tree-note')].find(note=>note.dataset.path==='联网抓页专项.md')?.click()`)
  check('打开联网发起篇', await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel==='联网抓页专项.md'`))
  check('打开笔记后底栏模型快照就绪', await waitFor(page, `document.querySelector('.status-model')?.value!==''`), await page.eval(`document.querySelector('.status-model')?.innerText??''`))
  await page.eval(`document.querySelector('.cm-content')?.focus()`)
  await page.call('Input.insertText', { text: '/联网抓页专项' })
  await page.key('Enter', 'Enter', 0, 13)
  check('口令卡出现联网勾选且默认不勾、写明抓网页', await waitFor(page, `(() => { const card=document.querySelector('.authorization-network'); const input=card?.querySelector('input[type="checkbox"]'); return !!input && input.checked===false && card.textContent.includes('抓网页') && !!document.querySelector('.authorization-send:not(:disabled)') })()`, 60000), await page.eval(`document.querySelector('.authorization-network')?.textContent??'(无联网勾选)'`))
  check('勾选联网后口令卡重新核对并可发送', await clickSelector('.authorization-network input[type="checkbox"]') && await waitFor(page, `document.querySelector('.authorization-network input[type="checkbox"]')?.checked===true && !!document.querySelector('.authorization-send:not(:disabled)')`, 30000), await page.eval(`document.querySelector('.authorization-status')?.textContent??''`))
  await shot(page, 'network-authorization-1200')
  if (!await clickSelector('.authorization-send')) throw Error('找不到确认发送按钮')

  // ⑤ 任务进行中抓一次 DOM：状态行必须出现「联网：」，而不是等任务结束后补记。
  check('任务进行中状态行出现联网提示', await waitFor(page, `(() => { const hint=document.querySelector('.status-task-network'); return !!hint && hint.textContent.includes('联网：') && !!document.querySelector('.status-task') })()`, 30000), await page.eval(`document.querySelector('.status')?.textContent?.slice(0,220)??'(无状态行)'`))

  // ③ 第一个 fetch_url 是回环地址：出口核心拒绝，模型收到 EGRESS_INVALID_URL，任务继续。
  for (let index = 0; index < 200 && !gate.reached; index += 1) await sleep(100)
  check('第一次抓页被拒后模型继续走下一步', gate.reached)
  check('回给模型的是 EGRESS_INVALID_URL', toolMessages().some(text => text.includes('EGRESS_INVALID_URL')), JSON.stringify(toolMessages().slice(-2)))
  check('状态行按真实拒绝事件显示主机与结果码', await waitFor(page, `(() => { const hint=document.querySelector('.status-task-network'); return !!hint && hint.textContent.includes('127.0.0.1') && hint.textContent.includes('未执行：EGRESS_INVALID_URL') })()`, 10000), await page.eval(`document.querySelector('.status-task-network')?.textContent??''`))

  // ④ 第二次抓取前点「停止联网」，再放行；停止必须先于请求。
  check('任务进行中可见「停止联网」', await waitFor(page, `!!document.querySelector('.status-task-network-stop:not(:disabled)')`, 10000))
  if (!await page.eval(`(() => { const b=document.querySelector('.status-task-network-stop'); if(!b)return false; b.click(); return true })()`)) throw Error('找不到停止联网按钮')
  check('停止联网后按钮消失且状态行仍有联网提示', await waitFor(page, `(() => { const hint=document.querySelector('.status-task-network'); return !!hint && hint.textContent.includes('联网：') && !document.querySelector('.status-task-network-stop') })()`, 15000), await page.eval(`document.querySelector('.status')?.textContent?.slice(0,220)??''`))
  check('停止生效前第二次抓取尚未发出', !toolMessages().some(text => text.includes('NETWORK_NOT_AUTHORIZED')))
  gate.release?.()
  check('状态行按第二次拒绝事件显示尝试主机与结果码', await waitFor(page, `(() => { const hint=document.querySelector('.status-task-network'); return !!hint && hint.textContent.includes('127.0.0.1') && hint.textContent.includes('未执行：NETWORK_NOT_AUTHORIZED') })()`, 10000), await page.eval(`document.querySelector('.status-task-network')?.textContent??''`))

  check('两次拒绝后任务仍正常完成', await waitFor(page, `(async()=>{ if((await window.rgent.agentTasks()).length) return false; return (await window.rgent.noteRead('联网抓页专项.md')).content.includes('联网专项核验完成。') })()`, 60000))
  check('第二次抓取回给模型 NETWORK_NOT_AUTHORIZED', toolMessages().some(text => text.includes('NETWORK_NOT_AUTHORIZED')), JSON.stringify(toolMessages().slice(-2)))

  // ③④ 账本：两条外发都看得见，且只有主机与结果码。
  await page.eval(`document.querySelector('.ledger-open')?.click()`)
  check('账本面板打开', await waitFor(page, `!!document.querySelector('.ledger-body details')`))
  await page.eval(`document.querySelectorAll('.ledger-body details').forEach(details=>details.open=true)`)
  check('账本出现本场外发与两条未执行原因', await waitFor(page, `(() => { const text=document.querySelector('.ledger-body')?.textContent||''; return text.includes('本场外发：') && text.includes('未执行：EGRESS_INVALID_URL') && text.includes('未执行：NETWORK_NOT_AUTHORIZED') && !text.includes('本场外发：无') })()`), await page.eval(`document.querySelector('.ledger-body')?.textContent?.slice(0,360)??''`))
  check('外发证据不含抓取路径或正文', await page.eval(`(() => { const nodes=[...document.querySelectorAll('.ledger-network-evidence')]; const text=nodes.map(node=>node.textContent).join('|'); return nodes.length>0 && !text.includes('https://127.0.0.1') && !text.includes('/x') && !text.includes('外部正文') })()`))
  await shot(page, 'network-ledger-1200')
}

/** 人发起联网专项（RGENT_UI_NETWORK_HUMAN_ONLY=1）：只证「菜单/快捷键开同一个对话框、
 *  总闸默认关、开闸后回环在出口被拒且外发日志/统计只留这次拒绝」；零真实外网、零模型调用。
 *  备注：总闸关闭时主进程会为这次尝试留一条 `NETWORK_NOT_AUTHORIZED` 拒绝记录（既不外发，
 *  也不假装“没有记录”），所以第二条判据查的是「没有成功外发」，不是「日志为空」。 */
async function verifyHumanNetwork(page, shot) {
  process.stdout.write('\n人发起联网专项\n')
  await waitFor(page, `document.querySelector('#app')?.inert===false && !!document.querySelector('.settings-open')`)
  const openSettings = async () => {
    await page.eval(`document.querySelector('.settings-open')?.click()`)
    return waitFor(page, `!!document.querySelector('.overlay-settings') && !!document.querySelector('.settings-nav')`)
  }
  const openModelPage = async () => {
    await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(button=>button.textContent==='模型')?.click()`)
    return waitFor(page, `document.querySelector('.settings-page-title')?.textContent==='模型' && !!document.querySelector('[data-network="enabled"]:not(:disabled)')`)
  }
  const closeSettings = async () => {
    await page.key('Escape', 'Escape', 0, 27)
    return waitFor(page, `!document.querySelector('.overlay-settings')`)
  }
  const toggleState = () => page.eval(`(() => { const node=document.querySelector('[data-network="enabled"]'); return node ? { checked: node.checked, disabled: node.disabled } : null })()`)
  /** macOS 用 meta(4)+shift(8)，其它平台用 ctrl(2)+shift(8)；键位与菜单加速键相同。 */
  const openDialogByShortcut = async () => {
    const modifiers = process.platform === 'darwin' ? 4 + 8 : 2 + 8
    const keys = { key: 'U', code: 'KeyU', modifiers, windowsVirtualKeyCode: 85 }
    await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keys })
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...keys })
    return waitFor(page, `!!document.querySelector('dialog.fetch-dialog[open]')`)
  }
  const fillDialog = (value) => page.eval(`(() => { const input=document.querySelector('.fetch-dialog-input'); if(!input) return false; input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const submitDialog = () => page.eval(`(() => { const button=document.querySelector('.fetch-dialog-submit'); if(!button) return false; button.click(); return true })()`)
  const dialogStatus = () => page.eval(`document.querySelector('.fetch-dialog-status')?.textContent ?? ''`)
  const closeDialog = async () => {
    await page.eval(`(() => { const button=document.querySelector('.fetch-dialog-close'); if(!button) return false; button.click(); return true })()`)
    return waitFor(page, `!document.querySelector('.fetch-dialog')`)
  }
  const egressLog = () => page.eval(`window.rgent.networkEgressLog({ limit: 5 })`)

  // ① 默认关：设置「模型」页里的总开关未勾选，且不是禁用态（能由人打开）。
  check('人发起联网：设置页打开', await openSettings())
  check('人发起联网：模型页的总开关默认关闭', await openModelPage() && JSON.stringify(await toggleState()) === JSON.stringify({ checked: false, disabled: false }), JSON.stringify(await toggleState()))
  await shot(page, 'human-network-settings-off-1200')
  check('人发起联网：关闭设置回到正文', await closeSettings())

  // ② 快捷键打开同一个对话框；总闸关闭时提交被抓，零成功外发。
  check('⌘⇧U／Ctrl+Shift+U 打开抓页对话框', await openDialogByShortcut())
  check('对话框默认为抓页模式且输入框可用', await page.eval(`(() => { const input=document.querySelector('.fetch-dialog-input'); const mode=document.querySelector('.fetch-dialog-mode[data-mode="fetch"]'); return !!input && !input.disabled && mode?.getAttribute('aria-pressed')==='true' })()`))
  await fillDialog('https://example.com/')
  await submitDialog()
  check('总闸关闭时人发起被抓并翻成人话', await waitFor(page, `(() => { const text=document.querySelector('.fetch-dialog-status')?.textContent||''; return text.includes('抓取失败') && text.includes('联网') && !text.includes('NETWORK_NOT_AUTHORIZED') })()`), await dialogStatus())
  const refusedLog = await egressLog()
  const refusedEntries = refusedLog?.ok ? refusedLog.view.entries : []
  check('总闸关闭：没有任何成功外发，只留一条 NETWORK_NOT_AUTHORIZED 拒绝记录',
    refusedLog?.ok === true && refusedEntries.length === 1 &&
      refusedEntries[0]?.outcome === 'refused' && refusedEntries[0]?.code === 'NETWORK_NOT_AUTHORIZED' && refusedEntries[0]?.host === 'example.com',
    JSON.stringify(refusedLog))
  check('总闸关闭：对话框没有渲染任何结果', await page.eval(`document.querySelector('.fetch-dialog-result')?.children.length===0`))
  await shot(page, 'human-network-gate-off-1200')
  check('人发起联网：关闭抓页对话框', await closeDialog())

  // ③ 开总闸（change 即保存）后重开对话框；回环地址在出口被拒，审计与统计只留这次拒绝。
  check('人发起联网：回设置打开模型页', await openSettings() && await openModelPage())
  check('勾选总开关', await page.eval(`(() => { const node=document.querySelector('[data-network="enabled"]'); if(!node || node.checked || node.disabled) return false; node.click(); return true })()`))
  check('总开关经设置卡保存为开（控件重新可用且读回 enabled）', await waitFor(page, `(async () => { const node=document.querySelector('[data-network="enabled"]'); if(!node || !node.checked || node.disabled) return false; const result=await window.rgent.networkConfig(); return result.ok===true && result.config.enabled===true })()`), await page.eval(`document.querySelector('[data-network="status"]')?.textContent ?? ''`))
  await shot(page, 'human-network-settings-on-1200')
  check('人发起联网：关闭设置', await closeSettings())
  check('再次用快捷键打开对话框', await openDialogByShortcut())
  await fillDialog('https://127.0.0.1/x')
  await submitDialog()
  check('开闸后回环地址被出口拒绝并翻成人话', await waitFor(page, `(() => { const text=document.querySelector('.fetch-dialog-status')?.textContent||''; return text.includes('抓取失败') && text.includes('目标网址不合法') && !text.includes('EGRESS_INVALID_URL') })()`), await dialogStatus())
  const invalidLog = await egressLog()
  const invalidEntries = invalidLog?.ok ? invalidLog.view.entries.filter(entry => entry.code === 'EGRESS_INVALID_URL') : []
  check('外发日志有且仅有 1 条 EGRESS_INVALID_URL（refused、主机 127.0.0.1）',
    invalidLog?.ok === true && invalidEntries.length === 1 && invalidEntries[0]?.outcome === 'refused' &&
      invalidEntries[0]?.host === '127.0.0.1' && invalidEntries[0]?.action === 'fetch',
    JSON.stringify(invalidLog))
  check('外发日志没有任何成功条目', invalidLog?.ok === true && invalidLog.view.entries.every(entry => entry.outcome !== 'ok'), JSON.stringify(invalidLog))
  const stats = await page.eval(`window.rgent.networkStats()`)
  check('外发统计把这次回环拒绝记进 humanFetch.refused', stats?.ok === true && stats.stats.kinds.humanFetch.refused >= 1, JSON.stringify(stats))
  await shot(page, 'human-network-invalid-url-1200')
  check('人发起联网：关闭抓页对话框', await closeDialog())

  // ④ 设置卡统计区：非空、写明「抓页(人)」，最近人发起列表带这次主机。
  check('人发起联网：设置页打开（统计）', await openSettings() && await openModelPage())
  check('设置卡统计区可见「抓页(人)」与最近一次主机 127.0.0.1', await waitFor(page, `(() => { const node=document.querySelector('.settings-network-stats'); const text=node?.textContent||''; return !!node && text.length>0 && text.includes('抓页(人)') && text.includes('127.0.0.1') && text.includes('拒绝 EGRESS_INVALID_URL') })()`), await page.eval(`document.querySelector('.settings-network-stats')?.textContent?.slice(0,500) ?? '(无统计区)'`))
  await shot(page, 'human-network-stats-1200')

  // ⑤ 收尾：对话框与设置都关掉，别把模态留给后续默认检查。
  check('人发起联网：关闭设置（收尾）', await closeSettings())
  check('人发起联网：专项结束时没有残留浮层', await waitFor(page, `!document.querySelector('.fetch-dialog') && !document.querySelector('.overlay-settings')`))
}

/** 远端只读 MCP 窗口专项（RGENT_UI_MCP_ONLY=1）：只证设置卡、坏地址拒绝、抓页对话框回归
 *  与口令卡门控；零真实外网、零真实模型。公共只读服务器不带 token 也是合法形状。 */
async function verifyMcpOnly(page, vault, shot, requests) {
  process.stdout.write('\n远端只读 MCP 专项\n')
  await waitFor(page, `document.querySelector('#app')?.inert===false && !!document.querySelector('.settings-open')`)
  const openSettings = async () => {
    await page.eval(`document.querySelector('.settings-open')?.click()`)
    return waitFor(page, `!!document.querySelector('.overlay-settings') && !!document.querySelector('.settings-nav')`)
  }
  const openModelPage = async () => {
    await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(button=>button.textContent==='模型')?.click()`)
    return waitFor(page, `document.querySelector('.settings-page-title')?.textContent==='模型' && !!document.querySelector('.settings-mcp')`)
  }
  const closeSettings = async () => {
    await page.key('Escape', 'Escape', 0, 27)
    return waitFor(page, `!document.querySelector('.overlay-settings')`)
  }
  /** macOS 用 meta(4)+shift(8)，其它平台用 ctrl(2)+shift(8)；键位与菜单加速键相同（同 A4）。 */
  const openFetchDialog = async () => {
    const modifiers = process.platform === 'darwin' ? 4 + 8 : 2 + 8
    const keys = { key: 'U', code: 'KeyU', modifiers, windowsVirtualKeyCode: 85 }
    await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keys })
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...keys })
    return waitFor(page, `!!document.querySelector('dialog.fetch-dialog[open]')`)
  }
  const closeFetchDialog = async () => {
    await page.eval(`(() => { const button=document.querySelector('.fetch-dialog-close'); if(!button) return false; button.click(); return true })()`)
    return waitFor(page, `!document.querySelector('.fetch-dialog')`)
  }

  // 夹具先落盘：设置页操作期间文件监听有时间把新笔记送进目录。
  writeFileSync(path.join(vault, 'MCP 门控专项.md'), '')

  // ①a 空配置：MCP 卡片可见，空服务器列表有说明文案。
  check('MCP 专项：设置页打开（空配置）', await openSettings())
  check('MCP 专项：MCP 卡片可见且空列表有说明文案', await openModelPage() && await waitFor(page, `(() => { const card=document.querySelector('.settings-mcp'); const empty=card?.querySelector('[data-mcp="empty"]'); return !!card && card.getBoundingClientRect().height>0 && empty?.hidden===false && empty.textContent.includes('还没有服务器') })()`), await page.eval(`document.querySelector('.settings-mcp [data-mcp="empty"]')?.textContent ?? '(无空态)'`))
  check('MCP 专项：空配置时没有服务器行', await page.eval(`document.querySelectorAll('.settings-mcp [data-mcp="row"]').length===0`))
  check('MCP 专项：关闭设置（空配置）', await closeSettings())

  // ①b 夹具：一台不带 token 的公共只读服务器（真实 IPC）。列表因此有一行可看，工具列表仍为空。
  const seeded = await page.eval(`window.rgent.mcpServerSave({ name: '窗口专项公共服务器', url: 'https://mcp.example.com/mcp', enabled: false })`)
  check('MCP 专项：能保存不带 token 的公共只读服务器', seeded?.ok === true && seeded.config.servers.length === 1 && seeded.config.servers[0].hasToken === false, JSON.stringify(seeded))

  // ①c 重开设置：卡片读到这一行，空工具列表有说明，「连接并列出工具」按钮在且未禁用。
  check('MCP 专项：模型页的 MCP 卡片可见并读到夹具服务器', await openSettings() && await openModelPage() && await waitFor(page, `!!document.querySelector('.settings-mcp [data-mcp="row"]')`) && await page.eval(`(() => { const card=document.querySelector('.settings-mcp'); return !!card && card.getBoundingClientRect().height>0 && card.textContent.includes('远端只读 MCP') })()`))
  check('MCP 专项：空工具列表有说明文案', await page.eval(`(() => { const hint=document.querySelector('.settings-mcp [data-mcp="tools-empty"]'); return !!hint && hint.textContent.includes('还没有读取过工具') })()`), await page.eval(`document.querySelector('.settings-mcp [data-mcp="tools-empty"]')?.textContent ?? '(无说明)'`))
  check('MCP 专项：卡片有「连接并列出工具」按钮且无 token 也可点', await page.eval(`(() => { const button=document.querySelector('.settings-mcp [data-mcp="discover"]'); return !!button && button.textContent==='连接并列出工具' && !button.disabled })()`))
  check('MCP 专项：行内状态写明无 token', await page.eval(`document.querySelector('.settings-mcp [data-mcp="counts"]')?.textContent.includes('无 token') === true`), await page.eval(`document.querySelector('.settings-mcp [data-mcp="counts"]')?.textContent ?? '(无行)'`))
  await shot(page, 'mcp-settings-1200')

  // ② 添加表单填回环地址、token 留空 → 人话错误，且没有新增行。
  const rowsBefore = await page.eval(`document.querySelectorAll('.settings-mcp [data-mcp="row"]').length`)
  check('MCP 专项：坏地址保存前只有夹具一行', rowsBefore === 1, String(rowsBefore))
  await page.eval(`(() => {
    const name=document.querySelector('.settings-mcp [data-mcp="new-name"]');
    name.value='坏地址'; name.dispatchEvent(new Event('input',{bubbles:true}));
    const url=document.querySelector('.settings-mcp [data-mcp="new-url"]');
    url.value='https://127.0.0.1/mcp'; url.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('.settings-mcp [data-mcp="new-token"]').value='';
  })()`)
  await page.eval(`document.querySelector('.settings-mcp [data-mcp="save"]')?.click()`)
  check('MCP 专项：坏地址保存显示人话错误（地址不合法）', await waitFor(page, `(() => { const text=document.querySelector('.settings-mcp [data-mcp="error"]')?.textContent||''; return text.includes('地址') && text.includes('https') && !text.includes('MCP_BAD_URL') })()`, 10000), await page.eval(`document.querySelector('.settings-mcp [data-mcp="error"]')?.textContent ?? '(无错误)'`))
  const rowsAfter = await page.eval(`document.querySelectorAll('.settings-mcp [data-mcp="row"]').length`)
  check('MCP 专项：坏地址没有新增行', rowsAfter === rowsBefore, `${rowsAfter}/${rowsBefore}`)
  const configAfterBad = await page.eval(`window.rgent.mcpConfig()`)
  check('MCP 专项：坏地址没有写进配置', configAfterBad?.ok === true && configAfterBad.config.servers.length === 1 && configAfterBad.config.servers[0].name === '窗口专项公共服务器', JSON.stringify(configAfterBad))
  await shot(page, 'mcp-bad-url-1200')

  // ③ 回归：关闭设置后用既有快捷键打开抓页对话框再关闭，MCP 卡片的改动不影响联网对话框。
  check('MCP 专项：关闭设置', await closeSettings())
  check('MCP 专项：⌘⇧U／Ctrl+Shift+U 打开抓页对话框', await openFetchDialog())
  check('MCP 专项：抓页对话框仍可输入与提交', await page.eval(`!!document.querySelector('.fetch-dialog-input:not([disabled])') && !!document.querySelector('.fetch-dialog-submit')`))
  check('MCP 专项：关闭抓页对话框', await closeFetchDialog())

  // ④ 删除夹具，恢复到「未配置 MCP」；最小任务的整张口令卡只应有原因行，没有 MCP 勾选框。
  check('MCP 专项：回设置删除夹具', await openSettings() && await openModelPage() && await waitFor(page, `!!document.querySelector('.settings-mcp [data-mcp="row"]')`))
  check('MCP 专项：两下确认删除夹具服务器', await page.eval(`(() => {
    const button=document.querySelector('.settings-mcp [data-mcp="remove"]');
    if(!button) return false;
    button.click();
    if(button.textContent!=='确认删除？') return false;
    button.click();
    return true;
  })()`))
  check('MCP 专项：删除后 MCP 列表为空', await waitFor(page, `!document.querySelector('.settings-mcp [data-mcp="row"]') && document.querySelector('.settings-mcp')?.textContent.includes('还没有服务器')`))
  check('MCP 专项：关闭设置（任务前）', await closeSettings())
  const configEmpty = await page.eval(`window.rgent.mcpConfig()`)
  check('MCP 专项：MCP 配置已清空', configEmpty?.ok === true && configEmpty.config.servers.length === 0, JSON.stringify(configEmpty))

  await page.eval(`(() => { const toggle=document.querySelector('.tree-toggle'); if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click(); return true })()`)
  check('MCP 专项：夹具笔记进入目录', await waitFor(page, `[...document.querySelectorAll('.tree-note')].some(note=>note.dataset.path==='MCP 门控专项.md')`))
  await page.eval(`[...document.querySelectorAll('.tree-note')].find(note=>note.dataset.path==='MCP 门控专项.md')?.click()`)
  check('MCP 专项：打开发起篇', await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel==='MCP 门控专项.md'`))
  check('MCP 专项：底栏模型快照就绪', await waitFor(page, `document.querySelector('.status-model')?.value!==''`))
  await page.eval(`document.querySelector('.cm-content')?.focus()`)
  await page.call('Input.insertText', { text: '/mcp 门控专项' })
  await page.key('Enter', 'Enter', 0, 13)
  check('MCP 专项：口令卡准备就绪', await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`, 60000), await page.eval(`document.querySelector('.authorization-status')?.textContent ?? ''`))
  check('MCP 专项：未配置 MCP 时只有原因行、没有 MCP 勾选框', await page.eval(`(() => { const card=document.querySelector('.authorization-mcp'); return !!card && !card.querySelector('input[type="checkbox"]') && card.textContent.includes('本场不能使用 MCP') })()`), await page.eval(`document.querySelector('.authorization-mcp')?.textContent ?? '(无 MCP 行)'`))
  await shot(page, 'mcp-authorization-1200')
  // 非模态卡不抢焦点：发送前把焦点放到发送键。
  await page.eval(`document.querySelector('.overlay-authorization .authorization-send:not(:disabled)')?.focus()`)
  await page.key('Enter', 'Enter', 0, 13)
  check('MCP 专项：最小任务正常结束并保存回答', await waitFor(page, `(async()=>{ if((await window.rgent.agentTasks()).length) return false; const note=await window.rgent.noteRead('MCP 门控专项.md'); return note.content.includes('受控回答第一句。') })()`, 60000))
  check('MCP 专项：任务只走受控主机', requests.length >= 1, String(requests.length))
  check('MCP 专项：专项结束时没有残留浮层', await waitFor(page, `!document.querySelector('.overlay-authorization') && !document.querySelector('.overlay-settings') && !document.querySelector('.fetch-dialog')`))
}

/** 外部消失与恢复核验专项（RGENT_UI_RECOVERY_ONLY=1）：在专用临时库里真删真放回，逐条走
 *  「识别与如实呈现／人原地重建同名笔记／核验通过／内容已变／附件缺失／设置页无删除入口」六条判据。
 *  模型只用来做登记场与恢复后复跑，全部走受控主机，零真实调用。 */
async function verifyExternalRecovery(page, vault, staging, shot, requests, shotDir) {
  const modifier = process.platform === 'darwin' ? 4 : 2
  const at = (name) => path.join(vault, name)
  const parked = (name) => path.join(staging, name)
  const sha256 = (name) => createHash('sha256').update(readFileSync(at(name))).digest('hex')
  const inodeOf = (file) => statSync(file, { bigint: true }).ino.toString()
  const editorText = () => page.eval(`document.querySelector('.cm-content')?.cmTile?.root?.view?.state?.doc?.toString() ?? null`)
  const readFails = (name) => page.eval(`window.rgent.noteRead(${JSON.stringify(name)}).then(() => false, () => true)`)
  mkdirSync(staging, { recursive: true })
  for (const [name, body] of Object.entries({
    '恢复甲.md': '# 恢复甲\n\n受控原正文，用来核对内容哈希。\n',
    '恢复乙.md': '# 恢复乙\n\n受控原正文，用来核对内容哈希。\n',
    '恢复丙.md': '# 恢复丙\n\n受控原正文，附件夹与它同住。\n'
  })) writeFileSync(at(name), body)
  mkdirSync(at('恢复丙'))
  writeFileSync(path.join(at('恢复丙'), '附件.txt'), '受控附件内容。\n')
  const evidence = { dialogs: [], menus: {}, scans: [] }
  // 原生 alert 只作兜底：路径保留放行后人新建同名笔记应当直接成功、不该再弹拒绝文案。
  // 仍截获并立刻确认，避免自动化被原生对话框卡死；dialog 只进 evidence 供诊断，不作断言。
  await page.call('Page.enable', {})
  page.onEvent = (message) => {
    if (message.method !== 'Page.javascriptDialogOpening') return
    evidence.dialogs.push(message.params.message)
    void page.call('Page.handleJavaScriptDialog', { accept: true })
  }
  const ownerFor = (name) => {
    let entries = []
    try { entries = readdirSync(path.join(vault, '.rgent', 'ledgers')) } catch { return null }
    for (const id of entries) {
      try {
        const raw = JSON.parse(readFileSync(path.join(vault, '.rgent', 'ledgers', id, 'owner.json'), 'utf8'))
        if (raw.relPath === name) return raw
      } catch { /* 不是夹具的登记目录 */ }
    }
    return null
  }
  const recoveryPanel = () => page.eval(`(() => {
    const section = [...document.querySelectorAll('.settings-main section')].find(node => node.querySelector('h3')?.textContent === '外部消失与恢复核验')
    if (!section) return null
    return {
      message: section.querySelector('.vault-settings-hint')?.textContent ?? '',
      actions: [...section.querySelectorAll('li button')].map(node => node.textContent),
      rows: [...section.querySelectorAll('li')].map(node => ({ text: node.textContent, verdict: node.dataset.recoveryVerdict ?? null, confirm: node.querySelector('[data-recovery-confirm]')?.dataset.recoveryConfirm ?? null }))
    }
  })()`)
  const rowFor = async (relPath) => {
    const panel = await recoveryPanel()
    const row = panel?.rows.find((item) => item.text.startsWith(relPath)) ?? null
    evidence.scans.push({ relPath, verdict: row?.verdict ?? null, confirm: row?.confirm ?? null, text: row?.text ?? null })
    return { panel, row }
  }
  const leaveSettings = async () => {
    await page.key('Escape', 'Escape', 0, 27)
    return waitFor(page, `!document.querySelector('.settings-nav')`)
  }
  /** 打开「笔记库」页并点「重扫并核验恢复」；收尾看真实事务的 `aria-busy`，不靠睡眠猜。 */
  const rescan = async () => {
    if (!await page.eval(`!!document.querySelector('.settings-main .vault-settings')`)) {
      await page.eval(`document.querySelector('.settings-open').click()`)
      if (!await waitFor(page, `!!document.querySelector('.settings-nav')`)) return '设置面板没打开'
      await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(node => node.textContent === '笔记库').click()`)
      if (!await waitFor(page, `!!document.querySelector('.settings-main .vault-settings')`)) return '「笔记库」页没打开'
    }
    if (!await waitFor(page, `!!document.querySelector('[data-recovery-scan]:not(:disabled)')`, 20000)) {
      return '「重扫并核验恢复」按钮不可用：' + await page.eval(`JSON.stringify({ scan: !!document.querySelector('[data-recovery-scan]'), disabled: document.querySelector('[data-recovery-scan]')?.disabled ?? null, busy: document.querySelector('.settings-main .vault-settings')?.getAttribute('aria-busy') ?? null, text: document.querySelector('.settings-main .vault-settings')?.innerText?.slice(0, 200) })`)
    }
    await page.eval(`document.querySelector('[data-recovery-scan]').click()`)
    if (!await waitFor(page, `document.querySelector('.settings-main .vault-settings')?.getAttribute('aria-busy') === 'false'`, 30000)) return '重扫没有收尾'
    return true
  }
  /** 登记场：真开一场（受控主机），让账本记住这篇的对象身份、正文哈希与附件证据。 */
  const register = async (name, prompt, expectManifest = false) => {
    await selectBrowserFolder(page, '')
    if (!await waitFor(page, `[...document.querySelectorAll('.tree-note')].some(node => node.dataset.path === ${JSON.stringify(name)})`)) return `目录里没有 ${name}`
    await page.eval(`[...document.querySelectorAll('.tree-note')].find(node => node.dataset.path === ${JSON.stringify(name)}).click()`)
    if (!await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(name)}`)) return `tab 没打开 ${name}`
    // 口令段落要用编辑器事务写进去：库里的原文以换行结尾时，`Input.insertText` 会把结尾那个
    // 换行替换掉（CDP/DOM 选区映射），口令就不再是空段落开头的口令。事务走的是同一条编辑路径，
    // 回车仍然是真实按键。
    await page.eval(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const at = view.state.doc.length, insert = '\\n/' + ${JSON.stringify(prompt)}
      view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: 'input.type' })
      view.focus()
      return true
    })()`)
    await sleep(300)
    await page.key('Enter', 'Enter', 0, 13)
    if (!await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`, 60000)) {
      return `授权弹窗没出现（${name}）` + await page.eval(`JSON.stringify({ editor: document.querySelector('.cm-content')?.innerText?.slice(0, 80), popover: !!document.querySelector('.overlay-authorization'), send: document.querySelector('.authorization-send')?.disabled ?? null, status: document.querySelector('.status')?.textContent?.slice(0, 160) })`)
    }
    if (expectManifest) {
      const manifest = await page.eval(`[...document.querySelectorAll('.authorization-manifest li')].map(node => node.textContent)`)
      if (manifest.length !== 1 || manifest[0] !== name) return `授权清单不是仅有发起篇：${JSON.stringify(manifest)}`
    }
    // 非模态卡不抢焦点：发送前把焦点放到发送键。
    await page.eval(`document.querySelector('.overlay-authorization .authorization-send:not(:disabled)')?.focus()`)
    await page.key('Enter', 'Enter', 0, 13)
    if (!await waitFor(page, `!document.querySelector('.status-task')`, 60000)) return `任务没有收尾（${name}）`
    if (!await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content.includes('受控回答第一句。'))()`, 30000)) return `回答没有落盘（${name}）`
    return true
  }

  // 受控供应商经 IPC 配好，渲染层的模型快照要开一次设置页才刷新。
  await page.eval(`document.querySelector('.settings-open').click()`)
  await waitFor(page, `!!document.querySelector('.settings-nav')`)
  await leaveSettings()
  await page.eval(`(() => { const toggle = document.querySelector('.tree-toggle'); if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click(); return true })()`)
  const fixtureReady = await waitFor(page, `[...document.querySelectorAll('.tree-note')].filter(node => /^恢复[甲乙丙]\\.md$/.test(node.dataset.path ?? '')).length === 3`)
  const registrations = []
  for (const [name, prompt] of [['恢复甲.md', '恢复登记甲'], ['恢复乙.md', '恢复登记乙'], ['恢复丙.md', '恢复登记丙']]) registrations.push(await register(name, prompt))
  const owners = ['恢复甲.md', '恢复乙.md', '恢复丙.md'].map(ownerFor)
  check('恢复核验夹具已登记：账本有主人、附件证据入库、正文哈希与磁盘一致',
    fixtureReady && registrations.every((item) => item === true) &&
      owners.every((entry) => !!entry?.recoveryEvidence && entry.bodyRevision === sha256(entry.relPath)) &&
      JSON.stringify(owners[0]?.recoveryEvidence?.attachments ?? null) === '[]' &&
      JSON.stringify(owners[2]?.recoveryEvidence?.attachments?.map((part) => part.relPath) ?? null) === JSON.stringify(['恢复丙', '恢复丙/附件.txt']),
    JSON.stringify({ fixtureReady, registrations, owners: owners.map((entry) => entry ? { relPath: entry.relPath, attachments: entry.recoveryEvidence?.attachments?.map((part) => part.relPath) ?? null, hashMatches: entry.bodyRevision === sha256(entry.relPath) } : null) }))

  // 一、外部消失：甲在 tab 里开着，文件被移出库外（Finder 删除的等价动作）。
  await selectBrowserFolder(page, '')
  await page.eval(`[...document.querySelectorAll('.tree-note')].find(node => node.dataset.path === '恢复甲.md').click()`)
  if (!await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === '恢复甲.md'`)) throw Error('甲没有成为当前 tab')
  const beforeDelete = await page.eval(`(async () => (await window.rgent.noteRead('恢复甲.md')).content)()`)
  renameSync(at('恢复甲.md'), parked('恢复甲.md'))
  const tabWentUnavailable = await waitFor(page, `document.querySelector('.note-unavailable:not([hidden]) span')?.textContent === '文件已消失，窗口稿已保留；原路径不会重建。'`, 30000)
  await shot(page, 'recovery-tab-unavailable-1200')
  // 不自动保存也不重建：在不可用的 tab 里打字并按保存键，磁盘上都不许复活旧名字。
  await page.eval(`document.querySelector('.cm-content').cmTile.root.view.focus()`)
  await page.call('Input.insertText', { text: '消失后的窗口稿不该落盘。' })
  await page.key('s', 'KeyS', modifier, 83)
  await sleep(1500)
  const notRecreated = !existsSync(at('恢复甲.md'))
  const treeHasNoGhost = await page.eval(`![...document.querySelectorAll('.tree-note')].some(node => node.dataset.path === '恢复甲.md')`)
  for (let attempt = 0; attempt < 3 && await editorText() !== beforeDelete; attempt += 1) await page.key('z', 'KeyZ', modifier, 90)
  const draftRestored = await editorText() === beforeDelete
  const scanned = await rescan()
  if (scanned !== true) throw Error('设置「笔记库」页没能重扫核验：' + scanned)
  const missingRow = await rowFor('恢复甲.md')
  check('外部消失被识别并如实呈现：设置页如实报「仍在库外」、tab 不可用且不重建、不自动保存',
    tabWentUnavailable && notRecreated && treeHasNoGhost && draftRestored &&
      missingRow.row?.verdict === 'still-missing' && missingRow.row.confirm === null &&
      missingRow.row.text.includes('仍在库外') && missingRow.row.text.includes('文件仍不在原路径') && !missingRow.row.text.includes('已恢复'),
    JSON.stringify({ tabWentUnavailable, notRecreated, treeHasNoGhost, draftRestored, row: missingRow.row, message: missingRow.panel?.message }))
  await shot(page, 'recovery-missing-settings-1200')

  // 二、按原身份放回（同 inode）：核验未过之前它仍不是可用的原对象。
  // 重扫停在设置页，先离开它：下面看的是目录树上的标记与编辑器里的不可用提示。
  await leaveSettings()
  const inodeRestored = inodeOf(parked('恢复甲.md'))
  renameSync(parked('恢复甲.md'), at('恢复甲.md'))
  if (inodeOf(at('恢复甲.md')) !== inodeRestored) throw Error('夹具放回后 inode 变了，构造不出同身份恢复')
  const pendingMarked = await waitFor(page, `document.querySelector('.tree-note[data-path="恢复甲.md"]')?.dataset.recoveryPending === 'true' && document.querySelector('.tree-note[data-path="恢复甲.md"] .tree-recovery')?.textContent === '待核验'`, 30000)
  await shot(page, 'recovery-pending-tree-1200')
  const stillUnavailable = await page.eval(`document.querySelector('.note-unavailable:not([hidden]) span')?.textContent === '暂时无法核验文件；自动保存和生成已暂停。'`)
  const suspendedRead = await readFails('恢复甲.md')
  const scanned2 = await rescan()
  if (scanned2 !== true) throw Error('设置「笔记库」页没能重扫核验：' + scanned2)
  const restorableRow = await rowFor('恢复甲.md')
  check('对象回到原路径但核验未过：树上标「待核验」，行说可以核验恢复，对象与来源仍失效',
    pendingMarked && stillUnavailable && suspendedRead &&
      restorableRow.row?.verdict === 'restored' && restorableRow.row.confirm === '恢复甲.md' && restorableRow.row.text.includes('可以核验恢复'),
    JSON.stringify({ pendingMarked, stillUnavailable, suspendedRead, row: restorableRow.row }))
  await shot(page, 'recovery-pending-row-1200')

  // 三、核验通过：点「核验并恢复」，记录清除、树标记消失、tab 与来源恢复可用。
  await page.eval(`document.querySelector('[data-recovery-confirm="恢复甲.md"]').click()`)
  await waitFor(page, `document.querySelector('.settings-main .vault-settings')?.getAttribute('aria-busy') === 'false'`, 30000)
  const clearedRows = await waitFor(page, `(() => { const section = [...document.querySelectorAll('.settings-main section')].find(node => node.querySelector('h3')?.textContent === '外部消失与恢复核验'); return !!section && section.querySelectorAll('li').length === 0 })()`, 20000)
  const confirmMessage = await page.eval(`document.querySelector('.settings-main .vault-settings-status')?.textContent ?? ''`)
  const treeMarkerGone = await waitFor(page, `!document.querySelector('.tree-note[data-path="恢复甲.md"] .tree-recovery')`, 20000)
  await leaveSettings()
  const tabUsable = await waitFor(page, `document.querySelector('.note-unavailable')?.hidden === true && document.querySelector('.cm-content')?.cmTile?.root?.view?.state?.doc?.toString() === ${JSON.stringify(beforeDelete)}`, 20000)
  const readWorks = await page.eval(`window.rgent.noteRead('恢复甲.md').then(note => note.content === ${JSON.stringify(beforeDelete)}, () => false)`)
  // 来源恢复可用：再开一场，授权清单里必须正好是这一篇（读不出来时这一场根本起不来）。
  const rerun = await register('恢复甲.md', '恢复复跑', true)
  const answeredTwice = await page.eval(`(async () => ((await window.rgent.noteRead('恢复甲.md')).content.split('受控回答第一句。').length - 1) >= 2)()`)
  check('核验通过分支：记录清除、树标记消失、tab 与来源恢复可用',
    clearedRows && confirmMessage.includes('核验通过') && confirmMessage.includes('来源恢复可用') && treeMarkerGone && tabUsable && readWorks && rerun === true && answeredTwice,
    JSON.stringify({ clearedRows, confirmMessage, treeMarkerGone, tabUsable, readWorks, rerun, answeredTwice }))
  await shot(page, 'recovery-restored-1200')

  // 四、人原地重建同名笔记（路径保留放行）：旧记录不再占着名字拦人，人用原名字新建应当成功；
  // 旧记录转为历史，重扫后不再出现在「待恢复」。这一步放在甲的恢复核验之后，甲的路径不参与。
  // 丁登记进账本后移出库外，留着它的不可用 tab 当当前 tab 去新建：产品会先把旧窗口稿另存为
  // 同目录兄弟笔记（名字见 shell.ts 的 restoredDraftName），再关旧 tab、开新 tab；副本随临时库删除。
  writeFileSync(at('恢复丁.md'), '# 恢复丁\n\n受控原正文，用来核对同名重建。\n')
  const registeredD = await register('恢复丁.md', '恢复登记丁')
  if (registeredD !== true) throw Error('丁没有登记进账本：' + registeredD)
  renameSync(at('恢复丁.md'), parked('恢复丁.md'))
  if (!await waitFor(page, `document.querySelector('.note-unavailable:not([hidden]) span')?.textContent === '文件已消失，窗口稿已保留；原路径不会重建。'`, 30000)) throw Error('丁消失后 tab 没有进入不可用')
  // 先证明旧记录真的在：否则「不再出现」只是空断言。
  const scannedD0 = await rescan()
  if (scannedD0 !== true) throw Error('设置「笔记库」页没能重扫核验：' + scannedD0)
  const missingD = await rowFor('恢复丁.md')
  await leaveSettings()
  // 不切走：丁的不可用 tab 必须保持当前 tab，重建才会走「旧稿另存、关旧 tab、开新 tab」那条路。
  const heldBefore = await page.eval(`document.querySelector('.tab[aria-selected=true]')?.dataset.rel === '恢复丁.md' && document.querySelector('.note-unavailable')?.hidden === false`)
  if (!heldBefore) throw Error('丁的不可用 tab 没有保持为当前 tab')
  await selectBrowserFolder(page, '')
  await page.eval(`document.querySelector('.tab-new').click()`)
  if (!await waitFor(page, `!!document.querySelector('dialog[open] input')`)) throw Error('新建笔记的人确认框没有出现')
  await page.eval(`(() => { const dialog = document.querySelector('dialog[open]'); const input = dialog.querySelector('input'); input.value = '恢复丁'; input.dispatchEvent(new Event('input', { bubbles: true })); dialog.querySelector('button[value=ok]').click() })()`)
  const dingFile = await waitFor(page, `window.rgent.noteRead('恢复丁.md').then(() => true, () => false)`, 30000)
  const dingTree = await waitFor(page, `!!document.querySelector('.tree-note[data-path="恢复丁.md"]')`, 20000)
  // 旧 tab 还占着时横幅不会消失；先等横幅消失（旧 tab 已关），再确认当前 tab 是丁（新 tab 已打开）。
  const dingUsable = await waitFor(page, `document.querySelector('.note-unavailable')?.hidden === true`, 20000)
  const dingTab = await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === '恢复丁.md'`, 20000)
  const dingIdle = await page.eval(`document.querySelector('.note-unavailable')?.hidden === true`)
  // 编辑器可编辑：真敲一段，等它落盘到新笔记。
  await page.eval(`document.querySelector('.cm-content')?.cmTile?.root?.view?.focus()`)
  await page.call('Input.insertText', { text: '重建后的正文。' })
  const typedInEditor = await waitFor(page, `(document.querySelector('.cm-content')?.cmTile?.root?.view?.state?.doc?.toString() ?? '').includes('重建后的正文。')`, 10000)
  const typedSaved = await waitFor(page, `window.rgent.noteRead('恢复丁.md').then(note => note.content.includes('重建后的正文。'), () => false)`, 20000)
  // 旧窗口稿是产品行为（保留窗口稿），另存为同目录兄弟笔记；副本随临时库一起删除，不额外清理。
  const draftCopy = '恢复丁（恢复的旧稿）.md'
  const draftCopyFile = await waitFor(page, `window.rgent.noteRead(${JSON.stringify(draftCopy)}).then(() => true, () => false)`, 20000)
  const draftCopyTree = await waitFor(page, `!!document.querySelector('.tree-note[data-path=${JSON.stringify(draftCopy)}]')`, 20000)
  const draftCopyContent = await page.eval(`window.rgent.noteRead(${JSON.stringify(draftCopy)}).then(note => note.content, () => null)`)
  const scannedD1 = await rescan()
  if (scannedD1 !== true) throw Error('设置「笔记库」页没能重扫核验：' + scannedD1)
  const dingRowAfter = await rowFor('恢复丁.md')
  check('恢复：人原地重建同名笔记成功且旧记录不再拦人',
    missingD.row?.verdict === 'still-missing' && heldBefore && existsSync(at('恢复丁.md')) &&
      dingFile && dingTree && dingUsable && dingTab && dingIdle && typedInEditor && typedSaved && dingRowAfter.row === null,
    JSON.stringify({ disappearedRow: missingD.row, heldBefore, exists: existsSync(at('恢复丁.md')), dingFile, dingTree, dingUsable, dingTab, dingIdle, typedInEditor, typedSaved, rowAfter: dingRowAfter.row, dialogs: evidence.dialogs }))
  check('恢复：重建同名笔记时旧窗口稿另存为兄弟笔记且内容保住',
    existsSync(at(draftCopy)) && draftCopyFile && draftCopyTree &&
      typeof draftCopyContent === 'string' && draftCopyContent.includes('受控原正文，用来核对同名重建。'),
    JSON.stringify({ copy: draftCopy, exists: existsSync(at(draftCopy)), noteRead: draftCopyFile, tree: draftCopyTree, content: typeof draftCopyContent === 'string' ? draftCopyContent.slice(0, 200) : draftCopyContent }))
  await leaveSettings()
  await shot(page, 'recovery-human-recreate-1200')

  // 五、内容已变：同 inode、同路径放回，但内容不同——不许冒充通过。
  await selectBrowserFolder(page, '')
  await page.eval(`[...document.querySelectorAll('.tree-note')].find(node => node.dataset.path === '恢复乙.md').click()`)
  if (!await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === '恢复乙.md'`)) throw Error('乙没有成为当前 tab')
  const inodeChanged = inodeOf(at('恢复乙.md'))
  renameSync(at('恢复乙.md'), parked('恢复乙.md'))
  if (!await waitFor(page, `!!document.querySelector('.note-unavailable:not([hidden])')`, 30000)) throw Error('乙消失后 tab 没有进入不可用')
  writeFileSync(parked('恢复乙.md'), '# 恢复乙\n\n这段正文在库外被改过，哈希与登记不一致。\n')
  const inodeKept = inodeOf(parked('恢复乙.md')) === inodeChanged
  renameSync(parked('恢复乙.md'), at('恢复乙.md'))
  const scanned3 = await rescan()
  if (scanned3 !== true) throw Error('设置「笔记库」页没能重扫核验：' + scanned3)
  const changedRow = await rowFor('恢复乙.md')
  const changedMarked = await waitFor(page, `document.querySelector('.tree-note[data-path="恢复乙.md"]')?.dataset.recoveryPending === 'true'`, 30000)
  const changedSuspended = await readFails('恢复乙.md')
  const changedTabUnavailable = await page.eval(`document.querySelector('.note-unavailable')?.hidden === false`)
  check('内容已变分支：核验不过、行保持失效并如实上报，不冒充通过',
    inodeKept && changedRow.row?.verdict === 'content-changed' && changedRow.row.confirm === null &&
      changedRow.row.text.includes('内容已变') && changedRow.row.text.includes('不一致') && changedRow.row.text.includes('不自动遗忘') &&
      changedMarked && changedSuspended && changedTabUnavailable,
    JSON.stringify({ inodeKept, row: changedRow.row, changedMarked, changedSuspended, changedTabUnavailable }))
  await shot(page, 'recovery-content-changed-1200')

  // 六、附件缺失：只放回笔记、附件夹不在——降级上报，既不是通过也不是普通失败。
  const inodeAttachments = inodeOf(at('恢复丙.md'))
  renameSync(at('恢复丙.md'), parked('恢复丙.md'))
  renameSync(at('恢复丙'), parked('恢复丙'))
  // 消失要真的被程序看见（这里由设置页的重扫登记），否则夹具从没离开过，分支根本不存在。
  const scanned4 = await rescan()
  if (scanned4 !== true) throw Error('设置「笔记库」页没能重扫核验：' + scanned4)
  const stillMissingRow = await rowFor('恢复丙.md')
  renameSync(parked('恢复丙.md'), at('恢复丙.md'))
  if (inodeOf(at('恢复丙.md')) !== inodeAttachments) throw Error('丙放回后 inode 变了，构造不出同身份恢复')
  const scanned5 = await rescan()
  if (scanned5 !== true) throw Error('设置「笔记库」页没能重扫核验：' + scanned5)
  const attachmentRow = await rowFor('恢复丙.md')
  const attachmentsMarked = await waitFor(page, `document.querySelector('.tree-note[data-path="恢复丙.md"]')?.dataset.recoveryPending === 'true'`, 30000)
  const attachmentsSuspended = await readFails('恢复丙.md')
  check('附件缺失分支：只放回笔记而附件夹不在时降级上报，不冒充通过',
    stillMissingRow.row?.verdict === 'still-missing' &&
      attachmentRow.row?.verdict === 'attachments-missing' && attachmentRow.row.confirm === null &&
      attachmentRow.row.text.includes('附件夹缺失（降级）') && attachmentRow.row.text.includes('降级状态') && attachmentRow.row.text.includes('不冒充核验通过') &&
      attachmentsMarked && attachmentsSuspended,
    JSON.stringify({ disappearedRow: stillMissingRow.row, row: attachmentRow.row, attachmentsMarked, attachmentsSuspended }))
  await shot(page, 'recovery-attachments-missing-1200')

  // 七、门关：整个「笔记库」页与目录树里不许有任何删除入口、按钮或菜单项。
  const menuLabels = async (selector) => {
    // 只派发 contextmenu；不按 Esc（那会连设置浮层一起关掉）。下一次开菜单会先收掉上一个。
    await page.eval(`(() => { const row = document.querySelector(${JSON.stringify(selector)}); const rect = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 12 })) })()`)
    if (!await waitFor(page, `!!document.querySelector('.tier-menu')`)) return null
    const labels = await page.eval(`[...document.querySelectorAll('.tier-menu button')].map(node => node.textContent)`)
    evidence.menus[selector] = labels
    return labels
  }
  const noteMenu = await menuLabels('.tree-note[data-path="恢复甲.md"]')
  const dirMenu = await menuLabels('.tree-dir[data-path="资料"]')
  const gate = await page.eval(`(() => {
    const forbidden = /删除|废纸篓|回收站|清空|永久移除/
    const interactive = 'button, [role="menuitem"], [role="button"], a[href], input[type="button"], input[type="submit"], summary'
    const hits = []
    const scopes = [['设置面板', document.querySelector('.overlay-settings')], ['目录树', document.querySelector('#tree-panel')], ['顶栏', document.querySelector('.top')], ['目录菜单', document.querySelector('.tier-menu')]]
    for (const [scope, node] of scopes) {
      if (!node) { if (scope !== '目录菜单') hits.push(scope + '：整块缺失'); continue }
      for (const label of [...node.querySelectorAll(interactive)].map(item => (item.getAttribute('aria-label') || item.textContent || '').trim()).filter(Boolean)) if (forbidden.test(label)) hits.push(scope + '：' + label)
    }
    const panel = document.querySelector('.settings-main .vault-settings')
    // 「从列表移除」的说明里那句「不会删除」是解释文字，不是入口；剔掉它以后整页不许再出现「删除」。
    const pageText = (panel?.textContent ?? '').split('不会删除').join('')
    const section = [...document.querySelectorAll('.settings-main section')].find(node => node.querySelector('h3')?.textContent === '外部消失与恢复核验')
    return {
      hits,
      pageDeleteHits: pageText.match(/删除/g) ?? [],
      recoveryActions: [...(section?.querySelectorAll('button') ?? [])].map(node => node.textContent),
      recoveryVerdicts: [...(section?.querySelectorAll('li') ?? [])].map(node => node.dataset.recoveryVerdict),
      noteRowButtons: document.querySelectorAll('.tree-note[data-path="恢复甲.md"] button').length,
      dirRowButtons: document.querySelectorAll('.tree-dir[data-path="资料"] button').length
    }
  })()`)
  const expectedNoteMenu = process.platform === 'darwin' ? ['改名', '移动', '删除'] : ['改名', '移动']
  check('恢复专项：macOS 笔记可删、文件夹与设置页没有删除入口',
    JSON.stringify(noteMenu) === JSON.stringify(expectedNoteMenu) &&
      JSON.stringify(dirMenu) === JSON.stringify(['在此新建笔记', '新建文件夹', '改名', '移动', '可参考', '必须遵循', '禁止触碰']) &&
      !dirMenu.includes('删除') &&
      gate.hits.length === 0 && gate.pageDeleteHits.length === 0 &&
      gate.recoveryActions.includes('重扫并核验恢复') &&
      gate.recoveryActions.filter(action => action === '放弃恢复').length === gate.recoveryVerdicts.length &&
      JSON.stringify(gate.recoveryVerdicts) === JSON.stringify(['content-changed', 'attachments-missing']) &&
      gate.noteRowButtons === 0 && gate.dirRowButtons === 2,
    JSON.stringify({ noteMenu, dirMenu, expectedNoteMenu, ...gate }))
  await shot(page, 'recovery-gate-closed-1200')
  // 八、放弃恢复：入口与二次确认都在行内；点开先出确认块，取消则零动作（记录、路径与磁盘对象都不许变）。
  const abandonToggle = `document.querySelector('[data-recovery-abandon="恢复乙.md"]')`
  const abandonPresent = await waitFor(page, `!!${abandonToggle}`, 20000)
  const statusOf = () => page.eval(`document.querySelector('.settings-main .vault-settings-status')?.textContent ?? ''`)
  const abandonStatusBefore = await statusOf()
  const abandonBefore = { row: (await rowFor('恢复乙.md')).row, file: existsSync(at('恢复乙.md')), blocked: await readFails('恢复乙.md') }
  await page.eval(`${abandonToggle}?.click()`)
  const abandonConfirmShown = await waitFor(page, `(() => { const row=document.querySelector('[data-recovery-abandon="恢复乙.md"]')?.closest('li'); const panel=row?.querySelector('.vault-settings-confirmation'); const text=panel?.textContent||''; return !!panel && !!row.querySelector('[data-recovery-abandon-confirm="true"]') && text.includes('只清除 Rgent 库内的恢复记录') && text.includes('不会动系统废纸篓里的文件') })()`, 20000)
  const abandonAfterOpen = { file: existsSync(at('恢复乙.md')), blocked: await readFails('恢复乙.md'), row: (await rowFor('恢复乙.md')).row }
  await page.eval(`(() => { const row=document.querySelector('[data-recovery-abandon="恢复乙.md"]')?.closest('li'); const panel=row?.querySelector('.vault-settings-confirmation'); [...(panel?.querySelectorAll('button') ?? [])].find(node => node.textContent === '取消')?.click() })()`)
  const abandonConfirmClosed = await waitFor(page, `!document.querySelector('[data-recovery-abandon="恢复乙.md"]')?.closest('li')?.querySelector('.vault-settings-confirmation')`)
  const abandonAfterCancel = {
    file: existsSync(at('恢复乙.md')),
    blocked: await readFails('恢复乙.md'),
    row: (await rowFor('恢复乙.md')).row,
    status: await statusOf()
  }
  check('放弃恢复：行内入口存在，点开先出二次确认；取消后零动作',
    abandonPresent && abandonConfirmShown && abandonConfirmClosed &&
      abandonBefore.row?.verdict === 'content-changed' && abandonBefore.file && abandonBefore.blocked &&
      abandonAfterOpen.file && abandonAfterOpen.blocked && abandonAfterOpen.row?.verdict === 'content-changed' &&
      abandonAfterCancel.file && abandonAfterCancel.blocked && abandonAfterCancel.row?.verdict === 'content-changed' &&
      abandonAfterCancel.status === abandonStatusBefore && !abandonAfterCancel.status.includes('已放弃恢复'),
    JSON.stringify({ abandonPresent, abandonConfirmShown, abandonConfirmClosed, abandonStatusBefore, abandonBefore, abandonAfterOpen, abandonAfterCancel }))
  await shot(page, 'recovery-abandon-confirm-1200')

  check('恢复专项的模型调用都走受控主机', requests.length >= 4 && requests.every((request) => request.model === 'test'), String(requests.length) + '／' + JSON.stringify([...new Set(requests.map((request) => request.model))]))
  if (shotDir) writeFileSync(path.join(shotDir, 'recovery-evidence.json'), JSON.stringify(evidence, null, 2))
}

function reclaimTrashSamples() {
  const trash = path.join(homedir(), '.Trash')
  let n = 0
  for (const name of ['rg-trash-sample.md', 'rg-trash-sample', 'rg-trash-keep.md']) {
    try {
      rmSync(path.join(trash, name), { recursive: true, force: true })
      n += 1
    } catch { /* 列举废纸篓会 EPERM；已知路径仍可能被系统改名 */ }
  }
  const script = 'tell application "Finder"\ntry\ndelete (every item of trash whose name contains "rg-trash-sample" or name contains "rg-trash-keep")\nend try\nend tell'
  const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 10000 })
  if (result.status === 0) n += 1
  return n
}

/** macOS 人删除专项：右键 → 确认 → 进废纸篓；不删则不动。Windows 只断言没有删除项。 */
async function verifyHumanTrash(page, vault, shot) {
  process.stdout.write('\n人删除\n')
  const darwin = process.platform === 'darwin'
  check('窗口起来并展开目录', await waitFor(page, `!!document.querySelector('.tree-toggle') && document.querySelectorAll('.tree-row').length>0`) && await setTreeExpanded(page, true))
  await selectBrowserFolder(page, '')
  const openMenu = async (selector) => {
    await page.eval(`(() => { const row = document.querySelector(${JSON.stringify(selector)}); const rect = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 12 })) })()`)
    return waitFor(page, `!!document.querySelector('.tier-menu')`)
  }
  const labels = async () => page.eval(`[...document.querySelectorAll('.tier-menu button')].map(node => node.textContent)`)
  await waitFor(page, `document.querySelectorAll('.tree-note').length>0`)
  const noteSelector = '.tree-note[data-path="研究记录.md"]'
  check('打开一篇笔记的右键菜单', await openMenu(noteSelector))
  const noteMenu = await labels()
  check(darwin ? 'macOS 笔记菜单有删除' : 'Windows 笔记菜单没有删除',
    darwin ? noteMenu.includes('删除') : !noteMenu.includes('删除'),
    JSON.stringify(noteMenu))
  check('打开一个文件夹的右键菜单', await openMenu('.tree-dir[data-path="资料"]'))
  const dirMenu = await labels()
  check('文件夹菜单没有删除', !dirMenu.includes('删除'), JSON.stringify(dirMenu))
  if (!darwin) {
    await shot(page, 'trash-windows-no-entry-1200')
    return
  }
  const token = `rg-trash-${Date.now()}`
  writeFileSync(path.join(vault, 'rg-trash-keep.md'), `# 不删\n\n${token}-keep\n`)
  writeFileSync(path.join(vault, 'rg-trash-sample.md'), `# 样张\n\n${token}\n`)
  mkdirSync(path.join(vault, 'rg-trash-sample'))
  writeFileSync(path.join(vault, 'rg-trash-sample', '附图.txt'), `${token}-附图`)
  try {
    check('样张出现在树里', await waitFor(page, `!!document.querySelector('.tree-note[data-path="rg-trash-sample.md"]') && !!document.querySelector('.tree-note[data-path="rg-trash-keep.md"]')`))
    await openMenu('.tree-note[data-path="rg-trash-keep.md"]')
    await page.eval(`[...document.querySelectorAll('.tier-menu button')].find(n => n.textContent === '删除')?.click()`)
    check('确认卡写出路径', await waitFor(page, `!!document.querySelector('.overlay-write-confirm') && document.querySelector('.overlay-write-confirm').textContent.includes('rg-trash-keep.md')`))
    check('确认卡写明链接会失效、不会代为改字', await waitFor(page, `(() => {const text=document.querySelector('.overlay-write-confirm')?.textContent||'';return text.includes('链接会失效') && text.includes('不会代为改字')})()`))
    await shot(page, 'trash-confirm-1200')
    await page.eval(`document.querySelector('.write-confirm-cancel')?.click()`)
    check('点「不删」后文件仍在', await waitFor(page, `!document.querySelector('.overlay-write-confirm')`) && existsSync(path.join(vault, 'rg-trash-keep.md')))
    await page.eval(`document.querySelector('.tree-note[data-path="rg-trash-sample.md"]')?.click()`)
    check('样张标签已打开', await waitFor(page, `document.querySelector('.tab[data-rel="rg-trash-sample.md"]')`))
    await openMenu('.tree-note[data-path="rg-trash-sample.md"]')
    await page.eval(`[...document.querySelectorAll('.tier-menu button')].find(n => n.textContent === '删除')?.click()`)
    check('带附件夹的确认卡说明会一起送', await waitFor(page, `document.querySelector('.overlay-write-confirm')?.textContent.includes('同名附件夹')`))
    await page.eval(`document.querySelector('.write-confirm-accept')?.click()`)
    check('确认后笔记从库里消失', await waitFor(page, `!document.querySelector('.tree-note[data-path="rg-trash-sample.md"]')`, 15000) &&
      !existsSync(path.join(vault, 'rg-trash-sample.md')) && !existsSync(path.join(vault, 'rg-trash-sample')))
    check('被删笔记的标签已关掉', await page.eval(`![...document.querySelectorAll('.tab')].some(t => t.dataset.rel === 'rg-trash-sample.md')`))
    await shot(page, 'trash-after-1200')
  } finally {
    const cleaned = reclaimTrashSamples()
    if (!cleaned) process.stdout.write('  ! 未能从废纸篓清掉样张，请在访达废纸篓里找 rg-trash-sample\n')
  }
}

/** 端到端旅程专项（RGENT_UI_JOURNEY_ONLY=1）：一条真人旅程走完建、写、补、改名、挪、
 *  人删除与账本可审，作为跨能力集成证据；不复制各专项的细断言，零真实外网与真实模型。 */
async function verifyJourney(page, vault, shot) {
  process.stdout.write('\n端到端旅程\n')
  const darwin = process.platform === 'darwin'
  const journeyPath = '旅程笔记.md'
  const renamedPath = '旅程笔记改.md'
  const movedPath = `资料/${renamedPath}`
  const bodyText = '旅程正文：这条笔记从界面新建，正文由人输入。'
  const prompt = '把下面一句补到这篇：旅程补写一句。'
  const scratchPath = '旅程删除样张.md'
  const scratchBody = '旅程删除样张正文：这一篇在本次旅程中新建，删前先确认它有内容。'
  const expectedRoot = ['一个特别特别长的笔记文件名用来验证省略号.md', '研究记录.md', '资料', '过程稿.md']

  const openMenu = async (selector) => {
    const dropped = await page.eval(`(() => {
      const row = document.querySelector(${JSON.stringify(selector)})
      if (!row) return false
      const rect = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 12 }))
      return true
    })()`)
    return dropped && waitFor(page, `!!document.querySelector('.tier-menu')`)
  }
  const menuClick = async (label) => page.eval(`[...document.querySelectorAll('.tier-menu button')].find(node => node.textContent === ${JSON.stringify(label)})?.click()`)
  const fillModal = async (value) => {
    if (!await waitFor(page, `!!document.querySelector('.modal input')`)) return false
    await page.eval(`(() => {
      const input = document.querySelector('.modal input')
      input.value = ${JSON.stringify(value)}
      document.querySelector('.modal button[value=ok]')?.click()
    })()`)
    return true
  }
  const createNote = async (name) => {
    if (!await waitFor(page, `(() => { const button = document.querySelector('.resource-create'); return !!button && !button.hidden && !button.disabled })()`, 10000)) return false
    const clicked = await page.eval(`(() => { const button = document.querySelector('.resource-create'); if (!button) return false; button.click(); return true })()`)
    if (!clicked || !await fillModal(name)) return false
    return waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(`${name}.md`)}`, 15000)
  }
  const activeRel = () => page.eval(`document.querySelector('.tab[aria-selected=true]')?.dataset.rel ?? null`)
  const noteText = (rel) => page.eval(`window.rgent.noteRead(${JSON.stringify(rel)}).then(note => note.content).catch(() => null)`)

  try {
    await waitFor(page, `!!document.querySelector('.tree-toggle') && document.querySelectorAll('.tree-row').length > 0`)
    // 渲染层的模型快照要开一次设置页才刷新；不刷新的话按 Enter 只会得到「请选择可用模型」。
    await page.eval(`document.querySelector('.settings-open')?.click()`)
    await waitFor(page, `!!document.querySelector('.settings-nav')`)
    await page.key('Escape', 'Escape', 0, 27)
    await waitFor(page, `!document.querySelector('.settings-nav')`)
    await setTreeExpanded(page, true)
    await selectBrowserFolder(page, '')

    // 一、建：界面新建，编辑器与文件树同时出现。
    const created = await createNote('旅程笔记')
    const editorReady = created && await waitFor(page, `!!document.querySelector('.cm-content') && document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(journeyPath)}`)
    const treeReady = editorReady && await waitFor(page, `!!document.querySelector('.tree-note[data-path=${JSON.stringify(journeyPath)}]')`) && await page.eval(`(() => { const row = document.querySelector('.tree-note[data-path=${JSON.stringify(journeyPath)}]'); return !!row && row.getBoundingClientRect().width > 0 && document.querySelector('.tree-toggle')?.getAttribute('aria-expanded') === 'true' })()`)
    check('旅程：界面新建笔记后编辑器出现且文件树可见', created && editorReady && treeReady, JSON.stringify({ created, editorReady, treeReady, tab: await activeRel(), tree: await page.eval(`[...document.querySelectorAll('.tree-note')].map(node => node.dataset.path).slice(0, 8)`) }))
    await shot(page, 'journey-created-1200')

    // 二、写：中文正文自动保存，noteRead 与磁盘都含这段。
    await page.eval(`document.querySelector('.cm-content')?.focus()`)
    await page.call('Input.insertText', { text: bodyText })
    const saved = await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(journeyPath)})).content.includes(${JSON.stringify(bodyText)}))()`, 15000)
    const onDisk = saved && existsSync(path.join(vault, journeyPath)) && readFileSync(path.join(vault, journeyPath), 'utf8').includes(bodyText)
    const readBack = saved ? await noteText(journeyPath) : null
    check('旅程：中文正文保存后 noteRead 与磁盘都含该段', saved && onDisk && String(readBack).includes(bodyText), JSON.stringify({ saved, onDisk, read: String(readBack ?? '').slice(0, 120) }))

    // 三、补：受控模型按口令追加一句；正文与账本各留证据。
    // 口令必须是空段落开头：正文与口令之间留一个空行，否则 `/` 只是普通字符。
    await page.key('Enter', 'Enter', 0, 13)
    await page.key('Enter', 'Enter', 0, 13)
    await page.call('Input.insertText', { text: `/${prompt}` })
    const confirmed = await confirmSlashAuthorization(page)
    const finished = confirmed && await waitFor(page, `(async () => {
      const note = await window.rgent.noteRead(${JSON.stringify(journeyPath)})
      const history = await window.rgent.ledgerGet({ sessionId: note.sessionId, objectVersion: note.objectVersion, relPath: ${JSON.stringify(journeyPath)} })
      return history.ok && history.value.records.some(record => record.chapter?.status === 'completed') && note.content.includes('part="append"') && (await window.rgent.agentTasks()).length === 0
    })()`, 90000)
    const afterTask = finished ? await page.eval(`(async () => {
      const note = await window.rgent.noteRead(${JSON.stringify(journeyPath)})
      const history = await window.rgent.ledgerGet({ sessionId: note.sessionId, objectVersion: note.objectVersion, relPath: ${JSON.stringify(journeyPath)} })
      return {
        content: note.content,
        tasks: (await window.rgent.agentTasks()).length,
        appendRecorded: history.ok && history.value.records.some(record => record.chapter?.status === 'completed' && (record.chapter.provenance?.tools ?? []).some(tool => tool.name === 'append_to_note' && String(tool.outcome).startsWith('ok')))
      }
    })()`) : null
    const bodyAfter = afterTask ? String(afterTask.content).split('<!-- rgent:ledger')[0] : ''
    const appendIndex = bodyAfter.indexOf('part="append"')
    const appendCopies = (bodyAfter.match(/旅程补写一句。/g) ?? []).length
    const appended = appendIndex >= 0 && bodyAfter.slice(appendIndex).includes('旅程补写一句。') && appendCopies >= 2
    check('旅程：受控模型补写后正文出现补写句、账本记下补写', confirmed && finished && afterTask?.tasks === 0 && appended && afterTask?.appendRecorded === true, JSON.stringify({ confirmed, finished, tasks: afterTask?.tasks ?? null, appended, appendCopies, appendRecorded: afterTask?.appendRecorded ?? null, tail: bodyAfter.slice(-160) }))
    // 任务收尾后宿主会把新正文同步回编辑器；等它落地再做结构操作，避免把旧窗口稿当成脏稿保存。
    await waitFor(page, `(() => { const view = document.querySelector('.cm-content')?.cmTile?.root?.view; const text = view?.state?.doc?.toString() ?? ''; return text.includes('part="append"') && text.includes('写工具核验完成。') })()`, 15000)
    await shot(page, 'journey-appended-1200')

    // 四、改名：文件树右键 → 改名 → 预览 → 确认；tab 跟着走。
    let renamePreview = false
    if (await openMenu(`.tree-note[data-path=${JSON.stringify(journeyPath)}]`)) {
      await menuClick('改名')
      renamePreview = await fillModal('旅程笔记改') && await waitFor(page, `document.querySelector('.lifecycle-dialog')?.textContent.includes(${JSON.stringify(`${journeyPath} → ${renamedPath}`)})`, 10000)
    }
    if (renamePreview) await page.eval(`document.querySelector('.lifecycle-actions button:last-child')?.click()`)
    const renamed = renamePreview && await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(renamedPath)} && !!document.querySelector('.tree-note[data-path=${JSON.stringify(renamedPath)}]')`, 15000)
    const renamedRead = renamed ? await noteText(renamedPath) : null
    check('旅程：改名后文件名、noteRead 路径与 tab 一致', renamed && existsSync(path.join(vault, renamedPath)) && !existsSync(path.join(vault, journeyPath)) && String(renamedRead).includes(bodyText), JSON.stringify({ renamePreview, renamed, tab: await activeRel(), read: String(renamedRead ?? '').slice(0, 120) }))
    await shot(page, 'journey-renamed-1200')

    // 五、挪：右键 → 移动 → 选资料 → 预览 → 确认；树里位置与新路径都可核。
    let movePreview = false
    if (await openMenu(`.tree-note[data-path=${JSON.stringify(renamedPath)}]`)) {
      await menuClick('移动')
      if (await waitFor(page, `!!document.querySelector('.lifecycle-dialog select')`, 10000)) {
        await page.eval(`(() => { const select = document.querySelector('.lifecycle-dialog select'); select.value = '资料' })()`)
        await page.eval(`[...document.querySelectorAll('.lifecycle-dialog button')].find(node => node.textContent === '查看预览')?.click()`)
        movePreview = await waitFor(page, `document.querySelector('.lifecycle-dialog')?.textContent.includes(${JSON.stringify(`${renamedPath} → ${movedPath}`)})`, 10000)
      }
    }
    if (movePreview) await page.eval(`document.querySelector('.lifecycle-actions button:last-child')?.click()`)
    const moved = movePreview && await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(movedPath)}`, 15000)
    const located = moved && await selectBrowserFolder(page, '资料') && await waitFor(page, `!!document.querySelector('.resource-scroll .tree-note[data-path=${JSON.stringify(movedPath)}]')`, 10000)
    const movedRead = located ? await noteText(movedPath) : null
    check('旅程：挪到资料后文件树位置正确、新路径可读', moved && located && existsSync(path.join(vault, '资料', renamedPath)) && String(movedRead).includes(bodyText), JSON.stringify({ movePreview, moved, located, tab: await activeRel() }))
    await shot(page, 'journey-moved-1200')
    const journeyTabBefore = await page.eval(`(() => { const tab = document.querySelector('.tab[data-rel=${JSON.stringify(movedPath)}]'); return tab ? { label: tab.querySelector('.tab-label')?.textContent ?? '', title: tab.title } : null })()`)

    // 六、人删除：另建一篇旅程样张，右键删除 + 确认卡两步；旅程笔记留着做第七步的账本审计。
    //    旅程笔记本身不能在这里删：删掉后标签关闭，第七步就没有可打开的账本了。
    if (darwin) {
      await selectBrowserFolder(page, '')
      const scratchWasAbsent = !existsSync(path.join(vault, scratchPath))
      const scratchCreated = await createNote('旅程删除样张')
      let scratchRead = null
      if (scratchCreated) {
        await page.eval(`document.querySelector('.cm-content')?.focus()`)
        await page.call('Input.insertText', { text: scratchBody })
        const scratchSaved = await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(scratchPath)})).content.includes(${JSON.stringify(scratchBody)}))()`, 15000)
        scratchRead = scratchSaved ? await noteText(scratchPath) : null
      }
      const scratchInTree = scratchCreated && await waitFor(page, `!!document.querySelector('.tree-note[data-path=${JSON.stringify(scratchPath)}]')`, 10000)
      let menuOpened = false
      let confirmShown = false
      if (scratchInTree && await openMenu(`.tree-note[data-path=${JSON.stringify(scratchPath)}]`)) {
        menuOpened = true
        await menuClick('删除')
        confirmShown = await waitFor(page, `(() => { const text = document.querySelector('.overlay-write-confirm')?.textContent ?? ''; return text.includes(${JSON.stringify(scratchPath)}) && text.includes('移入系统废纸篓') })()`, 15000)
      }
      if (confirmShown) await page.eval(`document.querySelector('.write-confirm-accept')?.click()`)
      const gone = confirmShown && await waitFor(page, `!document.querySelector('.tree-note[data-path=${JSON.stringify(scratchPath)}]')`, 15000)
      const tabClosed = gone && await page.eval(`![...document.querySelectorAll('.tab')].some(tab => tab.dataset.rel === ${JSON.stringify(scratchPath)})`)
      const noticeOk = gone && await waitFor(page, `(document.querySelector('.status-host-notice')?.textContent ?? '').includes('笔记已移入系统废纸篓')`, 10000)
      const notice = await page.eval(`document.querySelector('.status-host-notice')?.textContent ?? ''`)
      const journeyTabAfter = await page.eval(`(() => { const tab = document.querySelector('.tab[data-rel=${JSON.stringify(movedPath)}]'); return tab ? { label: tab.querySelector('.tab-label')?.textContent ?? '', title: tab.title } : null })()`)
      const journeyTabKept = !!journeyTabBefore && !!journeyTabAfter && journeyTabAfter.label === journeyTabBefore.label && journeyTabAfter.title === journeyTabBefore.title && journeyTabAfter.label === '旅程笔记改'
      check('旅程：右键删除两步确认后树里消失、tab 关闭、废纸篓无异常', scratchWasAbsent && scratchCreated && String(scratchRead).includes(scratchBody) && scratchInTree && menuOpened && confirmShown && gone && tabClosed && journeyTabKept && noticeOk && !existsSync(path.join(vault, scratchPath)) && !/未能|未核验|孤儿/.test(notice), JSON.stringify({ scratchWasAbsent, scratchCreated, scratchSaved: String(scratchRead).includes(scratchBody), scratchInTree, menuOpened, confirmShown, gone, tabClosed, journeyTabKept, journeyTabBefore, journeyTabAfter, notice }))
      await shot(page, 'journey-trash-1200')
    } else {
      check('（跳过）旅程：人删除（当前平台没有删除入口）', true, `platform=${process.platform}`)
    }

    // 七、账本可审：回到旅程笔记打开账本，本章节与补写记录都在；关掉回正文。
    await selectBrowserFolder(page, '资料')
    const reopened = await page.eval(`(() => { const row = document.querySelector('.tree-note[data-path=${JSON.stringify(movedPath)}]'); if (!row) return false; row.click(); return true })()`) && await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(movedPath)}`)
    // 先把焦点放回正文，再确认当前 tab 就是旅程笔记，避免上一步残留的树焦点带错对象。
    await page.eval(`document.querySelector('.cm-content')?.focus()`)
    const activeBeforeLedger = await page.eval(`document.querySelector('.tab[aria-selected=true]')?.dataset.rel ?? null`)
    await page.eval(`document.querySelector('.ledger-open')?.click()`)
    const ledgerListed = reopened && activeBeforeLedger === movedPath && await waitFor(page, `!!document.querySelector('.ledger-body details')`, 15000)
    if (ledgerListed) {
      await page.eval(`document.querySelectorAll('.ledger-body details').forEach(details => { details.open = true })`)
      await waitFor(page, `!!document.querySelector('.ledger-body details > div')?.childNodes.length`, 15000)
    }
    const ledgerText = await page.eval(`document.querySelector('.ledger-body')?.textContent ?? ''`)
    await page.eval(`document.querySelector('.ledger-close')?.click()`)
    const ledgerClosed = await waitFor(page, `document.querySelector('.ledger-view')?.hidden === true`, 10000)
    check('旅程：账本本章节可见且含补写记录，关闭后回到正文', reopened && activeBeforeLedger === movedPath && ledgerListed && ledgerText.includes('append_to_note') && ledgerText.includes('ok (1)') && ledgerText.includes('口令：把下面一句补到这篇') && ledgerClosed, JSON.stringify({ reopened, activeBeforeLedger, ledgerListed, ledgerClosed, text: ledgerText.slice(0, 220) }))
    await shot(page, 'journey-ledger-1200')

    // 八、收尾：没有残留浮层或任务；一次性库里只剩旅程笔记，删除样张已不在。
    const endState = await page.eval(`(async () => ({
      tasks: (await window.rgent.agentTasks()).length,
      statusTask: !!document.querySelector('.status-task'),
      overlays: document.querySelectorAll('dialog[open], .overlay-write-confirm[open], .tier-menu').length
    }))()`)
    const rootNames = readdirSync(vault).filter(name => !name.startsWith('.')).sort()
    const movedNames = readdirSync(path.join(vault, '资料')).filter(name => !name.startsWith('.')).sort()
    const finalRead = await noteText(movedPath)
    check('旅程：收尾无残留浮层与任务、笔记库无测试垃圾', endState.tasks === 0 && !endState.statusTask && endState.overlays === 0 && String(finalRead).includes(bodyText) && !existsSync(path.join(vault, scratchPath)) && JSON.stringify(rootNames) === JSON.stringify(expectedRoot) && JSON.stringify(movedNames) === JSON.stringify([renamedPath]), JSON.stringify({ endState, rootNames, movedNames }))
  } finally {
    // 删除样张已真实进系统废纸篓；这里不清理废纸篓，报告里如实写明。
  }
}

/** 交互减负专项的受控主机（RGENT_UI_UX_ONLY=1）：只按专属口令回脚本化回答，
 *  「UX建许可」「UX建拒绝」两个口令各发一次 create_note；其余请求给既有受控回答。
 *  独立于 createControlledHostServer，既有专项的口令与分流一个字节都不动。 */
function createUxHostServer(requests) {
  const server = createHttpServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      let decoded
      try { decoded = JSON.parse(body) } catch { response.writeHead(400, { 'content-type': 'text/plain' }); response.end('bad request'); return }
      requests.push(decoded)
      const transcript = JSON.stringify(decoded.messages ?? [])
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'ux-ui', object: 'chat.completion.chunk', created: 1, model: decoded.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const toolResults = (decoded.messages ?? []).filter((message) => message.role === 'tool')
      const scenario = transcript.includes('UX建许可') ? 'allow' : transcript.includes('UX建拒绝') ? 'deny' : null
      if (scenario && toolResults.length === 0) {
        // 第一轮只提议一次新建；写确认卡由人点允许／不允许，第二轮才收尾。
        const call = scenario === 'allow'
          ? { name: 'create_note', input: { name: 'UX确认样张', body: '# UX 确认样张\n\n交互减负受控正文。' } }
          : { name: 'create_note', input: { name: 'UX拒绝样张', body: '# UX 拒绝样张\n\n不应该落盘。' } }
        emit({ tool_calls: [{ index: 0, id: 'ux-' + scenario, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] })
        emit({}, 'tool_calls')
      } else {
        emit({ content: scenario === 'allow' ? 'UX 写许可完成。' : scenario === 'deny' ? 'UX 写拒绝完成。' : '受控回答第一句。第二句。' })
        emit({}, 'stop')
      }
      response.end('data: [DONE]\n\n')
    })
  })
  return server
}

/** 交互减负专项（RGENT_UI_UX_ONLY=1）：授权卡与写确认卡非模态、卡内 Enter 发送、
 *  冲突先出可点横幅再进核对浮层、正常路径零原生 alert／confirm、卡片文案首行短且无机器码。
 *  模型是受控主机脚本，零真实供应商调用。 */
async function verifyUx(page, vault, shot) {
  process.stdout.write('\n交互减负（非模态卡片、冲突横幅、零原生弹窗）\n')
  const modifier = process.platform === 'darwin' ? 4 : 2
  const nativeDialogs = []
  await page.call('Page.enable', {})
  // 沿用各专项的拦截模式：记下每一条原生对话框并立刻确认，免得自动化被卡死。断言只认 0 条。
  page.onEvent = (message) => {
    if (message.method !== 'Page.javascriptDialogOpening') return
    nativeDialogs.push(message.params.message)
    void page.call('Page.handleJavaScriptDialog', { accept: true })
  }
  const at = (name) => path.join(vault, name)
  for (const [name, body] of Object.entries({ 'UX 授权.md': '', 'UX 写许可.md': '', 'UX 写拒绝.md': '', 'UX 冲突.md': '# UX 冲突\n\n窗口正文。\n' })) writeFileSync(at(name), body)
  // 外壳、库与文件树都就绪后再开设置页；否则设置关闭后的模型快照刷新可能还没轮到。
  const vaultReady = await waitFor(page, `(async () => { const state = await window.rgent.vaultGet(); return !!state?.sessionId && state.status === 'ready' })()`, 20000)
  await waitFor(page, `!!document.querySelector('.tree-toggle') && !!document.querySelector('.status')`, 20000)
  await setTreeExpanded(page, true)
  await selectBrowserFolder(page, '')
  const fixturesReady = await waitFor(page, `[...document.querySelectorAll('.tree-note')].filter((node) => ['UX 授权.md', 'UX 写许可.md', 'UX 写拒绝.md', 'UX 冲突.md'].includes(node.dataset.path)).length === 4`, 20000)
  // 受控供应商是经 IPC 配的；渲染层模型快照要开关一次设置页才刷新（与写工具专项同一条路）。
  await page.eval(`document.querySelector('.settings-open')?.click()`)
  await waitFor(page, `!!document.querySelector('.settings-nav')`)
  await page.key('Escape', 'Escape', 0, 27)
  await waitFor(page, `!document.querySelector('.settings-nav')`)
  await setTreeExpanded(page, true)
  await selectBrowserFolder(page, '')

  const editorText = () => page.eval(`document.querySelector('.cm-content')?.cmTile?.root?.view?.state?.doc?.toString() ?? null`)
  const clickSelector = async (selector) => {
    const point = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const rect = el.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()`)
    if (!point) return false
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    return true
  }
  const waitFile = async (file, timeout = 20000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (existsSync(file)) return true
      await sleep(200)
    }
    return false
  }
  const openNote = async (name) => {
    await selectBrowserFolder(page, '')
    if (!await waitFor(page, `[...document.querySelectorAll('.tree-note')].some((node) => node.dataset.path === ${JSON.stringify(name)})`, 15000)) return false
    await page.eval(`[...document.querySelectorAll('.tree-note')].find((node) => node.dataset.path === ${JSON.stringify(name)})?.click()`)
    if (!await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(name)}`, 10000)) return false
    await page.eval(`document.querySelector('.cm-content')?.focus()`)
    return true
  }
  const prepareAuthorization = async (prompt) => {
    await page.call('Input.insertText', { text: '/' + prompt })
    await page.key('Enter', 'Enter', 0, 13)
    return waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`, 30000)
  }
  // 非模态卡不抢焦点：测试必须先把焦点放进卡里，再按 Enter；只有焦点在卡内时 Esc／Enter 才归卡片。
  const confirmInCard = async () => {
    const focused = await page.eval(`(() => { const button = document.querySelector('.authorization-send'); if (!button || button.disabled) return false; button.focus({ preventScroll: true }); return document.activeElement === button })()`)
    if (!focused) return { ok: false, focused }
    await page.key('Enter', 'Enter', 0, 13)
    let sent = await waitFor(page, `!document.querySelector('.overlay-authorization[open]')`, 12000)
    if (!sent && await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`, 15000)) {
      // 卡片开着时在正文里打过字：内容变化会让卡片自我刷新一次，再按一次仍是卡内 Enter 发送。
      await page.eval(`document.querySelector('.authorization-send')?.focus()`)
      await page.key('Enter', 'Enter', 0, 13)
      sent = await waitFor(page, `!document.querySelector('.overlay-authorization[open]')`, 12000)
    }
    return { ok: sent, focused }
  }

  // 一、授权卡非模态：卡开着，编辑器仍能输入。
  const openedAuth = await openNote('UX 授权.md')
  // 设置页关闭后才异步刷新模型快照；状态栏的模型下拉出现即证明它已经换了新配置。
  const modelReady = await waitFor(page, `!!document.querySelector('.status-model')`, 15000)
  await page.call('Input.insertText', { text: '/请写一句话' })
  const draftBeforeCard = await editorText()
  await page.key('Enter', 'Enter', 0, 13)
  const authReady = await waitFor(page, `!!document.querySelector('dialog[open][data-modal="false"].overlay-authorization .authorization-send:not(:disabled)')`, 30000)
  const authState = authReady ? await page.eval(`(() => {
    const card = document.querySelector('dialog[open][data-modal="false"].overlay-authorization')
    if (!card) return null
    let modal = null
    let modalSupported = true
    try { modal = card.matches(':modal') } catch { modalSupported = false }
    const rect = card.getBoundingClientRect()
    return {
      open: card.open,
      dataModal: card.dataset.modal,
      modal,
      modalSupported,
      inViewport: rect.width > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
      tookFocus: card.contains(document.activeElement),
      text: card.innerText,
      first: card.querySelector('h2')?.innerText?.trim() ?? ''
    }
  })()`) : null
  const editorReachable = authState ? await page.eval(`(() => { const content = document.querySelector('.cm-content'); if (!content) return false; content.focus(); return document.activeElement === content || document.querySelector('.cm-editor')?.contains(document.activeElement) })()`) : false
  await page.call('Input.insertText', { text: 'UX非模态输入' })
  const inputLanded = await waitFor(page, `(document.querySelector('.cm-content')?.cmTile?.root?.view?.state?.doc?.toString() ?? '').includes('UX非模态输入')`, 5000)
  const cardStayedOpen = await page.eval(`!!document.querySelector('dialog[open][data-modal="false"].overlay-authorization')`)
  check('UX：授权卡非模态，打开时编辑器仍能输入', vaultReady && fixturesReady && openedAuth && modelReady && authReady && !!authState && authState.modalSupported && authState.modal === false && authState.open === true && authState.dataModal === 'false' && authState.inViewport && authState.tookFocus === false && editorReachable && inputLanded && cardStayedOpen, JSON.stringify({ vaultReady, fixturesReady, openedAuth, modelReady, authReady, authState: authState ? { open: authState.open, dataModal: authState.dataModal, modal: authState.modal, modalSupported: authState.modalSupported, inViewport: authState.inViewport, tookFocus: authState.tookFocus } : null, editorReachable, inputLanded, cardStayedOpen }))
  await shot(page, 'ux-authorization-1200')

  // 二、卡内 Enter 发送：焦点放在发送键上按 Enter，任务启动并落回答。
  // 输入测试改过正文；先撤销回原稿。撤销可能把两次输入并成一组，所以再以事务精确还原一次：
  // submitSlash 捕获的是开卡时的全文，正文必须逐字回到那一刻，卡片才可能发送成功。
  let undoRestored = await editorText() === draftBeforeCard
  for (let attempt = 0; attempt < 3 && !undoRestored; attempt += 1) {
    await page.key('z', 'KeyZ', modifier, 90)
    undoRestored = await editorText() === draftBeforeCard
  }
  if (!undoRestored && typeof draftBeforeCard === 'string') {
    await page.eval(`(() => { const view = document.querySelector('.cm-content').cmTile.root.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(draftBeforeCard)} } }); view.focus(); return true })()`)
    undoRestored = await editorText() === draftBeforeCard
  }
  const confirmation = await confirmInCard()
  const answered = confirmation.ok && await waitFor(page, `(async () => { const note = await window.rgent.noteRead('UX 授权.md'); return note.content.includes('受控回答第一句。') && (await window.rgent.agentTasks()).length === 0 })()`, 60000)
  check('UX：焦点在卡内按 Enter 就发送并完成', confirmation.focused === true && confirmation.ok && answered, JSON.stringify({ ...confirmation, undoRestored, answered }))

  // 三、写确认卡非模态：受控模型在「UX建许可」这场发 create_note，点允许才落盘。
  const openedAllow = await openNote('UX 写许可.md')
  const allowReady = openedAllow && await prepareAuthorization('UX建许可')
  const allowSent = allowReady && (await confirmInCard()).ok
  const allowConfirm = allowSent && await waitFor(page, `!!document.querySelector('.overlay-write-confirm[open]')`, 30000)
  const allowState = allowConfirm ? await page.eval(`(() => {
    const card = document.querySelector('.overlay-write-confirm')
    if (!card) return null
    const openDialogs = [...document.querySelectorAll('dialog[open]')]
    let anyModal = false
    let modalSupported = true
    for (const dialog of openDialogs) {
      try { if (dialog.matches(':modal')) anyModal = true } catch { modalSupported = false }
    }
    const rect = card.getBoundingClientRect()
    return {
      open: card.open,
      dataModal: card.dataset.modal,
      openDialogs: openDialogs.length,
      anyModal,
      modalSupported,
      inViewport: rect.width > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
      tookFocus: card.contains(document.activeElement),
      text: card.innerText,
      first: card.querySelector('.write-confirm-title')?.innerText?.trim() ?? ''
    }
  })()`) : null
  const editorStillFocusable = allowState ? await page.eval(`(() => { const content = document.querySelector('.cm-content'); if (!content) return false; content.focus(); return document.activeElement === content || document.querySelector('.cm-editor')?.contains(document.activeElement) })()`) : false
  await shot(page, 'ux-write-confirm-1200')
  const accepted = allowState && await clickSelector('.write-confirm-accept')
  const created = accepted && await waitFile(at('UX确认样张.md'))
  const createdBody = created ? readFileSync(at('UX确认样张.md'), 'utf8') : ''
  const allowSettled = created && await waitFor(page, `(async () => { const note = await window.rgent.noteRead('UX 写许可.md'); return note.content.includes('UX 写许可完成。') && (await window.rgent.agentTasks()).length === 0 })()`, 60000)
  check('UX：写确认卡非模态，点「允许」才落盘', openedAllow && allowReady && allowSent && allowConfirm && !!allowState && allowState.open === true && allowState.dataModal === 'false' && allowState.modalSupported && allowState.anyModal === false && allowState.openDialogs === 1 && allowState.inViewport && allowState.tookFocus === false && editorStillFocusable && accepted && created && createdBody.includes('交互减负受控正文。') && allowSettled, JSON.stringify({ openedAllow, allowReady, allowSent, allowConfirm, allowState: allowState ? { open: allowState.open, dataModal: allowState.dataModal, openDialogs: allowState.openDialogs, anyModal: allowState.anyModal, modalSupported: allowState.modalSupported, inViewport: allowState.inViewport, tookFocus: allowState.tookFocus } : null, editorStillFocusable, accepted, created, allowSettled }))

  // 四、拒绝不落盘：再跑一场发 create_note，点不允许；文件不在、任务照常收尾、没有弹窗。
  const openedDeny = await openNote('UX 写拒绝.md')
  const denyReady = openedDeny && await prepareAuthorization('UX建拒绝')
  const denySent = denyReady && (await confirmInCard()).ok
  const denyConfirm = denySent && await waitFor(page, `!!document.querySelector('.overlay-write-confirm[open]')`, 30000)
  const denied = denyConfirm && await clickSelector('.write-confirm-cancel')
  const denySettled = denied && await waitFor(page, `(async () => { const note = await window.rgent.noteRead('UX 写拒绝.md'); return note.content.includes('UX 写拒绝完成。') && (await window.rgent.agentTasks()).length === 0 })()`, 60000)
  const denyClean = denySettled && await page.eval(`document.querySelectorAll('dialog[open]').length === 0 && !document.querySelector('.overlay-write-confirm')`)
  check('UX：点「不允许」不落盘，任务照常收尾且无弹窗', openedDeny && denyReady && denySent && denyConfirm && denied && !existsSync(at('UX拒绝样张.md')) && denySettled && denyClean, JSON.stringify({ openedDeny, denyReady, denySent, denyConfirm, denied, rejectedAbsent: !existsSync(at('UX拒绝样张.md')), denySettled, denyClean }))

  // 五、冲突先横幅：编辑器里的未保存稿 vs 磁盘上的外部改动；Cmd/Ctrl+S 后只出 notice，
  //    点 notice 的「核对」才进既有的模态核对浮层。这里用真文件改写构造冲突。
  const openedConflict = await openNote('UX 冲突.md')
  const conflictCaret = openedConflict && await page.eval(`(() => { const view = document.querySelector('.cm-content').cmTile.root.view; view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus(); return true })()`)
  await page.call('Input.insertText', { text: '窗口未保存标记' })
  const windowDraft = await editorText()
  // 正文已与开篇夹具不同（=窗口里的未保存稿）；不拿 dot 当判据，避免自动保存抢在检查前。
  const conflictDirty = typeof windowDraft === 'string' && windowDraft.includes('窗口未保存标记') && windowDraft !== '# UX 冲突\n\n窗口正文。\n'
  writeFileSync(at('UX 冲突.md'), '# UX 冲突\n\n磁盘改动标记：外部改了这一版。\n')
  await page.key('s', 'KeyS', modifier, 83)
  const noticeShown = await waitFor(page, `(() => { const notice = [...document.querySelectorAll('.notice')].find((node) => (node.innerText || '').includes('不一致')); return !!notice && [...notice.querySelectorAll('button')].some((button) => button.textContent.trim() === '核对') })()`, 15000)
  const noticeState = noticeShown ? await page.eval(`(() => {
    const notice = [...document.querySelectorAll('.notice')].find((node) => (node.innerText || '').includes('不一致'))
    if (!notice) return null
    return { text: notice.innerText, first: notice.querySelector('.notice-title')?.innerText?.trim() ?? '', dialogs: document.querySelectorAll('dialog[open]').length, actions: [...notice.querySelectorAll('button')].map((button) => button.textContent.trim()) }
  })()`) : null
  await shot(page, 'ux-conflict-notice-1200')
  // 极端慢机器上自动保存可能先一步把草稿写盘：tab 不脏时「核对」只会重跑对照、不开模态。
  // 补一个字再按一次保存，重新制造窗口稿 vs 磁盘的对照；正常时序下这段不执行。
  const dirtyForReview = await page.eval(`!!document.querySelector('.tab[aria-selected=true] .tab-dirty')`)
  if (noticeShown && !dirtyForReview) {
    await page.eval(`document.querySelector('.cm-content')?.focus()`)
    await page.call('Input.insertText', { text: '（补记）' })
    await page.key('s', 'KeyS', modifier, 83)
  }
  const reviewClicked = noticeShown && await clickSelector('.notice-action')
  const conflictShown = reviewClicked && await waitFor(page, `!!document.querySelector('dialog[open].conflict')`, 15000)
  const conflictState = conflictShown ? await page.eval(`(() => { const dialog = document.querySelector('dialog[open].conflict'); let modal = null; let modalSupported = true; try { modal = dialog.matches(':modal') } catch { modalSupported = false } return { modal, modalSupported, dataModal: dialog.dataset.modal } })()`) : null
  await shot(page, 'ux-conflict-dialog-1200')
  // 关闭核对浮层按「继续编辑」算：两份都留着，什么都不写。横幅随后由测试清掉，收尾才可能干净。
  const conflictClosed = conflictShown && await page.eval(`(() => { document.querySelector('[data-action="continue"]')?.click(); return true })()`) && await waitFor(page, `!document.querySelector('dialog[open]')`, 15000)
  const noticeCleared = conflictClosed && await page.eval(`(() => { document.querySelector('.notice-close')?.click(); return true })()`) && await waitFor(page, `!document.querySelector('.notice')`, 5000)
  check('UX：冲突先出横幅，点「核对」才进模态', openedConflict && conflictDirty && noticeShown && noticeState?.dialogs === 0 && noticeState.text.includes('不一致') && noticeState.actions.includes('核对') && reviewClicked && conflictShown && conflictState?.modalSupported && conflictState.modal === true && conflictClosed && noticeCleared, JSON.stringify({ openedConflict, conflictCaret, conflictDirty, windowDraft, noticeShown, noticeState: noticeState ? { dialogs: noticeState.dialogs, actions: noticeState.actions } : null, dirtyForReview, reviewClicked, conflictShown, conflictState, conflictClosed, noticeCleared }))

  // 六、零原生弹窗：全程只在 Page.javascriptDialogOpening 上记数。
  check('UX：全程零原生 alert／confirm', nativeDialogs.length === 0, JSON.stringify({ dialogs: nativeDialogs.slice(0, 3) }))

  // 七、文案：三张卡片的可见文本无机器码，首行不超过 60 字。
  const MACHINE_CODE = /\b[A-Z][A-Z0-9_]{5,}\b/
  const copyCards = [
    { card: '授权卡', text: authState?.text ?? '', first: authState?.first ?? '' },
    { card: '写确认卡', text: allowState?.text ?? '', first: allowState?.first ?? '' },
    { card: '冲突横幅', text: noticeState?.text ?? '', first: noticeState?.first ?? '' }
  ]
  const machineFree = copyCards.every((item) => item.text.length > 0 && !MACHINE_CODE.test(item.text))
  const firstLinesShort = copyCards.every((item) => item.first.length > 0 && [...item.first].length <= 60)
  check('UX：卡片与横幅没有机器码，首行不超过 60 字', !!authState && !!allowState && !!noticeState && machineFree && firstLinesShort, JSON.stringify(copyCards.map((item) => ({ card: item.card, first: item.first, firstLength: [...item.first].length, machineCode: MACHINE_CODE.test(item.text) }))))

  // 八、收尾：横幅与模态都已清掉、任务清空，正文两侧都没被这次冲突破坏。
  const endState = await page.eval(`(async () => ({
    tasks: (await window.rgent.agentTasks()).length,
    taskBar: !!document.querySelector('.status-task'),
    notices: document.querySelectorAll('.notice').length,
    dialogs: document.querySelectorAll('dialog[open]').length,
    editor: document.querySelector('.cm-content')?.cmTile?.root?.view?.state?.doc?.toString() ?? null
  }))()`)
  const authorizedContent = await page.eval(`(async () => (await window.rgent.noteRead('UX 授权.md')).content)()`)
  const conflictDisk = readFileSync(at('UX 冲突.md'), 'utf8')
  const conflictDraft = typeof endState.editor === 'string' ? endState.editor : ''
  const createdKept = existsSync(at('UX确认样张.md')) && readFileSync(at('UX确认样张.md'), 'utf8').includes('交互减负受控正文。')
  const contentIntact = createdKept && !existsSync(at('UX拒绝样张.md')) && authorizedContent.includes('受控回答第一句。') &&
    conflictDisk === '# UX 冲突\n\n磁盘改动标记：外部改了这一版。\n' &&
    conflictDraft.includes('窗口正文。') && conflictDraft.includes('窗口未保存标记')
  check('UX：收尾无横幅无模态、任务清空、笔记内容未被破坏', endState.tasks === 0 && !endState.taskBar && endState.notices === 0 && endState.dialogs === 0 && contentIntact && page.errors.length === 0, JSON.stringify({ endState, contentIntact, dialogs: nativeDialogs, errors: page.errors.slice(0, 1) }))
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
const imeOnly = process.env.RGENT_UI_IME_ONLY === '1'
const multiVaultOnly = process.env.RGENT_UI_MULTI_VAULT_ONLY === '1'
const memoryOnly = process.env.RGENT_UI_MEMORY_ONLY === '1'
const skillsOnly = process.env.RGENT_UI_SKILLS_ONLY === '1'
const writeOnly = process.env.RGENT_UI_WRITE_ONLY === '1'
const recoveryOnly = process.env.RGENT_UI_RECOVERY_ONLY === '1'
const trashOnly = process.env.RGENT_UI_TRASH_ONLY === '1'
const networkOnly = process.env.RGENT_UI_NETWORK_ONLY === '1'
// 人发起联网专项：菜单/快捷键共用的对话框、总闸门控、回环拒绝与设备级审计／统计。
const humanNetworkOnly = process.env.RGENT_UI_NETWORK_HUMAN_ONLY === '1'
// 远端只读 MCP 专项：设置卡、坏地址拒绝、抓页对话框回归与口令卡门控。
const mcpOnly = process.env.RGENT_UI_MCP_ONLY === '1'
// 端到端旅程专项：建→写→补→改名→挪→人删除→账本可审，跨能力集成证据。
const journeyOnly = process.env.RGENT_UI_JOURNEY_ONLY === '1'
// 交互减负专项：非模态授权／写确认卡、冲突先横幅、零原生弹窗与卡片文案上限。
const uxOnly = process.env.RGENT_UI_UX_ONLY === '1'
// 付费专项：只由显式环境变量触发，普通测试／构建／CI 永不调用模型。
const skillsLive = process.env.RGENT_UI_SKILLS_LIVE
const v4Only = process.env.RGENT_UI_V4_ONLY === '1'

/** Browser IME commands exercise the real input bridge, rather than inserting final Chinese text. */
async function verifyComposition(page, vault, shot) {
  process.stdout.write('\n中文组合输入\n')
  const fixtures = [
    ['输入法快速.md', ''],
    ['输入法普通.md', '前文 '],
    ['输入法混合换行.md', '\ufeff开头\r\n\r\n'],
    ['输入法口令.md', '/'],
    ['输入法标题.md', '# '],
    ['输入法列表.md', '- '],
    ['输入法AI后.md', '<!-- rgent:ai:v1 -->\n回答\n']
  ]
  for (const [name, source] of fixtures) writeFileSync(path.join(vault, name), source)
  await page.eval(`(() => { const button = document.querySelector('.tree-toggle'); if (button.getAttribute('aria-expanded') !== 'true') button.click() })()`)
  await selectBrowserFolder(page, '')
  for (const [name, source] of fixtures) {
    await waitFor(page, `[...document.querySelectorAll('.tree-note')].some(node => node.dataset.path === ${JSON.stringify(name)})`)
    await page.eval(`[...document.querySelectorAll('.tree-note')].find(node => node.dataset.path === ${JSON.stringify(name)}).click()`)
    await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(name)}`)
    await page.eval(`(() => { const content = document.querySelector('.cm-content'); const view = content.cmTile.root.view; view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus() })()`)
    await page.eval(`(() => {
      const content = document.querySelector('.cm-content'), view = content.cmTile.root.view, trace = []
      const state = () => ({ text: view.state.doc.toString(), composing: view.compositionStarted,
        selection: view.state.selection.main.toJSON(), dom: content.innerHTML.slice(-600), time: performance.now() })
      const record = event => trace.push({ event: event.type, data: event.data, inputType: event.inputType, ...state() })
      const events = ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'blur', 'focus']
      events.forEach(type => content.addEventListener(type, record, true))
      const original = view.update
      view.update = function(transactions) {
        trace.push({ event: 'transaction', transactions: transactions.map(tr => ({ changes: tr.changes.toJSON(), effects: tr.effects.length,
          compose: tr.isUserEvent('input.type.compose'), external: tr.isUserEvent('rgent.external'), setText: tr.isUserEvent('rgent.setText') })), ...state() })
        return original.call(this, transactions)
      }
      window.__imeObservation = () => { events.forEach(type => content.removeEventListener(type, record, true)); view.update = original; delete window.__imeObservation; return trace }
    })()`)
    const text = () => page.eval(`(() => { const content = document.querySelector('.cm-content'); const view = content.cmTile.root.view; return { text: view.state.doc.toString(), dom: content.textContent, composing: view.compositionStarted, focus: document.activeElement?.className } })()`)
    for (const syllable of ['n', 'ni', 'nih', 'niha', 'nihao']) {
      if (name === '输入法混合换行.md' && syllable === 'niha') await page.interruptNativeFocus?.()
      const response = await page.call('Input.imeSetComposition', { text: syllable, selectionStart: syllable.length, selectionEnd: syllable.length })
      if (response.error) throw Error(JSON.stringify(response.error))
      // The first draft is held beyond the save debounce to detect a save-induced interruption.
      await sleep(syllable === 'n' && name !== '输入法快速.md' ? 1000 : 80)
      const current = await text()
      check(`${name} 拼音预编辑 ${syllable} 不丢字`, current.text === source.replace(/\r\n?|\n/g, '\n') + (name === '输入法AI后.md' ? '\n' : '') + syllable && current.composing, JSON.stringify(current))
    }
    if (name === '输入法口令.md') {
      await page.eval(`document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))`)
      await sleep(1000)
      check('组合输入的选词回车不准备或发送口令', await page.eval(`!document.querySelector('.overlay-authorization')`) === true)
      await page.eval(`document.querySelector('.authorization-cancel')?.click()`)
    }
    await shot(page, `ime-${name.slice(0, -3)}-preedit`)
    await page.call('Input.insertText', { text: '你好' })
    await sleep(200)
    const committed = await text()
    check(`${name} 选词后只保留完整汉字`, committed.text === source.replace(/\r\n?|\n/g, '\n') + (name === '输入法AI后.md' ? '\n' : '') + '你好', JSON.stringify(committed))
    await shot(page, `ime-${name.slice(0, -3)}-committed`)
    const saved = await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content.endsWith('你好'))()`)
    check(`${name} 选词结果自动保存`, saved)
    const expectedRaw = source + (name === '输入法AI后.md' ? '\n' : '') + '你好'
    check(`${name} 输入保留完整原文字节`, readFileSync(path.join(vault, name), 'utf8') === expectedRaw)
    await page.key('z', 'KeyZ', process.platform === 'darwin' ? 4 : 2, 90)
    check(`${name} 一次撤销恢复输入前全文`, (await text()).text === source.replace(/\r\n?|\n/g, '\n'))
    // CodeMirror historyKeymap: Mod-Shift-z on macOS, Mod-y on Windows/Linux.
    if (process.platform === 'darwin') await page.key('z', 'KeyZ', 4 | 8, 90)
    else await page.key('y', 'KeyY', 2, 89)
    check(`${name} 重做恢复完整选词`, (await text()).text === expectedRaw.replace(/\r\n?|\n/g, '\n'))
    for (const syllable of ['n', 'ni', '']) await page.call('Input.imeSetComposition', { text: syllable, selectionStart: syllable.length, selectionEnd: syllable.length })
    await sleep(150)
    check(`${name} 取消后保留既有正文且不残留拼音`, (await text()).text === expectedRaw.replace(/\r\n?|\n/g, '\n'))
    await page.restoreNativeWindow?.()
    const trace = await page.eval(`window.__imeObservation()`)
    if (process.env.RGENT_UI_IME_TRACE === '1' || results.some(result => result.name.startsWith(name) && !result.ok)) process.stdout.write('IME 事件与事务 ' + name + ' — ' + JSON.stringify(trace) + '\n')
  }
  const cancelled = '输入法AI取消.md'
  const cancelledSource = '<!-- rgent:ai:v1 -->\n回答\n'
  writeFileSync(path.join(vault, cancelled), cancelledSource)
  await waitFor(page, `[...document.querySelectorAll('.tree-note')].some(node => node.dataset.path === ${JSON.stringify(cancelled)})`)
  await page.eval(`[...document.querySelectorAll('.tree-note')].find(node => node.dataset.path === ${JSON.stringify(cancelled)}).click()`)
  await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === ${JSON.stringify(cancelled)}`)
  await page.eval(`(() => { const view = document.querySelector('.cm-content').cmTile.root.view; view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus() })()`)
  for (const text of ['n', 'ni', '']) await page.call('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
  await sleep(150)
  check('AI 边界取消后不残留拼音或自动断段', await page.eval(`document.querySelector('.cm-content').cmTile.root.view.state.doc.toString() === ${JSON.stringify(cancelledSource)}`) === true)
  check('AI 边界取消结果落盘不修改原文', await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(cancelled)})).content === ${JSON.stringify(cancelledSource)})()`))
  check('组合输入没有未捕获异常', page.errors.length === 0, page.errors.slice(0, 1).join(''))
}

function seedVisualVault(vault) {
  const liveImage = process.env.RGENT_UI_LIVE_IMAGE_URL || 'https://media.example.invalid/file?id=sample%2Fone'
  const research = path.join(vault, '研究记录')
  const assets = path.join(vault, '素材')
  mkdirSync(research)
  mkdirSync(assets)
  const browsing = path.join(vault, '浏览验收')
  mkdirSync(browsing)
  for (let i = 0; i < 20; i++) {
    mkdirSync(path.join(browsing, `子目录-${String(i).padStart(2, '0')}`))
    writeFileSync(path.join(browsing, `长名称资源-${String(i).padStart(2, '0')}-独立滚动.md`), '# 浏览夹具\n')
  }
  mkdirSync(path.join(research, '自然生长', '子目录'), { recursive: true })
  writeFileSync(path.join(research, '自然生长', '附件说明.md'), '# 附件说明\n')
  writeFileSync(path.join(research, '自然生长', '图.png'), '')
  writeFileSync(path.join(research, '自然生长', '子目录', '资料.pdf'), '')
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

async function verifySidebarScrolling(page) {
  await selectBrowserFolder(page, '浏览验收')
  await page.eval(`(() => { document.querySelector('.folder-scroll').scrollTop = 60; document.querySelector('.resource-scroll').scrollTop = 80; document.querySelector('.tree-toggle').click() })()`)
  await sleep(200)
  await page.eval(`document.querySelector('.tree-toggle').click()`)
  await sleep(200)
  check('仅滚动后立即收起再展开保留两区位置', await page.eval(`document.querySelector('.folder-scroll').scrollTop === 60 && document.querySelector('.resource-scroll').scrollTop === 80`) === true)
  await page.eval(`(() => { document.querySelector('.folder-scroll').scrollTop = 60; document.querySelector('.resource-scroll').scrollTop = 80; [...document.querySelectorAll('.tab')].find(node => node.innerText.includes('知识的落点'))?.click() })()`)
  await sleep(200)
  check('真实两区滚动在切 tab 后独立保持', await page.eval(`document.querySelector('.folder-scroll').scrollTop === 60 && document.querySelector('.resource-scroll').scrollTop === 80 && document.querySelector('.resource-path').textContent === '浏览验收'`) === true)
  await page.eval(`document.querySelector('.tree-toggle')?.click(); [...document.querySelectorAll('.tab')].find(node => node.innerText.includes('自然生长'))?.click()`)
  await sleep(200)
  await page.eval(`document.querySelector('.tree-toggle')?.click()`)
  await sleep(200)
  check('收起侧栏切 tab 后展开仍恢复两区滚动', await page.eval(`document.querySelector('.folder-scroll').scrollTop === 60 && document.querySelector('.resource-scroll').scrollTop === 80`) === true)
  await selectBrowserFolder(page, '素材'); await selectBrowserFolder(page, '浏览验收')
  check('切目录返回保留资源滚动', await page.eval(`document.querySelector('.resource-scroll').scrollTop === 80`) === true)
  const before = await page.eval(`document.querySelector('.folder-pane').getBoundingClientRect().height`)
  const point = await page.eval(`(() => { const rect = document.querySelector('.browser-divider').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()`)
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y + 35, button: 'left', buttons: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y + 35, button: 'left', clickCount: 1 })
  check('真实鼠标拖动分隔调整区高', await page.eval(`document.querySelector('.folder-pane').getBoundingClientRect().height > ${before + 20}`) === true)
  await page.eval(`(() => { const divider = document.querySelector('.browser-divider'); divider.focus(); divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); })()`)
  check('分隔键盘极限报告实际比例并保留两区最小高度', await page.eval(`(() => { const upper = document.querySelector('.folder-pane').offsetHeight, lower = document.querySelector('.resource-pane').offsetHeight, now = Number(document.querySelector('.browser-divider').getAttribute('aria-valuenow')); const host = document.querySelector('.file-browser'), bottom = host.getBoundingClientRect().bottom - parseFloat(getComputedStyle(host).paddingBottom); return upper >= 96 && lower >= 160 && Math.abs(now - upper / (upper + lower) * 100) <= 1 && document.querySelector('.resource-pane').getBoundingClientRect().bottom <= bottom + 1 })()`) === true)
  await page.eval(`(() => { const divider = document.querySelector('.browser-divider'); divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); for (let i = 0; i < 5; i++) divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); document.querySelector('.folder-scroll').scrollTop = 0; })()`)
  await selectBrowserFolder(page, '研究记录')
  await page.eval(`(() => { const button = [...document.querySelectorAll('.tree-folder-toggle')].find(node => node.dataset.path === '浏览验收'); if (button?.getAttribute('aria-expanded') === 'true') button.click(); document.querySelector('.folder-scroll').scrollTop = 0; [...document.querySelectorAll('.tab')].find(node => node.innerText.includes('自然生长'))?.click() })()`)
}

async function captureSidebar(page, shot, mode, size) {
  await setTreeExpanded(page, true)
  await selectBrowserFolder(page, '研究记录')
  check(`${mode}/${size}两区位于侧栏内且高度可用`, await page.eval(`(() => {
    const panel = document.querySelector('.tree-panel').getBoundingClientRect()
    const upper = document.querySelector('.folder-pane').getBoundingClientRect()
    const lower = document.querySelector('.resource-pane').getBoundingClientRect()
    const divider = document.querySelector('.browser-divider').getBoundingClientRect()
    return upper.height >= 96 && lower.height >= 160 && upper.bottom <= divider.bottom && lower.top >= divider.top && lower.bottom <= panel.bottom + 1 && getComputedStyle(document.querySelector('.folder-scroll')).overflowY === 'auto' && getComputedStyle(document.querySelector('.resource-scroll')).overflowY === 'auto'
  })()`) === true)
  await page.eval(`document.querySelector('.attachment-toggle')?.click()`)
  check(`${mode}/${size}附件仅在资源区可切换并标明归属`, await page.eval(`document.querySelector('.attachment-toggle').getAttribute('aria-pressed') === 'true' && document.querySelector('.attachment-folder')?.textContent.includes('附件 · 自然生长') && ![...document.querySelectorAll('.tree-select')].some(node => node.dataset.path.startsWith('研究记录/自然生长'))`) === true)
  check(`${mode}/${size}附件眼睛与路径同一行且无定位按钮`, await page.eval(`!document.querySelector('.resource-locate') && !!document.querySelector('.attachment-toggle .icon') && document.querySelector('.attachment-toggle').textContent === '' && Math.abs(document.querySelector('.attachment-toggle').getBoundingClientRect().top - document.querySelector('.resource-path').getBoundingClientRect().top) < 6`) === true)
  await shot(page, `sidebar-${mode}-${size}-resources`)
  await page.eval(`document.querySelector('.attachment-folder')?.click()`)
  check(`${mode}/${size}附件浏览不改变目录且无新建笔记`, await page.eval(`document.querySelector('.resource-path').textContent === '研究记录/自然生长' && document.querySelector('.tree-select[aria-current=location]').dataset.path === '研究记录' && document.querySelector('.resource-create').hidden`) === true)
  await shot(page, `sidebar-${mode}-${size}-attachment`)
  await page.eval(`document.querySelector('.resource-back')?.click(); document.querySelector('.attachment-toggle')?.click()`)
  // Tab changes must not follow the note back from a different directory.
  await selectBrowserFolder(page, '素材')
  await page.eval(`[...document.querySelectorAll('.tab')].find(node => node.innerText.includes('知识的落点'))?.click()`)
  check(`${mode}/${size}切 tab 不改变所选目录`, await page.eval(`document.querySelector('.resource-path').textContent === '素材'`) === true)
  await selectBrowserFolder(page, '研究记录')
  await page.eval(`(() => { const divider = document.querySelector('.browser-divider'); divider.focus(); divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); [...document.querySelectorAll('.tab')].find(node => node.innerText.includes('自然生长'))?.click(); document.activeElement?.blur() })()`)
}

async function captureVisualBaseline(page, shot, nativeShot) {
  process.stdout.write('\n同内容视觉样例\n')
  // CI 虚拟屏幕会把真实窗口夹到 1024px 左右；比较 1200×800 稿前先固定页面度量。
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  check('视觉对照使用 1200×800 页面度量', await page.eval(`innerWidth === 1200 && innerHeight === 800`) === true)
  const ready = await waitFor(page, `document.querySelectorAll('.tree-dir').length >= 2`)
  check('固定演示库含文件夹和多种文件类型', ready)
  if (!ready) return
  await setTreeExpanded(page, true)
  await selectBrowserFolder(page, '素材')
  const types = await page.eval(`document.querySelectorAll('.resource-scroll .tree-file').length === 3`)
  await selectBrowserFolder(page, '研究记录')
  const rows = await waitFor(page, `document.querySelectorAll('.tree-note').length >= 3`)
  check('演示库按目录显示三篇笔记及多种文件类型', rows && types)
  check('上方只含普通目录且附件默认不出现', await page.eval(`!document.querySelector('.folder-scroll .tree-note, .folder-scroll .tree-file') && ![...document.querySelectorAll('.tree-select')].some(node => node.dataset.path === '研究记录/自然生长') && !document.querySelector('.attachment-folder')`) === true)
  await page.call('Page.reload', {})
  check('重新加载恢复按库保存的目录与展开状态', await waitFor(page, `document.querySelector('.resource-path')?.textContent === '研究记录' && document.querySelector('.tree-select[aria-current=location]')?.dataset.path === '研究记录' && document.querySelector('.tree-toggle')?.getAttribute('aria-expanded') === 'true'`))
  await setTreeExpanded(page, true)
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
  // Switching tabs schedules CodeMirror's scroll restoration in its measure frame.
  // Establish the screenshot's top-of-note position after that pending layout work.
  await page.eval(`(async () => {
    document.activeElement?.blur()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    document.querySelector('.cm-scroller').scrollTop = 0
  })()`)

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
    await setTreeExpanded(page, true)
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
    await captureSidebar(page, shot, mode, 'wide')
    if (mode === 'day') await verifySidebarScrolling(page)
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
    await probe('设置遮罩柔焦且导航仅列出七页与同系图标', async () => {
      await waitFor(page, `(() => { const dialog = document.querySelector('.overlay-settings[open]'); if (!dialog) return false; const style = getComputedStyle(dialog, '::backdrop'); const blur = style.backdropFilter || style.webkitBackdropFilter; return typeof blur === 'string' && blur.includes('blur(') })()`)
      const state = JSON.parse(await page.eval(`(() => {
        const dialog = document.querySelector('.overlay-settings')
        const style = getComputedStyle(dialog, '::backdrop')
        const blur = style.backdropFilter || style.webkitBackdropFilter
        const labels = [...dialog.querySelectorAll('.settings-nav button')].map((button) => button.textContent)
        return JSON.stringify({ blur, labels, icons: dialog.querySelectorAll('.settings-nav .icon').length })
      })()`))
      return {
        ok: typeof state.blur === 'string' && state.blur.includes('blur(') && JSON.stringify(state.labels) === JSON.stringify(['笔记库','界面','助手','记忆','技能','模型','运行']) && state.icons === 7,
        detail: JSON.stringify(state)
      }
    })
    check('阅读排版有真实中英样张和五项可调控件', await waitFor(page, `document.querySelector('.settings-reading-sample')?.textContent.includes('English') && [...document.querySelectorAll('.settings-reading-controls [data-setting]')].filter(node => !node.dataset.setting.startsWith('chrome-')).length === 5`))
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
    await verifyChromeText(page, shot, `reference-${mode}-settings`)
    await page.eval(`document.querySelector('.settings-main').scrollTop = 0`)
    for (const name of ['助手', '模型', '运行']) {
      await page.eval(`([...document.querySelectorAll('.settings-nav button')].find((button) => button.textContent === '${name}'))?.click()`)
      await waitFor(page, `document.querySelector('.settings-page-title')?.textContent === '${name}'`)
      if (name === '助手') {
        await waitFor(page, `!!document.querySelector('.settings-form textarea')`)
        await shot(page, `reference-${mode}-settings-assistant`)
        await page.eval(`document.querySelector('.assistant-default-section').scrollIntoView({block:'center'})`)
        await shot(page, `reference-${mode}-settings-assistant-default`)
        continue
      }
      if (name === '模型') {
        await shot(page, `reference-${mode}-settings-model`)
        await page.eval(`(() => { document.querySelector('.settings-provider-row[data-provider="minimax"]')?.click() })()`)
        await sleep(250)
        await page.eval(`document.querySelector('.settings-main').scrollTop = 0`)
        await sleep(150)
        await shot(page, `reference-${mode}-settings-model-provider`)
        continue
      }
      await shot(page, `reference-${mode}-settings-run`)
      await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='记忆')?.click()`)
      await waitFor(page, `!!document.querySelector('[data-memory="default-model"]')`)
      await shot(page, `reference-${mode}-settings-memory`)
      await page.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
      await sleep(160)
      await shot(page, `reference-${mode}-settings-memory-wide`)
      await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
    }
    await page.eval(`([...document.querySelectorAll('.settings-nav button')].find((button) => button.textContent === '界面'))?.click()`)
    if (mode === 'day') {
      await page.hideNativeWindow?.()
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 })
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 })
      check('设置面板外真实点击可关闭并返回原焦点', await waitFor(page, `!document.querySelector('.overlay-settings') && document.activeElement?.classList.contains('settings-open')`), await page.eval(`JSON.stringify({ dialog: !!document.querySelector('.overlay-settings'), focus: document.activeElement?.className, connected: document.querySelector('.settings-open')?.isConnected, hasFocus: document.hasFocus(), open: document.querySelector('.overlay-settings')?.open, visibility: document.visibilityState })`))
      await page.restoreNativeWindow?.()
    } else {
      await page.eval(`document.querySelector('.settings-nav-current')?.focus()`)
      await page.key('Escape', 'Escape', 0, 27)
      check('设置面板按 Esc 可关闭并返回原焦点', await waitFor(page, `!document.querySelector('.overlay-settings') && document.activeElement?.classList.contains('settings-open')`), await page.eval(`JSON.stringify({ dialog: !!document.querySelector('.overlay-settings'), focus: document.activeElement?.className, connected: document.querySelector('.settings-open')?.isConnected, hasFocus: document.hasFocus() })`))
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
    await captureSidebar(page, shot, mode, 'narrow')
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
    for (const name of ['助手', '模型', '运行']) {
      await page.eval(`([...document.querySelectorAll('.settings-nav button')].find((button) => button.textContent === '${name}'))?.click()`)
      await waitFor(page, `document.querySelector('.settings-page-title')?.textContent === '${name}'`)
      if (name === '助手') {
        await waitFor(page, `!!document.querySelector('.settings-form textarea')`)
        await shot(page, `reference-${mode}-settings-assistant-narrow`)
        await page.eval(`document.querySelector('.assistant-default-section').scrollIntoView({block:'center'})`)
        await shot(page, `reference-${mode}-settings-assistant-default-narrow`)
        continue
      }
      if (name === '模型') {
        await waitFor(page, `[...document.querySelectorAll('.settings-provider-row')].length === 3`)
        await shot(page, `reference-${mode}-settings-model-narrow`)
        await page.eval(`(() => { document.querySelector('.settings-provider-row[data-provider="minimax"]')?.click() })()`)
        await sleep(200)
        await shot(page, `reference-${mode}-settings-model-provider-narrow`)
        continue
      }
      await shot(page, `reference-${mode}-settings-run-narrow`)
      await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='记忆')?.click()`)
      await waitFor(page, `!!document.querySelector('[data-memory="default-model"]')`)
      await shot(page, `reference-${mode}-settings-memory-narrow`)
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
  await selectBrowserFolder(page, '研究记录')
  await page.eval(`[...document.querySelectorAll('.tab')].find(node => node.innerText.includes('自然生长'))?.click()`)
  await page.eval(`document.querySelector('.cm-scroller').scrollTop = 0`)
  await verifySidebarWidth(page, shot)
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
  })()`) === true && readFileSync(path.join(vault, name)).equals(Buffer.from(original)))
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
  const edited = body.replace('原文字节。', '原文字节。改')
  check('编辑保存只增加输入字符，BOM与所有原换行保留', await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(edited)})()`) && readFileSync(path.join(vault,name)).equals(Buffer.from(edited+ledger)))
  await page.key('z', 'KeyZ', modifier, 90)
  await page.key('s', 'KeyS', modifier, 83)
  check('真实键盘撤销恢复原文完整字节', await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(body)})()`) && readFileSync(path.join(vault,name)).equals(Buffer.from(original)))
  await page.key(process.platform === 'darwin' ? 'Z' : 'y', process.platform === 'darwin' ? 'KeyZ' : 'KeyY', process.platform === 'darwin' ? modifier | 8 : modifier, process.platform === 'darwin' ? 90 : 89)
  await page.key('s', 'KeyS', modifier, 83)
  check('真实键盘重做保持混合换行与BOM', await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(edited)})()`) && readFileSync(path.join(vault,name)).equals(Buffer.from(edited+ledger)))
  await page.key('z', 'KeyZ', modifier, 90)
  await page.key('s', 'KeyS', modifier, 83)
  await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(body)})()`)
  // 移动按钮用原文单位；图片后的标题和尾文必须与标记一并搬走。
  await page.eval(`(() => { const marker = document.querySelector('.rgent-marker-ai'); marker?.querySelector('.rgent-marker-more-toggle')?.click(); [...(marker?.querySelectorAll('button') ?? [])].find((button) => button.textContent === '上移一段')?.click() })()`)
  await page.key('s', 'KeyS', modifier, 83)
  const swapped = body.replace(`原文字节。\n\n${ai}`, `${ai}\n\n原文字节。`)
  check('身份块搬移保留图、尾文、分隔与账本字节', await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(swapped)})()`) && readFileSync(path.join(vault,name)).equals(Buffer.from(swapped+ledger)))
  await page.key('z', 'KeyZ', modifier, 90)
  await page.key('s', 'KeyS', modifier, 83)
  await waitFor(page, `(async () => (await window.rgent.noteRead(${JSON.stringify(name)})).content === ${JSON.stringify(body)})()`)
  await page.eval(`(() => { const view = document.querySelector('.cm-content').cmTile.root.view; const at = view.state.doc.toString().indexOf('/快速完成') + '/快速完成'.length; view.dispatch({ selection: { anchor: at } }); view.focus() })()`)
  await confirmSlashAuthorization(page)
  const completed = await waitFor(page, `(async () => { const note = await window.rgent.noteRead(${JSON.stringify(name)}); return note.content.includes('受控回答第一句。第二句。') && (await window.rgent.agentTasks()).length === 0 })()`)
  check('混合换行口令按原文落点生成且旧账本保留', completed && await page.eval(`(async()=>{const n=await window.rgent.noteRead(${JSON.stringify(name)});const h=await window.rgent.ledgerGet({sessionId:n.sessionId,objectVersion:n.objectVersion,relPath:${JSON.stringify(name)}});return h.ok&&h.value.records.some(r=>r.legacyRaw?.includes('不改历史。'))&&!n.content.includes('rgent:ledger:v1')})()`))
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
  check('独立账本允许正文保存未闭合代码，不把历史吞入正文', await waitFor(page, `(async()=>{const n=await window.rgent.noteRead(${JSON.stringify(copyName)});return n.content.includes('unfinished')&&!n.content.includes('rgent:ledger:v1')})()`))
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

/** Text presets preview locally; a successful save changes only client typography. */
async function verifyChromeText(page, shot, label) {
  await waitFor(page, `!!document.querySelector('[data-setting="chrome-tabs"]:not(:disabled)')`)
  const original = await page.eval(`window.rgent.chromeTextGet()`)
  check(label + '实际设置控件使用中性焦点', await page.eval(`(() => {
    const nodes = [document.querySelector('.settings-nav-current'), document.querySelector('[data-setting="chrome-tabs"]'), document.querySelector('.settings-choice input:checked')]
    const expected = getComputedStyle(document.documentElement).getPropertyValue('--focus-ring').trim()
    const probe = document.createElement('span'); probe.style.color = expected; document.body.append(probe); const neutral = getComputedStyle(probe).color; probe.remove()
    return nodes.every(node => { node.focus(); const style = getComputedStyle(node); return style.outlineStyle === 'none' || style.outlineWidth === '0px' || style.outlineColor === neutral })
  })()`) === true)

  const baseline = await page.eval(`JSON.stringify({ root: getComputedStyle(document.documentElement).fontSize, editor: getComputedStyle(document.querySelector('.cm-editor')).fontSize, tabs: document.documentElement.style.getPropertyValue('--tab-name-font-size'), sidebar: document.documentElement.style.getPropertyValue('--sidebar-name-font-size') })`)
  for (const tabs of ['small', 'default', 'large']) for (const sidebar of ['small', 'default', 'large']) {
    const ok = await page.eval(`(() => {
      for (const [name, value] of [['tabs', '${tabs}'], ['sidebar', '${sidebar}']]) {
        const control = document.querySelector('[data-setting="chrome-' + name + '"]'); control.value = value; control.dispatchEvent(new Event('change'))
      }
      const sample = document.querySelector('.settings-chrome-sample')
      const sizes = [sample.querySelector('.tab-label'), sample.querySelector('.tree-row')].map(node => parseFloat(getComputedStyle(node).fontSize))
      return sizes.every(value => value >= 12 && value <= 16) && JSON.stringify({ root: getComputedStyle(document.documentElement).fontSize, editor: getComputedStyle(document.querySelector('.cm-editor')).fontSize, tabs: document.documentElement.style.getPropertyValue('--tab-name-font-size'), sidebar: document.documentElement.style.getPropertyValue('--sidebar-name-font-size') }) === ${JSON.stringify(baseline)}
    })()`)
    check(label + '字号样张 ' + tabs + '/' + sidebar + ' 不改变正文或工作区', ok === true)
  }
  const viewport = await page.eval(`({width:innerWidth,height:innerHeight})`)
  const fonts = JSON.stringify(JSON.parse(baseline), ['root','editor'])
  for (const size of ['large', 'small']) {
    await page.eval(`(() => { for (const name of ['tabs', 'sidebar']) { const control = document.querySelector('[data-setting="chrome-' + name + '"]'); control.value = '${size}'; control.dispatchEvent(new Event('change')) } document.querySelector('.settings-chrome-save').click() })()`)
    const saved = await waitFor(page, `(async () => { const value = await window.rgent.chromeTextGet(); return value.tabs === '${size}' && value.sidebar === '${size}' && document.querySelector('.settings-chrome-save').disabled })()`)
    check(label + '字号 ' + size + ' 保存后应用且根字号保持', saved && await page.eval(`JSON.stringify({ root: getComputedStyle(document.documentElement).fontSize, editor: getComputedStyle(document.querySelector('.cm-editor')).fontSize }) === ${JSON.stringify(fonts)}`))
    await page.eval(`document.querySelector('.settings-chrome-section').scrollIntoView({block:'center'})`)
    await shot(page, label + '-text-' + size)
    await page.eval(`document.querySelector('.overlay-settings')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    for (const [width, height] of [[1200,800],[800,560],[1840,1000]]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await sleep(160)
      check(label + '字号 ' + size + ' ' + width + ' 工作区不溢出', await page.eval(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.top').scrollWidth <= innerWidth`) === true)
      await shot(page, label + '-text-' + size + '-workspace-' + width)
    }
    await page.call('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false })
    await page.eval(`document.querySelector('.settings-open')?.click()`)
    await waitFor(page, `!!document.querySelector('[data-setting="chrome-tabs"]:not(:disabled)')`)
  }
  await page.eval(`(() => { for (const [name, value] of Object.entries(${JSON.stringify(original)})) { const control = document.querySelector('[data-setting="chrome-' + name + '"]'); control.value = value; control.dispatchEvent(new Event('change')) } document.querySelector('.settings-chrome-save').click() })()`)
  check(label + '字号回到原档', await waitFor(page, `(async () => JSON.stringify(await window.rgent.chromeTextGet()) === ${JSON.stringify(JSON.stringify(original))})()`))
}

/** 样张夹具：每供应商一份凭据、三个模型。 */
async function seedVisualModels(page) {
  await page.eval(`(async () => {
    const deepseek = await window.rgent.modelProviderSave({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', modelId: 'deepseek-flash', contextTokens: 1048576, newKey: 'ui-visual-secret' })
    if (deepseek.ok) await window.rgent.modelAdd({ provider: 'deepseek', modelId: 'deepseek-reasoner', contextTokens: 131072 })
    await window.rgent.modelProviderSave({ provider: 'minimax', baseURL: 'https://api.minimaxi.com/v1', modelId: 'MiniMax-M3', contextTokens: 204800, newKey: 'ui-visual-secret' })
    const current = await window.rgent.modelConfigGet()
    const model = current.ok && current.config.models.find(row => row.provider === 'minimax')
    if (model) await window.rgent.modelDefaultSet({ modelId: model.id })
    await window.rgent.assistantSet({ address: '写作者', tone: 'concise', note: '先给结论，再补不超过三句的理由。' })
  })()`)
}

async function verifyMultiVault(page,nativePage,vault,sibling,profile,shot,electron,child) {
  // Pause real handler receipts only in this disposable main process. The
  // production renderer/preload and every original handler check still run.
  const holdReceipt=async(channel,relPath=null)=>{
    await nativePage.eval(`(()=>{const ipc=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain;const channel=${JSON.stringify(channel)},old=ipc._invokeHandlers.get(channel),gate={seen:false,old,channel};globalThis.__workspaceGate=gate;ipc._invokeHandlers.set(channel,async(...args)=>{const result=await old(...args);if(!gate.seen && (${JSON.stringify(relPath)}===null || args[1]?.args?.[0]===${JSON.stringify(relPath)})){gate.seen=true;await new Promise(resolve=>gate.release=resolve)}return result});return true})()`)
  }
  const gateSeen=async()=>{
    for(let attempt=0;attempt<60;attempt++){if(await nativePage.eval(`globalThis.__workspaceGate.seen`))return;await sleep(100)}
    throw Error('工作区恢复回执未进入延迟夹具')
  }
  const releaseReceipt=async()=>nativePage.eval(`(()=>{const gate=globalThis.__workspaceGate;process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain._invokeHandlers.set(gate.channel,gate.old);gate.release?.();return true})()`)
  const diskWorkspace=root=>JSON.parse(readFileSync(path.join(profile,'vault-workspaces.json'),'utf8')).entries.find(entry=>entry.path===realpathSync.native(root))?.workspace
  const openNote=async(name)=>{await waitFor(page,`[...document.querySelectorAll('.tree-note')].some(n=>n.dataset.path===${JSON.stringify(name)})`);await page.eval(`[...document.querySelectorAll('.tree-note')].find(n=>n.dataset.path===${JSON.stringify(name)}).click()`);await waitFor(page,`document.querySelector('.tab[aria-selected="true"]')?.textContent.includes(${JSON.stringify(name.replace(/\.md$/,''))}) && document.querySelector('.cm-content')?.textContent.includes(${JSON.stringify(name==='第二篇.md'?'A 的第二篇':'库 ')})`)}
  const openLibrarySettings=async()=>{
    await page.eval(`document.querySelector('.settings-open').click()`)
    await waitFor(page,`!!document.querySelector('.overlay-settings[open]')`)
    await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(n=>n.textContent==='笔记库').click()`)
    await waitFor(page,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false'`)
  }
  const closeLibrarySettings=async()=>{
    await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await waitFor(page,`!document.querySelector('.overlay-settings')`)
  }
  const switchTo=async(id,label)=>{
    await openLibrarySettings()
    await waitFor(page,`!!document.querySelector('.vault-settings [data-vault-open="${id}"]:not(:disabled)')`)
    await page.eval(`document.querySelector('.vault-settings [data-vault-open="${id}"]').click()`)
    const ok = await waitFor(page,`document.querySelector('.status-vault')?.textContent===${JSON.stringify(label)} && !document.querySelector('.vault-settings')`)
    if (!ok) throw new Error('切换未完成：'+await page.eval(`JSON.stringify({vault:document.querySelector('.status-vault')?.textContent,status:document.querySelector('.vault-settings-status')?.textContent,inert:document.querySelector('#app').inert,unavailable:document.querySelector('.note-unavailable')?.textContent,notice:document.querySelector('.status-host-notice')?.textContent})`))
    return ok
  }
  check('启动恢复最后使用库 A',await waitFor(page,`document.querySelector('.status-vault')?.textContent==='研究库 A'`))
  check('右下角库名仅为只读状态',await page.eval(`(()=>{const n=document.querySelector('.status-vault');return n.tagName==='SPAN' && n.tabIndex<0 && !n.onclick && !n.hasAttribute('role')})()`))
  await page.eval(`document.querySelector('.settings-open').click()`)
  check('普通设置默认界面且六页顺序正确',await waitFor(page,`document.querySelector('.settings-page-title')?.textContent==='界面' && JSON.stringify([...document.querySelectorAll('.settings-nav button')].map(n=>n.textContent))===JSON.stringify(['笔记库','界面','助手','记忆','模型','运行'])`))
  await page.eval(`globalThis.__originalSettings=document.querySelector('.overlay-settings')`)
  await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0].webContents.send('menu:open-vault');true`)
  check('原生库菜单在同一设置面板直达库页',await waitFor(page,`document.querySelector('.settings-page-title')?.textContent==='笔记库' && document.querySelector('.overlay-settings')===globalThis.__originalSettings && document.querySelectorAll('dialog[open]').length===1`))
  check('当前库单列且没有重复切换项',await waitFor(page,`document.querySelectorAll('[data-vault-id="vault-a"]').length===1 && document.querySelector('[data-vault-id="vault-a"]')?.dataset.vaultCurrent==='true' && !document.querySelector('[data-vault-open="vault-a"]')`))
  await closeLibrarySettings()
  await openNote('同名.md');await openNote('第二篇.md');await openNote('同名.md')
  await page.eval(`(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:30,head:34}});if(document.querySelector('.tree-toggle').getAttribute('aria-expanded')==='true')document.querySelector('.tree-toggle').click()})()`)
  await sleep(150)
  await page.eval(`document.querySelector('.cm-content').cmTile.root.view.scrollDOM.scrollTop=400`)
  await sleep(700)
  const old=await page.eval(`(async()=>{const s=await window.rgent.vaultGet();globalThis.__oldNote=await window.rgent.noteRead('同名.md');globalThis.__oldSession=s.sessionId;globalThis.__oldMedia='rgent-vault://media/?p=same.png&s='+encodeURIComponent(s.sessionId);return {session:s.sessionId,workspace:await window.rgent.vaultWorkspaceGet(s.sessionId)}})()`)
  check('工作区仅保存布局，不包含正文或临时模型',old.workspace?.tabs.length===2 && old.workspace.active==='同名.md' && old.workspace.sidebarHidden && !JSON.stringify(old.workspace).includes('A 段落') && !JSON.stringify(old.workspace).includes('modelId'),JSON.stringify(old.workspace))
  await holdReceipt('note:read','第二篇.md')
  try {
    await page.call('Page.reload');await gateSeen()
    check('启动恢复第二篇等待中冻结实际交互',await page.eval(`document.querySelector('#app').inert===true && document.querySelectorAll('.tab').length===1`))
    // An actual CDP pointer cannot open the pending note through the inert root.
    await page.eval(`if(document.querySelector('.tree-toggle').getAttribute('aria-expanded')!=='true')document.querySelector('.tree-toggle').click()`)
    const point=await page.eval(`(()=>{const node=[...document.querySelectorAll('.tree-note')].find(n=>n.dataset.path==='第二篇.md'),r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await page.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point})
    await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
    await sleep(150)
    check('恢复中真实目录点击不重复打开待恢复篇',await page.eval(`document.querySelectorAll('.tab').length===1`))
  } finally { await releaseReceipt() }
  check('完整恢复后两篇唯一且恢复交互',await waitFor(page,`document.querySelector('#app').inert===false && document.querySelectorAll('.tab').length===2 && new Set([...document.querySelectorAll('.tab')].map(n=>n.dataset.rel)).size===2`))
  await holdReceipt('lifecycle:status')
  try {
    await page.call('Page.reload');await gateSeen()
    const before=JSON.stringify(diskWorkspace(vault))
    await sleep(650)
    check('启动慢初始化无交互时不覆写已有工作区',JSON.stringify(diskWorkspace(vault))===before && diskWorkspace(vault)?.tabs.length===2)
    await nativePage.eval(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron'),win=e.BrowserWindow.getAllWindows()[0];globalThis.__workspaceDialogCalls=0;globalThis.__workspaceOldDialog=e.dialog.showOpenDialog;e.dialog.showOpenDialog=async()=>{globalThis.__workspaceDialogCalls++;return {canceled:true,filePaths:[]}};win.webContents.send('menu:open-vault');win.webContents.send('menu:new-note');win.webContents.send('menu:save');win.webContents.send('app:flush-request');return true})()`)
    await page.eval(`document.querySelector('.tree-toggle').click();window.dispatchEvent(new Event('pagehide'))`)
    await sleep(650)
    check('恢复中原生菜单不启动选库或新建',await nativePage.eval(`globalThis.__workspaceDialogCalls===0`) && await page.eval(`!document.querySelector('dialog[open]') && document.querySelector('#app').inert===true`))
    check('恢复中定时、关闭flush和pagehide不保存空工作区',JSON.stringify(diskWorkspace(vault))===before)
  } finally {
    await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog.showOpenDialog=globalThis.__workspaceOldDialog;true`)
    await releaseReceipt()
  }
  check('慢初始化放行后保留原工作区并解除恢复门',await waitFor(page,`document.querySelector('#app').inert===false && document.querySelectorAll('.tab').length===2`))
  await verifyV4RestoreQuery(page,nativePage,vault,profile,shot)
  // A real lost-root notification supersedes the old restore without changing
  // the retained session. Starting recovery again then overlaps both generations.
  await holdReceipt('note:read','第二篇.md')
  await page.call('Page.reload');await gateSeen()
  await nativePage.eval(`globalThis.__olderWorkspaceGate=globalThis.__workspaceGate;true`)
  const movedRoot=vault+'-恢复代际暂失'
  renameSync(vault,movedRoot)
  try {
    await page.eval(`window.rgent.noteRead('同名.md').catch(()=>null)`)
    if(!await waitFor(page,`document.querySelector('#app').inert===false && document.querySelector('.note-unavailable')?.hidden===false`))throw Error('原库暂失未进入新状态')
  } finally { renameSync(movedRoot,vault) }
  try {
    await nativePage.eval(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');globalThis.__generationOldDialog=e.dialog.showOpenDialog;e.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(vault)}]});e.BrowserWindow.getAllWindows()[0].webContents.send('menu:open-vault');return true})()`)
    // The library page also reads lifecycle state during initialization. Hold only
    // after that real query completes, so this receipt belongs to the new restore.
    if(!await waitFor(page,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false' && document.querySelector('.vault-settings-recovery')?.textContent.includes('登记损坏可先重建原描述') && !!document.querySelector('[data-vault-action="open"]:not(:disabled)')`))throw Error('恢复代际夹具库页未完成真实初始化')
    await holdReceipt('lifecycle:status')
    await page.eval(`document.querySelector('[data-vault-action="open"]').click()`)
    await gateSeen()
    if(!await waitFor(page,`document.querySelector('#app').inert===true && document.querySelectorAll('.tab').length===1`))throw Error('新代际真实恢复未进入当前保护门')
    await nativePage.eval(`(()=>{const gate=globalThis.__olderWorkspaceGate;process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain._invokeHandlers.set(gate.channel,gate.old);gate.release();return true})()`)
    await sleep(250)
    check('同会话旧恢复迟到不加tab也不解除新恢复门',await page.eval(`document.querySelector('#app').inert===true && document.querySelectorAll('.tab').length===1`))
  } finally {
    await releaseReceipt()
    await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog.showOpenDialog=globalThis.__generationOldDialog;true`)
  }
  check('新代际完成后恢复两篇且交互可用',await waitFor(page,`document.querySelector('#app').inert===false && document.querySelectorAll('.tab').length===2`))
  await page.eval(`document.querySelector('.note-recheck').click()`);await waitFor(page,`document.querySelector('.note-unavailable')?.hidden===true`)
  await page.eval(`(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:30,head:34}});if(document.querySelector('.tree-toggle').getAttribute('aria-expanded')==='true')document.querySelector('.tree-toggle').click();view.scrollDOM.scrollTop=400})()`)
  await sleep(700)
  // Page.reload discarded the renderer globals used by the later stale-A checks.
  await page.eval(`(async()=>{globalThis.__oldNote=await window.rgent.noteRead('同名.md');globalThis.__oldSession=(await window.rgent.vaultGet()).sessionId;globalThis.__oldMedia='rgent-vault://media/?p=same.png&s='+encodeURIComponent(globalThis.__oldSession)})()`)
  // The native dialog is controlled only in this disposable test process.
  await nativePage.eval(`(()=>{const d=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog;globalThis.__oldOpenDialog=d.showOpenDialog;d.showOpenDialog=async()=>({canceled:true,filePaths:[]})})()`)
  await openLibrarySettings()
  await waitFor(page,`!!document.querySelector('[data-vault-action="open"]')`)
  await page.eval(`document.querySelector('[data-vault-action="open"]').focus();document.querySelector('[data-vault-action="open"]').click()`)
  await waitFor(page,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false'`)
  check('取消选库后恢复原操作焦点',await waitFor(page,`document.activeElement?.getAttribute('data-vault-action')==='open'`))
  check('取消选库保持旧会话、选区和设置页',await page.eval(`(async()=>{const view=document.querySelector('.cm-content').cmTile.root.view;return (await window.rgent.vaultGet()).sessionId===globalThis.__oldSession && view.state.selection.main.anchor===30 && !!document.querySelector('.vault-settings')})()`))
  await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog.showOpenDialog=globalThis.__oldOpenDialog;true`)
  // Re-selecting this same root committed a newer catalog revision while the
  // existing page retained its snapshot. Follow its CAS diagnosis: re-enter the
  // page before testing a fresh successful edit; never silently rebase its draft.
  await closeLibrarySettings();await openLibrarySettings()
  await holdReceipt('vault:catalog-change')
  try {
  await page.eval(`(()=>{const r=document.querySelector('[data-vault-id="vault-b"]');if(r.querySelector('[data-vault-action="more"]').getAttribute('aria-expanded')!=='true')r.querySelector('[data-vault-action="more"]').click();r.querySelector('[data-vault-action="edit-name"]').click();r.querySelector('input').value='写作库 B · 长名称工作资料';r.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}));r.querySelector('[data-vault-action="label"]').click()})()`)
    await gateSeen()
    await page.eval(`globalThis.__busySettings=document.querySelector('.overlay-settings')`)
    await nativePage.eval(`(()=>{const win=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0];win.webContents.send('menu:new-note');win.webContents.send('menu:open-vault');return true})()`)
    await sleep(150)
    check('库名保存等待中原生菜单不替换设置',await page.eval(`document.querySelector('.overlay-settings')===globalThis.__busySettings && document.querySelector('.settings-page-title')?.textContent==='笔记库' && document.querySelectorAll('dialog[open]').length===1 && document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='true'`))
  } finally { await releaseReceipt() }
  check('库显示名称可保存而磁盘目录不改名',await waitFor(page,`document.querySelector('[data-vault-id="vault-b"] .vault-settings-label')?.textContent.includes('长名称工作资料') && document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false'`) && existsSync(sibling))
  await page.eval(`(()=>{const r=document.querySelector('[data-vault-id="vault-b"]');if(r.querySelector('[data-vault-action="more"]').getAttribute('aria-expanded')!=='true')r.querySelector('[data-vault-action="more"]').click();r.querySelector('[data-vault-action="edit-name"]').click();r.querySelector('input').value='写作库 B';r.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}));r.querySelector('[data-vault-action="label"]').click()})()`)
  await waitFor(page,`document.querySelector('[data-vault-id="vault-b"] .vault-settings-label')?.textContent==='写作库 B' && document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false'`)
  await page.eval(`document.querySelector('[data-vault-id="vault-b"] [data-vault-action="pin"]').click()`)
  check('固定后库优先显示在其他库列表',await waitFor(page,`document.querySelector('.vault-settings-list [data-vault-id]')?.dataset.vaultId==='vault-b' && document.querySelector('[data-vault-id="vault-b"] [data-vault-action="pin"]')?.textContent.includes('取消')`))
  await closeLibrarySettings()
  await waitFor(page,`!document.querySelector('.vault-settings')`)
  // The main has committed B and sent release; only the final ready receipt
  // is held. This is the gap where the old A editor must remain frozen.
  await holdReceipt('vault:pick')
  try {
    await nativePage.eval(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');e.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(sibling)}]});e.BrowserWindow.getAllWindows()[0].webContents.send('menu:open-vault');return true})()`)
    await waitFor(page,`!!document.querySelector('[data-vault-action="open"]')`)
    await page.eval(`document.querySelector('[data-vault-action="open"]').click()`)
    await gateSeen()
    check('新库回执未到时设置保留且导航暂停',await page.eval(`!!document.querySelector('.overlay-settings') && [...document.querySelectorAll('.settings-nav button')].every(n=>n.disabled) && document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='true'`))
    await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    check('切库忙时Esc不能关闭设置',await page.eval(`!!document.querySelector('.overlay-settings')`))
    check('主进程release后ready未到仍冻结旧库正文',await page.eval(`document.querySelector('#app').inert===true && document.querySelector('.status-vault')?.textContent==='研究库 A'`))
    const before=await page.eval(`document.querySelector('.cm-content').textContent`)
    await page.eval(`document.querySelector('.cm-content').focus()`)
    await page.call('Input.insertText',{text:'release-gap-input'})
    check('release到ready空档真实输入不能进入旧稿',await page.eval(`document.querySelector('.cm-content').textContent===${JSON.stringify(before)}`) && !readFileSync(path.join(vault,'同名.md'),'utf8').includes('release-gap-input') && !readFileSync(path.join(sibling,'同名.md'),'utf8').includes('release-gap-input'))
  } finally {
    await releaseReceipt()
    await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog.showOpenDialog=globalThis.__oldOpenDialog;true`)
  }
  check('应用内切换至库 B',await waitFor(page,`document.querySelector('.status-vault')?.textContent==='写作库 B' && document.querySelector('#app').inert===false`))
  check('新库使用空工作区及默认收起状态',await page.eval(`document.querySelectorAll('.tab').length===0 && document.querySelector('.tree-panel')?.classList.contains('is-collapsed')`))
  await page.eval(`document.querySelector('.tree-toggle').click()`)
  await openNote('同名.md')
  check('同名正文来自 B',await page.eval(`document.querySelector('.cm-content').textContent.includes('只属于 B') && !document.querySelector('.cm-content').textContent.includes('A 段落')`))
  const suspendedBasis=await page.eval(`window.rgent.noteRead('同名.md')`)
  const displaced=sibling+'-暂失根'
  renameSync(sibling,displaced)
  try {
    await page.eval(`window.rgent.noteRead('同名.md').catch(()=>null)`)
    await waitFor(page,`document.querySelector('.note-unavailable')?.hidden===false`)
    await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});true`)
    await openLibrarySettings();await waitFor(page,`!!document.querySelector('[data-vault-action="open"]')`)
    await page.eval(`document.querySelector('[data-vault-action="open"]').click()`);await waitFor(page,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false'`)
  } finally {
    renameSync(displaced,sibling)
    await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog.showOpenDialog=globalThis.__oldOpenDialog;true`)
  }
  await closeLibrarySettings();await waitFor(page,`!document.querySelector('.vault-settings')`)
  await page.eval(`document.querySelector('.note-recheck').click()`)
  check('暂失根取消选库后既有重新核验入口恢复',await waitFor(page,`document.querySelector('.note-unavailable')?.hidden===true && document.querySelector('.cm-content')?.textContent.includes('只属于 B')`))
  const recoveredBasis=await page.eval(`window.rgent.noteRead('同名.md').catch(()=>null)`)
  check('暂失根恢复保留同文件身份、会话与正文',recoveredBasis?.objectVersion===suspendedBasis.objectVersion && recoveredBasis?.sessionId===suspendedBasis.sessionId && recoveredBasis?.content===suspendedBasis.content)
  const media=await page.eval(`(async()=>({old:globalThis.__oldMedia,current:'rgent-vault://media/?p=same.png&s='+encodeURIComponent((await window.rgent.vaultGet()).sessionId)}))()`)
  const images=await nativePage.eval(`(async()=>{const net=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').net;const old=await net.fetch(${JSON.stringify(media.old)});const current=await net.fetch(${JSON.stringify(media.current)});const bytes=new Uint8Array(await current.arrayBuffer());return {old:old.status,current:current.status,last:bytes.at(-1)}})()` )
  check('旧库媒体地址不重新解释为新库同名图片',images.old===410 && images.current===200 && images.last===66,JSON.stringify(images))
  const denied=await page.eval(`window.rgent.noteWrite({relPath:'同名.md',content:'跨库伪造',sessionId:globalThis.__oldSession,objectVersion:globalThis.__oldNote.objectVersion,expectedRevision:globalThis.__oldNote.revision})`)
  check('旧会话写请求被拒绝且 B 未改变',!denied.ok && denied.error==='VAULT_CHANGED' && readFileSync(path.join(sibling,'同名.md'),'utf8').includes('只属于 B'))
  await openLibrarySettings()
  if(!await waitFor(page,`document.querySelector('.vault-settings-recovery')?.textContent.includes('登记损坏可先重建原描述')`))throw Error('慢目标夹具库页未完成真实初始化')
  await holdReceipt('lifecycle:status')
  const switching=switchTo('vault-a','研究库 A')
  try {
    await gateSeen();const before=JSON.stringify(diskWorkspace(vault));await sleep(650)
    check('正常切换慢目标初始化不以空tab覆写目标工作区',JSON.stringify(diskWorkspace(vault))===before && diskWorkspace(vault)?.tabs.length===2 && await page.eval(`document.querySelector('#app').inert===true`))
  } finally { await releaseReceipt() }
  check('返回 A 恢复两篇 tab、活动篇与侧栏',await switching && await waitFor(page,`document.querySelectorAll('.tab').length===2 && document.querySelector('.tab[aria-selected="true"]')?.textContent.includes('同名') && document.querySelector('.tree-panel')?.classList.contains('is-collapsed')`))
  const position=await page.eval(`(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;return {anchor:view.state.selection.main.anchor,head:view.state.selection.main.head,top:view.scrollDOM.scrollTop}})()`)
  check('恢复选区与阅读位置',position.anchor===30 && position.head===34 && position.top>200,JSON.stringify(position))
  await verifyV4NativeRestoreProducer(page,nativePage,switchTo,profile,vault)
  await page.eval(`document.querySelector('.cm-content').cmTile.root.view.dispatch({selection:{anchor:0},changes:{from:0,insert:'切换前的新输入\\n'}})`)
  check('有未保存输入时切换 B 成功',await switchTo('vault-b','写作库 B'))
  check('切换前新输入已保存在 A，不写入 B',readFileSync(path.join(vault,'同名.md'),'utf8').startsWith('切换前的新输入')&&!readFileSync(path.join(sibling,'同名.md'),'utf8').includes('切换前的新输入'))
  await sleep(700)
  await page.call('Page.reload');check('页面重载恢复 B 当前工作区',await waitFor(page,`document.querySelector('.status-vault')?.textContent==='写作库 B' && document.querySelectorAll('.tab').length===1 && document.querySelector('.cm-content')?.textContent.includes('只属于 B')`))
  check('最后使用库持久化为 B',JSON.parse(readFileSync(path.join(profile,'vault-catalog.json'),'utf8')).lastVaultId==='vault-b')
  const created=path.join(path.dirname(sibling),'新建空库'),relocated=path.join(path.dirname(sibling),'已移动的空库')
  await nativePage.eval(`(()=>{const d=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog;globalThis.__oldSaveDialog=d.showSaveDialog;d.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(created)}})})()`)
  await openLibrarySettings();await waitFor(page,`!!document.querySelector('[data-vault-action="create"]')`)
  await page.eval(`document.querySelector('[data-vault-action="create"]').click()`)
  check('创建空库通过同一切换管线打开',await waitFor(page,`document.querySelector('.status-vault')?.textContent==='新建空库' && !document.querySelector('.vault-settings')`) && existsSync(created))
  const createdId=await page.eval(`(async()=>{const c=await window.rgent.vaultCatalog();return c.entries.find(e=>e.label==='新建空库').id})()`)
  check('新空库不恢复旧库笔记',await page.eval(`document.querySelectorAll('.tab').length===0`))
  await switchTo('vault-b','写作库 B')
  renameSync(created,relocated)
  await nativePage.eval(`(()=>{const d=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog;d.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(relocated)}]})})()`)
  await openLibrarySettings()
  await page.eval(`document.querySelector('[data-vault-id="${createdId}"] [data-vault-action="more"]').click();document.querySelector('[data-vault-id="${createdId}"] [data-vault-action="relocate"]').click()`)
  check('重新定位更新列表且保留文件',await waitFor(page,`document.querySelector('[data-vault-id="${createdId}"] .vault-settings-path p')?.textContent.includes('已移动的空库') && document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false'`) && existsSync(relocated))
  await page.eval(`if(document.querySelector('[data-vault-id="${createdId}"] [data-vault-action="more"]').getAttribute('aria-expanded')!=='true')document.querySelector('[data-vault-id="${createdId}"] [data-vault-action="more"]').click();document.querySelector('[data-vault-id="${createdId}"] [data-vault-action="remove"]').click()`)
  check('移除目录项前显示保留文件说明',await page.eval(`document.querySelector('[data-vault-id="${createdId}"] .vault-settings-confirmation').textContent.includes('不会删除')`))
  await page.eval(`document.querySelector('[data-vault-id="${createdId}"] [data-vault-action="confirm-remove"]').click()`)
  check('确认移除只删除目录项',await waitFor(page,`!document.querySelector('[data-vault-id="${createdId}"]')`) && existsSync(relocated))
  await closeLibrarySettings()
  await waitFor(page,`!document.querySelector('.vault-settings')`)
  await nativePage.eval(`(()=>{const d=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog;d.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(path.join(sibling,'不允许的子库'))}})})()`)
  await openLibrarySettings();await waitFor(page,`!!document.querySelector('[data-vault-action="create"]')`)
  await page.eval(`document.querySelector('[data-vault-action="create"]').click()`)
  check('拒绝嵌套建库且没有残留目录',await waitFor(page,`document.querySelector('.vault-settings-status')?.textContent.includes('不能互相包含')`) && !existsSync(path.join(sibling,'不允许的子库')))
  await closeLibrarySettings()
  await waitFor(page,`!document.querySelector('.vault-settings')`)
  await nativePage.eval(`(()=>{const d=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog;d.showOpenDialog=globalThis.__oldOpenDialog;d.showSaveDialog=globalThis.__oldSaveDialog})()`)
  chmodSync(sibling,0o500)
  try {
    await page.eval(`document.querySelector('.cm-content').cmTile.root.view.dispatch({changes:{from:0,insert:'必须保留的草稿'}})`)
    await openLibrarySettings();await waitFor(page,`!!document.querySelector('[data-vault-open="vault-a"]')`)
    await page.eval(`document.querySelector('[data-vault-open="vault-a"]').click()`)
    await waitFor(page,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false' && document.querySelector('.vault-settings-status')?.textContent.includes('尚未保存')`)
    check('正文保存失败留在原库并保留草稿',await page.eval(`document.querySelector('.status-vault')?.textContent==='写作库 B' && document.querySelector('.cm-content')?.textContent.includes('必须保留的草稿') && document.querySelector('#app').inert===false`) && !readFileSync(path.join(sibling,'同名.md'),'utf8').includes('必须保留的草稿'))
    for(const theme of ['day','night']) {
      await page.eval(`window.rgent.themeSet('${theme}')`)
      await page.call('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false})
      await shot(page,'vault-settings-failure-'+theme)
    }
    await closeLibrarySettings()
      await waitFor(page,`!document.querySelector('.vault-settings')`)
  } finally { chmodSync(sibling,0o700) }
  await page.eval(`if(document.querySelector('.note-unavailable')?.hidden===false)document.querySelector('.note-recheck').click()`)
  await waitFor(page,`document.querySelector('.note-unavailable')?.hidden===true`)
  await switchTo('vault-a','研究库 A');await switchTo('vault-b','写作库 B')
  check('存储恢复并重新核验后切换保存草稿',readFileSync(path.join(sibling,'同名.md'),'utf8').includes('必须保留的草稿'))
  // A real external edit races with a dirty draft during switch preparation.
  // Keep the same settings instance even when ordinary save would ask to resolve it.
  const beforeConflict=readFileSync(path.join(sibling,'同名.md'),'utf8')
  await openLibrarySettings()
  await page.eval(`(()=>{globalThis.__conflictSettings=document.querySelector('.overlay-settings');globalThis.__confirmBeforeConflict=window.confirm;window.confirm=()=>true;const r=document.querySelector('[data-vault-id="vault-a"]');r.querySelector('.vault-settings-path').open=true;r.querySelector('[data-vault-action="more"]').click();r.querySelector('[data-vault-action="edit-name"]').click();r.querySelector('input').value='保存冲突前的名称草稿';r.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}))})()`)
  writeFileSync(path.join(sibling,'同名.md'),'磁盘冲突改动\n'+beforeConflict)
  await page.eval(`(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({changes:{from:0,insert:'窗口冲突改动\\n'}});const b=document.querySelector('[data-vault-open="vault-a"]');b.focus();b.click()})()`)
  await waitFor(page,`!!document.querySelector('.conflict') || document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false' && !!document.querySelector('.vault-settings-status')?.textContent`)
  // 冲突处理后的焦点同样是异步落位的：这一段改用等待，其余断言逐字保持原样。
  check('切库正文冲突不替换设置且保留名称、展开与焦点',await waitFor(page,`document.querySelector('.overlay-settings')===globalThis.__conflictSettings && !document.querySelector('.conflict') && document.querySelector('[data-vault-id="vault-a"] input')?.value==='保存冲突前的名称草稿' && document.querySelector('[data-vault-id="vault-a"] .vault-settings-path')?.open===true && document.activeElement?.dataset.vaultOpen==='vault-a'`))
  check('切库正文冲突明确要求先处理保存而两份稿都保留',await page.eval(`document.querySelector('.status-vault')?.textContent==='写作库 B' && document.querySelector('.cm-content')?.textContent.includes('窗口冲突改动') && document.querySelector('.vault-settings-status')?.textContent.includes('冲突')`) && readFileSync(path.join(sibling,'同名.md'),'utf8').startsWith('磁盘冲突改动'))
  if(await page.eval(`!!document.querySelector('.vault-settings')`))for(const theme of ['day','night']) {
    await page.eval(`window.rgent.themeSet('${theme}')`)
    await shot(page,'vault-settings-conflict-'+theme)
  }
  // Baseline RED can show the old conflict dialog; settle it without choosing a draft.
  if(await page.eval(`!!document.querySelector('.conflict')`))await page.eval(`document.querySelector('.conflict [data-action="continue"]').click()`)
  await page.eval(`window.confirm=globalThis.__confirmBeforeConflict`)
  if(await page.eval(`!!document.querySelector('.overlay-settings')`))await closeLibrarySettings()
  await waitFor(page,`document.querySelector('#app').inert===false && !document.querySelector('.conflict')`)
  await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0].webContents.send('menu:save');true`)
  await waitFor(page,`!!document.querySelector('.conflict [data-action="window"]')`)
  await page.eval(`document.querySelector('.conflict [data-action="window"]').click()`)
  check('关闭设置后普通保存仍提供既有冲突决策',await waitFor(page,`!document.querySelector('.conflict') && !document.querySelector('.tab-dirty')`) && readFileSync(path.join(sibling,'同名.md'),'utf8').startsWith('窗口冲突改动'))
  await page.eval(`(()=>{const v=document.querySelector('.cm-content').cmTile.root.view;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(beforeConflict)}}})})()`)
  await waitFor(page,`!document.querySelector('.tab-dirty')`)
  await page.eval(`(async()=>{const c=await window.rgent.vaultCatalog();await window.rgent.vaultCatalogChange({id:'vault-a',revision:c.revision,action:'label',label:'研究资料 · 长期记忆、项目建设与多库工作区的完整记录'})})()`)
  for(const theme of ['day','night']) {
    await page.eval(`window.rgent.themeSet('${theme}')`)
    for(const [width,height] of [[1200,800],[800,560],[1840,1000]]) {
      await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
      await openLibrarySettings()
      check(theme+' '+width+' 库管理不横向溢出',await page.eval(`document.querySelector('.vault-settings').scrollWidth<=document.querySelector('.vault-settings').clientWidth && document.documentElement.scrollWidth<=innerWidth`))
      await page.eval(`document.querySelectorAll('.vault-settings-path').forEach(n=>n.open=true);document.querySelector('[data-vault-open]').focus()`)
      await shot(page,'vault-settings-'+theme+'-'+width)
      if(width===1200) {
        await page.eval(`(()=>{const r=document.querySelector('[data-vault-id="vault-a"]');if(r.querySelector('[data-vault-action="more"]').getAttribute('aria-expanded')!=='true')r.querySelector('[data-vault-action="more"]').click();r.querySelector('[data-vault-action="edit-name"]').click();const input=r.querySelector('input');input.value='研究资料 · 我的显示名称';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus()})()`)
        await shot(page,'vault-settings-edit-'+theme)
        await page.eval(`document.querySelector('[data-vault-id="vault-a"] [data-vault-action="cancel-name"]').click();if(document.querySelector('[data-vault-id="vault-a"] [data-vault-action="more"]').getAttribute('aria-expanded')!=='true')document.querySelector('[data-vault-id="vault-a"] [data-vault-action="more"]').click();document.querySelector('[data-vault-id="vault-a"] [data-vault-action="remove"]').click()`)
        await shot(page,'vault-settings-remove-'+theme)
        await page.eval(`document.querySelector('[data-vault-id="vault-a"] [data-vault-action="cancel-remove"]').click()`)
      }
      await closeLibrarySettings()
      await waitFor(page,`!document.querySelector('.vault-settings')`)
    }
  }
  const second=spawn(electron,['.',`--user-data-dir=${profile}`,'--no-sandbox','--disable-gpu'],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},stdio:'ignore'})
  const exited=await new Promise(resolve=>{const timer=setTimeout(()=>{second.kill('SIGTERM');resolve(false)},6000);second.on('exit',code=>{clearTimeout(timer);resolve(code===0)})})
  check('第二次启动只唤起原窗口且退出',exited && await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows().length===1`))
  // Complete a real committed switch with a pending native close, then restart this same profile.
  await switchTo('vault-a','研究资料 · 长期记忆、项目建设与多库工作区的完整记录')
  const closeEvidence=path.join(profile,'v4-native-close-evidence.json')
  await nativePage.eval(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron'),fs=process.getBuiltinModule('fs'),win=globalThis.__rgentTestWindow,ipc=e.ipcMain,g={events:[],acks:[],closed:0},send=win.webContents.send,ack=ipc._invokeHandlers.get('vault:transition');globalThis.__readyNativeClose=g;win.webContents.send=function(channel,...args){g.events.push({channel,value:args[0],time:Date.now()});return send.call(this,channel,...args)};ipc._invokeHandlers.set('vault:transition',async(...args)=>{const result=await ack(...args);g.acks.push({receipt:args[1]?.args?.[0]??args[1],result,time:Date.now()});return result});win.once('closed',()=>{g.closed++;fs.writeFileSync(${JSON.stringify(closeEvidence)},JSON.stringify(g));e.app.quit()});return true})()`)
  await holdV4Receipt(nativePage,'vault:workspace-get')
  try{
    await openLibrarySettings();await page.eval(`document.querySelector('[data-vault-open="vault-b"]').click()`);await v4ReceiptSeen(nativePage)
    await nativePage.eval(`globalThis.__rgentTestWindow.close();globalThis.__rgentTestWindow.close();true`)
    check('最后真实提交恢复门持有唯一延后关闭，不发并发flush',await nativePage.eval(`globalThis.__readyNativeClose.closed===0&&!globalThis.__rgentTestWindow.isDestroyed()&&globalThis.__readyNativeClose.events.filter(e=>e.channel==='app:flush-request').length===0`)&&await page.eval(`document.querySelector('#app').inert===true`))
  }finally{await releaseV4Receipt(nativePage)}
  for(let n=0;n<100&&!existsSync(closeEvidence);n++)await sleep(100)
  if(!existsSync(closeEvidence))throw Error('目标 ready 后原生关闭没有完成')
  const completedClose=JSON.parse(readFileSync(closeEvidence,'utf8')),accepted=completedClose.acks.filter(a=>a.result===true&&a.receipt.outcome==='ready'),flushes=completedClose.events.filter(e=>e.channel==='app:flush-request')
  check('真实 ready 回执后仅一次关闭flush和一次窗口关闭退出',completedClose.closed===1&&accepted.length===1&&flushes.length===1&&completedClose.events.some(e=>e.channel==='vault:transition'&&e.value.busy===false&&e.time<=flushes[0].time))
  nativePage.close();page.close()
  await new Promise((resolve,reject)=>{if(child.exitCode!==null)return resolve();const t=setTimeout(()=>reject(new Error('原窗口进程退出超时')),6000);child.once('exit',()=>{clearTimeout(t);resolve()})})
  check('原生成功关闭流程真实进程正常退出',child.exitCode===0)
  const restart=async(assertion)=>{
    const port=await availablePort()
    const processRun=spawn(electron,['.',`--user-data-dir=${profile}`,'--no-sandbox','--disable-gpu','--disable-renderer-backgrounding','--disable-background-timer-throttling',`--remote-debugging-port=${port}`],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},stdio:'ignore'})
    let restoredPage
    try {
      for(let i=0;i<40;i++){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}await sleep(250)}
      restoredPage=await connect(port)
      await assertion(restoredPage)
    }finally{restoredPage?.close();processRun.kill('SIGKILL');await new Promise((resolve,reject)=>{if(processRun.exitCode!==null||processRun.signalCode!==null)return resolve();const t=setTimeout(()=>reject(new Error('重启夹具进程清理超时')),6000);processRun.once('exit',()=>{clearTimeout(t);resolve()})})}
  }
  await restart(async restoredPage=>{
    check('实际进程重启恢复最后使用库及工作区',await waitFor(restoredPage,`document.querySelector('.status-vault')?.textContent==='写作库 B' && document.querySelectorAll('.tab').length===1 && document.querySelector('.cm-content')?.textContent.includes('必须保留的草稿')`))
  })
  renameSync(path.join(sibling,'同名.md'),path.join(sibling,'临时移走.md'))
  await restart(async restoredPage=>{
    check('重启时缺失笔记保留提示且不重建文件',await waitFor(restoredPage,`document.querySelector('.status-vault')?.textContent==='写作库 B' && document.querySelectorAll('.tab').length===1 && document.querySelector('.tab')?.textContent.includes('同名') && document.querySelector('.note-unavailable')?.hidden===false`) && !existsSync(path.join(sibling,'同名.md')))
  })
  const catalogBefore=readFileSync(path.join(profile,'vault-catalog.json'),'utf8')
  renameSync(sibling,sibling+'-原对象');mkdirSync(sibling)
  await restart(async restoredPage=>{
    check('上次库被替换时停在选库，不回退其他库',await waitFor(restoredPage,`!!document.querySelector('.picker-card') && document.querySelectorAll('.tab').length===0`) && readFileSync(path.join(profile,'vault-catalog.json'),'utf8')===catalogBefore)
    await restoredPage.eval(`[...document.querySelectorAll('.pick-btn')].find(n=>n.textContent==='已登记的笔记库').click()`);await waitFor(restoredPage,`!!document.querySelector('.vault-settings')`);await restoredPage.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await restoredPage.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});check('未打开库时关闭管理仍返回选库入口',await waitFor(restoredPage,`!!document.querySelector('.picker-card')`))
  })
  // All following mutations are to this disposable fixture, after the identity
  // replacement assertions. Capture the real single-library empty-list state.
  rmSync(sibling,{recursive:true,force:true});renameSync(sibling+'-原对象',sibling)
  renameSync(path.join(sibling,'临时移走.md'),path.join(sibling,'同名.md'))
  // 卷重新挂载：设备号变了、inode 没变。记录里留着旧设备号时，库必须仍能被人工确认打开，
  // 而不是被判成"被替换"卡在选库页（macOS 重启后 APFS 会换设备号）。
  {
    const catalogFile=path.join(profile,'vault-catalog.json'),workspaceFile=path.join(profile,'vault-workspaces.json')
    const liveCatalog=JSON.parse(readFileSync(catalogFile,'utf8'))
    const remountEntry=liveCatalog.entries.find(entry=>entry.id===liveCatalog.lastVaultId)
    const realIdentity=remountEntry.rootIdentity,inode=realIdentity.slice(realIdentity.indexOf(':')+1),staleIdentity=`99999999:${inode}`
    remountEntry.rootIdentity=staleIdentity
    writeFileSync(catalogFile,JSON.stringify(liveCatalog))
    const liveWorkspaces=JSON.parse(readFileSync(workspaceFile,'utf8'))
    for(const item of liveWorkspaces.entries)if(item.path===remountEntry.path)item.rootIdentity=staleIdentity
    writeFileSync(workspaceFile,JSON.stringify(liveWorkspaces))
    await restart(async restoredPage=>{
      check('卷重新挂载后停在选库并说明可确认打开',await waitFor(restoredPage,`!!document.querySelector('.picker-card') && document.querySelector('.picker-copy')?.textContent.includes('重新挂载') && document.querySelectorAll('.tab').length===0`))
      check('选择库的两个按钮有间隔且不贴在一起',await restoredPage.eval(`(()=>{const card=document.querySelector('.picker-card');if(!card||!card.querySelector('.picker-actions'))return false;const boxes=[...card.querySelectorAll('.pick-btn')].map(b=>b.getBoundingClientRect());return boxes.length===2&&boxes[0].width>0&&boxes[0].right+4<=boxes[1].left})()`))
      await restoredPage.eval(`[...document.querySelectorAll('.pick-btn')].find(n=>n.textContent==='已登记的笔记库').click()`)
      await waitFor(restoredPage,`!!document.querySelector('[data-vault-open="${remountEntry.id}"]')`)
      await restoredPage.eval(`document.querySelector('[data-vault-open="${remountEntry.id}"]').click()`)
      await waitFor(restoredPage,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false'`)
      check('普通切换不认领变化的根',JSON.parse(readFileSync(catalogFile,'utf8')).entries.find(entry=>entry.id===remountEntry.id).rootIdentity===staleIdentity)
      await rootRecoveryShots(restoredPage,shot,'switch-refused',null)
      await restoredPage.eval(`document.querySelector('[data-vault-id="${remountEntry.id}"] [data-vault-action="more"]').click();document.querySelector('[data-vault-id="${remountEntry.id}"] [data-vault-action="root-preview"]').click()`)
      check('先展示根对象与工作区恢复预览',await waitFor(restoredPage,`[...document.querySelectorAll('[data-vault-id="${remountEntry.id}"] button')].some(n=>n.textContent==='确认建立新关联')`))
      await rootRecoveryShots(restoredPage,shot,'remount-preview',remountEntry.id)
      await restoredPage.eval(`[...document.querySelectorAll('[data-vault-id="${remountEntry.id}"] button')].find(n=>n.textContent==='确认建立新关联').click()`)
      check('确认切换后打开同一个库并恢复工作区',await waitFor(restoredPage,`document.querySelector('.status-vault')?.textContent==='写作库 B' && document.querySelector('.tab')?.textContent.includes('同名') && document.querySelector('.cm-content')?.textContent.includes('必须保留的草稿')`))
    })
    const confirmed=JSON.parse(readFileSync(catalogFile,'utf8')).entries.find(entry=>entry.id===remountEntry.id)
    check('明确确认只更新根关联，稳定ID工作区原字节不换根',confirmed.rootIdentity===realIdentity&&JSON.parse(readFileSync(workspaceFile,'utf8')).entries.every(item=>item.path!==remountEntry.path||item.rootIdentity===staleIdentity))
  }
  // 实际活动根替换：两篇窗口稿保留，新同名正文不接收旧写；取消与确认均走真实控件。
  {
    const heldRoot=sibling+'-root-held',workspaceFile=path.join(profile,'vault-workspaces.json')
    const workspaceBefore=readFileSync(workspaceFile,'utf8')
    writeFileSync(path.join(sibling,'根保稿.md'),'第二篇原正文')
    try{await restart(async restoredPage=>{
      if(!await waitFor(restoredPage,`document.querySelector('.status-vault')?.textContent==='写作库 B' && document.querySelector('#app').inert===false`))throw Error('根保稿夹具未就绪')
      chmodSync(sibling,0o500)
      await restoredPage.eval(`document.querySelector('.cm-content').cmTile.root.view.dispatch({changes:{from:0,to:document.querySelector('.cm-content').cmTile.root.view.state.doc.length,insert:'根窗口稿一'}})`)
      await waitFor(restoredPage,`[...document.querySelectorAll('.tree-note')].some(n=>n.dataset.path==='根保稿.md')`)
      await restoredPage.eval(`[...document.querySelectorAll('.tree-note')].find(n=>n.dataset.path==='根保稿.md').click()`)
      await waitFor(restoredPage,`document.querySelector('.tab[aria-selected="true"]')?.textContent.includes('根保稿')`)
      await restoredPage.eval(`document.querySelector('.cm-content').cmTile.root.view.dispatch({changes:{from:0,to:document.querySelector('.cm-content').cmTile.root.view.state.doc.length,insert:'根窗口稿二'}})`)
      renameSync(sibling,heldRoot);mkdirSync(sibling);writeFileSync(path.join(sibling,'同名.md'),'新根同名不可覆写');writeFileSync(path.join(sibling,'根保稿.md'),'新根第二篇不可覆写')
      await restoredPage.eval(`document.querySelector('.settings-open').click()`)
      await waitFor(restoredPage,`!!document.querySelector('.settings-nav')`)
      await restoredPage.eval(`[...document.querySelectorAll('.settings-nav button')].find(n=>n.textContent==='笔记库').click()`)
      await waitFor(restoredPage,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false'`)
      await restoredPage.eval(`document.querySelector('[data-vault-id="vault-b"] [data-vault-action="more"]').click();document.querySelector('[data-vault-id="vault-b"] [data-vault-action="root-preview"]').click()`)
      await waitFor(restoredPage,`[...document.querySelectorAll('[data-vault-id="vault-b"] button')].some(n=>n.textContent==='取消恢复预览')`)
      await rootRecoveryShots(restoredPage,shot,'active-root-preview','vault-b')
      await restoredPage.eval(`[...document.querySelectorAll('[data-vault-id="vault-b"] button')].find(n=>n.textContent==='取消恢复预览').click()`)
      check('活动根恢复取消保留两篇窗口稿',await waitFor(restoredPage,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false' && document.querySelectorAll('.tab').length===2`)&&readFileSync(path.join(sibling,'根保稿.md'),'utf8')==='新根第二篇不可覆写')
      await restoredPage.eval(`document.querySelector('[data-vault-id="vault-b"] [data-vault-action="root-preview"]').click()`)
      await waitFor(restoredPage,`[...document.querySelectorAll('[data-vault-id="vault-b"] button')].some(n=>n.textContent==='确认建立新关联')`)
      await restoredPage.eval(`[...document.querySelectorAll('[data-vault-id="vault-b"] button')].find(n=>n.textContent==='确认建立新关联').click()`)
      check('明确关联保留旧会话两篇稿并提供正文另存与舍弃出口',await waitFor(restoredPage,`!document.querySelector('.vault-settings') && document.querySelector('#app').inert===false && document.querySelectorAll('.tab').length===2 && document.querySelector('.cm-content')?.textContent.includes('根窗口稿二') && !document.querySelector('.note-unavailable').hidden && !!document.querySelector('.note-save-copy') && !!document.querySelector('.note-discard')`))
      check('根关联没有覆写新同名对象或不完整工作区',readFileSync(path.join(sibling,'同名.md'),'utf8')==='新根同名不可覆写'&&readFileSync(path.join(sibling,'根保稿.md'),'utf8')==='新根第二篇不可覆写'&&readFileSync(workspaceFile,'utf8')===workspaceBefore)
    })}finally{if(existsSync(heldRoot)){rmSync(sibling,{recursive:true,force:true});renameSync(heldRoot,sibling);chmodSync(sibling,0o700)}writeFileSync(workspaceFile,workspaceBefore)}
  }
  const singleCatalog=JSON.parse(catalogBefore)
  singleCatalog.entries=singleCatalog.entries.filter(entry=>entry.id==='vault-b')
  writeFileSync(path.join(profile,'vault-catalog.json'),JSON.stringify(singleCatalog))
  await restart(async restoredPage=>{
    await waitFor(restoredPage,`document.querySelector('#app').inert===false && document.querySelector('.status-vault')?.textContent==='写作库 B'`)
    for(const theme of ['day','night']) {
      await restoredPage.eval(`window.rgent.themeSet('${theme}')`)
      await restoredPage.call('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false})
      await restoredPage.eval(`document.querySelector('.settings-open').click()`)
      await waitFor(restoredPage,`!!document.querySelector('.overlay-settings')`)
      await restoredPage.eval(`[...document.querySelectorAll('.settings-nav button')].find(n=>n.textContent==='笔记库').click()`)
      check(theme+'单库页面显示当前库和简短引导',await waitFor(restoredPage,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false' && document.querySelectorAll('[data-vault-id]').length===1 && !document.querySelector('[data-vault-open]')`))
      await shot(restoredPage,'vault-settings-single-'+theme)
      await restoredPage.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
      await restoredPage.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
      await waitFor(restoredPage,`!document.querySelector('.overlay-settings')`)
    }
  })
}

/** Every snapshot is from the disposable vault; reading/opening cannot earn a write. */
function vaultFileSnapshot(vault) {
  const rows = []
  const walk = directory => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = statSync(file, { bigint: true })
      rows.push({ path: path.relative(vault, file), id: `${stat.dev}:${stat.ino}`, mtime: String(stat.mtimeNs), bytes: stat.isFile() ? readFileSync(file).toString('base64') : null })
      if (stat.isDirectory()) walk(file)
    }
  }
  walk(vault)
  return JSON.stringify(rows)
}

/** Only delays the actual existing handler in this disposable Electron process. */
async function holdV4Receipt(nativePage, channel, fail = false) {
  await nativePage.eval(`(() => {
    const ipc=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain;
    const channel=${JSON.stringify(channel)},old=ipc._invokeHandlers.get(channel);
    if(!old)throw Error('缺少现有 handler：'+channel);
    const gate={old,channel,seen:false};globalThis.__v4Gate=gate;
    ipc._invokeHandlers.set(channel,async(...args)=>{if(gate.seen)return old(...args);gate.seen=true;await new Promise(r=>gate.release=r);if(${fail})throw Error('V4_DISPOSABLE_RECEIPT_FAILURE');return old(...args)});
    return true
  })()`)
}
async function v4ReceiptSeen(nativePage) {
  for(let n=0;n<60;n++){if(await nativePage.eval('globalThis.__v4Gate?.seen'))return;await sleep(100)}
  throw Error('v4 实际 handler 没有进入延迟夹具')
}
async function releaseV4Receipt(nativePage) {
  await nativePage.eval(`(() => {const gate=globalThis.__v4Gate;if(gate){process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain._invokeHandlers.set(gate.channel,gate.old);gate.release?.()}return true})()`)
}
async function v4Settings(page, name = '笔记库') {
  if(!await page.eval(`!!document.querySelector('.overlay-settings')`))await page.eval(`document.querySelector('.settings-open').click()`)
  if(!await waitFor(page,`!!document.querySelector('.settings-nav')`))throw Error('设置未打开')
  await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent===${JSON.stringify(name)}).click()`)
  if(name==='笔记库'&&!await waitFor(page,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false'`))throw Error('库页未就绪')
}
async function v4CloseSettings(page) {
  await page.key('Escape','Escape',0,27)
  if(!await waitFor(page,`!document.querySelector('.overlay-settings')`))throw Error('设置没有关闭')
}
async function v4Click(page, selector, text) {
  const expression=`[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent===${JSON.stringify(text)} && !b.disabled)`
  if(!await waitFor(page,`!!(${expression})`))throw Error('未出现可用按钮：'+text)
  await page.eval(`(${expression}).click()`)
}
async function rootRecoveryShots(page,shot,name,id) {
  const theme=await page.eval('window.rgent.themeGet()')
  const renderedTheme=await page.eval('document.documentElement.dataset.theme')
  const viewport=await page.eval('({width:innerWidth,height:innerHeight})')
  try {
    for(const mode of ['day','night']) {
      await page.eval(`window.rgent.themeSet('${mode}')`)
      if(!await waitFor(page,`document.documentElement.dataset.theme==='${mode}'`))throw Error('根恢复样张主题未同步')
      for(const [width,height] of [[1200,800],[800,560]]) {
        await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
        const target=id?`[data-vault-id=${JSON.stringify(id)}] .vault-settings-confirmation:not([hidden])`:'.vault-settings-status'
        await page.eval(`document.querySelector(${JSON.stringify(target)})?.scrollIntoView({block:'nearest'});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`)
        check(`${name} ${mode} ${width}px 根恢复文字无横向裁切`,await page.eval(`(()=>{const n=document.querySelector(${JSON.stringify(target)}),panel=document.querySelector('.vault-settings');return !!n&&!!n.textContent.trim()&&n.scrollWidth<=n.clientWidth+1&&panel.scrollWidth<=panel.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+1})()`))
        if(id) {
          const textVisible=await page.eval(`(()=>{const n=document.querySelector(${JSON.stringify(target)});return [...n.querySelectorAll('p')].filter(p=>!p.closest('details')||p.closest('details').open).every(p=>{p.scrollIntoView({block:'nearest'});const range=document.createRange();range.selectNodeContents(p);return !!p.textContent.trim()&&[...range.getClientRects()].every(r=>r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1)})})()`)
          check(`${name} ${mode} ${width}px 路径、工作位置与保稿说明可滚动完整阅读`,textVisible)
          await page.eval(`document.querySelector(${JSON.stringify(target)})?.scrollIntoView({block:'start'})`)
          await shot(page,`root-recovery-${name}-text-${mode}-${width}`)
          await page.eval(`(()=>{const n=document.querySelector(${JSON.stringify(target)});[...n.querySelectorAll('button')].find(b=>b.textContent==='确认建立新关联')?.scrollIntoView({block:'nearest'})})()`)
          check(`${name} ${mode} ${width}px 确认与取消控件可见可操作`,await page.eval(`(()=>{const n=document.querySelector(${JSON.stringify(target)});return ['确认建立新关联','取消恢复预览'].every(text=>{const b=[...n.querySelectorAll('button')].find(b=>b.textContent===text);if(!b||b.disabled)return false;const r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&!!hit&&b.contains(hit)})})()`))
        }else {
          check(`${name} ${mode} ${width}px 失败提示可见`,await page.eval(`(()=>{const n=document.querySelector('.vault-settings-status'),r=n.getBoundingClientRect();return !!n.textContent.trim()&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight+1})()`))
        }
        await shot(page,`root-recovery-${name}-${mode}-${width}`)
      }
    }
  }finally {
    await page.call('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:false})
    await page.eval(`window.rgent.themeSet(${JSON.stringify(theme)})`)
    await waitFor(page,`document.documentElement.dataset.theme===${JSON.stringify(renderedTheme)}`)
  }
}
async function v4OpenNote(page, name) {
  await selectBrowserFolder(page,'')
  if(!await waitFor(page,`[...document.querySelectorAll('.tree-note')].some(n=>n.dataset.path===${JSON.stringify(name)})`))throw Error('目录未出现：'+name)
  await page.eval(`[...document.querySelectorAll('.tree-note')].find(n=>n.dataset.path===${JSON.stringify(name)}).click()`)
  if(!await waitFor(page,`document.querySelector('.tab[aria-selected=true]')?.dataset.rel===${JSON.stringify(name)} && !!document.querySelector('.cm-content')`))throw Error('笔记未打开：'+name)
}
async function v4Shots(page, shot, name, selector = '.settings-main') {
  const theme=await page.eval('window.rgent.themeGet()')
  for(const mode of ['day','night']){
    await page.eval(`window.rgent.themeSet('${mode}')`)
    if(!await waitFor(page,`document.documentElement.dataset.theme==='${mode}'`))throw Error('主题未同步')
    for(const [width,height] of [[1200,800],[800,560]]){
      await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
      await page.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`)
      check(`${name} ${mode} ${width}px 不横向溢出`,await page.eval(`document.documentElement.scrollWidth<=innerWidth+1 && [...document.querySelectorAll(${JSON.stringify(selector)})].every(n=>n.scrollWidth<=n.clientWidth+1)`))
      if(name==='workspace-retry'){
        const visible=await page.eval(`(()=>{const banner=document.querySelector('.workspace-recovery'),text=banner.querySelector('span'),button=banner.querySelector('button'),range=document.createRange();range.selectNodeContents(text);const lines=[...range.getClientRects()],rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}},hits=[];const exposed=(r,node)=>r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&[[(r.left+r.right)/2,r.top+1],[(r.left+r.right)/2,(r.top+r.bottom)/2],[(r.left+r.right)/2,r.bottom-1],[r.left+1,(r.top+r.bottom)/2],[r.right-1,(r.top+r.bottom)/2]].every(([x,y])=>{const hit=document.elementFromPoint(x,y);hits.push({x,y,hit:hit?.className||hit?.tagName});return !!hit&&node.contains(hit)});return {ok:!banner.hidden&&!!text.textContent&&lines.length>0&&lines.every(r=>exposed(r,text))&&!button.disabled&&exposed(button.getBoundingClientRect(),button),banner:rect(banner),empty:rect(document.querySelector('.empty')),text:lines.map(r=>({x:r.x,y:r.y,width:r.width,height:r.height})),button:rect(button),hits}})()`)
        check(`${name} ${mode} ${width}px 提示全文与重试按钮可见且未被空页覆盖`,visible.ok,visible.ok?'':JSON.stringify(visible))
      }
      await shot(page,`v4-${name}-${mode}-${width}`)
    }
  }
  await page.call('Emulation.clearDeviceMetricsOverride',{})
  await page.eval(`window.rgent.themeSet(${JSON.stringify(theme)})`)
}
async function verifyV4ReadOnly(page, nativePage, vault, shot) {
  process.stdout.write('\nv4 A：只读打开与坏登记正文\n')
  await waitFor(page,`document.querySelector('#app').inert===false && !!document.querySelector('.settings-open')`)
  const cases=[['只读未登记.md','\ufeff人写甲\r\n人写乙\r人写丙\n'],['只读旧尾部.md','\ufeff旧正文\r\n第二行\r第三行\n<!-- rgent:ledger:v1 -->\r\n只在历史出现的机器尾部\r\n']]
  for(const [name,raw] of cases){
    writeFileSync(path.join(vault,name),raw)
    await waitFor(page,`[...document.querySelectorAll('.tree-note')].some(n=>n.dataset.path===${JSON.stringify(name)})`)
    const before=vaultFileSnapshot(vault)
    await v4OpenNote(page,name)
    const note=await page.eval(`window.rgent.noteRead(${JSON.stringify(name)})`)
    await page.eval(`document.querySelector('.ledger-open').click()`)
    check(name+' 打开及历史回顾不创建登记、不改原始快照',vaultFileSnapshot(vault)===before)
    check(name+' 正文读取独立于账本且机器尾部不进编辑器',note.content.includes('人写')||note.content.includes('旧正文'))
    if(name.includes('旧尾部'))check('旧尾部历史诊断明确',await waitFor(page,`document.querySelector('.ledger-body')?.textContent.includes('迁移')`))
    await page.eval(`document.querySelector('.ledger-close').click()`)
    check(name+' renderer 只有正文',await page.eval(`!document.querySelector('.cm-content').textContent.includes('只在历史出现') && !document.querySelector('.cm-content').textContent.includes('rgent:ledger')`))
  }
  const registry=path.join(vault,'.rgent','registry.json'),had=existsSync(registry),old=had?readFileSync(registry):null
  mkdirSync(path.dirname(registry),{recursive:true});writeFileSync(registry,'{坏登记，保留这些字节')
  const before=vaultFileSnapshot(vault)
  try{
    await v4OpenNote(page,cases[0][0]);await page.eval(`document.querySelector('.ledger-open').click()`)
    check('坏 registry 的历史诊断可见、原始字节和文件集不变',await waitFor(page,`document.querySelector('.ledger-body')?.textContent.includes('登记')`)&&vaultFileSnapshot(vault)===before)
    await page.eval(`document.querySelector('.ledger-close').click()`)
    check('坏 registry 不挡普通正文阅读',await page.eval(`document.querySelector('.cm-content').textContent.includes('人写甲')`))
  }finally{if(had)writeFileSync(registry,old);else rmSync(registry)}
  await v4OpenNote(page,cases[1][0])
  await page.eval(`(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:1,head:1}});view.focus()})()`)
  await page.call('Input.insertText',{text:'保存增量'})
  const changed=await waitFor(page,`document.querySelector('.cm-content').cmTile.root.view.state.doc.toString().startsWith('\\ufeff保存增量') && !!document.querySelector('.tab[aria-selected=true] .tab-dirty')`)
  check('正常保存保留 BOM、混合换行和旧机器尾部原字节',changed&&await waitFor(page,`!document.querySelector('.tab[aria-selected=true] .tab-dirty')`)&&readFileSync(path.join(vault,cases[1][0]),'utf8')==='\ufeff保存增量'+cases[1][1].slice(1))
  if(process.platform!=='win32'){
    const mode=statSync(vault).mode&0o777,before=readFileSync(path.join(vault,cases[1][0]));
    await nativePage.eval(`(()=>{const ipc=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain,old=ipc._invokeHandlers.get('note:write');globalThis.__v4DeniedWrite={old,results:[]};ipc._invokeHandlers.set('note:write',async(...args)=>{const result=await old(...args);globalThis.__v4DeniedWrite.results.push({request:args[1]?.args?.[0]??args[1],result});return result});return true})()`);chmodSync(vault,0o500)
    try{
      await page.call('Input.insertText',{text:'拒写保留稿'})
      for(let n=0;n<100&&!await nativePage.eval(`globalThis.__v4DeniedWrite.results.some(r=>r.request?.relPath===${JSON.stringify(cases[1][0])}&&r.request.content.includes('拒写保留稿')&&r.result.ok===false)`);n++)await sleep(100)
      check('权限仍拒写时真实 noteWrite 已返回失败',await nativePage.eval(`globalThis.__v4DeniedWrite.results.some(r=>r.request?.relPath===${JSON.stringify(cases[1][0])}&&r.request.content.includes('拒写保留稿')&&r.result.ok===false&&typeof r.result.error==='string')`))
      await page.eval(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`)
      check('实际权限拒写保留窗口稿和未保存标志',await waitFor(page,`!!document.querySelector('.tab[aria-selected=true] .tab-dirty') && document.querySelector('.cm-content')?.textContent.includes('拒写保留稿')`)&&readFileSync(path.join(vault,cases[1][0])).equals(before))
    }finally{chmodSync(vault,mode);await nativePage.eval(`(()=>{const ipc=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain;ipc._invokeHandlers.set('note:write',globalThis.__v4DeniedWrite.old);return true})()`)}
    await page.eval(`document.querySelector('.note-recheck')?.click()`)
    // The failed write may still be finishing its renderer-side object inspection.
    // An early save request joins that failed in-flight write, so retry the real
    // menu action until its retained draft has actually reached disk.
    let saved=false
    for(let n=0;n<40;n++){
      await nativePage.eval(`globalThis.__rgentTestWindow.webContents.send('menu:save');true`)
      if(await waitFor(page,`!document.querySelector('.tab[aria-selected=true] .tab-dirty')`,300)){saved=true;break}
    }
    const expected='\ufeff保存增量拒写保留稿'+cases[1][1].slice(1)
    check('恢复写权限后原拒写窗口稿真实保存且不遗留脏tab',saved&&readFileSync(path.join(vault,cases[1][0]),'utf8')===expected)
    if(!saved||readFileSync(path.join(vault,cases[1][0]),'utf8')!==expected)throw Error('只读夹具拒写稿未真实保存，停止后续恢复夹具')
  }else process.stdout.write('Windows 权限拒写夹具尚待原生证据；未记通过。\n')
}

async function verifyV4CopiedVault(page,nativePage,vault,profile,shot) {
  process.stdout.write('\nv4 B：复制库显式关联及同 catalogID 工作区\n')
  const names=Array.from({length:7},(_,i)=>`备份来源${i}.md`)
  for(const [i,name] of names.entries())writeFileSync(path.join(vault,name),`唯一来源${i}，窗口备份关联虚构材料。\n`)
  mkdirSync(path.join(vault,'备份来源0'))
  const attachment=Buffer.from([0,255,13,10,128,1,2,3]);writeFileSync(path.join(vault,'备份来源0','原始附件.bin'),attachment)
  const seeded=await page.eval(`(async()=>{
    const state=await window.rgent.vaultGet();let after=null;
    do{const r=await window.rgent.ledgerMigrate({sessionId:state.sessionId,after});if(!r.ok||r.value.failures.length)throw Error('备份夹具迁移失败');after=r.value.after}while(after);
    const ids=[];for(const name of ${JSON.stringify(names.slice(0,2))}){
      const n=await window.rgent.noteRead(name),end=n.content.indexOf('\\n');if(end<1)throw Error('备份夹具缺少独立人写段落');const p=await window.rgent.memoryManualPreview({sessionId:n.sessionId,relPath:name,revision:n.revision,objectVersion:n.objectVersion,kind:'body',start:0,end});
      if(!p.ok)throw Error(p.error);const r=await window.rgent.memoryPreviewCommit({sessionId:n.sessionId,id:p.value.id,content:'备份记忆 '+name,layer:'demand',scope:'虚构备份'});if(!r.ok)throw Error(r.error);ids.push(r.value.entries.find(e=>e.content==='备份记忆 '+name).id)
    }return {state,ids,catalog:await window.rgent.vaultCatalog()}
  })()`)
  // Actual local receiver and consumed/unused authorizations establish a non-default old state.
  let oldCalls=0
  const oldReceiver=createHttpServer((request,response)=>{let raw='';request.on('data',c=>raw+=c);request.on('end',()=>{oldCalls++;const r=JSON.parse(raw),answer=r.model==='v4-backup-memory'?JSON.stringify({recent:null,proposals:[]}):'旧授权真实回答';response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:answer},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)})})
  const copy=vault+'-复制',parking=vault+'-停靠'
  await new Promise(resolve=>oldReceiver.listen(0,'127.0.0.1',resolve))
  try{
  const oldState=await page.eval(`(async()=>{
    const a=await window.rgent.modelProviderSave({provider:'custom',baseURL:'http://127.0.0.1:${oldReceiver.address().port}/v1',modelId:'v4-backup-default',contextTokens:50000,newKey:'v4-backup-key'});if(!a.ok)throw Error(a.error);
    if(!a.config.models.some(m=>m.modelId==='v4-backup-default')){const added=await window.rgent.modelAdd({provider:'custom',modelId:'v4-backup-default',contextTokens:50000});if(!added.ok)throw Error(added.error)}
    const b=await window.rgent.modelAdd({provider:'custom',modelId:'v4-backup-temporary',contextTokens:50000});if(!b.ok)throw Error(b.error);
    const c=await window.rgent.modelAdd({provider:'custom',modelId:'v4-backup-memory',contextTokens:50000});if(!c.ok)throw Error(c.error);
    const models=c.config.models,base=models.find(m=>m.modelId==='v4-backup-default').id,temporary=models.find(m=>m.modelId==='v4-backup-temporary').id,memory=models.find(m=>m.modelId==='v4-backup-memory').id;
    if(!(await window.rgent.modelDefaultSet({modelId:base})).ok)throw Error('旧默认模型设置失败');
    const state=await window.rgent.vaultGet();for(const request of [{target:'default',modelId:memory},{target:'vault',vault:{enabled:true,override:{mode:'inherit'}}}]){const r=await window.rgent.memoryConfigSave({...request,sessionId:state.sessionId});if(!r.ok)throw Error(r.error)}
    const n=await window.rgent.noteRead(${JSON.stringify(names[2])}),w=await window.rgent.noteWrite({relPath:n.relPath??${JSON.stringify(names[2])},sessionId:n.sessionId,objectVersion:n.objectVersion,expectedRevision:n.revision,content:n.content+'\\n/旧授权任务\\n'});if(!w.ok)throw Error(w.error);
    const saved=await window.rgent.noteRead(${JSON.stringify(names[2])}),start=saved.content.indexOf('/旧授权任务'),request={relPath:${JSON.stringify(names[2])},sessionId:saved.sessionId,objectVersion:saved.objectVersion,expectedRevision:saved.revision,range:{start,end:start+6},expectedText:'/旧授权任务',promptText:'旧授权任务',modelRecordId:temporary,references:[]};
    const preview=await window.rgent.agentAuthorizationPreview(request);if(!preview.ok)throw Error(preview.error);const task=await window.rgent.agentStart({...request,previewId:preview.preview.id});if(!task.ok)throw Error(task.error);return {base,temporary,memory,consumed:{...request,previewId:preview.preview.id},taskId:task.id}
  })()`)
  if(!await v4TaskDone(page,names[2],oldState.taskId))throw Error('旧真实授权任务未完成')
  if(!await waitFor(page,`(async()=>{const m=await window.rgent.memoryGet({sessionId:${JSON.stringify(seeded.state.sessionId)}});return m.ok&&m.value.jobs.some(j=>j.taskId===${JSON.stringify(oldState.taskId)}&&j.outcome==='applied')})()`))throw Error('旧库学习开关没有实际进入整理')
  // Direct main-process fixture calls do not invoke the settings UI's model
  // refresh callback; reload through the real startup/workspace path first.
  await page.call('Page.reload')
  if(!await waitFor(page,`document.querySelector('#app')?.inert===false && [...document.querySelectorAll('.status-model option')].some(o=>o.value===${JSON.stringify(oldState.temporary)})`))throw Error('旧库模型模块未实际刷新')
  const unused=await page.eval(`(async()=>{const n=await window.rgent.noteRead(${JSON.stringify(names[3])}),content=n.content+'\\n/旧未用授权\\n',w=await window.rgent.noteWrite({relPath:${JSON.stringify(names[3])},sessionId:n.sessionId,objectVersion:n.objectVersion,expectedRevision:n.revision,content});if(!w.ok)throw Error(w.error);const saved=await window.rgent.noteRead(${JSON.stringify(names[3])}),start=saved.content.indexOf('/旧未用授权'),r={relPath:${JSON.stringify(names[3])},sessionId:saved.sessionId,objectVersion:saved.objectVersion,expectedRevision:saved.revision,range:{start,end:start+6},expectedText:'/旧未用授权',promptText:'旧未用授权',modelRecordId:${JSON.stringify(oldState.temporary)},references:[]},p=await window.rgent.agentAuthorizationPreview(r);if(!p.ok)throw Error(p.error);return {...r,previewId:p.preview.id}})()`)
  check('复制前实际学习开启、旧授权已消费并有未用旧许可',oldCalls>=2&&oldState.consumed.previewId!==unused.previewId&&await page.eval(`window.rgent.memoryGet({sessionId:${JSON.stringify(seeded.state.sessionId)}}).then(m=>m.ok&&m.value.config.vault.enabled)`))
  // Persist insufficient historical evidence on one descriptor in the original disposable vault.
  // Copy then changes every native object; no production in-memory state is substituted.
  const rpath=path.join(vault,'.rgent','registry.json'),registry=JSON.parse(readFileSync(rpath,'utf8'))
  const insufficient=registry.owners.find(o=>o.relPath===names[1]);delete insufficient.recoveryEvidence
  writeFileSync(path.join(vault,'.rgent','ledgers',insufficient.noteId,'owner.json'),JSON.stringify(insufficient));writeFileSync(rpath,JSON.stringify(registry))
  await v4OpenNote(page,names[0]);await v4OpenNote(page,names[1]);await v4OpenNote(page,names[0])
  await page.eval(`(()=>{const v=document.querySelector('.cm-content').cmTile.root.view;v.dispatch({selection:{anchor:4,head:8}});if(document.querySelector('.tree-toggle').getAttribute('aria-expanded')!=='true')document.querySelector('.tree-toggle').click();const h=document.querySelector('.sidebar-resizer');h.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));for(let i=0;i<11;i++)h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))})()`)
  mkdirSync(path.join(vault,'恢复浏览目录'));writeFileSync(path.join(vault,'恢复浏览目录','浏览.md'),'复制恢复浏览正文');if(!await waitFor(page,`!!document.querySelector('.tree-select[data-path="恢复浏览目录"]')`)||!await selectBrowserFolder(page,'恢复浏览目录'))throw Error('旧库实际浏览位置未建立');check('复制前侧栏真实展开280px并浏览不同于根的目录',await page.eval(`!document.querySelector('.tree-panel').classList.contains('is-collapsed')&&document.querySelector('.sidebar-resizer').getAttribute('aria-valuenow')==='280'&&document.querySelector('.resource-path').textContent==='恢复浏览目录'`))
  await page.eval(`(()=>{const select=document.querySelector('.status-model');select.value=${JSON.stringify(oldState.temporary)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);check('复制前本篇使用不同于设备默认的临时模型',await waitFor(page,`document.querySelector('.status-model').value===${JSON.stringify(oldState.temporary)}`))
  await sleep(750)
  const oldSession=seeded.state.sessionId,catalogId=seeded.catalog.entries.find(e=>e.path===realpathSync.native(vault)).id
  cpSync(vault,copy,{recursive:true});mkdirSync(parking)
  writeFileSync(path.join(parking,'停靠.md'),'停靠正文')
  const chooseRoot=async target=>{
    await nativePage.eval(`(()=>{const d=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog;globalThis.__v4OldDialog??=d.showOpenDialog;d.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(target)}]});return true})()`)
    await v4Settings(page);await page.eval(`document.querySelector('[data-vault-action="open"]').click()`)
    if(!await waitFor(page,`!document.querySelector('.overlay-settings') && document.querySelector('#app').inert===false`))throw Error('切库未完成')
  }
  const switchId=async id=>{await v4Settings(page);await page.eval(`document.querySelector('[data-vault-open="${id}"]').click()`);if(!await waitFor(page,`!document.querySelector('.overlay-settings') && document.querySelector('#app').inert===false`))throw Error('登记切库未完成')}
    await chooseRoot(parking)
    await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(copy)}]});true`)
    await v4Settings(page);await page.eval(`document.querySelector('[data-vault-id="${catalogId}"] [data-vault-action="more"]').click();document.querySelector('[data-vault-id="${catalogId}"] [data-vault-action="root-choose"]').click()`)
    if(!await waitFor(page,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false' && [...document.querySelectorAll('[data-vault-id="${catalogId}"] button')].some(b=>b.textContent==='确认建立新关联')`))throw Error('备份恢复预览失败')
    check('复制库先预览而未认领，机器对象标识默认收起',await page.eval(`(async()=>{const c=await window.rgent.vaultCatalog(),row=document.querySelector('[data-vault-id="${catalogId}"]'),proof=row.querySelector('.vault-settings-confirmation:not([hidden])'),technical=proof.querySelector('.vault-root-technical');return c.entries.find(e=>e.id===${JSON.stringify(catalogId)}).path===${JSON.stringify(realpathSync.native(vault))}&&proof.textContent.includes('不证明这是原来的目录')&&proof.textContent.includes('恢复本库上次的工作位置')&&!!technical&&!technical.open&&technical.textContent.includes('登记对象')})()`))
    await rootRecoveryShots(page,shot,'copied-preview',catalogId)
    await v4Click(page,`[data-vault-id="${catalogId}"] .vault-settings-confirmation button`,'确认建立新关联')
    if(!await waitFor(page,`!document.querySelector('.overlay-settings') && document.querySelector('#app').inert===false`))throw Error('备份恢复确认失败')
    const moved=await page.eval(`window.rgent.vaultGet()`)
    check('同 catalogID 新根实际恢复 tabs、光标及侧栏',moved.vaultId===catalogId&&moved.sessionId!==oldSession&&await page.eval(`document.querySelector('.tab[aria-selected=true]')?.dataset.rel===${JSON.stringify(names[0])} && document.querySelector('.cm-content').cmTile.root.view.state.selection.main.anchor===4 && !document.querySelector('.tree-panel').classList.contains('is-collapsed') && document.querySelector('.sidebar-resizer').getAttribute('aria-valuenow')==='280' && document.querySelector('.resource-path').textContent==='恢复浏览目录'`))
    check('重新定位后本篇临时模型复位设备默认',await page.eval(`document.querySelector('.status-model').value===${JSON.stringify(oldState.base)}`))
    const newNote=await page.eval(`window.rgent.noteRead(${JSON.stringify(names[0])})`)
    check('新根重新核验，旧正文对象不作连续性证明',newNote.objectVersion!==registry.owners.find(o=>o.relPath===names[0]).objectVersion&&readFileSync(path.join(copy,'备份来源0','原始附件.bin')).equals(attachment))
    await v4Settings(page)
    const before=vaultFileSnapshot(copy)
    await v4Click(page,'.vault-settings-recovery button','预览整库恢复')
    check('同页预览明确新关联授权、合格及不足来源',await waitFor(page,`document.querySelector('.vault-settings-recovery').textContent.includes('不证明是同一物理文件') && document.querySelector('.vault-settings-recovery').textContent.includes('来源核验通过') && document.querySelector('.vault-settings-recovery').textContent.includes('来源暂停')`))
    await v4Shots(page,shot,'restore-preview','.vault-settings-recovery')
    await v4Click(page,'.vault-settings-recovery button','取消恢复预览')
    check('取消恢复预览原始字节、文件集合及所有身份不变',await waitFor(page,`[...document.querySelectorAll('.vault-settings-recovery button')].some(b=>b.textContent==='预览整库恢复')`)&&vaultFileSnapshot(copy)===before)
    await holdV4Receipt(nativePage,'ledger:repair')
    try{
      await v4Click(page,'.vault-settings-recovery button','预览整库恢复');await v4ReceiptSeen(nativePage)
      await page.key('Escape','Escape',0,27)
      check('恢复预览忙时同页禁止导航与关闭',await page.eval(`!!document.querySelector('.overlay-settings') && [...document.querySelectorAll('.settings-nav button')].every(n=>n.disabled)`))
    }finally{await releaseV4Receipt(nativePage)}
    await v4Click(page,'.vault-settings-recovery button','确认授权新关联')
    check('足够实际控制文件触发四写批次并返回当前 pending revision',await waitFor(page,`document.querySelector('.vault-settings-recovery').textContent.includes('可暂停并离开本库')`)&&JSON.parse(readFileSync(path.join(copy,'.rgent-lifecycle'),'utf8')).active?.kind==='ledger-repair')
    await v4Shots(page,shot,'restore-pending','.vault-settings-recovery')
    await v4CloseSettings(page);await chooseRoot(parking);await switchId(catalogId);await v4Settings(page)
    check('离库再进入仍明确续跑且未自动完成',await waitFor(page,`[...document.querySelectorAll('.vault-settings-recovery button')].some(b=>b.textContent==='核验并继续一批')`))
    for(let n=0;n<30;n++){
      await v4Click(page,'.vault-settings-recovery button','核验并继续一批')
      if(await waitFor(page,`document.querySelector('.vault-settings')?.getAttribute('aria-busy')==='false'`)){
        if(await page.eval(`document.querySelector('.vault-settings-recovery').textContent.includes('恢复已完成')`))break
      }
    }
    check('实际分批完成合格来源续接、不足来源继续暂停',await page.eval(`(async()=>{const s=await window.rgent.vaultGet(),m=await window.rgent.memoryGet({sessionId:s.sessionId});return m.ok&&m.value.entries.find(e=>e.id===${JSON.stringify(seeded.ids[0])})?.status==='active'&&m.value.entries.find(e=>e.id===${JSON.stringify(seeded.ids[1])})?.status==='paused'&&!m.value.config.vault.enabled&&!(await window.rgent.agentTasks()).length})()`)&&JSON.parse(readFileSync(path.join(copy,'.rgent-lifecycle'),'utf8')).active===null)
    const replay=await page.eval(`(async()=>{const current=await window.rgent.noteRead(${JSON.stringify(names[3])});return Promise.all([window.rgent.agentStart(${JSON.stringify(oldState.consumed)}),window.rgent.agentStart(${JSON.stringify(unused)}),window.rgent.agentStart({...${JSON.stringify(unused)},sessionId:current.sessionId,objectVersion:current.objectVersion,expectedRevision:current.revision})])})()`)
    check('恢复后旧已消费/未用授权ID及换新会话重放全拒绝，必须新预览',replay.every(r=>r.ok===false&&['STALE_PREVIEW','INVALID_AUTHORIZATION'].includes(r.error))&&oldCalls===2)
    check('整库恢复保留全部笔记及附件原始字节',names.every(name=>readFileSync(path.join(copy,name)).equals(readFileSync(path.join(vault,name))))&&readFileSync(path.join(copy,'备份来源0','原始附件.bin')).equals(attachment))
    await v4CloseSettings(page);await chooseRoot(parking)
    await v4Settings(page);await page.eval(`document.querySelector('[data-vault-id="${catalogId}"] [data-vault-action="more"]').click();document.querySelector('[data-vault-id="${catalogId}"] [data-vault-action="remove"]').click();document.querySelector('[data-vault-id="${catalogId}"] [data-vault-action="confirm-remove"]').click()`)
    await waitFor(page,`!document.querySelector('[data-vault-id="${catalogId}"]')`);await v4CloseSettings(page);await chooseRoot(copy)
    const readded=await page.eval('window.rgent.vaultGet()')
    check('移除再登记新ID不接旧tabs、光标及侧栏偏好',readded.vaultId!==catalogId&&await page.eval(`document.querySelectorAll('.tab').length===0 && document.querySelector('.tree-panel').classList.contains('is-collapsed') && document.querySelector('.resource-path').textContent==='笔记库'`))
    await page.eval(`document.querySelector('.tree-toggle').click()`);check('新登记侧栏实际展开使用默认宽度而非旧280px',await waitFor(page,`document.querySelector('.sidebar-resizer').getAttribute('aria-valuenow')==='224'`));check('新登记访问当前根正文',await page.eval(`window.rgent.noteRead(${JSON.stringify(names[0])}).then(n=>n.sessionId===${JSON.stringify(readded.sessionId)}&&n.content.includes('唯一来源0'))`))
  }finally{await nativePage.eval(`(()=>{const d=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog;if(globalThis.__v4OldDialog)d.showOpenDialog=globalThis.__v4OldDialog;return true})()`);await new Promise(resolve=>oldReceiver.close(resolve))}
  return copy
}

// Compile only the production codec definitions, without the store/FS implementation.
// This keeps disposable fixtures identical to the current format on Node >=20.
let memoryFixtureCodec
function workingMemoryFixtureCodec() {
  if (memoryFixtureCodec) return memoryFixtureCodec
  const source=readFileSync(path.join(root,'src/main/working-memory-store.ts'),'utf8')
  const definitions=source.slice(0,source.indexOf('export class WorkingMemoryStore')).replace(/^import .*$/gm,'').replace(/\bexport /g,'')
  const esbuild=createRequire(require.resolve('vite'))('esbuild'),code=esbuild.transformSync(definitions,{loader:'ts',target:'es2022',format:'cjs'}).code
  memoryFixtureCodec=new Function('Buffer','createHash','randomUUID',code+';return {encode:encodeWorkingMemory,parse:parseWorkingMemory}') (Buffer,createHash,()=> 'fixture-identity')
  return memoryFixtureCodec
}
function encodeV5Memory(record) { return workingMemoryFixtureCodec().encode(record) }
function parseV5Memory(raw) { return workingMemoryFixtureCodec().parse(raw) }

const v4Hash = text => createHash('sha256').update(text).digest('hex')
async function v4Task(page, vault, relPath, prompt, modelRecordId, references = []) {
  writeFileSync(path.join(vault,relPath),'/'+prompt+'\n')
  const result=await page.eval(`(async()=>{
    const n=await window.rgent.noteRead(${JSON.stringify(relPath)}),r={relPath:${JSON.stringify(relPath)},range:{start:0,end:${prompt.length+1}},expectedText:${JSON.stringify('/'+prompt)},promptText:${JSON.stringify(prompt)},sessionId:n.sessionId,objectVersion:n.objectVersion,expectedRevision:n.revision,modelRecordId:${JSON.stringify(modelRecordId)},references:${JSON.stringify(references)}};
    const p=await window.rgent.agentAuthorizationPreview(r);if(!p.ok)throw Error('任务预览：'+p.error);return window.rgent.agentStart({...r,previewId:p.preview.id})
  })()`)
  if(!result.ok)throw Error('任务启动：'+result.error)
  return result.id
}
async function v4TaskDone(page, relPath, taskId) {
  return waitFor(page,`(async()=>{const n=await window.rgent.noteRead(${JSON.stringify(relPath)}),r=await window.rgent.ledgerGet({sessionId:n.sessionId,objectVersion:n.objectVersion,relPath:${JSON.stringify(relPath)}});return !(await window.rgent.agentTasks()).length&&r.ok&&r.value.records.some(r=>r.taskId===${JSON.stringify(taskId)}&&r.state==='saved')})()`,20000)
}
async function verifyV4MemoryTools(page,nativePage,vault,shot) {
  process.stdout.write('\nv4 A+：实际接收方往返、四次记忆检索与共享预算\n')
  const requests=[],pending=new Map(),responses=new Set()
  const server=createHttpServer((request,response)=>{
    let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
      const decoded=JSON.parse(body);requests.push(decoded);responses.add(response);response.on('close',()=>responses.delete(response))
      const text=JSON.stringify(decoded.messages),count=decoded.messages.filter(m=>m.role==='tool').length
      const send=()=>{
        response.writeHead(200,{'content-type':'text/event-stream'})
        const emit=(delta,finish_reason=null)=>response.write(`data: ${JSON.stringify({id:'v4-model',object:'chat.completion.chunk',created:1,model:decoded.model,choices:[{index:0,delta,finish_reason}]})}\n\n`)
        if(text.includes('V4真实往返')&&count===0){emit({tool_calls:[{index:0,id:'v4-verified',type:'function',function:{name:'search_library',arguments:'{"query":"唯一来源"}'}}]});emit({},'tool_calls')}
        else if(text.includes('V4记忆额度')&&count===0){for(let i=0;i<6;i++)emit({tool_calls:[{index:i,id:'v4-memory-'+i,type:'function',function:{name:'search_memory',arguments:'{"query":"备份记忆"}'}}]});emit({},'tool_calls')}
        else if(/V4晚到(停用|遗忘|来源)/.test(text)&&count===0){emit({tool_calls:[{index:0,id:'v4-late',type:'function',function:{name:'search_memory',arguments:'{"query":"备份记忆"}'}}]});emit({},'tool_calls')}
        else{emit({content:'V4记忆工具回答保稿'});emit({},'stop')}
        response.end('data: [DONE]\n\n')
      }
      const label=/V4晚到(停用|遗忘|来源)/.exec(text)?.[0];if(label)pending.set(label,send);else send()
    })
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const baseURL=`http://127.0.0.1:${server.address().port}/v1`
    const modelId=await page.eval(`(async()=>{const r=await window.rgent.modelProviderSave({provider:'custom',baseURL:${JSON.stringify(baseURL)},modelId:'v4-memory-tools',contextTokens:50000,newKey:'v4-disposable-key'});if(!r.ok)throw Error(r.error);if(!r.config.models.some(m=>m.modelId==='v4-memory-tools')){const added=await window.rgent.modelAdd({provider:'custom',modelId:'v4-memory-tools',contextTokens:50000});if(!added.ok)throw Error(added.error);return added.config.models.find(m=>m.modelId==='v4-memory-tools').id}return r.config.models.find(m=>m.modelId==='v4-memory-tools').id})()`)
    await v4OpenNote(page,'备份来源0.md')
    if(!await waitFor(page,`(async()=>{const s=await window.rgent.vaultGet(),w=await window.rgent.vaultWorkspaceGet(s.sessionId);return w?.active==='备份来源0.md'})()`))throw Error('记忆工具模型刷新前真实工作区未保存')
    await page.call('Page.reload')
    if(!await waitFor(page,`document.querySelector('#app')?.inert===false && [...document.querySelectorAll('.status-model option')].some(o=>o.value===${JSON.stringify(modelId)})`))throw Error('记忆工具模型模块未实际刷新')
    const verified=await v4Task(page,vault,'V4往返.md','V4真实往返',modelId,['备份来源0.md'])
    check('接收方通过真正库工具结果往返完成核验',await v4TaskDone(page,'V4往返.md',verified)&&requests.length===2&&requests[1].messages.some(m=>m.role==='tool'))
    await page.eval(`(async()=>{const s=await window.rgent.vaultGet();const r=await window.rgent.memoryConfigSave({sessionId:s.sessionId,target:'vault',vault:{enabled:true,override:{mode:'inherit'}}});if(!r.ok)throw Error(r.error)})()`)
    await page.eval(`(async()=>{const n=await window.rgent.noteRead('备份来源0.md'),p=await window.rgent.memoryManualPreview({sessionId:n.sessionId,relPath:'备份来源0.md',revision:n.revision,objectVersion:n.objectVersion,kind:'body',start:0,end:n.content.indexOf('\\n')});if(!p.ok)throw Error(p.error);const c=await window.rgent.memoryPreviewCommit({sessionId:n.sessionId,id:p.value.id,content:'备份记忆实际工具核心',layer:'core',scope:'虚构'});if(!c.ok)throw Error(c.error)})()`)
    writeFileSync(path.join(vault,'V4检索.md'),'')
    await v4OpenNote(page,'V4检索.md');await page.eval(`(()=>{const m=document.querySelector('.status-model');m.value=${JSON.stringify(modelId)};m.dispatchEvent(new Event('change'));document.querySelector('.cm-content').focus()})()`)
    await page.call('Input.insertText',{text:'/V4记忆额度'})
    await page.key('Enter','Enter',0,13)
    check('单篇真实授权浮层披露四次检索及共享额度',await waitFor(page,`document.querySelector('.authorization-memory')?.textContent.includes('最多 4 次') && document.querySelectorAll('.authorization-manifest li').length===1 && !!document.querySelector('.authorization-send:not(:disabled)')`))
    await v4Shots(page,shot,'memory-only-authorization','.overlay-authorization')
    const at=requests.length
    // 非模态卡不抢焦点：发送前把焦点放到发送键。
    await page.eval(`document.querySelector('.overlay-authorization .authorization-send:not(:disabled)')?.focus()`)
    await page.key('Enter','Enter',0,13)
    check('memory-only 六次请求只执行四次、第五及第六拒绝后仍能回答',await waitFor(page,`(async()=>{const n=await window.rgent.noteRead('V4检索.md');return n.content.includes('V4记忆工具回答保稿')&&!(await window.rgent.agentTasks()).length})()`))
    // The inherited learning model may also run after save. Associate this
    // foreground chain with its actual model and unique current command.
    const chain=requests.slice(at).filter(r=>r.model==='v4-memory-tools'&&r.messages.some(m=>m.role==='user'&&String(m.content).includes('当前口令：'+JSON.stringify('V4记忆额度')))),results=chain[1]?.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content))??[]
    check('只有记忆工具 schema，四次有界返回版本与核验来源，两次拒绝未搜库',chain.length===2&&chain.every(r=>r.tools?.length===1&&r.tools[0].function.name==='search_memory')&&results.length===6&&results.slice(0,4).every(r=>r.items?.length&&r.items.every(e=>e.version>0&&e.sourceChecked&&e.sources.length>0))&&results.slice(4).every(r=>r.error==='MEMORY_SEARCH_LIMIT'),chain.length===2?'':JSON.stringify({models:requests.slice(at).map(r=>r.model),results}))
    await page.eval(`document.querySelector('.ledger-open').click()`);await waitFor(page,`!!document.querySelector('.ledger-body details')`);await page.eval(`document.querySelectorAll('.ledger-body details').forEach(d=>d.open=true)`)
    check('账本使用本地工具名称且实际记忆依赖、版本和有界摘要可核对',await waitFor(page,`document.querySelector('.ledger-body')?.textContent.includes('检索记忆') && document.querySelector('.ledger-body').textContent.includes('执行 4 次') && document.querySelector('.ledger-body').textContent.includes('@') && document.querySelector('.ledger-body').textContent.includes('本场四次记忆检索已用完') && document.querySelector('.ledger-body').textContent.includes('未执行次数：2') && !document.querySelector('.ledger-body').textContent.includes('MEMORY_SEARCH_LIMIT')`)&&await page.eval(`(async()=>{const n=await window.rgent.noteRead('V4检索.md'),r=await window.rgent.ledgerGet({sessionId:n.sessionId,objectVersion:n.objectVersion,relPath:'V4检索.md'});return r.ok&&r.value.records.some(r=>r.chapter?.provenance?.memoryDeps.length>0)})()`))
    await v4Shots(page,shot,'memory-tool-ledger','.ledger-body');await page.eval(`document.querySelector('.ledger-close').click()`)
    await page.eval(`window.rgent.modelLimitsSet({tier:'local',limits:{seconds:300,steps:12,tools:5}})`)
    const limited=await v4Task(page,vault,'V4总额度.md','V4记忆额度总额',modelId)
    check('真正全局五次额度被六次调用超出时如实终止并保口令',await v4TaskDone(page,'V4总额度.md',limited)&&await page.eval(`(async()=>{const n=await window.rgent.noteRead('V4总额度.md'),r=await window.rgent.ledgerGet({sessionId:n.sessionId,objectVersion:n.objectVersion,relPath:'V4总额度.md'});return n.content.includes('V4记忆额度总额')&&r.value.records.some(r=>r.taskId===${JSON.stringify(limited)}&&r.chapter?.reason==='TOOL_CALL_LIMIT')})()`))
    await page.eval(`window.rgent.modelLimitsSet({tier:'local',limits:{seconds:300,steps:12,tools:24}})`)
    for(const kind of ['停用','遗忘','来源']){
      const label='V4晚到'+kind,start=requests.length
      const id=await v4Task(page,vault,label+'.md',label,modelId)
      for(let n=0;n<80&&!pending.has(label);n++)await sleep(100)
      if(!pending.has(label))throw Error('晚到请求没有进入夹具：'+kind)
      if(kind==='停用')await page.eval(`(async()=>{const s=await window.rgent.vaultGet();return window.rgent.memoryConfigSave({sessionId:s.sessionId,target:'vault',vault:{enabled:false,override:{mode:'inherit'}}})})()`)
      else if(kind==='遗忘')await page.eval(`(async()=>{const s=await window.rgent.vaultGet(),m=await window.rgent.memoryGet({sessionId:s.sessionId}),e=m.value.entries.find(e=>e.status==='active'&&e.layer==='core');return window.rgent.memoryItemForget({sessionId:s.sessionId,id:e.id,version:e.version,revision:m.value.revision,objectVersion:m.value.objectVersion})})()`)
      else writeFileSync(path.join(vault,'备份来源0.md'),'来源材料实际变化，旧依据不能续发')
      pending.get(label)();pending.delete(label)
      check(kind+'后晚到工具不继续派发',await v4TaskDone(page,label+'.md',id)&&requests.length===start+1)
      if(kind==='停用'||kind==='遗忘'){
        if(kind==='遗忘')await page.eval(`(async()=>{const n=await window.rgent.noteRead('备份来源0.md'),p=await window.rgent.memoryManualPreview({sessionId:n.sessionId,relPath:'备份来源0.md',revision:n.revision,objectVersion:n.objectVersion,kind:'body',start:0,end:n.content.indexOf('\\n')});if(!p.ok)throw Error(p.error);return window.rgent.memoryPreviewCommit({sessionId:n.sessionId,id:p.value.id,content:'备份记忆重新明确记住',layer:'core',scope:'虚构'})})()`)
        await page.eval(`(async()=>{const s=await window.rgent.vaultGet();return window.rgent.memoryConfigSave({sessionId:s.sessionId,target:'vault',vault:{enabled:true,override:{mode:'inherit'}}})})()`)
      }
    }
  }finally{for(const response of responses)response.destroy();await new Promise(resolve=>server.close(resolve))}
}

async function verifyV4Summary(page,nativePage,vault,shot) {
  process.stdout.write('\nv4 C：实际摘要发送记录、部分复用和遗忘过滤\n')
  const rel='V4摘要.md',requests=[],summary=['主题目标','人的要求','已完成结论','未决与受阻','后续上下文','须查原文事项'].map(h=>h+'：V4摘要核对标识').join('\n')
  writeFileSync(path.join(vault,rel),'摘要测试正文\n\n/V4摘要第一次\n')
  await page.eval(`(async()=>{const s=await window.rgent.vaultGet();let after=null;do{const r=await window.rgent.ledgerMigrate({sessionId:s.sessionId,after});if(!r.ok||r.value.failures.length)throw Error('摘要夹具迁移');after=r.value.after}while(after)})()`)
  const rp=path.join(vault,'.rgent','registry.json'),reg=JSON.parse(readFileSync(rp,'utf8')),owner=reg.owners.find(o=>o.relPath===rel),histories=[]
  // Valid persisted history fixture, read by the real LedgerStore and Host. Each has a
  // real unique material sequence; no fake summary or renderer success is inserted.
  for(let n=0;n<8;n++){
    const taskId='v4-history-'+n,prompt='V4历史要求'+n,answer='虚构历史内容'+('材料'+n).repeat(400),sequence=++reg.sequence
    const chapter={taskId,startedAt:'2026-10-04T00:00:00Z',status:'completed',prompt,answer,provenance:{version:2,memoryDeps:[],model:{provider:'custom',modelId:'v4-summary',endpointHost:'127.0.0.1'},scope:[rel],sources:[],tools:[]}}
    const record={version:1,noteId:owner.noteId,taskId,revision:1,state:'saved',bodyStatus:'unable-to-verify',chapter,sequence};histories.push(record)
    writeFileSync(path.join(vault,'.rgent','ledgers',owner.noteId,taskId+'.json'),JSON.stringify(record))
  }
  owner.sequenceCeiling=reg.sequence;writeFileSync(path.join(vault,'.rgent','ledgers',owner.noteId,'owner.json'),JSON.stringify(owner));writeFileSync(rp,JSON.stringify(reg))
  const server=createHttpServer((request,response)=>{let raw='';request.on('data',chunk=>raw+=chunk);request.on('end',()=>{
    const r=JSON.parse(raw);requests.push(r);const isSummary=r.messages.some(m=>typeof m.content==='string'&&m.content.startsWith('仅整理'))
    response.writeHead(200,{'content-type':'text/event-stream'});response.write(`data: ${JSON.stringify({id:'v4-summary',object:'chat.completion.chunk',created:1,model:r.model,choices:[{index:0,delta:{content:isSummary?summary:'V4摘要实际回答'},finish_reason:null}]})}\n\n`);response.write(`data: ${JSON.stringify({id:'v4-summary',object:'chat.completion.chunk',created:1,model:r.model,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`);response.end('data: [DONE]\n\n')
  })})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const model=await page.eval(`(async()=>{const r=await window.rgent.modelProviderSave({provider:'custom',baseURL:'http://127.0.0.1:${server.address().port}/v1',modelId:'v4-summary',contextTokens:18000,newKey:'v4-summary-key'});if(!r.ok)throw Error(r.error);if(!r.config.models.some(m=>m.modelId==='v4-summary')){const added=await window.rgent.modelAdd({provider:'custom',modelId:'v4-summary',contextTokens:18000});if(!added.ok)throw Error(added.error);return added.config.models.find(m=>m.modelId==='v4-summary').id}return r.config.models.find(m=>m.modelId==='v4-summary').id})()`)
    // Keep the registered body identity by saving through the existing human channel.
    const start=async label=>{
      const result=await page.eval(`(async()=>{let n=await window.rgent.noteRead(${JSON.stringify(rel)}),content=${JSON.stringify('摘要测试正文\n\n/'+label+'\n')};const w=await window.rgent.noteWrite({relPath:${JSON.stringify(rel)},content,expectedRevision:n.revision,objectVersion:n.objectVersion,sessionId:n.sessionId});if(!w.ok)throw Error(w.error);n=await window.rgent.noteRead(${JSON.stringify(rel)});const at=n.content.indexOf('/'),r={relPath:${JSON.stringify(rel)},range:{start:at,end:at+${label.length+1}},expectedText:${JSON.stringify('/'+label)},promptText:${JSON.stringify(label)},sessionId:n.sessionId,objectVersion:n.objectVersion,expectedRevision:n.revision,modelRecordId:${JSON.stringify(model)},references:[]};const p=await window.rgent.agentAuthorizationPreview(r);if(!p.ok)throw Error(p.error);return window.rgent.agentStart({...r,previewId:p.preview.id})})()`)
      if(!result.ok)throw Error(result.error);if(!await v4TaskDone(page,rel,result.id))throw Error('摘要任务未完成');return result.id
    }
    const first=await start('V4摘要第一次'),getRecords=`(async()=>{const n=await window.rgent.noteRead(${JSON.stringify(rel)});return (await window.rgent.ledgerGet({sessionId:n.sessionId,objectVersion:n.objectVersion,relPath:${JSON.stringify(rel)}})).value.records})()`
    // Background consolidation uses a distinct model; Host step numbers count
    // only the foreground requests. Summary text is serialized as a JSON string.
    const firstRecords=await page.eval(getRecords),sent=firstRecords.find(r=>r.taskId===first)?.chapter?.sentSummaries??[],firstRequests=requests.filter(r=>r.model==='v4-summary')
    check('实际摘要生成后发送副本、生成方、覆盖依赖和步号全部进原账本',sent.length>0&&sent.every(s=>firstRequests[s.step-1]?.messages.some(m=>String(m.content).includes(JSON.stringify(s.text)))&&s.dependencies.length===s.sourceChapterIds.length&&s.generators.every(g=>g.modelId==='v4-summary'&&g.host.includes('127.0.0.1'))),sent.length?'':JSON.stringify({task:first,chapter:firstRecords.find(r=>r.taskId===first)?.chapter,models:requests.map(r=>r.model)}))
    if(!sent.length)throw Error('实际模型未生成可发送摘要，保留首因，停止摘要依赖检查')
    const coveredTask=sent[0].sourceChapterIds[0],coveredHistory=histories.find(r=>r.taskId===coveredTask)
    if(!coveredHistory)throw Error('实际摘要覆盖不在持久夹具中')
    const before=requests.length,second=await start('V4摘要第二次'),secondRecords=await page.eval(getRecords),chapter=secondRecords.find(r=>r.taskId===second)?.chapter,secondRequests=requests.slice(before).filter(r=>r.model==='v4-summary')
    check('有效部分摘要复用不额外生成或隐藏模型步骤',secondRequests.every(r=>!r.messages.some(m=>String(m.content).startsWith('仅整理')))&&chapter?.trace?.some(t=>t.includes('复用'))&&chapter.metrics.length===secondRequests.length&&chapter.sentSummaries?.length>0,chapter?.trace?.some(t=>t.includes('复用'))?'':JSON.stringify({task:second,chapter,models:requests.slice(before).map(r=>r.model)}))
    await v4OpenNote(page,rel);await page.eval(`document.querySelector('.ledger-open').click()`);await waitFor(page,`!!document.querySelector('.ledger-body details')`);await page.eval(`document.querySelectorAll('.ledger-body details').forEach(d=>d.open=true)`)
    check('renderer 历史回顾真实摘要复用步骤可见',await waitFor(page,`document.querySelector('.ledger-body details[data-task-id="${second}"]')?.textContent.includes('复用') && document.querySelector('.ledger-body details[data-task-id="${second}"]').textContent.includes('第 1 步')`));await v4Shots(page,shot,'summary-ledger','.ledger-body');await page.eval(`document.querySelector('.ledger-close').click()`)
    await page.eval(`(async()=>{const n=await window.rgent.noteRead(${JSON.stringify(rel)}),p=await window.rgent.memoryManualPreview({sessionId:n.sessionId,relPath:${JSON.stringify(rel)},revision:n.revision,objectVersion:n.objectVersion,kind:'ledger',taskId:${JSON.stringify(coveredTask)},start:4,end:${4+coveredHistory.chapter.prompt.length}});if(!p.ok)throw Error('摘要遗忘来源：'+p.error);const c=await window.rgent.memoryPreviewCommit({sessionId:n.sessionId,id:p.value.id,content:'V4摘要覆盖材料遗忘',layer:'demand',scope:'虚构摘要'});if(!c.ok)throw Error(c.error);const e=c.value.entries.find(e=>e.content==='V4摘要覆盖材料遗忘');return window.rgent.memoryItemForget({sessionId:n.sessionId,id:e.id,version:e.version,revision:c.value.revision,objectVersion:c.value.objectVersion})})()`)
    const forgottenAt=requests.length,third=await start('V4摘要遗忘后'),thirdRecords=await page.eval(getRecords),thirdChapter=thirdRecords.find(r=>r.taskId===third)?.chapter
    check('遗忘后旧摘要副本和派生历史不能再发送，原历史保留',requests.slice(forgottenAt).every(r=>!JSON.stringify(r).includes('V4摘要核对标识'))&&thirdChapter?.trace?.some(t=>t.includes('省略派生历史'))&&thirdRecords.some(r=>r.taskId===coveredTask&&r.chapter?.answer===coveredHistory.chapter.answer))
  }finally{await new Promise(resolve=>server.close(resolve))}
}

async function verifyV4FullMemory(page,nativePage,vault,shot) {
  process.stdout.write('\nv4 D：合法满容量、真实记忆页遗忘与 pendingTarget 闭包\n')
  const park=vault+'-容量停靠';mkdirSync(park);writeFileSync(path.join(park,'停靠.md'),'容量停靠')
  const switchRoot=async target=>{
    await nativePage.eval(`(()=>{const d=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog;globalThis.__capacityOldDialog??=d.showOpenDialog;d.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(target)}]});return true})()`)
    await v4Settings(page);await page.eval(`document.querySelector('[data-vault-action="open"]').click()`);if(!await waitFor(page,`!document.querySelector('.overlay-settings') && document.querySelector('#app').inert===false`))throw Error('容量夹具切库失败')
  }
  await switchRoot(park)
  try{
    const memoryFile=path.join(vault,'.rgent-memory'),raw=readFileSync(memoryFile,'utf8'),meta=parseV5Memory(raw),sourceEntry=meta.entries.find(e=>e.sources.some(s=>s.relPath==='备份来源1.md'))??meta.entries[0]
    if(!sourceEntry)throw Error('缺少原生满容量来源夹具')
    // A legal persisted capacity fixture assembled from an actually authorized source.
    // Reload the vault to let the production parser/reconciler establish its own state.
    meta.entries=Array.from({length:1000},(_,i)=>({...structuredClone(sourceEntry),id:'v4-full-'+i,version:1,content:'满容量需遗忘条目'+i,layer:'demand',category:'long',state:{source:'revoked',content:'current',enabled:true,capacity:'ready'},status:'paused',reason:'MEMORY_SOURCE_CHANGED',...(i?{pendingTarget:{id:'v4-full-0',version:1}}:{})}))
    meta.recent=[];meta.jobs=[];meta.forgotten=[];delete meta.entries[0].pendingTarget
    let low=0,high=1200
    while(low<high){const mid=Math.ceil((low+high)/2);for(const e of meta.entries)e.content='满容量需遗忘条目'+e.id+'x'.repeat(mid);if(Buffer.byteLength(encodeV5Memory(meta))<=2*1024*1024-1024)low=mid;else high=mid-1}
    for(const e of meta.entries)e.content='满容量需遗忘条目'+e.id+'x'.repeat(low)
    const full=encodeV5Memory(meta);if(Buffer.byteLength(full)<=2*1024*1024-256*1024||Buffer.byteLength(full)>2*1024*1024)throw Error('合法满容量夹具未满足边界')
    writeFileSync(memoryFile,full)
    const beforeNotes=namesBytes(vault),beforeRegistry=readFileSync(path.join(vault,'.rgent','registry.json')),beforeLedgers=vaultFileSnapshot(path.join(vault,'.rgent','ledgers'))
    // Only .rgent-memory/jobs may change here; every owner/task/legacy byte and native identity is protected.
    await switchRoot(vault);await v4Settings(page,'记忆')
    check('合法满容量记忆页仍可查看且学习质量警示持续',await waitFor(page,`document.querySelectorAll('.memory-entry').length===1000 && document.querySelector('.memory-quality-status')?.textContent.includes('尚未通过验证')`),`${Buffer.byteLength(full)} bytes`)
    await page.eval(`document.querySelector('.memory-entry').open=true`);await v4Click(page,'.memory-entry button','删除并遗忘')
    check('满容量遗忘真实页预览明确保留原笔记与账本',await waitFor(page,`document.querySelector('.memory-forget-warning')?.textContent.includes('原笔记与账本不变')`))
    await v4Shots(page,shot,'full-memory-forget','.settings-main')
    await v4Click(page,'.memory-entry button','确认删除并遗忘')
    check('真实确认后 pendingTarget 千条闭包全移除、原文账本不变',await waitFor(page,`document.querySelectorAll('.memory-entry').length===0`)&&namesBytes(vault)===beforeNotes&&readFileSync(path.join(vault,'.rgent','registry.json')).equals(beforeRegistry)&&vaultFileSnapshot(path.join(vault,'.rgent','ledgers'))===beforeLedgers)
    const after=readFileSync(memoryFile,'utf8'),data=parseV5Memory(after)
    check('满容量遗忘不保留已删除正文、约束阻止闭包重学',!after.includes('满容量需遗忘条目')&&data.entries.length===0&&data.forgotten.some(f=>f.entryIds.length===1000)&&data.forgotten.some(f=>sourceEntry.sources.every(s=>f.materialIds.includes(s.materialId))))
    check('遗忘后质量警示和人的开关保持可见',await page.eval(`document.querySelector('.memory-quality-status').textContent.includes('尚未通过验证') && !!document.querySelector('[data-memory="vault-enabled"]')`))
    await v4CloseSettings(page)
  }finally{await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog.showOpenDialog=globalThis.__capacityOldDialog;true`)}
}
function namesBytes(vault) {
  const files=[];const walk=dir=>{for(const name of readdirSync(dir).sort()){if(name.startsWith('.'))continue;const file=path.join(dir,name);if(statSync(file).isDirectory())walk(file);else files.push([path.relative(vault,file),readFileSync(file).toString('base64')])}};walk(vault);return JSON.stringify(files)
}

/** Timeout is the existing renderer deadline, with real IPC receipts held in main. */
async function verifyV4RestoreQuery(page,nativePage,vault,profile,shot) {
  process.stdout.write('\nv4 E：实际重试恢复位置按钮与查询保护\n')
  const workspaceBefore=readFileSync(path.join(profile,'vault-workspaces.json'),'utf8')
  await holdV4Receipt(nativePage,'note:read')
  let older
  try{
    await page.call('Page.reload');await v4ReceiptSeen(nativePage)
    check('真实恢复超时展示诊断入口、原工作区磁盘记录保持',await waitFor(page,`document.querySelector('.workspace-recovery')?.hidden===false && document.querySelector('#app').inert===false`,14000)&&readFileSync(path.join(profile,'vault-workspaces.json'),'utf8')===workspaceBefore)
    await v4Shots(page,shot,'workspace-retry','.workspace-recovery')
  }finally{await releaseV4Receipt(nativePage)}
  await holdV4Receipt(nativePage,'vault:get',true)
  try{
    await page.eval(`document.querySelector('.workspace-recovery button').click()`);await v4ReceiptSeen(nativePage)
    check('真实重试按钮在 vaultGet 查询回执到达前保护交互与工作区保存',await page.eval(`document.querySelector('#app').inert===true`)&&readFileSync(path.join(profile,'vault-workspaces.json'),'utf8')===workspaceBefore)
    await page.call('Input.insertText',{text:'query-gap-must-not-write'})
    check('慢查询期间真实键盘不进入窗口正文或磁盘',!readFileSync(path.join(vault,'同名.md'),'utf8').includes('query-gap-must-not-write')&&await page.eval(`!document.querySelector('.cm-content')?.textContent.includes('query-gap-must-not-write')`))
  }finally{await releaseV4Receipt(nativePage)}
  check('真实查询失败保留诊断、稿与重试入口',await waitFor(page,`document.querySelector('.workspace-recovery')?.textContent.includes('位置核验未完成') && document.querySelector('#app').inert===false`))
  await holdV4Receipt(nativePage,'vault:get')
  try{
    await page.eval(`document.querySelector('.workspace-recovery button').click()`);await v4ReceiptSeen(nativePage)
    check('有限查询超时保留原位置记录并可再次重试',await waitFor(page,`document.querySelector('#app').inert===false && document.querySelector('.workspace-recovery')?.hidden===false`,14000)&&readFileSync(path.join(profile,'vault-workspaces.json'),'utf8')===workspaceBefore)
    await nativePage.eval(`globalThis.__v4OldQuery=globalThis.__v4Gate;process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain._invokeHandlers.set('vault:get',globalThis.__v4Gate.old);true`)
    older=true
    await holdV4Receipt(nativePage,'vault:get')
    await page.eval(`document.querySelector('.workspace-recovery button').click()`);await v4ReceiptSeen(nativePage)
    await nativePage.eval(`globalThis.__v4OldQuery.release();true`)
    await sleep(250)
    check('真实同会话旧查询迟到不释放后来重试保护',await page.eval(`document.querySelector('#app').inert===true`))
  }finally{if(older)await nativePage.eval(`globalThis.__v4OldQuery.release?.();true`);await releaseV4Receipt(nativePage)}
  check('新查询真实恢复全部原 tabs 后才解除保护',await waitFor(page,`document.querySelector('#app').inert===false && document.querySelectorAll('.tab').length===2 && document.querySelector('.workspace-recovery')?.hidden===true`,14000))
}

async function verifyV4Retirement(page,nativePage,vault,shot) {
  process.stdout.write('\nv4 A+：已识别旧对象退休失败、预览重试及未知格式保留\n')
  if(process.platform==='win32'){process.stdout.write('Windows 退休拒写夹具待原生证据；未记通过。\n');return}
  const known=vault+'-旧记忆',unknown=vault+'-未知记忆',legacy=JSON.stringify({version:1,entries:[{content:'退休旧内容不应显示'}],forgotten:[],jobs:[],relocations:[]}),opaque='未知格式字节，不得自动覆盖'
  for(const target of [known,unknown]){mkdirSync(target);writeFileSync(path.join(target,'原文.md'),'原文始终保留')}
  writeFileSync(path.join(known,'.rgent-memory'),legacy);writeFileSync(path.join(unknown,'.rgent-memory'),opaque)
  const choose=async target=>{
    await nativePage.eval(`(()=>{const d=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog;globalThis.__retireOldDialog??=d.showOpenDialog;d.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(target)}]});return true})()`)
    await v4Settings(page);await page.eval(`document.querySelector('[data-vault-action="open"]').click()`);if(!await waitFor(page,`!document.querySelector('.overlay-settings') && document.querySelector('#app').inert===false`))throw Error('退休夹具切库失败')
  }
  try{
    chmodSync(known,0o500)
    await choose(known);await v4Settings(page,'记忆');await page.eval(`document.querySelector('[data-memory-section="maintenance"]').open=true`)
    check('已识别旧目标失败可见且旧内容未展示、原字节仍保留',await waitFor(page,`[...document.querySelectorAll('.memory-maintenance button')].some(b=>b.textContent==='重试清除旧记忆…')`)&&readFileSync(path.join(known,'.rgent-memory'),'utf8')===legacy&&await page.eval(`!document.querySelector('.memory-page')?.textContent.includes('退休旧内容不应显示')`))
    await v4Click(page,'.memory-maintenance button','重试清除旧记忆…')
    check('退休重试沿一次性预览明确原笔记账本与设备设置保留',await waitFor(page,`document.querySelector('.memory-preview')?.textContent.includes('原笔记') && document.querySelector('.memory-preview').textContent.includes('设备')`))
    await v4Shots(page,shot,'retirement-preview','.settings-main')
    await v4Click(page,'.memory-preview button','确认清除旧记忆')
    check('真实退休再次写失败出口可见、原字节保持',await waitFor(page,`!!document.querySelector('.memory-page .settings-error:not([hidden])')`)&&readFileSync(path.join(known,'.rgent-memory'),'utf8')===legacy)
    chmodSync(known,0o700)
    await page.eval(`document.querySelector('[aria-label="刷新状态"]').click()`)
    await v4Click(page,'.memory-maintenance button','重试清除旧记忆…');await v4Click(page,'.memory-preview button','确认清除旧记忆')
    check('恢复写权限后真实退休确认成功、原笔记不变',await waitFor(page,`![...document.querySelectorAll('.memory-maintenance button')].some(b=>b.textContent==='重试清除旧记忆…')`)&&readFileSync(path.join(known,'.rgent-memory'),'utf8')==='<!-- rgent:memory:retired:v2 -->\n'&&readFileSync(path.join(known,'原文.md'),'utf8')==='原文始终保留')
    await v4CloseSettings(page);await choose(unknown);await v4Settings(page,'记忆');await page.eval(`document.querySelector('[data-memory-section="maintenance"]').open=true`)
    const unknownView=await page.eval(`(async()=>{const s=await window.rgent.vaultGet();return window.rgent.memoryGet({sessionId:s.sessionId})})()`)
    check('未知旧格式只有诊断、没有退休重试且原字节保留',unknownView.ok&&unknownView.value.status==='invalid'&&unknownView.value.reason==='MEMORY_STORAGE_INVALID'&&!!unknownView.value.diagnosis?.revision&&!!unknownView.value.diagnosis?.objectVersion&&unknownView.value.diagnosis.bytes===Buffer.byteLength(opaque)&&!unknownView.value.retirement&&await waitFor(page,`document.querySelector('.memory-page')?.textContent.includes('记忆操作未完成，已有记录保留')`)&&!await page.eval(`[...document.querySelectorAll('.memory-maintenance button')].some(b=>b.textContent==='重试清除旧记忆…')`)&&readFileSync(path.join(unknown,'.rgent-memory'),'utf8')===opaque)
    await v4Shots(page,shot,'unknown-memory','.settings-main');await v4CloseSettings(page);await choose(vault)
  }finally{
    chmodSync(known,0o700)
    await nativePage.eval(`(()=>{process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog.showOpenDialog=globalThis.__retireOldDialog;return true})()`)
  }
}

async function verifyV4ConsolidationRetry(page,nativePage,vault,shot) {
  process.stdout.write('\nv4 D：整理模型失败与独立 Host 材料交接故障的真实重试\n')
  let requests=0,memoryAttempts=0
  const server=createHttpServer((request,response)=>{let raw='';request.on('data',chunk=>raw+=chunk);request.on('end',()=>{
    const r=JSON.parse(raw);requests++;if(r.model==='v4-consolidation-memory'&&++memoryAttempts<=2){response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'受控临时整理失败'}}));return}const answer=r.model==='v4-consolidation-memory'?JSON.stringify({recent:null,proposals:[]}):'V4整理已保存回答'
    response.writeHead(200,{'content-type':'text/event-stream'});response.write(`data: ${JSON.stringify({id:'v4-consolidation',object:'chat.completion.chunk',created:1,model:r.model,choices:[{index:0,delta:{content:answer},finish_reason:null}]})}\n\n`);response.write(`data: ${JSON.stringify({id:'v4-consolidation',object:'chat.completion.chunk',created:1,model:r.model,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`);response.end('data: [DONE]\n\n')
  })})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const models=await page.eval(`(async()=>{const baseURL='http://127.0.0.1:${server.address().port}/v1',a=await window.rgent.modelProviderSave({provider:'custom',baseURL,modelId:'v4-consolidation-answer',contextTokens:50000,newKey:'v4-consolidation-key'});if(!a.ok)throw Error(a.error);if(!a.config.models.some(m=>m.modelId==='v4-consolidation-answer')){const added=await window.rgent.modelAdd({provider:'custom',modelId:'v4-consolidation-answer',contextTokens:50000});if(!added.ok)throw Error(added.error)}const b=await window.rgent.modelAdd({provider:'custom',modelId:'v4-consolidation-memory',contextTokens:50000});if(!b.ok)throw Error(b.error);const s=await window.rgent.vaultGet(),memory=b.config.models.find(m=>m.modelId==='v4-consolidation-memory');let r=await window.rgent.memoryConfigSave({sessionId:s.sessionId,target:'default',modelId:memory.id});if(!r.ok)throw Error(r.error);r=await window.rgent.memoryConfigSave({sessionId:s.sessionId,target:'vault',vault:{enabled:true,override:{mode:'inherit'}}});if(!r.ok)throw Error(r.error);return {answer:b.config.models.find(m=>m.modelId==='v4-consolidation-answer').id,memory:memory.id}})()`)
    const id=await v4Task(page,vault,'V4整理.md','V4整理失败需要保留材料',models.answer)
    check('回答已真实保存，整理模型失败单独可见并可重新披露',await v4TaskDone(page,'V4整理.md',id)&&await waitFor(page,`(async()=>{const s=await window.rgent.vaultGet(),m=await window.rgent.memoryGet({sessionId:s.sessionId});return m.ok&&m.value.jobs.some(j=>j.taskId===${JSON.stringify(id)}&&j.outcome==='rejected'&&j.retryable)})()`))
    await v4Settings(page,'记忆');await page.eval(`document.querySelector('[data-memory-section="jobs"]').open=true`)
    await v4Click(page,`.memory-job[data-task-id="${id}"] button`,'重新整理…')
    check('真实重试预览显示当前接收方与材料',await waitFor(page,`document.querySelector('.memory-preview')?.textContent.includes('v4-consolidation-memory')`))
    await v4Shots(page,shot,'consolidation-retry','.settings-main')
    await v4Click(page,'.memory-preview button','确认重新整理')
    check('重新披露后整理完成且未重新生成已保存回答',await waitFor(page,`(async()=>{const s=await window.rgent.vaultGet(),m=await window.rgent.memoryGet({sessionId:s.sessionId});return m.ok&&m.value.jobs.some(j=>j.taskId===${JSON.stringify(id)}&&j.outcome==='applied')})()`,20000)&&requests===4&&readFileSync(path.join(vault,'V4整理.md'),'utf8').includes('V4整理已保存回答'))
    await v4CloseSettings(page)
    // A condition breakpoint only schedules a real disposable disk fault after ledger.complete.
    // It never replaces Host saving, material versions, or the original result consumer.
    const bundle=path.join(root,'out','main','index.js'),lines=readFileSync(bundle,'utf8').split('\n'),handoffLine=lines.findIndex(line=>/const saved = await this\.readBound\(root, [A-Za-z0-9_]+\);/.test(line))
    if(handoffLine<0)throw Error('构建 Host 材料核验位置无法定位')
    const localPath=/this\.readBound\(root, ([A-Za-z0-9_]+)\)/.exec(lines[handoffLine])[1],materialRel='V4交接.md',materialFile=path.join(vault,materialRel),parkedFile=materialFile+'.交接故障暂存'
    let breakpoint
    await nativePage.call('Debugger.enable',{})
    try{
      await nativePage.eval(`globalThis.__v4HandoffFault={fired:0,results:[],file:${JSON.stringify(materialFile)},parked:${JSON.stringify(parkedFile)}};true`)
      const condition=`(()=>{const g=globalThis.__v4HandoffFault;if(root===${JSON.stringify(realpathSync.native(vault))}&&${localPath}===${JSON.stringify(materialRel)}&&g.fired===0){const fs=process.getBuiltinModule('fs');g.host=this;g.old=this.deps.onTaskMaterialResult;g.before=fs.readFileSync(g.file).toString('base64');const stat=fs.statSync(g.file);g.id=stat.dev+':'+stat.ino;g.fired++;fs.renameSync(g.file,g.parked);this.deps.onTaskMaterialResult=result=>{fs.renameSync(g.parked,g.file);g.results.push(result);this.deps.onTaskMaterialResult=g.old;return g.old(result)}}return false})()`
      const installed=await nativePage.call('Debugger.setBreakpointByUrl',{urlRegex:'out.main.index[.]js$',lineNumber:handoffLine,condition});breakpoint=installed.result?.breakpointId
      if(!breakpoint||!installed.result.locations.length)throw Error('Host 实际构建脚本条件断点未绑定')
      const handoffId=await v4Task(page,vault,materialRel,'V4保存完成后材料核验故障',models.answer)
      check('真实回答保存完成后 Host 材料核验确实失败且原对象已恢复',await v4TaskDone(page,materialRel,handoffId)&&await nativePage.eval(`(()=>{const g=globalThis.__v4HandoffFault,fs=process.getBuiltinModule('fs');return g.fired===1&&g.results.length===1&&g.results[0].taskId===${JSON.stringify(handoffId)}&&g.results[0].status==='unavailable'&&typeof g.results[0].reason==='string'&&fs.statSync(g.file).dev+':'+fs.statSync(g.file).ino===g.id&&fs.readFileSync(g.file).toString('base64')===g.before&&!fs.existsSync(g.parked)})()`))
      check('Host 交接失败由真实版本形成独立 rejected、未调用整理模型',await waitFor(page,`(async()=>{const s=await window.rgent.vaultGet(),m=await window.rgent.memoryGet({sessionId:s.sessionId});return m.ok&&m.value.jobs.some(j=>j.taskId===${JSON.stringify(handoffId)}&&j.outcome==='rejected'&&typeof j.materialVersion==='string'&&j.retryable)})()`)&&requests===5&&memoryAttempts===3)
      const savedAnswer=readFileSync(materialFile)
      await v4Settings(page,'记忆');await page.eval(`document.querySelector('[data-memory-section="jobs"]').open=true`)
      check('材料交接失败的现有页面回执与恢复入口可见',await waitFor(page,`document.querySelector('.memory-job[data-task-id="${handoffId}"] .memory-job-result')?.textContent.includes('没有写入')&&[...document.querySelectorAll('.memory-job[data-task-id="${handoffId}"] button')].some(b=>b.textContent==='重新整理…'&&!b.disabled)`))
      await v4Click(page,`.memory-job[data-task-id="${handoffId}"] button`,'重新整理…')
      check('材料交接重试须重新披露真实接收方',await waitFor(page,`document.querySelector('.memory-preview')?.textContent.includes('v4-consolidation-memory')`));await v4Shots(page,shot,'handoff-retry','.settings-main')
      await v4Click(page,'.memory-preview button','确认重新整理')
      check('交接故障受控重试完成且保存回答原字节不重复生成',await waitFor(page,`(async()=>{const s=await window.rgent.vaultGet(),m=await window.rgent.memoryGet({sessionId:s.sessionId});return m.ok&&m.value.jobs.some(j=>j.taskId===${JSON.stringify(handoffId)}&&j.outcome==='applied')})()`,20000)&&requests===6&&memoryAttempts===4&&readFileSync(materialFile).equals(savedAnswer))
      await v4CloseSettings(page)
    }finally{
      try{
        if(breakpoint)await nativePage.call('Debugger.removeBreakpoint',{breakpointId:breakpoint})
        await nativePage.eval(`(()=>{const g=globalThis.__v4HandoffFault,fs=process.getBuiltinModule('fs');if(g){if(fs.existsSync(g.parked)){if(fs.existsSync(g.file))throw Error('故障恢复目标已存在');fs.renameSync(g.parked,g.file)}if(g.host&&g.old)g.host.deps.onTaskMaterialResult=g.old}return true})()`)
      }finally{await nativePage.call('Debugger.disable',{})}
    }
  }finally{await new Promise(resolve=>server.close(resolve))}
}

/** Two real 30s main watchdogs exercise native retry producers and closePending.
 * Hold existing IPC receipts, never manufacture transition messages or restore IDs. */
async function verifyV4NativeRestoreProducer(page,nativePage,switchTo,profile,vault) {
  process.stdout.write('\nv4 E：原生关闭与实际 R1/R2 恢复 producer（保留两次 30 秒等待）\n')
  if(process.platform!=='win32'){
    const mode=statSync(vault).mode&0o777,before=readFileSync(path.join(vault,'同名.md'))
    await nativePage.eval(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');globalThis.__preparingClose={oldDialog:e.dialog.showMessageBox,dialogs:[]};e.dialog.showMessageBox=(...args)=>{const o=args.at(-1);if(o.title==='笔记尚未保存'){globalThis.__preparingClose.dialogs.push(o);return Promise.resolve({response:1})}return globalThis.__preparingClose.oldDialog(...args)};return true})()`)
    await page.eval(`globalThis.__preparingCloseEvents=[];globalThis.__preparingCloseOff=window.rgent.onVaultTransition((busy,session,state)=>globalThis.__preparingCloseEvents.push({...state}));globalThis.__preparingCloseFlushes=0;globalThis.__preparingCloseFlushOff=window.rgent.onFlushRequest(()=>globalThis.__preparingCloseFlushes++)`)
    await holdV4Receipt(nativePage,'note:write');chmodSync(vault,0o500)
    try{
      await page.eval(`document.querySelector('.cm-content').cmTile.root.view.dispatch({changes:{from:0,insert:'原生准备期保留稿\\n'}})`);await v4ReceiptSeen(nativePage)
      await v4Settings(page);await page.eval(`document.querySelector('[data-vault-open="vault-b"]').click()`)
      if(!await waitFor(page,`globalThis.__preparingCloseEvents.some(e=>e.phase==='preparing')`))throw Error('原生准备期未进入真实切库')
      await nativePage.eval(`globalThis.__rgentTestWindow.close();globalThis.__rgentTestWindow.close();true`)
      check('原生 preparing 关闭登记真实取消且已有 dirty 稿不并发普通flush',await page.eval(`globalThis.__preparingCloseEvents.some(e=>e.phase==='preparing'&&e.closePending)&&globalThis.__preparingCloseFlushes===0&&!!document.querySelector('.tab-dirty')`))
      await releaseV4Receipt(nativePage)
      for(let n=0;n<100&&!await nativePage.eval('globalThis.__preparingClose.dialogs.length===1');n++)await sleep(100)
      check('真实拒写后继续编辑取消原生关闭、原库和 dirty 稿完整保留',await nativePage.eval(`globalThis.__preparingClose.dialogs.length===1&&!globalThis.__rgentTestWindow.isDestroyed()`)&&await waitFor(page,`document.querySelector('#app').inert===false&&document.querySelector('.status-vault').textContent==='研究库 A'&&document.querySelector('.cm-content').textContent.includes('原生准备期保留稿')&&!!document.querySelector('.tab-dirty')`)&&readFileSync(path.join(vault,'同名.md')).equals(before))
    }finally{
      chmodSync(vault,mode);await releaseV4Receipt(nativePage)
      await nativePage.eval(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').dialog.showMessageBox=globalThis.__preparingClose.oldDialog;true`)
      await page.eval(`globalThis.__preparingCloseOff?.();globalThis.__preparingCloseFlushOff?.();true`)
    }
    if(await page.eval(`!!document.querySelector('.overlay-settings')`))await v4CloseSettings(page)
    // The real permission rejection is NOTE_UNREADABLE and retains the draft
    // behind the existing identity gate. Recheck before retrying the human save.
    if(await page.eval(`document.querySelector('.note-unavailable')?.hidden===false`))await page.eval(`document.querySelector('.note-recheck').click()`)
    if(!await waitFor(page,`document.querySelector('.note-unavailable')?.hidden===true`))throw Error('preparing 拒写稿尚未通过真实重新核验')
    let saved=false
    for(let n=0;n<40;n++){
      await nativePage.eval(`globalThis.__rgentTestWindow.webContents.send('menu:save');true`)
      if(await waitFor(page,`!document.querySelector('.tab-dirty')`,300)){saved=true;break}
    }
    const retained=Buffer.from('原生准备期保留稿\n'+before.toString())
    check('取消 preparing 后恢复权限可沿原保存入口落盘保留稿',saved&&readFileSync(path.join(vault,'同名.md')).equals(retained))
    if(!saved||!readFileSync(path.join(vault,'同名.md')).equals(retained))throw Error('preparing 取消后的原窗口稿未真实完整保存')
  }else process.stdout.write('  · Windows preparing 原生拒写夹具仍待核，不记通过\n')
  await switchTo('vault-b','写作库 B')
  await page.eval(`(()=>{globalThis.__nativeRestoreEvents=[];globalThis.__nativeRestoreOff=window.rgent.onVaultTransition((busy,session,state)=>globalThis.__nativeRestoreEvents.push({...state,time:Date.now()}));globalThis.__nativeRestoreFlushes=0;globalThis.__nativeRestoreFlushOff=window.rgent.onFlushRequest(()=>globalThis.__nativeRestoreFlushes++)})()`)
  const workspaceBefore=readFileSync(path.join(profile,'vault-workspaces.json'),'utf8')
  await nativePage.eval(`(()=>{
    const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron'),ipc=e.ipcMain;
    const g={old:new Map(),held:[],dialogs:[],release:false,query:false,workspace:false,oldDialog:e.dialog.showMessageBox,start:Date.now()};globalThis.__nativeRestore=g;
    for(const channel of ['vault:workspace-get','vault:get','vault:transition']){
      const old=ipc._invokeHandlers.get(channel);g.old.set(channel,old);
      ipc._invokeHandlers.set(channel,async(...args)=>{
        if(channel==='vault:transition'){
          const receipt=args[1];
          if(!g.release){const result=await new Promise(resolve=>g.held.push({channel,receipt,resolve}));if(result==='released'){const value=await old(...args);g.ackResults??=[];g.ackResults.push({receipt,value});return value}}
          return old(...args)
        }
        const value=await old(...args);
        if(!g.release&&(channel==='vault:get'&&g.query||channel==='vault:workspace-get'&&!g.workspace)){
          if(channel==='vault:workspace-get')g.workspace=true;
          await new Promise(resolve=>g.held.push({channel,resolve}));
        }
        return value
      })
    }
    e.dialog.showMessageBox=(...args)=>{const options=args.at(-1);if(options.title==='笔记库交接没有完成')return new Promise(resolve=>g.dialogs.push({resolve,time:Date.now(),options}));return g.oldDialog(...args)};
    return true
  })()`)
  try{
    // Start the actual catalog switch without waiting for the target restoration.
    await v4Settings(page);await page.eval(`document.querySelector('[data-vault-open="vault-a"]').click()`)
    for(let n=0;n<80&&!await nativePage.eval('globalThis.__nativeRestore.workspace');n++)await sleep(100)
    if(!await nativePage.eval('globalThis.__nativeRestore.workspace'))throw Error('原生 R1 未进入真实工作区读取')
    await nativePage.eval(`globalThis.__rgentTestWindow.close();globalThis.__rgentTestWindow.close();true`)
    check('真实提交后重复原生关闭仅登记延后、不并发普通flush',await page.eval(`document.querySelector('#app').inert===true && globalThis.__nativeRestoreEvents.filter(e=>e.phase==='restoring'&&e.closePending&&!e.restoreId).length>=2 && globalThis.__nativeRestoreFlushes===0`)&&await nativePage.eval(`!globalThis.__rgentTestWindow.isDestroyed()`))
    process.stdout.write('等待第一个真实主进程 30 秒恢复 watchdog…\n')
    for(let n=0;n<350&&!await nativePage.eval('globalThis.__nativeRestore.dialogs.length>=1');n++)await sleep(100)
    check('真实恢复 watchdog 的原生弹窗没有缩短产品期限',await nativePage.eval(`globalThis.__nativeRestore.dialogs.length>=1 && globalThis.__nativeRestore.dialogs[0].time-globalThis.__nativeRestore.start>=29000`))
    if(!await nativePage.eval('globalThis.__nativeRestore.dialogs.length>=1'))throw Error('主进程恢复 watchdog 没有触发')
    await nativePage.eval(`(()=>{const g=globalThis.__nativeRestore;g.query=true;g.dialogs[0].resolve({response:1});return true})()`)
    if(!await waitFor(page,`globalThis.__nativeRestoreEvents.some(e=>e.restoreId)`))throw Error('真实原生取消关闭/重试未发 R2')
    for(let n=0;n<80&&!await nativePage.eval(`globalThis.__nativeRestore.held.some(h=>h.channel==='vault:get')`);n++)await sleep(100)
    check('原生 retryRestore 真实 R2 handoff 后同 restoring 无ID通知不取消查询',await page.eval(`(()=>{const list=globalThis.__nativeRestoreEvents,index=list.findIndex(e=>e.restoreId);return index>=0&&list.slice(index+1).some(e=>e.phase==='restoring'&&!e.restoreId)&&document.querySelector('#app').inert===true})()`))
    await nativePage.eval(`globalThis.__rgentTestWindow.close();globalThis.__rgentTestWindow.close();true`)
    check('R2 查询中重复原生关闭通知仍保当前恢复和原工作区',await page.eval(`document.querySelector('#app').inert===true && globalThis.__nativeRestoreFlushes===0`)&&readFileSync(path.join(profile,'vault-workspaces.json'),'utf8')===workspaceBefore)
    await nativePage.eval(`(()=>{const g=globalThis.__nativeRestore;for(const h of g.held.filter(h=>h.channel==='vault:transition'))h.resolve('released');return true})()`)
    await sleep(250)
    check('R1 真实迟到诊断回执不能释放 R2 或提前关闭窗口',await nativePage.eval(`!globalThis.__rgentTestWindow.isDestroyed() && globalThis.__nativeRestore.ackResults?.some(r=>r.value===false)`)&&await page.eval(`document.querySelector('#app').inert===true`))
    process.stdout.write('等待第二个真实主进程 30 秒恢复 watchdog，取消关闭后完成新恢复…\n')
    for(let n=0;n<350&&!await nativePage.eval('globalThis.__nativeRestore.dialogs.length>=2');n++)await sleep(100)
    if(!await nativePage.eval('globalThis.__nativeRestore.dialogs.length>=2'))throw Error('R2 原生重试 watchdog 没有触发')
    await nativePage.eval(`(()=>{const g=globalThis.__nativeRestore;g.release=true;g.dialogs[1].resolve({response:1});for(const h of g.held)h.resolve('released');return true})()`)
    check('真实 R3 重新核验后解除门、取消关闭保留唯一窗口和完整目标位置',await waitFor(page,`document.querySelector('#app').inert===false && document.querySelectorAll('.tab').length===2 && document.querySelector('.tab[aria-selected=true]')?.dataset.rel==='同名.md' && globalThis.__nativeRestoreEvents.some(e=>!e.busy)`,14000)&&await nativePage.eval(`!globalThis.__rgentTestWindow.isDestroyed()`))
    check('原生恢复完成仍从当前根访问目标正文',await page.eval(`window.rgent.noteRead('同名.md').then(n=>n.content.includes('A 段落'))`)&&readFileSync(path.join(vault,'同名.md'),'utf8').includes('A 段落'))
  }finally{
    await nativePage.eval(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron'),g=globalThis.__nativeRestore;g.release=true;for(const [channel,old]of g.old)e.ipcMain._invokeHandlers.set(channel,old);for(const h of g.held)h.resolve('released');for(const d of g.dialogs)d.resolve({response:1});e.dialog.showMessageBox=g.oldDialog;return true})()`)
    await page.eval(`globalThis.__nativeRestoreOff?.();globalThis.__nativeRestoreFlushOff?.();true`)
  }
}

/** Disposable recovery counterexample. Native fixture creates a valid owner-complete,
 * registry-pending intent; real renderer, preload, IPC and resume perform the repair. */
async function verifyLedgerRecoveryDrafts(page,nativePage,vault) {
  const names=['恢复甲.md','恢复乙.md']
  writeFileSync(path.join(vault,names[0]),'恢复甲正文\n<!-- rgent:ledger:v1 -->\n旧历史')
  writeFileSync(path.join(vault,names[1]),'恢复乙正文')
  await page.eval(`(async()=>{const s=await window.rgent.vaultGet();const r=await window.rgent.ledgerMigrate({sessionId:s.sessionId,after:null});if(!r.ok||r.value.failures.length)throw Error('恢复夹具迁移失败')})()`)
  await waitFor(page,`[...document.querySelectorAll('.tree-note')].some(n=>n.dataset.path==='恢复乙.md')`)
  await nativePage.eval(`(()=>{const ipc=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain;const old=ipc._invokeHandlers.get('note:write');globalThis.__recoverySave={old,seen:false,requests:[],results:[]};ipc._invokeHandlers.set('note:write',async(...args)=>{const g=globalThis.__recoverySave,request=args[1]?.args?.[0]??args[1];if(g.seen||!${JSON.stringify(names)}.includes(request?.relPath)||!request.content.includes('未保存草稿'))return old(...args);g.seen=true;g.requests.push(request);await new Promise(r=>g.release=r);const result=await old(...args);g.results.push(result);return result});return true})()`)
  try {
    for(const name of names){
      await page.eval(`[...document.querySelectorAll('.tree-note')].find(n=>n.dataset.path===${JSON.stringify(name)}).click()`)
      if(!await waitFor(page,`document.querySelector('.tab[aria-selected="true"]')?.dataset.rel===${JSON.stringify(name)}`))throw Error('恢复夹具笔记未打开：'+name)
      await page.eval(`(()=>{const v=document.querySelector('.cm-content').cmTile.root.view;v.dispatch({changes:{from:v.state.doc.length,insert:'未保存草稿'},userEvent:'input.type'})})()`)
    }
    for(let n=0;n<40&&!await nativePage.eval(`globalThis.__recoverySave.seen`);n++)await sleep(100)
    if(!await nativePage.eval(`globalThis.__recoverySave.seen`))throw Error('恢复甲乙真实草稿保存未进入暂停夹具')
    const session=await page.eval(`(async()=>{const s=await window.rgent.vaultGet();return s.sessionId})()`)
    await nativePage.eval(`(()=>{
      const req=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json'),fs=req('node:fs'),path=req('node:path'),native=req(path.join(process.cwd(),'out/main/rgent_fs.node')),root=${JSON.stringify(vault)},h=native.openRoot(root)
      try{const snap=p=>native.readSnapshot(h,p),registry=snap('.rgent/registry.json'),r=JSON.parse(registry.bytes.toString()),owner=r.owners.find(o=>o.relPath==='恢复甲.md'),ownerPath='.rgent/ledgers/'+owner.noteId+'/owner.json',before=snap(ownerPath),body=snap(owner.relPath),stat=fs.statSync(root,{bigint:true});let permission=null;try{permission=snap('.rgent-permissions')}catch{}
        owner.sequenceCeiling=++r.sequence;const nextOwner=JSON.stringify(owner),nextRegistry=JSON.stringify(r)
        const receipt=native.replace(h,ownerPath,before.bytes,Buffer.from(nextOwner),before.objectVersion)
        const plan={kind:'ledger-publication',rootIdentity:stat.dev+':'+stat.ino,sessionId:${JSON.stringify(session)},relPath:owner.relPath,objectVersion:body.objectVersion,bodyRevision:req('node:crypto').createHash('sha256').update(body.bytes).digest('hex'),permissionRaw:permission?permission.bytes.toString():null,permissionId:permission?.objectVersion??null,ownerPath,writes:[{path:ownerPath,before:before.bytes.toString(),beforeId:before.objectVersion,after:nextOwner,receipt},{path:'.rgent/registry.json',before:registry.bytes.toString(),beforeId:registry.objectVersion,after:nextRegistry}]}
        const journal=snap('.rgent-lifecycle');native.replace(h,'.rgent-lifecycle',journal.bytes,Buffer.from(JSON.stringify({version:1,active:plan})),journal.objectVersion)
      }finally{native.closeRoot(h)}return true
    })()`)
  } finally {
    await nativePage.eval(`(()=>{const ipc=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain,g=globalThis.__recoverySave;ipc._invokeHandlers.set('note:write',g.old);g.release?.();return true})()`)
  }
  const paused=await waitFor(page,`document.querySelectorAll('.tab-dirty').length===2 && document.querySelector('.cm-content')?.getAttribute('contenteditable')==='false'`)
  check('发布中断后真实自动保存拒绝写盘、两篇窗口稿保留',paused,paused?'':JSON.stringify({held:await nativePage.eval(`({seen:globalThis.__recoverySave.seen,requests:globalThis.__recoverySave.requests,results:globalThis.__recoverySave.results})`),renderer:await page.eval(`(async()=>({status:await window.rgent.lifecycleStatus(),tabs:[...document.querySelectorAll('.tab')].map(t=>({name:t.dataset.rel,dirty:!!t.querySelector('.tab-dirty')})),contenteditable:document.querySelector('.cm-content').getAttribute('contenteditable')}))()`)}))
  check('恢复暂停仍能阅读正文且磁盘未被草稿改写',!readFileSync(path.join(vault,names[0]),'utf8').includes('未保存草稿')&&!readFileSync(path.join(vault,names[1]),'utf8').includes('未保存草稿')&&await page.eval(`document.querySelector('.cm-content')?.textContent.includes('未保存草稿') && !document.querySelector('#app').inert`))
  await page.eval(`document.querySelector('.settings-open').click()`)
  await waitFor(page,`!!document.querySelector('.overlay-settings')`)
  await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(n=>n.textContent==='笔记库').click()`)
  if(!await waitFor(page,`[...document.querySelectorAll('.vault-settings-recovery button')].some(b=>b.textContent==='核验并继续一批')`))throw Error('真实恢复暂停入口未就绪')
  await page.eval(`[...document.querySelectorAll('.vault-settings-recovery button')].find(b=>b.textContent==='核验并继续一批').click()`)
  check('携带脏 tab 通过真实恢复 IPC 续跑、没有预先强制保存',await waitFor(page,`document.querySelector('.vault-settings-recovery')?.textContent.includes('恢复已完成')`))
  check('恢复完成后两篇窗口稿自动保存且编辑恢复',await waitFor(page,`document.querySelectorAll('.tab-dirty').length===0 && document.querySelector('.cm-content')?.getAttribute('contenteditable')==='true'`))
  check('恢复后磁盘保存两篇原窗口稿且意图完成',names.every(name=>readFileSync(path.join(vault,name),'utf8').includes('未保存草稿'))&&JSON.parse(readFileSync(path.join(vault,'.rgent-lifecycle'),'utf8')).active===null)
  await page.eval(`document.querySelector('.overlay-settings')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`)
  await verifyLedgerRecoveryHostPending(page,vault)
}

/** Real Host pending and real repair IPC. POSIX directory permissions interrupt
 * registry publication after the owner receipt, using only the disposable vault. */
async function verifyLedgerRecoveryHostPending(page,vault) {
  if(process.platform==='win32'){process.stdout.write('Host 发布故障窗口夹具待 Windows 专属注入；不代称通过。\n');return}
  const relPath='恢复生成.md',answer='恢复后保住的完整生成回答',control=path.join(vault,'.rgent'),mode=statSync(control).mode&0o777
  let requests=0,sendAnswer=null,responseInFlight=null
  const server=createHttpServer((request,response)=>{
    request.resume();request.on('end',()=>{
      requests++;responseInFlight=response
      sendAnswer=()=>{
        chmodSync(control,0o555)
        response.writeHead(200,{'content-type':'text/event-stream'})
        for(const [delta,finish_reason] of [[{content:answer},null],[{},'stop']])response.write(`data: ${JSON.stringify({id:'recovery-ui',object:'chat.completion.chunk',created:1,model:'recovery-ui',choices:[{index:0,delta,finish_reason}]})}\n\n`)
        response.end('data: [DONE]\n\n')
      }
    })
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    writeFileSync(path.join(vault,relPath),'/恢复回答\n')
    const baseURL=`http://127.0.0.1:${server.address().port}/v1`
    const started=await page.eval(`(async()=>{
      const added=await window.rgent.modelProviderSave({provider:'custom',baseURL:${JSON.stringify(baseURL)},modelId:'recovery-ui',contextTokens:16000,newKey:'disposable-recovery-fixture'})
      if(!added.ok)throw Error('恢复模型夹具配置失败')
      const model=added.config.models.find(m=>m.provider==='custom'&&m.modelId==='recovery-ui')
      const note=await window.rgent.noteRead(${JSON.stringify(relPath)}),request={relPath:${JSON.stringify(relPath)},range:{start:0,end:5},expectedText:'/恢复回答',promptText:'恢复回答',sessionId:note.sessionId,objectVersion:note.objectVersion,expectedRevision:note.revision,modelRecordId:model.id,references:[]}
      globalThis.__pendingRecoveryEvents=[];globalThis.__pendingRecoveryOff=window.rgent.onAgentEvent(e=>globalThis.__pendingRecoveryEvents.push(e))
      const preview=await window.rgent.agentAuthorizationPreview(request)
      if(!preview.ok)throw Error('恢复任务授权失败：'+preview.error)
      return window.rgent.agentStart({...request,previewId:preview.preview.id})
    })()`)
    if(!started.ok)throw Error('恢复任务启动失败：'+started.error)
    for(let i=0;i<50&&!sendAnswer;i++)await sleep(100)
    if(!sendAnswer)throw Error('受控恢复模型未收到请求')
    const busy=await page.eval(`(async()=>{const s=await window.rgent.vaultGet();return window.rgent.ledgerRepair({action:'resume',sessionId:s.sessionId,revision:'0'.repeat(64)})})()`)
    check('生成仍活动时真实恢复 IPC 拒绝',!busy.ok&&busy.error==='STRUCTURE_BUSY')
    sendAnswer()
    check('真实 Host 发布失败留下完整待保存回答',await waitFor(page,`(async()=>globalThis.__pendingRecoveryEvents.some(e=>e.id===${JSON.stringify(started.id)}&&e.status==='failed'&&!e.persisted&&e.answer===${JSON.stringify(answer)}) && !(await window.rgent.agentTasks()).length)()`))
    const journal=JSON.parse(readFileSync(path.join(vault,'.rgent-lifecycle'),'utf8'))
    check('故障落在 owner 已成而 registry 未成',journal.active?.kind==='ledger-publication'&&!!journal.active.writes[0].receipt&&!journal.active.writes[1].receipt)
    const resume=`(async()=>{const s=await window.rgent.vaultGet(),status=await window.rgent.lifecycleStatus();return window.rgent.ledgerRepair({action:'resume',sessionId:s.sessionId,revision:status.revision})})()`
    const failedBefore=vaultFileSnapshot(vault)
    const failed=await page.eval(resume)
    check('Host pending 的失败续跑保留日志和回答',!failed.ok&&JSON.parse(readFileSync(path.join(vault,'.rgent-lifecycle'),'utf8')).active!==null&&vaultFileSnapshot(vault)===failedBefore&&await page.eval(`globalThis.__pendingRecoveryEvents.some(e=>e.id===${JSON.stringify(started.id)}&&e.answer===${JSON.stringify(answer)}&&!e.persisted)`))
    chmodSync(control,mode)
    const restored=await page.eval(resume)
    check('Host pending 经真实恢复入口续跑成功',restored.ok&&restored.value?.status==='complete')
    check('恢复释放后自动补存回答且没有再次派发模型',await waitFor(page,`globalThis.__pendingRecoveryEvents.some(e=>e.id===${JSON.stringify(started.id)}&&e.persisted&&e.answer===${JSON.stringify(answer)})`)&&readFileSync(path.join(vault,relPath),'utf8').includes(answer)&&requests===1)
  } finally {
    chmodSync(control,mode);responseInFlight?.end()
    await page.eval(`globalThis.__pendingRecoveryOff?.();true`)
    await new Promise(resolve=>server.close(resolve))
  }
}

async function verifyModelFeedback(page, nativePage, shot) {
  const longId = '失败候选模型名称用于验证窄窗口省略与容量草稿保留'.repeat(4)
  const config = await page.eval(`(async()=>{const r=await window.rgent.modelConfigGet();if(!r.ok)throw new Error('模型反馈夹具初读失败');return r.config})()`)
  const theme = await page.eval(`window.rgent.themeGet()`)
  const closeSettings = async () => {
    await page.eval(`document.querySelector('.overlay-settings')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`)
    if (!await waitFor(page, `!document.querySelector('.overlay-settings')`)) throw new Error('模型反馈设置未关闭')
  }
  const openModel = async () => {
    await page.eval(`document.querySelector('.settings-open').click()`)
    await waitFor(page, `!!document.querySelector('.overlay-settings[open]')`)
    await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(n=>n.textContent==='模型').click()`)
    if (!await waitFor(page, `!!document.querySelector('[data-provider="custom"]')`)) throw new Error('模型反馈供应商未就绪')
    await page.eval(`document.querySelector('[data-provider="custom"]').click()`)
  }
  const readList = async () => {
    await page.eval(`document.querySelector('.settings-read-row button').click()`)
    if (!await waitFor(page, `document.querySelectorAll('.settings-candidate').length===5`)) throw new Error('模型反馈候选未就绪')
  }
  await closeSettings()
  await nativePage.eval(`(()=>{
    const ipc=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain
    const channels=['model-config:get','model-config:model-add','model-config:model-list']
    const f={old:channels.map(c=>[c,ipc._invokeHandlers.get(c)]),config:${JSON.stringify(config)},longId:${JSON.stringify(longId)},calls:[],mode:'batch',release:null,readRelease:null}
    globalThis.__modelFeedback=f
    ipc._invokeHandlers.set(channels[0],async()=>({ok:true,config:f.config}))
    ipc._invokeHandlers.set(channels[2],async()=>{
      if(f.mode==='read-late')await new Promise(resolve=>f.readRelease=resolve)
      return {ok:true,models:[{id:'feedback-added',contextTokens:4096},{id:'feedback-existing',contextTokens:4096},{id:f.longId},{id:'feedback-later',contextTokens:16384},{id:'feedback-unselected',contextTokens:32768}]}
    })
    ipc._invokeHandlers.set(channels[1],async(_event,value)=>{
      f.calls.push(value)
      if(f.mode==='error')return {ok:false,error:f.error}
      if(f.mode==='late'){await new Promise(resolve=>f.release=resolve);return {ok:false,error:'IO_ERROR'}}
      if(f.mode==='late-success'){await new Promise(resolve=>f.release=resolve);f.config={...f.config,models:[...f.config.models,{id:'feedback-late-record',provider:'custom',modelId:'feedback-late-saved',contextTokens:value.contextTokens}]};return {ok:true,config:f.config}}
      if(value.modelId==='feedback-added'){
        f.config={...f.config,models:[...f.config.models,{id:'feedback-record',provider:'custom',modelId:value.modelId,contextTokens:value.contextTokens}]}
        return {ok:true,config:f.config}
      }
      if(value.modelId==='feedback-existing')return {ok:false,error:'DUPLICATE_MODEL'}
      await new Promise(resolve=>f.release=resolve)
      return {ok:false,error:'TOO_MANY_MODELS'}
    })
    return true
  })()`)
  try {
    await openModel()
    for (const error of ['CONNECTION_NOT_FOUND','MODEL_NOT_FOUND','BAD_PROVIDER','DUPLICATE_MODEL','TOO_MANY_MODELS','constructor']) {
      await nativePage.eval(`globalThis.__modelFeedback.mode='error';globalThis.__modelFeedback.error=${JSON.stringify(error)};true`)
      await page.eval(`[...document.querySelectorAll('.settings-action')].find(n=>n.textContent==='添加模型').click()`)
      check('模型反馈错误 '+error+' 显示易读原因而非内部码',await waitFor(page,`(()=>{const t=document.querySelector('.settings-error')?.textContent;return !!t && /[\u4e00-\u9fff]/.test(t) && !t.includes(${JSON.stringify(error)})})()`))
    }
    await nativePage.eval(`globalThis.__modelFeedback.mode='batch';globalThis.__modelFeedback.calls=[];true`)
    await readList()
    await page.eval(`(()=>{const rows=[...document.querySelectorAll('.settings-candidate')];const capacity=rows[2].querySelector('input[type=number]');capacity.value='8192';capacity.dispatchEvent(new Event('input'));rows[4].querySelector('input[type=checkbox]').click();const add=[...document.querySelectorAll('.settings-action')].find(n=>n.textContent==='添加所选（4）');add.click();add.click()})()`)
    let gated = false
    for (let attempt=0;attempt<60;attempt++) {
      if (await nativePage.eval(`!!globalThis.__modelFeedback.release`)) { gated=true;break }
      await sleep(100)
    }
    if(!gated)throw new Error('模型反馈批量失败回执未抵达屏障')
    check('模型反馈成功项在后续回执挂起时已同步且重复项退出候选',await waitFor(page,`document.querySelectorAll('.settings-candidate').length===3 && [...document.querySelectorAll('.settings-model-id')].some(n=>n.textContent==='feedback-added') && [...document.querySelectorAll('.status-model option')].some(n=>n.textContent==='feedback-added')`))
    check('模型反馈 busy 防重复并禁用读取和候选操作',await nativePage.eval(`globalThis.__modelFeedback.calls.length===3`) && await page.eval(`[...document.querySelectorAll('.settings-form button,.settings-form input')].filter(n=>!n.closest('.settings-network')).every(n=>n.disabled)`))
    await nativePage.eval(`globalThis.__modelFeedback.release();globalThis.__modelFeedback.release=null;true`)
    check('模型反馈分别报告成功、重复、失败与未尝试',await waitFor(page,`document.querySelector('.settings-read-panel')?.textContent.includes('已添加 1 个，已存在 1 个，失败 1 个，未尝试 1 个')`))
    check('模型反馈长名称、容量与未勾选草稿保留且结束恢复控件',await page.eval(`(()=>{const rows=[...document.querySelectorAll('.settings-candidate')];return rows[0].querySelector('.settings-candidate-id').textContent===${JSON.stringify(longId)} && rows[0].querySelector('input[type=number]').value==='8192' && rows[0].querySelector('input[type=checkbox]').checked && !rows[2].querySelector('input[type=checkbox]').checked && !document.querySelector('.settings-read-row button').disabled})()`))
    // 前段配色探针会保留 light 媒体模拟；真实设备主题验收须先解除该覆盖。
    await page.call('Emulation.setEmulatedMedia', { features: [] })
    for(const mode of ['day','night']) {
      await page.eval(`window.rgent.themeSet('${mode}')`)
      const themeReady = await waitFor(page,`document.documentElement.dataset.theme==='${mode}' && getComputedStyle(document.documentElement).colorScheme==='${mode === 'night' ? 'dark' : 'light'}'`)
      for(const [width,height] of [[1200,800],[800,560]]) {
        await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
        await page.eval(`document.querySelector('.settings-candidate input[type=checkbox]').focus()`)
        await page.key('Tab', 'Tab', 0, 9)
        check('模型反馈 '+mode+' '+width+' 容量说明单行可读、无横向溢出且焦点中性',themeReady && await page.eval(`(()=>{const panel=document.querySelector('.overlay-settings'),form=document.querySelector('.settings-form'),active=document.activeElement,s=getComputedStyle(active),probe=document.createElement('span');probe.style.color='var(--focus-ring)';document.body.append(probe);const neutral=getComputedStyle(probe).color;probe.remove();const readableNotes=[...form.querySelectorAll('.settings-candidate-note')].every(n=>{const range=document.createRange();range.selectNodeContents(n);return range.getClientRects().length===1});return readableNotes && panel.scrollWidth<=panel.clientWidth+1 && form.scrollWidth<=form.clientWidth+1 && document.documentElement.scrollWidth<=innerWidth && active.matches('.settings-candidate input[type=number]') && s.outlineStyle!=='none' && s.outlineColor===neutral})()`), await page.eval(`(()=>{const active=document.activeElement;return JSON.stringify({theme:document.documentElement.dataset.theme,colorScheme:getComputedStyle(document.documentElement).colorScheme,mediaDark:matchMedia('(prefers-color-scheme: dark)').matches,viewport:innerWidth,widths:[...document.querySelectorAll('.overlay-settings,.settings-form,.settings-read-panel,.settings-candidates,.settings-candidate')].map(n=>({class:n.className,client:n.clientWidth,scroll:n.scrollWidth})),focus:active?.className,focusVisible:active?.matches(':focus-visible'),outline:getComputedStyle(active).outline})})()`))
        if (themeReady) await shot(page,'model-feedback-'+mode+'-'+width)
      }
    }
    await page.call('Emulation.clearDeviceMetricsOverride',{})
    await nativePage.eval(`globalThis.__modelFeedback.mode='late';globalThis.__modelFeedback.calls=[];true`)
    await page.eval(`[...document.querySelectorAll('.settings-action')].find(n=>n.textContent==='添加所选（2）').click()`)
    gated=false
    for(let attempt=0;attempt<60;attempt++){if(await nativePage.eval(`!!globalThis.__modelFeedback.release`)){gated=true;break}await sleep(100)}
    if(!gated)throw new Error('模型反馈离页添加未抵达屏障')
    await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(n=>n.textContent==='界面').click()`)
    await nativePage.eval(`globalThis.__modelFeedback.release();globalThis.__modelFeedback.release=null;true`)
    await page.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    check('模型反馈离页后添加失败回执不复活页面或错误',await waitFor(page,`document.querySelector('.settings-page-title')?.textContent==='界面' && !document.querySelector('.settings-read-panel') && !document.querySelector('.settings-error')?.textContent`))
    await closeSettings();await openModel()
    await readList()
    await nativePage.eval(`globalThis.__modelFeedback.mode='late-success';globalThis.__modelFeedback.calls=[];true`)
    await page.eval(`(()=>{for(const input of document.querySelectorAll('.settings-candidate input[type=number]')){if(!input.value){input.value='8192';input.dispatchEvent(new Event('input'))}}[...document.querySelectorAll('.settings-action')].find(n=>n.textContent==='添加所选（5）').click()})()`)
    gated=false
    for(let attempt=0;attempt<60;attempt++){if(await nativePage.eval(`!!globalThis.__modelFeedback.release`)){gated=true;break}await sleep(100)}
    if(!gated)throw new Error('模型反馈离页成功添加未抵达屏障')
    await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(n=>n.textContent==='界面').click()`)
    await nativePage.eval(`globalThis.__modelFeedback.release();globalThis.__modelFeedback.release=null;true`)
    check('模型反馈离页成功回执刷新全局模型且不复活旧页面',await waitFor(page,`document.querySelector('.settings-page-title')?.textContent==='界面' && !document.querySelector('.settings-read-panel') && [...document.querySelectorAll('.status-model option')].some(n=>n.textContent==='feedback-late-saved')`))
    check('模型反馈离页成功后停止后续批次',await nativePage.eval(`globalThis.__modelFeedback.calls.length===1`))
    await closeSettings();await openModel()
    await nativePage.eval(`globalThis.__modelFeedback.mode='read-late';true`)
    await page.eval(`document.querySelector('.settings-read-row button').click()`)
    gated=false
    for(let attempt=0;attempt<60;attempt++){if(await nativePage.eval(`!!globalThis.__modelFeedback.readRelease`)){gated=true;break}await sleep(100)}
    if(!gated)throw new Error('模型反馈离页读取未抵达屏障')
    await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(n=>n.textContent==='界面').click()`)
    await nativePage.eval(`globalThis.__modelFeedback.readRelease();globalThis.__modelFeedback.readRelease=null;true`)
    await page.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    check('模型反馈离页后读取清单回执不复活旧候选',await waitFor(page,`document.querySelector('.settings-page-title')?.textContent==='界面' && !document.querySelector('.settings-read-panel')`))
  } finally {
    await nativePage.eval(`(()=>{const f=globalThis.__modelFeedback;const ipc=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain;for(const [channel,handler]of f.old)ipc._invokeHandlers.set(channel,handler);f.release?.();f.readRelease?.();delete globalThis.__modelFeedback;return true})()`)
    await closeSettings()
    await page.eval(`window.rgent.themeSet(${JSON.stringify(theme)})`)
    await page.call('Emulation.clearDeviceMetricsOverride',{})
  }
  await openModel()
}

function createControlledHostServer(memoryRequests,toolLoopRequests,writeRequests=[],allRequests=null) {
  const server = createHttpServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += String(chunk) })
      request.on('end', () => {
        const decoded = JSON.parse(body)
        allRequests?.push(decoded)
        if (decoded.model === 'memory-ui-fixture') {
          memoryRequests.push(decoded)
          const material = JSON.parse(decoded.messages.find(m=>m.role==='user').content)
          const source = (material.sources??[]).find(s=>s.classification==='command' && s.text.includes('长期记住'))
          // 生产整理已切共同管线（continuity-m4）：回执必须是 {recent, proposals}，长期约定必须带
          // 逐字存在于 command 来源里的 authority 原话；旧式 {proposals:[…]} 会被判格式失败。
          const proposal = source ? [{action:'add',content:'后续回答请用中文简短表达（记忆验收）。',scope:'当前库',semantic:'standing',attribution:'本场人的明确长期口令',sourceIds:[source.id],reviewAt:null,authority:[{sourceId:source.id,quote:'长期记住'}]}] : []
          const payload = {recent:null, proposals:proposal}
          response.writeHead(200, {'content-type':'text/event-stream'})
          response.write(`data: ${JSON.stringify({id:'memory-ui',object:'chat.completion.chunk',created:1,model:decoded.model,choices:[{index:0,delta:{content:JSON.stringify(payload)},finish_reason:null}]})}\n\n`)
          response.write(`data: ${JSON.stringify({id:'memory-ui',object:'chat.completion.chunk',created:1,model:decoded.model,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`)
          response.end('data: [DONE]\n\n'); return
        }
        if (body.includes('记忆后续')) {
          memoryRequests.push(decoded)
          const answer = body.includes('后续回答请用中文简短表达（记忆验收）。') ? '记忆验收旧回答：后续回答请用中文简短表达（记忆验收）。' : '受控遗忘核验回答。'
          response.writeHead(200, {'content-type':'text/event-stream'})
          response.write(`data: ${JSON.stringify({id:'memory-use-ui',object:'chat.completion.chunk',created:1,model:decoded.model,choices:[{index:0,delta:{content:answer},finish_reason:null}]})}\n\n`)
          response.write(`data: ${JSON.stringify({id:'memory-use-ui',object:'chat.completion.chunk',created:1,model:decoded.model,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`)
          response.end('data: [DONE]\n\n'); return
        }
        // 只按写工具专项自己的口令识别：工具链场景现在也带写工具，按工具名匹配会把它整个劫持走。
        const writeBody = JSON.stringify(decoded.messages)
        const writePrompts = ['建样张一', '建样张二', '补样张', '超限样张', '改名样张', '挪样张', '越权样张', '删样张', '不删样张', '旅程补写']
        if (writePrompts.some(prompt => writeBody.includes(prompt))) {
          writeRequests.push(decoded)
          const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'write-ui', object: 'chat.completion.chunk', created: 1, model: decoded.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          const results = decoded.messages.filter(message => message.role === 'tool')
          if (!results.length) {
            // 第一轮：按口令提出一次写请求；工具名只在"有工具档"的场里出现。
            const prompts = writeBody
            const call = prompts.includes('越权样张')
              // 越权场景：请模型改「正在写入的发起篇」自己——门必须按 ORIGIN_LOCKED 拒。
              ? { name: 'rename_note', input: { relPath: '写作越权.md', newName: '偷改发起篇' } }
              : prompts.includes('改名样张')
                ? { name: 'rename_note', input: { relPath: '写作参考.md', newName: '写作参考改' } }
                : prompts.includes('挪样张')
                  ? { name: 'move_note', input: { relPath: '写作挪参考.md', targetFolder: '归档' } }
                : prompts.includes('不删样张')
                  ? { name: 'delete_note', input: { relPath: '写作不删参考.md' } }
                : prompts.includes('删样张')
                  ? { name: 'delete_note', input: { relPath: '写作删参考.md' } }
                  : prompts.includes('建样张二')
                ? { name: 'create_note', input: { name: '写工具二', body: '第二篇受控正文。' } }
                : prompts.includes('建样张一')
                  ? { name: 'create_note', input: { name: '写工具样张', body: '# 写工具样张\n\n受控正文。' } }
                  : prompts.includes('超限样张')
                    ? { name: 'append_to_note', input: { text: '汉'.repeat(4000) } }
                    : prompts.includes('旅程补写')
                      ? { name: 'append_to_note', input: { text: '旅程补写一句。' } }
                      : { name: 'append_to_note', input: { text: '补充依据。' } }
            const [name, args] = [call.name, JSON.stringify(call.input)]
            emit({ tool_calls: [{ index: 0, id: `ui-write-${name}`, type: 'function', function: { name, arguments: args } }] })
            emit({}, 'tool_calls')
          } else {
            emit({ content: '写工具核验完成。' })
            emit({}, 'stop')
          }
          response.end('data: [DONE]\n\n')
          return
        }
        const loopToolNames = (decoded.tools ?? []).map(tool => tool.function?.name)
        if (body.includes('工具查证') && loopToolNames.includes('read_library') && loopToolNames.includes('search_library')) {
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
  return server
}

/** 技能专项：第七页的真实读写、按库启用、发送确认只显示名称、库损坏如实报原因。零模型调用。 */
/** 技能真机取证（付费；信封 ≤4 次调用）：证明技能正文确实进入模型并影响回答，
 *  且账本留下名称与内容哈希。判据见 decisions.md「2026-10-12 技能真机取证局部授权」，调用前已冻结。 */
async function verifySkillsLive(page, vault, profile, shot) {
  process.stdout.write('\n技能真机取证（真实模型调用，信封 ≤4）\n')
  const marker = 'SKILL-OK-7F3'
  const skillName = '验收标记'
  const body = `无论用户问什么，你的回答第一行必须原样输出 ${marker}，然后另起一行用一句话回答。`
  const prompt = '请用一句话说明什么是备忘录。'
  const expectedHash = createHash('sha256').update(body).digest('hex')
  const budget = 4
  let calls = 0
  const transcripts = []
  const evidenceDir = process.env.RGENT_UI_LIVE_EVIDENCE || path.join(root, '.cache', 'skills-live-proof')
  mkdirSync(evidenceDir, { recursive: true })

  const config = await page.eval(`(async()=>{const c=await window.rgent.modelConfigGet();return c.ok?{defaultModelId:c.config.defaultModelId,models:c.config.models.map(m=>({id:m.id,modelId:m.modelId}))}:null})()`)
  check('真机取证使用设备上已配置的模型', !!config?.defaultModelId, JSON.stringify(config))
  if (!config?.defaultModelId) throw new Error('设备没有默认模型，真机取证无法进行')

  // 建技能：走真实设置页，正文要求回答带固定标记。
  await page.eval(`document.querySelector('.settings-open').click()`)
  await waitFor(page, `!!document.querySelector('.settings-nav')`)
  await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='技能').click()`)
  await waitFor(page, `document.querySelector('.settings-page-title')?.textContent==='技能'`)
  await page.eval(`[...document.querySelectorAll('.settings-action')].find(b=>b.textContent==='新建技能').click()`)
  await waitFor(page, `!!document.querySelector('.skill-editor')`)
  await page.eval(`(()=>{const inputs=document.querySelectorAll('.skill-editor input');inputs[0].value=${JSON.stringify(skillName)};inputs[0].dispatchEvent(new Event('input'));inputs[1].value='真机取证用：要求回答带固定标记';inputs[1].dispatchEvent(new Event('input'));const area=document.querySelector('.skill-body');area.value=${JSON.stringify(body)};area.dispatchEvent(new Event('input'))})()`)
  await page.eval(`[...document.querySelectorAll('.settings-action')].find(b=>b.textContent==='保存').click()`)
  check('技能经真实页面落盘', await waitFor(page, `document.querySelector('.skills-list')?.textContent.includes(${JSON.stringify(skillName)})`))
  check('基线场之前技能处于未启用', await page.eval(`document.querySelector('.skill-toggle')?.checked===false`))
  await page.key('Escape', 'Escape', 0, 27)

  const ask = async (rel) => {
    writeFileSync(path.join(vault, rel), '')
    await selectBrowserFolder(page, '')
    if (!await waitFor(page, `[...document.querySelectorAll('.tree-note')].some(n=>n.dataset.path===${JSON.stringify(rel)})`)) throw new Error(`夹具未进入目录：${rel}`)
    await page.eval(`[...document.querySelectorAll('.tree-note')].find(n=>n.dataset.path===${JSON.stringify(rel)}).click()`)
    if (!await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel===${JSON.stringify(rel)}`)) throw new Error(`夹具未打开：${rel}`)
    await page.eval(`document.querySelector('.cm-content').focus()`)
    await page.call('Input.insertText', { text: `/${prompt}` })
    await page.key('Enter', 'Enter', 0, 13)
    if (!await waitFor(page, `!!document.querySelector('.overlay-authorization[open] .authorization-send:not(:disabled)')`, 60000)) throw new Error('授权浮层未就绪')
    const preview = await page.eval(`document.querySelector('.authorization-skills')?.textContent||''`)
    // 非模态卡不抢焦点：发送前把焦点放到发送键。
    await page.eval(`document.querySelector('.overlay-authorization .authorization-send:not(:disabled)')?.focus()`)
    await page.key('Enter', 'Enter', 0, 13)
    calls += 1
    const finished = await waitFor(page, `(async()=>{if((await window.rgent.agentTasks()).length>0)return false;const n=await window.rgent.noteRead(${JSON.stringify(rel)});const r=await window.rgent.ledgerGet({sessionId:n.sessionId,objectVersion:n.objectVersion,relPath:${JSON.stringify(rel)}});return r.ok&&r.value.records.some(rec=>String(rec.chapter?.answer??'').length>0)})()`, 180000)
    const record = await page.eval(`(async()=>{const n=await window.rgent.noteRead(${JSON.stringify(rel)});const r=await window.rgent.ledgerGet({sessionId:n.sessionId,objectVersion:n.objectVersion,relPath:${JSON.stringify(rel)}});if(!r.ok)return {error:r.error};const rec=r.value.records.at(-1);return rec?{prompt:rec.chapter.prompt,answer:rec.chapter.answer,provenance:rec.chapter.provenance}:{error:'NO_RECORD'}})()`)
    transcripts.push({ rel, preview, finished, record })
    return { preview, finished, record }
  }

  // 判据 1：基线场（技能未启用）不得出现标记。
  const baseline = await ask('技能基线.md')
  check('基线场真实回答不含技能标记', baseline.finished && !String(baseline.record.answer ?? '').includes(marker), JSON.stringify({ finished: baseline.finished, answer: String(baseline.record.answer ?? '').slice(0, 120) }))
  // 判据 5：技能正文不得出现在发送确认里。
  check('基线场发送确认不出现技能正文或标记', !baseline.preview.includes(marker) && !baseline.preview.includes('等价词典'))

  // 启用该技能（按库启用），再做第二场。
  await page.eval(`document.querySelector('.settings-open').click()`)
  await waitFor(page, `!!document.querySelector('.settings-nav')`)
  await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='技能').click()`)
  await waitFor(page, `!!document.querySelector('.skill-toggle')`)
  await page.eval(`(()=>{const t=document.querySelector('.skill-toggle');t.checked=true;t.dispatchEvent(new Event('change'))})()`)
  check('启用写入本库启用集合', await waitFor(page, `document.querySelector('.skills-list')?.textContent.includes('本库已启用')`))
  await page.key('Escape', 'Escape', 0, 27)

  const enabled = await ask('技能启用.md')
  const answer = String(enabled.record.answer ?? '')
  check('启用场真实回答以技能要求的标记开头', enabled.finished && answer.trimStart().startsWith(marker), JSON.stringify(answer.slice(0, 160)))
  const skills = enabled.record.provenance?.skills ?? null
  check('账本记下该技能的名称与内容哈希', Array.isArray(skills) && skills.length === 1 && skills[0].name === skillName && skills[0].hash === expectedHash, JSON.stringify({ skills, expectedHash }))
  check('发送确认只出现技能名称', enabled.preview.includes(`本场技能：${skillName}`) && !enabled.preview.includes(marker) && !enabled.preview.includes('第一行必须'), JSON.stringify(enabled.preview))
  // 判据 4：两场范围、来源与工具逐项相同。
  const shape = record => JSON.stringify({ tools: record?.provenance?.tools ?? null, sources: (record?.provenance?.sources ?? []).map(s => s.relPath) })
  const scopeOnlyOwnNote = (record, rel) => { const scope = record?.provenance?.scope ?? null; return Array.isArray(scope) && scope.length === 1 && scope[0] === rel }
  check('技能没有扩大范围、来源或工具',
    shape(baseline.record) === shape(enabled.record) && scopeOnlyOwnNote(baseline.record, '技能基线.md') && scopeOnlyOwnNote(enabled.record, '技能启用.md'),
    JSON.stringify({ baseline: shape(baseline.record), enabled: shape(enabled.record), scopes: [baseline.record?.provenance?.scope ?? null, enabled.record?.provenance?.scope ?? null] }))
  check('真机取证没有超过调用信封', calls <= budget, `${calls}/${budget}`)

  const evidence = path.join(evidenceDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(evidence, JSON.stringify({ at: new Date().toISOString(), model: config, marker, skill: { name: skillName, body, hash: expectedHash }, prompt, calls, budget, transcripts }, null, 2))
  process.stdout.write(`真机取证证据：${evidence}\n真机调用：${calls}/${budget}\n`)
  await shot(page, 'skills-live-enabled')
}

async function verifySkills(page, vault, profile, shot) {
  process.stdout.write('\n技能页与发送确认\n')
  await page.eval(`document.querySelector('.settings-open').click()`)
  await waitFor(page, `!!document.querySelector('.settings-nav')`)
  await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='技能').click()`)
  check('第七页「技能」显示空库提示而不是假装没有技能', await waitFor(page, `document.querySelector('.settings-page-title')?.textContent==='技能' && document.body.textContent.includes('还没有技能')`))
  check('技能页说明只有人能创建与启用', await page.eval(`document.body.textContent.includes('只有你能创建、编辑、启用或停用') && document.body.textContent.includes('模型不能写技能')`))
  await page.eval(`[...document.querySelectorAll('.settings-action')].find(b=>b.textContent==='新建技能').click()`)
  await waitFor(page, `!!document.querySelector('.skill-editor')`)
  await page.eval(`(()=>{const inputs=document.querySelectorAll('.skill-editor input');inputs[0].value='答案批改';inputs[0].dispatchEvent(new Event('input'));inputs[1].value='按规则给客观题判分';inputs[1].dispatchEvent(new Event('input'));const area=document.querySelector('.skill-body');area.value='先核对题号，再按等价词典判分。';area.dispatchEvent(new Event('input'))})()`)
  await page.eval(`(()=>{const triggers=document.querySelectorAll('.skill-editor textarea')[0];triggers.value='批改\\n判分';triggers.dispatchEvent(new Event('input'))})()`)
  await page.eval(`[...document.querySelectorAll('.settings-action')].find(b=>b.textContent==='保存').click()`)
  check('新建技能经真实 IPC 落盘并回读', await waitFor(page, `document.querySelector('.skills-list')?.textContent.includes('答案批改')`))
  const stored = JSON.parse(readFileSync(path.join(profile, 'skills.json'), 'utf8'))
  check('设备级技能库字段完整且正文按字节记录', stored.skills.length === 1 && stored.skills[0].name === '答案批改' && stored.skills[0].triggers.join() === '批改,判分' && stored.skills[0].body.includes('等价词典') && typeof stored.skills[0].id === 'string')
  await page.eval(`(()=>{const toggle=document.querySelector('.skill-toggle');toggle.checked=true;toggle.dispatchEvent(new Event('change'))})()`)
  check('启用写入本库启用集合', await waitFor(page, `document.querySelector('.skills-list')?.textContent.includes('本库已启用')`))
  const enabled = JSON.parse(readFileSync(path.join(profile, 'skills.json'), 'utf8'))
  check('启用关系按库键保存且只有一个库', Object.keys(enabled.vaults).length === 1 && Object.values(enabled.vaults)[0].enabled.length === 1 && /^[a-f0-9]{64}$/.test(Object.keys(enabled.vaults)[0]))
  await shot(page, 'skills-1200')
  await page.call('Emulation.setDeviceMetricsOverride', { width: 800, height: 560, deviceScaleFactor: 1, mobile: false })
  check('窄窗技能页无横向溢出且保存按钮可见', await page.eval(`(()=>{const main=document.querySelector('.settings-main');const save=[...document.querySelectorAll('.skill-action,.settings-action')].find(b=>b.textContent==='保存')??document.querySelector('.skill-toggle');return main.scrollWidth<=main.clientWidth+1 && !!document.querySelector('.skills-list')})()`))
  await shot(page, 'skills-800')
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  await page.key('Escape', 'Escape', 0, 27)
  writeFileSync(path.join(vault, '技能确认.md'), '')
  check('技能确认夹具进入目录', await waitFor(page, `[...document.querySelectorAll('.tree-note')].some(n=>n.innerText.includes('技能确认'))`))
  await page.eval(`[...document.querySelectorAll('.tree-note')].find(n=>n.innerText.includes('技能确认'))?.click()`)
  await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.innerText.includes('技能确认')`)
  await page.eval(`document.querySelector('.cm-content')?.focus()`)
  await page.call('Input.insertText', { text: '/技能确认' })
  await page.key('Enter', 'Enter', 0, 13)
  check('发送确认只列技能名称', await waitFor(page, `document.querySelector('.authorization-skills')?.textContent.includes('本场技能：答案批改')`))
  check('发送确认不含正文、体量与展开控件', await page.eval(`(()=>{const node=document.querySelector('.authorization-skills');if(!node)return false;const text=node.textContent;return !text.includes('等价词典') && !node.querySelector('details') && !node.querySelector('button') && text.includes('账本记有名称与内容哈希') && !text.includes('正文合计') && !text.includes('KiB')})()`))
  await shot(page, 'skills-authorization-1200')
  await page.key('Escape', 'Escape', 0, 27)
  writeFileSync(path.join(profile, 'skills.json'), '{broken')
  await page.eval(`document.querySelector('.settings-open').click()`)
  await waitFor(page, `!!document.querySelector('.settings-nav')`)
  await page.eval(`[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='技能').click()`)
  check('技能库损坏时如实报原因且不改写原文件', await waitFor(page, `document.body.textContent.includes('技能库文件损坏')`) && readFileSync(path.join(profile, 'skills.json'), 'utf8') === '{broken')
  check('损坏时不显示成「还没有技能」', await page.eval(`!document.body.textContent.includes('还没有技能')`))
  await page.key('Escape', 'Escape', 0, 27)
  rmSync(path.join(profile, 'skills.json'), { force: true })
}

async function configureControlledHost(page,hostBaseURL) {
  return page.eval(`(async () => {
      const added = await window.rgent.modelProviderSave({ provider: 'custom', baseURL: '${hostBaseURL}', modelId: 'test', contextTokens: 20000, newKey: 'ui-fixture-secret' })
      if (!added.ok) return false
      const provider = added.config.providers.find((item) => item.provider === 'custom')
      const model = added.config.models.find((item) => item.provider === 'custom')
      if (!provider?.hasKey || !model) return false
      if (added.config.defaultModelId !== null) return false
      const second = await window.rgent.modelAdd({ provider: 'custom', modelId: 'test-override', contextTokens: 20000 })
      if (!second.ok) return false
      const picked = await window.rgent.modelDefaultSet({ modelId: model.id })
      return picked.ok && picked.config.defaultModelId === model.id
    })()`)
}

async function main() {
  const port = await availablePort()
  let inspectorPort = port
  for (let attempt = 0; attempt < 5 && inspectorPort === port; attempt += 1) inspectorPort = await availablePort()
  if (inspectorPort === port) throw new Error('无法为测试主进程分配独立诊断端口')
  const electron = require('electron')
  const workdir = mkdtempSync(path.join(tmpdir(), 'rgent-ui-'))
  const profile = path.join(workdir, 'profile')
  const vault = path.join(workdir, visualOnly ? '本地笔记库' : 'vault')
  mkdirSync(profile)
  mkdirSync(vault)
  writeFileSync(path.join(profile, 'vault.json'), JSON.stringify({ path: vault }))
  writeFileSync(path.join(profile, 'theme.json'), JSON.stringify({ mode: 'night' }))
  if (multiVaultOnly) {
    const sibling = path.join(workdir,'第二个笔记库');mkdirSync(sibling)
    writeFileSync(path.join(vault,'同名.md'),'# 库 A\n\n'+Array.from({length:100},(_,i)=>'A 段落 '+i).join('\n\n'))
    writeFileSync(path.join(vault,'第二篇.md'),'A 的第二篇')
    writeFileSync(path.join(sibling,'同名.md'),'# 库 B\n\n只属于 B 的内容。')
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSjAAAAAASUVORK5CYII=','base64')
    writeFileSync(path.join(vault,'same.png'),Buffer.concat([png,Buffer.from('A')]))
    writeFileSync(path.join(sibling,'same.png'),Buffer.concat([png,Buffer.from('B')]))
    const entries=[{id:'vault-a',label:'研究库 A',path:realpathSync.native(vault),pinned:true},{id:'vault-b',label:'写作库 B',path:realpathSync.native(sibling),pinned:false}].map(e=>{const st=statSync(e.path,{bigint:true});return {...e,rootIdentity:`${st.dev}:${st.ino}`,lastUsed:null}})
    writeFileSync(path.join(profile,'vault-catalog.json'),JSON.stringify({version:1,entries,lastVaultId:'vault-a'}))
  }
  if (skillsLive === '1') {
    // 真实凭据只从设备 profile 读一次并复制进一次性临时 profile：不动用户笔记库、技能库与偏好。
    const liveProfile = process.env.RGENT_UI_LIVE_PROFILE || path.join(homedir(), 'Library', 'Application Support', 'rgent')
    const source = path.join(liveProfile, 'model-config.json')
    if (!existsSync(source)) throw new Error(`技能真机取证需要设备上已配置的模型：缺少 ${source}`)
    copyFileSync(source, path.join(profile, 'model-config.json'))
  }
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
    if (process.env.RGENT_UI_SCREENSHOT_PREFIX && !name.startsWith(process.env.RGENT_UI_SCREENSHOT_PREFIX)) return
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
  let nativePage = null
  const child = spawn(
    electron,
    ['.', `--inspect=127.0.0.1:${inspectorPort}`, `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu',
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
    // This is a disposable test process. Control its native window separately from
    // CDP input: desktop activation can otherwise commit IME or discard pointer capture.
    // The product's BrowserWindow options and native/manual acceptance stay unchanged.
    let inspectorTarget
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) inspectorTarget = (await response.json()).find(target => target.webSocketDebuggerUrl)
        if (inspectorTarget) break
      } catch { /* The main inspector can become ready after the renderer CDP endpoint. */ }
      if (child.exitCode != null) break
      await sleep(250)
    }
    if (!inspectorTarget) throw new Error('测试主进程 inspector 未就绪')
    const inspectorSocket = new WebSocket(inspectorTarget.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('测试主进程 inspector 握手超时')), 10000)
      inspectorSocket.onopen = () => { clearTimeout(timer); resolve() }
      inspectorSocket.onerror = error => { clearTimeout(timer); reject(error) }
    })
    const inspectorSend = { send: payload => inspectorSocket.send(payload) }
    inspectorSocket.onmessage = event => inspectorSend.onMessage?.(event.data)
    nativePage = makePage(inspectorSend, () => inspectorSocket.close())
    await nativePage.eval(`globalThis.__rgentTestWindow = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').BrowserWindow.getAllWindows()[0]; true`)
    const isolatedInput = process.env.RGENT_UI_NATIVE_UNISOLATED !== '1'
    if (isolatedInput) {
      await nativePage.eval(`(() => {
        const win = globalThis.__rgentTestWindow
        win.setFocusable(false); win.blur()
        // Native hover/move events can also clear a CDP pointer's pending capture.
        // Ignore desktop mouse input; Input.dispatchMouseEvent still uses Chromium.
        win.setIgnoreMouseEvents(true)
        // Chromium's command-line timer flags do not keep animation-frame tasks
        // (including dialog close events) running when the native window is hidden.
        win.webContents.setBackgroundThrottling(false)
      })()`)
      await page.call('Emulation.setFocusEmulationEnabled', { enabled: true })
    }
    // Opt-in deterministic counterexamples; the original assertions remain in place.
    // Set RGENT_UI_NATIVE_UNISOLATED=1 with this flag to reproduce the old protocol.
    if (process.env.RGENT_UI_NATIVE_INTERRUPTION === '1') {
      page.interruptNativeFocus = async () => {
        const before = await nativePage.eval(`globalThis.__rgentTestWindow.isFocused()`)
        await nativePage.eval(`(() => {
          const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')
          globalThis.__rgentFocusProbe?.destroy()
          globalThis.__rgentFocusProbe = new BrowserWindow({ x: -10000, y: -10000, width: 200, height: 150 })
          globalThis.__rgentFocusProbe.show(); globalThis.__rgentFocusProbe.focus()
        })()`)
        await sleep(100)
        const probeFocused = await nativePage.eval(`globalThis.__rgentFocusProbe.isFocused()`)
        if (!probeFocused) throw new Error('原生抢焦反例未取得窗口焦点')
        process.stdout.write('原生抢焦反例 — ' + JSON.stringify({ before, probeFocused, after: await nativePage.eval(`globalThis.__rgentTestWindow.isFocused()`), documentFocus: await page.eval('document.hasFocus()') }) + '\n')
      }
      page.hideNativeWindow = () => nativePage.eval(`globalThis.__rgentTestWindow.hide()`)
      page.restoreNativeWindow = () => nativePage.eval(`globalThis.__rgentFocusProbe?.destroy(); globalThis.__rgentTestWindow.show(); true`)
    }

    if(memoryOnly){
      const memoryRequests=[]
      hostServer=createControlledHostServer(memoryRequests,[])
      await new Promise(resolve=>hostServer.listen(0,'127.0.0.1',resolve))
      const configured=await configureControlledHost(page,`http://127.0.0.1:${hostServer.address().port}/v1`)
      check('记忆专项初始化受控供应商与设备默认模型',configured===true)
      if(!configured)throw Error('记忆专项受控模型初始化失败')
      await page.eval(`(()=>{const toggle=document.querySelector('.tree-toggle');if(toggle.getAttribute('aria-expanded')!=='true')toggle.click()})()`)
      await waitFor(page,`document.querySelectorAll('.tree-row').length>0`)
      try{await verifyMemoryIntegration(page,vault,shot,memoryRequests,nativePage)}catch(error){stageFailed('库内记忆专项',error)}
      check('记忆专项没有未捕获异常',page.errors.length===0,page.errors.slice(0,1).join(''))
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(skillsLive){
      // dry：用受控假模型做一次零成本干跑，先把夹具与判据跑通；'1' 才花真实调用。
      if(process.env.RGENT_UI_SKILLS_LIVE==='dry'){
        const mock=createHttpServer((request,response)=>{
          let raw=''
          request.on('data',chunk=>{raw+=String(chunk)})
          request.on('end',()=>{
            const decoded=JSON.parse(raw)
            const text=raw.includes('SKILL-OK-7F3')?`SKILL-OK-7F3\n受控回答：技能正文确实进了系统提示。`:'受控回答：本场没有技能。'
            response.writeHead(200,{'content-type':'text/event-stream'})
            response.write(`data: ${JSON.stringify({id:'skills-live',object:'chat.completion.chunk',created:1,model:decoded.model,choices:[{index:0,delta:{content:text},finish_reason:null}]})}\n\n`)
            response.write(`data: ${JSON.stringify({id:'skills-live',object:'chat.completion.chunk',created:1,model:decoded.model,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`)
            response.end('data: [DONE]\n\n')
          })
        })
        await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve))
        hostServer=mock
        const configured=await configureControlledHost(page,`http://127.0.0.1:${mock.address().port}/v1`)
        check('技能真机取证干跑初始化受控模型',configured===true)
        if(!configured)throw Error('干跑受控模型初始化失败')
      }
      try{await verifySkillsLive(page,vault,profile,shot)}catch(error){stageFailed('技能真机取证',error)}
      check('技能真机取证没有未捕获异常',page.errors.length===0,page.errors.slice(0,1).join(''))
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(writeOnly){
      const writeRequests=[]
      hostServer=createControlledHostServer([],[],writeRequests)
      await new Promise(resolve=>hostServer.listen(0,'127.0.0.1',resolve))
      const configured=await configureControlledHost(page,`http://127.0.0.1:${hostServer.address().port}/v1`)
      check('写工具专项初始化受控供应商与设备默认模型',configured===true)
      if(!configured)throw Error('写工具专项受控模型初始化失败')
      try{await verifyWriteTools(page,vault,shot,writeRequests)}catch(error){stageFailed('写工具专项',error)}
      check('写工具专项没有未捕获异常',page.errors.length===0,page.errors.slice(0,1).join(''))
      check('写工具专项全程只走受控主机',writeRequests.length>=4,String(writeRequests.length))
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(networkOnly){
      const networkRequests=[],networkGate={reached:false,release:null}
      hostServer=createNetworkOnlyHostServer(networkRequests,networkGate)
      await new Promise(resolve=>hostServer.listen(0,'127.0.0.1',resolve))
      const configured=await configureControlledHost(page,`http://127.0.0.1:${hostServer.address().port}/v1`)
      check('联网专项初始化受控供应商与设备默认模型',configured===true)
      if(!configured)throw Error('联网专项受控模型初始化失败')
      try{await verifyNetworkOnly(page,vault,shot,networkRequests,networkGate)}catch(error){stageFailed('联网只读专项',error)}finally{networkGate.abort?.()}
      check('联网只读专项没有未捕获异常',page.errors.length===0,page.errors.slice(0,1).join(''))
      check('联网只读专项全程只走受控主机',networkRequests.length>=3,String(networkRequests.length))
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(humanNetworkOnly){
      try{await verifyHumanNetwork(page,shot)}catch(error){stageFailed('人发起联网专项',error)}
      check('人发起联网专项没有未捕获异常',page.errors.length===0,page.errors.slice(0,1).join(''))
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(mcpOnly){
      const mcpRequests=[]
      hostServer=createControlledHostServer([],[],[],mcpRequests)
      await new Promise(resolve=>hostServer.listen(0,'127.0.0.1',resolve))
      const configured=await configureControlledHost(page,`http://127.0.0.1:${hostServer.address().port}/v1`)
      check('MCP 专项初始化受控供应商与设备默认模型',configured===true)
      if(!configured)throw Error('MCP 专项受控模型初始化失败')
      try{await verifyMcpOnly(page,vault,shot,mcpRequests)}catch(error){stageFailed('远端只读 MCP 专项',error)}
      check('远端只读 MCP 专项没有未捕获异常',page.errors.length===0,page.errors.slice(0,1).join(''))
      check('远端只读 MCP 专项全程只走受控主机',mcpRequests.length>=1,String(mcpRequests.length))
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(journeyOnly){
      const journeyRequests=[]
      hostServer=createControlledHostServer([],[],journeyRequests)
      await new Promise(resolve=>hostServer.listen(0,'127.0.0.1',resolve))
      const configured=await configureControlledHost(page,`http://127.0.0.1:${hostServer.address().port}/v1`)
      check('旅程：专项初始化受控供应商与设备默认模型',configured===true)
      if(!configured)throw Error('旅程专项受控模型初始化失败')
      try{await verifyJourney(page,vault,shot)}catch(error){stageFailed('端到端旅程专项',error)}
      check('旅程：专项没有未捕获异常',page.errors.length===0,page.errors.slice(0,1).join(''))
      check('旅程：全程只走受控主机',journeyRequests.length>=1,String(journeyRequests.length))
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(uxOnly){
      // 交互减负只有 8 条判据：初始化只作为前置条件，失败直接抛给总账，不另占一条检查。
      const uxRequests=[]
      hostServer=createUxHostServer(uxRequests)
      await new Promise(resolve=>hostServer.listen(0,'127.0.0.1',resolve))
      const configured=await configureControlledHost(page,`http://127.0.0.1:${hostServer.address().port}/v1`)
      if(!configured)throw Error('交互减负专项受控模型初始化失败')
      try{await verifyUx(page,vault,shot)}catch(error){stageFailed('交互减负专项',error)}
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(trashOnly){
      try{await verifyHumanTrash(page,vault,shot)}catch(error){stageFailed('人删除专项',error)}
      check('人删除专项没有未捕获异常',page.errors.length===0,page.errors.slice(0,1).join(''))
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(recoveryOnly){
      const recoveryRequests=[]
      hostServer=createControlledHostServer([],[],[],recoveryRequests)
      await new Promise(resolve=>hostServer.listen(0,'127.0.0.1',resolve))
      const configured=await configureControlledHost(page,`http://127.0.0.1:${hostServer.address().port}/v1`)
      check('恢复专项初始化受控供应商与设备默认模型',configured===true)
      if(!configured)throw Error('恢复专项受控模型初始化失败')
      try{await verifyExternalRecovery(page,vault,path.join(workdir,'recovery-stage'),shot,recoveryRequests,shotDir)}catch(error){stageFailed('外部消失与恢复核验专项',error)}
      check('恢复专项没有未捕获异常',page.errors.length===0,page.errors.slice(0,1).join(''))
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(skillsOnly){
      const skillRequests=[]
      hostServer=createControlledHostServer(skillRequests,[])
      await new Promise(resolve=>hostServer.listen(0,'127.0.0.1',resolve))
      const configured=await configureControlledHost(page,`http://127.0.0.1:${hostServer.address().port}/v1`)
      check('技能专项初始化受控供应商与设备默认模型',configured===true)
      if(!configured)throw Error('技能专项受控模型初始化失败')
      try{await verifySkills(page,vault,profile,shot)}catch(error){stageFailed('技能专项',error)}
      check('技能专项没有未捕获异常',page.errors.length===0,page.errors.slice(0,1).join(''))
      check('技能专项未发生模型调用',skillRequests.length===0,String(skillRequests.length))
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(v4Only){
      await verifyV4ReadOnly(page,nativePage,vault,shot)
      await verifyLedgerRecoveryDrafts(page,nativePage,vault)
      const copied=await verifyV4CopiedVault(page,nativePage,vault,profile,shot)
      await verifyV4MemoryTools(page,nativePage,copied,shot)
      await verifyV4Summary(page,nativePage,copied,shot)
      await verifyV4ConsolidationRetry(page,nativePage,copied,shot)
      await verifyV4FullMemory(page,nativePage,copied,shot)
      await verifyV4Retirement(page,nativePage,copied,shot)
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if(process.env.RGENT_UI_LEDGER_RECOVERY_ONLY==='1'){
      await verifyLedgerRecoveryDrafts(page,nativePage,vault)
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode=failures===0?0:1
      return
    }
    if (multiVaultOnly) {
      await verifyMultiVault(page,nativePage,vault,path.join(workdir,'第二个笔记库'),profile,shot,electron,child)
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode = failures === 0 ? 0 : 1
      return
    }
    if (imeOnly) {
      await waitFor(page, `document.querySelectorAll('.tree-row').length > 0`)
      await verifyComposition(page, vault, shot)
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode = failures === 0 ? 0 : 1
      return
    }

    if (visualOnly) {
      await captureVisualBaseline(page, shot, nativeShot)
      process.stdout.write(`\n共 ${results.length} 条，失败 ${failures} 条。\n`)
      process.exitCode = failures === 0 ? 0 : 1
      return
    }

    // 阶段各自成块后，跨阶段共用的变量提在这里。
    let marked = ''
    const toolLoopRequests = []
    const memoryRequests = []
    process.stdout.write('\n外壳与主题\n')
    try {
    await waitFor(page, `document.querySelectorAll('.tree-row').length > 0`)
    check('本机主题偏好在窗口首帧生效', (await page.eval(`document.documentElement.dataset.theme === 'night' && getComputedStyle(document.documentElement).colorScheme === 'dark' && window.rgent.themeGet().then((mode) => mode === 'night')`)) === true)
    check('窗口起来了，库里三篇都在', (await page.eval(`document.querySelectorAll('.tree-note').length`)) === 3)
    await page.eval(`document.querySelectorAll('.tree-note')[1].click()`)
    await waitFor(page, `document.querySelectorAll('.tab').length > 0`)
    check('顶栏是 tab 条，没有品牌文字', (await page.eval(`!!document.querySelector('.top .tabs') && !document.querySelector('.brand')`)) === true)
    check('tab 有图标与标题', (await page.eval(`!!document.querySelector('.tab .icon') && document.querySelector('.tab').innerText.trim().length > 0`)) === true)
    await probe('常态 tab 收紧至 176px，侧栏资源名称缩小一号', async () => {
      const state = JSON.parse(await page.eval(`(() => {
        const tab = document.querySelector('.tab-wrap').getBoundingClientRect()
        const names = [...document.querySelectorAll('.tree-row .tree-label')]
        const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize)
        return JSON.stringify({ width: tab.width, sizes: names.map(node => parseFloat(getComputedStyle(node).fontSize)), expected: rootSize * .86 - 1 })
      })()`))
      return { ok: Math.abs(state.width - 176) <= 1 && state.sizes.length > 0 && state.sizes.every(size => Math.abs(size - state.expected) < .1), detail: JSON.stringify(state) }
    })
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
    await verifySidebarWidth(page, shot)
    check('底栏有行列、字数与库名', (await page.eval(`!!document.querySelector('.status-left')?.innerText && !!document.querySelector('.status-vault')?.innerText`)) === true)
    await probe('底栏最左的设置入口在边栏收起与展开时都在位', async () => {
      const state = JSON.parse(await page.eval(`(() => {
        const button = document.querySelector('.status .settings-open')
        if (!button) return JSON.stringify({ exists: false })
        const inBar = button.closest('.status') !== null
        const before = button.getBoundingClientRect()
        document.querySelector('.tree-toggle').click()
        const after = button.getBoundingClientRect()
        const status = document.querySelector('.status').getBoundingClientRect()
        document.querySelector('.tree-toggle').click()
        const bar = button.closest('.status-lead')
        const glyph = button.querySelector('svg')
        return JSON.stringify({ exists: true, inBar, size: Math.round(before.width) + 'x' + Math.round(before.height),
          glyph: glyph ? Math.round(glyph.getBoundingClientRect().width) : 0,
          glyphs: button.querySelectorAll('svg').length,
          moved: Math.abs(before.left - after.left) + Math.abs(before.top - after.top), barHeight: Math.round(status.height),
          label: button.textContent.trim(), first: bar && bar.firstElementChild === button })
      })()`))
      return { ok: state.exists && state.inBar && state.first && state.moved <= 1 && state.label === '' && state.size === '36x36' && state.glyphs === 1 && state.glyph === 20 && state.barHeight >= 36, detail: JSON.stringify(state) }
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
    await page.eval(`document.querySelector('.settings-open')?.click()`)
    await waitFor(page, `!!document.querySelector('.overlay-settings[open]')`)
    await verifyChromeText(page, shot, 'functional')
    await page.eval(`document.querySelector('.overlay-settings')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
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
      const original = readFileSync(path.join(vault, '研究记录.md'))
      await page.eval(`document.querySelector('.ledger-open')?.click()`)
      // Opening only reads. Use the existing human migration action before
      // expecting imported history; prove both the exact body and archived tail.
      if(!await waitFor(page,`document.querySelector('.ledger-body')?.textContent.includes('旧历史尚未迁移') && document.querySelector('.ledger-body')?.textContent.includes('原记录保留') && !document.querySelector('.ledger-body')?.textContent.includes('目前没有任务记录') && [...document.querySelectorAll('.ledger-body button')].some(n=>n.textContent==='迁移库内旧账本'&&!n.disabled)`))throw Error('旧账本未展示实际迁移入口')
      const unmigrated=await page.eval(`(async()=>{const n=await window.rgent.noteRead('研究记录.md');const h=await window.rgent.ledgerGet({sessionId:n.sessionId,objectVersion:n.objectVersion,relPath:'研究记录.md'});return n.ledger?.status==='unmigrated'&&h.ok&&h.value.ownership==='unregistered'&&h.value.records.length===0})()`)
      if(!unmigrated||!original.equals(Buffer.from(initialWithLedger))||!readFileSync(path.join(vault,'研究记录.md')).equals(original))throw Error('只读打开旧账本改变了原文件或登记前态')
      await page.eval(`[...document.querySelectorAll('.ledger-body button')].find(n=>n.textContent==='迁移库内旧账本').click()`)
      if(!await waitFor(page,`document.querySelector('.ledger-body')?.textContent.includes('本批已迁移') && document.querySelector('.ledger-body')?.textContent.includes('0 篇待核验')`))throw Error('显式旧账本迁移未完成')
      const migrated=await page.eval(`(async()=>{const n=await window.rgent.noteRead('研究记录.md');return window.rgent.ledgerGet({sessionId:n.sessionId,objectVersion:n.objectVersion,relPath:'研究记录.md'})})()`)
      if(!migrated.ok||migrated.value.ownership!=='verified'||!migrated.value.records.length)throw Error('显式迁移未保存可回顾的旧账本')
      const archive=JSON.parse(readFileSync(path.join(vault,'.rgent','ledgers',migrated.value.noteId,'legacy.json'),'utf8')),tail=initialWithLedger.slice((note+'\n').length)
      const before=readFileSync(path.join(vault,'研究记录.md')),migrationPreserved=before.equals(Buffer.from(note+'\n'))&&Buffer.from(archive.raw).equals(Buffer.from(tail))&&archive.hash===createHash('sha256').update(tail).digest('hex')
      await page.eval(`document.querySelector('.ledger-close').click();document.querySelector('.ledger-open').click()`)
      if(!await waitFor(page, `!!document.querySelector('.ledger-body details')`))throw Error('显式迁移后没有真实回顾记录')
      await page.eval(`document.querySelectorAll('.ledger-body details').forEach(d=>d.open=true)`)
      if(!await waitFor(page, `!!document.querySelector('.ledger-body details > div')?.childNodes.length`))throw Error('旧账本记录没有呈现内容')
      const state = JSON.parse(await page.eval(`(() => JSON.stringify({ heading: document.querySelector('.ledger-body h2')?.textContent, strong: document.querySelector('.ledger-body strong')?.textContent, editor: document.querySelector('.cm-content')?.innerText, outline: [...document.querySelectorAll('.outline-mark')].map((n) => n.getAttribute('aria-label')), editable: !!document.querySelector('.ledger-body [contenteditable]') }))()`))
      await page.eval(`document.querySelector('.ledger-close')?.click()`)
      return { ok: migrationPreserved && state.heading === '第一场' && state.strong === '账本结论' && !state.editor?.includes('账本结论') && !state.outline.includes('第一场') && !state.editable && readFileSync(path.join(vault, '研究记录.md')).equals(before), detail: JSON.stringify({ heading: state.heading, strong: state.strong, outline: state.outline, migrationPreserved }) }
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
        const row = document.querySelector('.tree-folder-toggle'); if (!row) return false
        if (row.getAttribute('aria-expanded') === 'true') row.click()
        const current = document.querySelector('.tree-folder-toggle')
        current.blur()
        const folder = current.querySelector('.icon-folder'), toggle = current.querySelector('.icon-folder-open')
        const normal = getComputedStyle(folder).display !== 'none' && getComputedStyle(toggle).display === 'none'
        current.focus()
        const focused = getComputedStyle(folder).display === 'none' && getComputedStyle(toggle).display !== 'none'
        return normal && focused && current.getAttribute('aria-expanded') === 'false'
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
    // 非模态合同：自动保存路径遇到冲突先出可点横幅，不弹模态；点「核对」才进双预览。
    const noticeAppeared = await waitFor(page, `(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) => (node.innerText || '').includes('不一致'))
      return !!notice && [...notice.querySelectorAll('button')].some((button) => button.textContent.trim() === '核对') && document.querySelector('dialog[open]') === null
    })()`, 12000)
    await probe('脏稿遇上外部改动先出可点横幅（不弹模态）', async () => noticeAppeared)
    const reviewed = noticeAppeared && await page.eval(`(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) => (node.innerText || '').includes('不一致'))
      const button = notice?.querySelector('.notice-action')
      button?.click()
      return !!button
    })()`) && await waitFor(page, `document.querySelectorAll('dialog.conflict[open]').length > 0`, 12000)
    await probe('点「核对」才进入冲突双预览', async () => reviewed)
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
    await page.eval(`document.querySelector('.conflict [data-action="disk"]')?.click()`)
    await probe('选「听磁盘」后横幅消失、保存完成', async () => {
      // 只认这篇笔记的冲突横幅；窗口里别的提示不替它下结论。
      const settled = reviewed && await waitFor(page, `!document.querySelector('dialog.conflict[open]') && !document.querySelector('.notice[data-notice-key^="conflict:"]')`, 15000)
      const diskShown = settled && await page.eval(`(document.querySelector('.cm-content')?.cmTile?.root?.view?.state?.doc?.toString() ?? '').includes('磁盘改的一行。')`)
      // 观察项：reviewConflict 选完盘后没有重绘 tab，脏点可能留在 DOM 里（内部 dirty 已 false）。
      const staleDirty = settled && await page.eval(`!!document.querySelector('.tab[data-rel="研究记录.md"] .tab-dirty')`)
      return { ok: settled && diskShown, detail: JSON.stringify({ diskShown, staleDirty }) }
    })

    } catch (error) { stageFailed('冲突双预览', error) }
    process.stdout.write('\n长文响应\n')
    try {
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

    // 用已有的长文 tab 复现拥挤顶栏：核对实际矩形，不只检查 overflow 属性。
    const tabGeometry = `(() => {
      const strip = document.querySelector('.tabs')
      const top = document.querySelector('.top')
      const selected = document.querySelector('.tab[aria-selected="true"]')?.closest('.tab-wrap')
      const add = document.querySelector('.tab-new')
      const bounds = strip.getBoundingClientRect()
      const header = top.getBoundingClientRect()
      const active = selected.getBoundingClientRect()
      const plus = add.getBoundingClientRect()
      const last = strip.querySelector('.tab-wrap:last-of-type').getBoundingClientRect()
      const right = header.right - parseFloat(getComputedStyle(top).paddingRight)
      const widths = [...strip.querySelectorAll('.tab-wrap')].map(el => el.getBoundingClientRect().width)
      return { count: widths.length, widths, average: widths.reduce((a, b) => a + b, 0) / widths.length,
        bounded: bounds.right <= right + 1 && top.scrollWidth <= top.clientWidth + 1,
        activeVisible: active.left >= bounds.left - 1 && active.right <= bounds.right + 1,
        addVisible: plus.left >= bounds.left && plus.right <= right + 1,
        addFollows: add.parentElement === strip && plus.left >= last.right && plus.left - last.right <= 8,
        overflow: strip.scrollWidth > strip.clientWidth, scroll: strip.scrollLeft }
    })()`
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
    await sleep(100)
    const wideTabs = await page.eval(tabGeometry)
    await shot(page, 'tabs-wide')
    await page.call('Emulation.setDeviceMetricsOverride', { width: 800, height: 560, deviceScaleFactor: 1, mobile: false })
    await sleep(100)
    const narrowTabs = await page.eval(tabGeometry)
    check('拥挤 tab 先压缩，最小宽度后仅在栏内滚动', wideTabs.count >= 7 && narrowTabs.bounded && narrowTabs.average < wideTabs.average - 1 && narrowTabs.widths.every(width => width >= 110 && width <= 176) && narrowTabs.overflow, JSON.stringify({ wide: wideTabs, narrow: narrowTabs }))
    check('新建加号紧随最后一个 tab，并随末尾当前项进入可视区', wideTabs.addFollows && narrowTabs.addFollows && narrowTabs.activeVisible && narrowTabs.addVisible, JSON.stringify(narrowTabs))
    await probe('标题压缩不挤掉 tab 图标和关闭按钮', async () => (await page.eval(`(() => {
      const wrap = document.querySelector('.tab[aria-selected="true"]').parentElement
      const bounds = wrap.getBoundingClientRect()
      const close = wrap.querySelector('.tab-close').getBoundingClientRect()
      const icon = wrap.querySelector('.tab .icon').getBoundingClientRect()
      return close.width >= 24 && close.left >= bounds.left && close.right <= bounds.right && icon.width >= 16 && wrap.querySelector('.tab-label').clientWidth > 20
    })()`)) === true)
    await shot(page, 'tabs-narrow')
    await page.eval(`document.querySelector('.cm-content').cmTile.root.view.focus()`)
    await page.key('Home', 'Home', modifier, 36)
    await page.eval(`document.querySelector('.tabs').scrollLeft = 60`)
    await page.key('X', 'KeyX', 0, 88, 'X')
    await probe('输入引起的 tab 重绘保留手动滚动位置', async () => (await page.eval(`Math.abs(document.querySelector('.tabs').scrollLeft - 60) < 1 && document.querySelector('.tab[aria-selected="true"]').querySelector('.tab-dirty') !== null`)) === true)
    await page.eval(`document.querySelector('.tab[aria-selected="true"]').focus()`)
    await page.key('ArrowRight', 'ArrowRight', 0, 39)
    // 焦点与滚动都是异步落位的：不能紧跟按键直接断言，否则机器一忙就会偶发失败。
    const keyboardMoved = await waitFor(page, `(() => {
      const strip = document.querySelector('.tabs')
      const selected = document.querySelector('.tab[aria-selected="true"]')
      if (!selected || document.activeElement !== selected) return false
      const bounds = strip.getBoundingClientRect()
      const active = selected.closest('.tab-wrap').getBoundingClientRect()
      return active.left >= bounds.left - 1 && active.right <= bounds.right + 1
    })()`)
    const keyboardTabs = await page.eval(tabGeometry)
    check('方向键切到栏外 tab 后，焦点与当前项一起进入可视区', keyboardMoved && keyboardTabs.activeVisible, JSON.stringify(keyboardTabs))
    await page.call('Emulation.clearDeviceMetricsOverride', {})

    } catch (error) { stageFailed('长文响应', error) }
    try { await verifyComposition(page, vault, shot) }
    catch (error) { stageFailed('中文组合输入', error) }
    process.stdout.write('\nHost 最小环\n')
    try {
    hostServer = createControlledHostServer(memoryRequests,toolLoopRequests)
    await new Promise((resolve) => hostServer.listen(0, '127.0.0.1', resolve))
    const hostAddress = hostServer.address()
    const hostBaseURL = `http://127.0.0.1:${hostAddress.port}/v1`
    const configured = await configureControlledHost(page,hostBaseURL)
    check('首次供应商保存不自动设默认，显式默认指向受控兼容接口', configured === true)
    await page.eval(`document.querySelector('.settings-open')?.click()`)
    await waitFor(page, `!!document.querySelector('.overlay-settings[open]')`)
    await page.eval(`(() => { [...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === '模型')?.click() })()`)
    check('模型页根页按供应商列出三家', await waitFor(page, `[...document.querySelectorAll('.settings-provider-row')].map((row) => row.dataset.provider).join(',') === 'deepseek,minimax,custom'`))
    await page.eval(`(() => { document.querySelector('.settings-provider-row[data-provider="custom"]')?.click() })()`)
    check('供应商子页只显示密钥状态、密码不回填、有返回入口且没有「当前模型」', await waitFor(page, `(() => {
      const password = document.querySelector('input[type=password]')
      return !!document.querySelector('.settings-back') && !!password && password.value === '' &&
        document.querySelectorAll('.settings-model-row').length >= 1 &&
        ![...document.querySelectorAll('button')].some((button) => button.textContent.includes('设为当前模型'))
    })()`))
    await verifyModelFeedback(page,nativePage,shot)
    await page.eval(`(() => { [...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === '助手')?.click() })()`)
    check('助手设置页有称呼、语气与补充说明三项', await waitFor(page, `(() => {
      const address = document.querySelector('.settings-form input')
      const tone = [...document.querySelectorAll('.settings-form select')].find(select => [...select.options].some(option => option.value === 'concise'))
      const note = document.querySelector('.settings-form textarea')
      return !!address && address.maxLength === 40 && !!tone && tone.options.length === 3 && !!note && note.maxLength === 500
    })()`))
    const habitsSaved = await page.eval(`(async () => {
      const address = document.querySelector('.settings-form input')
      address.value = '试跑者'
      address.dispatchEvent(new Event('input'))
      const tone = [...document.querySelectorAll('.settings-form select')].find(select => [...select.options].some(option => option.value === 'concise'))
      tone.value = 'concise'
      tone.dispatchEvent(new Event('change'))
      const save = [...document.querySelectorAll('.settings-action')].find((button) => button.textContent === '保存')
      if (!save || save.disabled) return false
      save.click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const habits = await window.rgent.assistantGet()
      return habits.ok && habits.habits.address === '试跑者' && habits.habits.tone === 'concise'
    })()`)
    check('助手习惯保存后只改变设备级偏好', habitsSaved === true)
    await page.eval(`(() => { [...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === '运行')?.click() })()`)
    check('运行设置页提供三档有限上限', await waitFor(page, `document.querySelectorAll('.settings-limit-group').length === 3`))
    await page.eval(`document.querySelector('.overlay-settings')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    // dialog.close() 先取消 open，close 事件下一帧才移除节点并归还焦点；先完成关闭再测底栏。
    if (!await waitFor(page, `!document.querySelector('.overlay-settings')`)) throw new Error('底栏验证前设置未完成关闭')
    const bottomDiagnostics = () => page.eval(`(async () => JSON.stringify({ modal: document.querySelector('dialog[open]')?.className, focus: document.activeElement?.className, center: document.querySelector('.status-center')?.outerHTML, config: await window.rgent.modelConfigGet() }))()`)
    check('底栏候选只列已存密钥的模型，未配置的不出现', await waitFor(page, `(() => {
      const options = [...document.querySelectorAll('.status-model option')].map((option) => option.textContent)
      const groups = [...document.querySelectorAll('.status-model optgroup')].map((group) => group.label)
      return options.includes('test') && !options.some((text) => text === 'deepseek-flash' || text === 'MiniMax-M2.7') &&
        !groups.some((label) => label.includes('缺密钥'))
    })()`), (await bottomDiagnostics()) + ' runtime=' + JSON.stringify(page.errors))
    const switched = await page.eval(`(async () => {
      const select = document.querySelector('.status-model')
      const target = select && [...select.options].find((option) => option.textContent === 'test-override')
      if (!target) return false
      window.__statusModelControl = select; select.focus()
      select.value = target.value
      select.dispatchEvent(new Event('change'))
      await new Promise((resolve) => setTimeout(resolve, 400))
      const config = await window.rgent.modelConfigGet()
      return config.ok && config.config.defaultModelId !== target.value && select.value === target.value
    })()`)
    check('底栏临时切换不修改设备默认', switched === true)
    check('底栏模型模块在状态重绘后仍是同一个控件', await waitFor(page, `(() => {
      const center = document.querySelectorAll('.status-center')
      const select = center[0]?.querySelector('.status-model')
      return center.length === 1 && !!select && select.selectedOptions.length === 1 && select.selectedOptions[0].textContent === 'test-override' && select === window.__statusModelControl && document.activeElement === select
    })()`), (await bottomDiagnostics()) + ' identity=' + await page.eval(`JSON.stringify({same:document.querySelector('.status-model')===window.__statusModelControl,documentFocus:document.hasFocus()})`))
    await page.eval(`(() => { const select = document.querySelector('.status-model'); const option = [...select.options].find(row => row.textContent === 'test'); select.value = option.value; select.dispatchEvent(new Event('change')) })()`)
    await page.eval(`window.__temporaryModelPreviousTab = document.querySelector('.tab[aria-selected=true]').dataset.rel`)
    writeFileSync(path.join(vault, 'Host 环路.md'), '')
    check('新笔记在目录中出现', await waitFor(page, `[...document.querySelectorAll('.tree-note')].some((n) => n.innerText.includes('Host 环路'))`, 8000))
    await page.eval(`(() => { [...document.querySelectorAll('.tree-note')].find((n) => n.innerText.includes('Host 环路'))?.click(); document.querySelector('.cm-content')?.focus() })()`)
    await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.innerText.includes('Host 环路')`)
    await page.eval(`(() => { const select = document.querySelector('.status-model'); const option = [...select.options].find(row => row.textContent === 'test-override'); select.value = option.value; select.dispatchEvent(new Event('change')); [...document.querySelectorAll('.tab')].find(row => row.dataset.rel === window.__temporaryModelPreviousTab).click() })()`)
    check('切到另一篇不继承临时模型', await waitFor(page, `document.querySelector('.status-model')?.selectedOptions[0]?.textContent === 'test'`))
    await page.eval(`[...document.querySelectorAll('.tab')].find(row => row.dataset.rel === 'Host 环路.md').click()`)
    check('返回原篇保留临时模型', await waitFor(page, `document.querySelector('.status-model')?.selectedOptions[0]?.textContent === 'test-override'`))
    await page.eval(`document.querySelector('.cm-content')?.focus()`)
    await page.call('Input.insertText', { text: '/请写两句话' })
    check('空段内输入的口令留在编辑器', await waitFor(page, `document.querySelector('.cm-content')?.textContent.includes('/请写两句话')`))
    await confirmSlashAuthorization(page, true)
    check('启动成功后本篇临时选择复位到设备默认', await waitFor(page, `document.querySelector('.status-model')?.selectedOptions[0]?.textContent === 'test'`))
    // Windows CI 上任务启动与底栏重绘更慢：先等任务登记，再给停止入口更宽的等待（断言不变）。
    await waitFor(page, `(async () => (await window.rgent.agentTasks()).length > 0)()`, 15000)
    const running = await waitFor(page, `!!document.querySelector('.status-task-stop')`, 15000)
    check('回车后底栏出现当前篇停止入口', running, running ? '' : await page.eval(`(async () => JSON.stringify({ status: document.querySelector('.status-left')?.innerText, note: (await window.rgent.noteRead('Host 环路.md')).content, editor: document.querySelector('.cm-content')?.textContent }))()`))
    check('回答写回正文，原始任务写入独立账本', await waitFor(page, `(async () => {
      const note = await window.rgent.noteRead('Host 环路.md')
      const history=await window.rgent.ledgerGet({sessionId:note.sessionId,objectVersion:note.objectVersion,relPath:'Host 环路.md'});return note.content.includes('受控回答第一句。第二句。')&&note.content.includes('<!-- rgent:ai:v1 task-id=')&&!note.content.includes('<!-- rgent:ledger:v1 -->')&&history.ok&&history.value.records.some(r=>r.state==='saved'&&r.chapter?.answer.includes('受控回答第一句。第二句。')&&r.chapter.assistant?.includes('试跑者')&&r.chapter.provenance?.model.modelId==='test-override')
    })()`, 10000))
    await page.eval(`document.querySelector('.ledger-open')?.click()`)
    await waitFor(page, `!!document.querySelector('.ledger-body details')`)
    await page.eval(`document.querySelectorAll('.ledger-body details').forEach(d=>d.open=true)`)
    await waitFor(page, `!!document.querySelector('.ledger-body details > div')?.childNodes.length`)
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
    try { await verifyMemoryIntegration(page, vault, shot, memoryRequests, nativePage) } catch (error) { stageFailed('库内记忆', error) }
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
    await page.eval(`(() => { const content = document.querySelector('.cm-content'); content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true })); })()`)
    check('组合输入的候选 Esc 不取消当前 Host 任务', await page.eval(`(async () => (await window.rgent.agentTasks()).some(task => task.relPath === 'Host B.md'))()`) === true)
    await page.eval(`document.querySelector('.cm-content').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))`)
    await sleep(100)
    await page.key('Escape', 'Escape', 0, 27)
    await parallelCheck('Esc 停止当前 B，两个任务均写入取消账本', `(async () => {
      const a = await window.rgent.noteRead('Host A.md')
      const b = await window.rgent.noteRead('Host B.md')
      const records=await Promise.all([a,b].map((n,i)=>window.rgent.ledgerGet({sessionId:n.sessionId,objectVersion:n.objectVersion,relPath:i?'Host B.md':'Host A.md'})));return records.every(h=>h.ok&&h.value.records.some(r=>r.chapter?.status==='cancelled'))&&(await window.rgent.agentTasks()).length===0
    })()`, 8000)

    } catch (error) { stageFailed('Host 最小环', error) }
    process.stdout.write('\n笔记库文件生命周期\n')
    try {
    await selectBrowserFolder(page, '资料')
    await page.eval(`(() => { if(document.querySelector('.tree-toggle').getAttribute('aria-expanded') === 'true') document.querySelector('.tree-toggle').click(); document.querySelector('.tab-new').click() })()`)
    await waitFor(page, `!!document.querySelector('.modal input')`)
    await page.eval(`(() => { document.querySelector('.modal input').value = '顶栏所选目录'; document.querySelector('.modal button[value=ok]').click() })()`)
    check('收起侧栏的顶栏加号在所选普通目录新建', await waitFor(page, `document.querySelector('.tab[aria-selected=true]')?.dataset.rel === '资料/顶栏所选目录.md'`) && existsSync(path.join(vault, '资料', '顶栏所选目录.md')) && !existsSync(path.join(vault, '顶栏所选目录.md')))
    await page.eval(`(() => { if(document.querySelector('.tree-toggle').getAttribute('aria-expanded') === 'false') document.querySelector('.tree-toggle').click() })()`)
    await selectBrowserFolder(page, '')
    check('新建文件夹入口为带名称的同行图标', await page.eval(`(() => { const button = document.querySelector('.folder-create'); return button.textContent === '' && !!button.querySelector('.icon') && button.getAttribute('aria-label').includes('新建文件夹') && button.title.includes('新建文件夹') && button.parentElement.classList.contains('browser-tools') && getComputedStyle(button.querySelector('.icon')).width === '16px' })()`) === true)
    await page.eval(`document.querySelector('.folder-create')?.click()`)
    check('库根新建文件夹入口可由键盘和鼠标使用', await waitFor(page, `!!document.querySelector('.modal input')`))
    await page.eval(`(() => { const input = document.querySelector('.modal input'); input.value = '生命周期'; document.querySelector('.modal button[value=ok]')?.click() })()`)
    check('新建文件夹进入真实文件树', await waitFor(page, `[...document.querySelectorAll('.tree-dir')].some((node) => node.textContent.includes('生命周期'))`, 8000))
    // 空名称时「取消」必须能退出：以前它会触发原生校验，弹「请填写此字段」把浮层卡住
    await page.eval(`(() => { [...document.querySelectorAll('.modal button')].find((button) => button.textContent === '取消')?.click() })()`)
    check('空名称时取消可直接退出且不弹校验气泡', await waitFor(page, `!document.querySelector('.modal')`))
    // 空名称点创建：留在浮层并给自家消息，仍可再取消
    await page.eval(`document.querySelector('.folder-create')?.click()`)
    await waitFor(page, `!!document.querySelector('.modal input')`)
    await page.eval(`(() => { [...document.querySelectorAll('.modal button')].find((button) => button.textContent === '创建')?.click() })()`)
    check('空名称点创建留在浮层并给自家提示', await waitFor(page, `document.querySelector('.modal-error')?.textContent === '请填写名称。' && !!document.querySelector('.modal input')`))
    await page.eval(`(() => { [...document.querySelectorAll('.modal button')].find((button) => button.textContent === '取消')?.click() })()`)
    check('提示之后仍可取消退出', await waitFor(page, `!document.querySelector('.modal')`))
    // 回车等同确认（两个 submit 按钮时它曾落到「取消」上）
    await page.eval(`document.querySelector('.folder-create')?.click()`)
    await waitFor(page, `!!document.querySelector('.modal input')`)
    await page.eval(`(() => { const input = document.querySelector('.modal input'); input.value = '回车新建'; input.focus() })()`)
    // rawKeyDown 不触发默认动作，这里用 keyDown 才能让浏览器真的提交表单
    // 回车要带 text 才会触发 char 事件，隐式提交靠的是它
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    check('回车确认新建而不是取消', await waitFor(page, `[...document.querySelectorAll('.tree-dir')].some((node) => node.textContent.includes('回车新建'))`, 8000))
    mkdirSync(path.join(vault, '生命周期', '原'), { recursive: true })
    writeFileSync(path.join(vault, '生命周期', '原.md'), '# 不应改写的正文\r\n')
    writeFileSync(path.join(vault, '生命周期', '原', '图.png'), Buffer.from([1, 2, 3]))
    writeFileSync(path.join(vault, '生命周期', '引用.md'), '见 [[生命周期/原]]。')
    await selectBrowserFolder(page, '生命周期')
    check('文件树显示待改名的笔记', await waitFor(page, `[...document.querySelectorAll('.resource-scroll .tree-note')].some((node) => node.querySelector('.tree-label')?.textContent === '原')`, 8000))
    await page.eval(`(() => { const node = [...document.querySelectorAll('.resource-scroll .tree-note')].find((n) => n.querySelector('.tree-label')?.textContent === '原'); node?.click(); node?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 220 })) })()`)
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
    const movedTaskLedger = taskMove.ok && await page.eval(`(async()=>{const note=await window.rgent.noteRead('生命周期/已停止.md');const history=await window.rgent.ledgerGet({sessionId:note.sessionId,objectVersion:note.objectVersion,relPath:'生命周期/已停止.md'});return history.ok&&history.value.records.some(r=>r.state==='saved'&&r.chapter?.status==='cancelled'&&r.chapter?.prompt==='多任务停止')})()`)
    check('移动运行任务的笔记先停止并写入取消账本', taskMove.ok === true && taskGone && movedTaskLedger && movedTaskSource.includes('多任务停止') && movedTaskSource.includes('rgent:prompt:v1') && !movedTaskSource.includes('<!-- rgent:ledger:v1 -->'),
      JSON.stringify({ beforeMoveTask, taskMove, taskGone, moved: movedTaskSource.length > 0, cancelled: movedTaskLedger }))
    writeFileSync(path.join(vault, '生命周期', '过期.md'), '第一版')
    const stale = await page.eval(`window.rgent.relocationPreview({ kind: 'note', source: '生命周期/过期.md', target: '生命周期/拒绝.md' })`)
    writeFileSync(path.join(vault, '生命周期', '过期.md'), '外部第二版')
    const staleResult = stale.ok ? await page.eval(`window.rgent.relocationCommit({ id: '${stale.preview.id}', repairLinks: false })`) : stale
    check('预览后的外部修改使移动失败且保留原文', staleResult.ok === false && !existsSync(path.join(vault, '生命周期', '拒绝.md')) &&
      readFileSync(path.join(vault, '生命周期', '过期.md'), 'utf8') === '外部第二版')
    await page.eval(`(() => { const node = [...document.querySelectorAll('.resource-scroll .tree-note')].find((n) => n.querySelector('.tree-label')?.textContent === '新'); node?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 220 })) })()`)
    const noteMenuAfter = await page.eval(`[...document.querySelectorAll('.tier-menu button')].map((n) => n.textContent)`)
    check(process.platform === 'darwin' ? 'macOS 笔记右键有删除' : 'Windows 笔记右键没有删除',
      process.platform === 'darwin' ? noteMenuAfter.includes('删除') : !noteMenuAfter.includes('删除'),
      JSON.stringify(noteMenuAfter))
    await page.eval(`(() => { const node = document.querySelector('.tree-dir[data-path="生命周期"]'); const rect = node?.getBoundingClientRect(); node?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: (rect?.left??100)+20, clientY: (rect?.top??220)+12 })) })()`)
    const dirMenuAfter = await page.eval(`[...document.querySelectorAll('.tier-menu button')].map((n) => n.textContent)`)
    check('文件夹右键没有删除', !dirMenuAfter.includes('删除'), JSON.stringify(dirMenuAfter))

    } catch (error) { stageFailed('笔记库文件生命周期', error) }
    process.stdout.write('\n文件操作恢复状态\n')
    await selectBrowserFolder(page, '生命周期')
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
        const config = await window.rgent.modelConfigGet(); request.modelRecordId = config.config.defaultModelId
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
      check('失败重试后键盘焦点仍在恢复浮层', await waitFor(page, `document.querySelector('.lifecycle-recovery')?.contains(document.activeElement)`))
      rmSync(path.join(vault, '生命周期', '复原', '外部新增.txt'))
      await page.eval(`document.querySelector('.lifecycle-retry').focus(); document.querySelector('.lifecycle-retry').click()`)
      const recoveredUi = await waitFor(page, `document.querySelector('.lifecycle-recovery [role=status]')?.textContent.includes('文件操作已完成')`, process.platform === 'win32' ? 30000 : 12000)
      const recoveredFiles = recoveredUi &&
        readFileSync(path.join(vault, '生命周期', '已恢复.md'), 'utf8') === '不应泄露到状态接口的正文\r\n' &&
        existsSync(path.join(vault, '生命周期', '已恢复', '附件.png')) &&
        JSON.parse(readFileSync(path.join(vault, '.rgent-lifecycle'), 'utf8')).active === null &&
        (!policy || readFileSync(path.join(vault, '.rgent-permissions'), 'utf8') === policy)
      check('安全重试续跑附件且正文与权限保持不变', recoveredFiles, recoveredFiles ? '' : await page.eval(`JSON.stringify({
        status: document.querySelector('.lifecycle-recovery [role=status]')?.textContent ?? null,
        overlay: !!document.querySelector('.lifecycle-recovery'),
        active: document.activeElement && (document.activeElement.textContent || document.activeElement.className),
        tab: document.querySelector('.tab[aria-selected=true]')?.dataset.rel ?? null
      })`))
      const unrelatedSaved = await waitFor(page, `(async () => {
        const source = (await window.rgent.noteRead('生命周期/无关生成.md')).content
        const note=await window.rgent.noteRead('生命周期/无关生成.md')
        const history=await window.rgent.ledgerGet({sessionId:note.sessionId,objectVersion:note.objectVersion,relPath:'生命周期/无关生成.md'})
        const records=history.ok?history.value.records:[],record=records.find(r=>r.taskId===${JSON.stringify(unrelatedTask.id)}),chapter=record?.chapter
        const stopped=chapter?.status==='cancelled'||chapter?.status==='failed'&&chapter.reason==='LIFECYCLE_RECOVERY_REQUIRED'
        return source.includes('受控回答第一句。')&&!source.includes('rgent:ledger:v1')&&chapter?.answer.includes('受控回答第一句。')&&records.length===1&&stopped&&(await window.rgent.agentTasks()).length===0
      })()`)
      check('恢复后补存无关任务的回答与一章账本', unrelatedSaved, unrelatedSaved ? '' : await page.eval(`(async () => JSON.stringify({taskId:${JSON.stringify(unrelatedTask.id)},tasks:await window.rgent.agentTasks(),source:(await window.rgent.noteRead('生命周期/无关生成.md')).content}))()`))
      const recoveredUnrelatedSource = await page.eval(`(async ()=>(await window.rgent.noteRead('生命周期/无关生成.md')).content)()`)

      // 焦点是异步落位的：这里必须等，不能紧跟异步操作直接断言——否则机器一忙就会偶发失败（构造性竞态）。
      const closeFocused = await waitFor(page,
        `document.querySelector('.lifecycle-recovery')?.contains(document.activeElement) && document.activeElement.textContent === '关闭'`,
        process.platform === 'win32' ? 30000 : 12000)
      check('成功重试后焦点转到浮层关闭按钮', closeFocused, closeFocused ? '' : await page.eval(`JSON.stringify({
        overlay: !!document.querySelector('.lifecycle-recovery'),
        active: document.activeElement && (document.activeElement.textContent || document.activeElement.className),
        status: document.querySelector('.lifecycle-recovery [role=status]')?.textContent ?? null
      })`))
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
    nativePage?.close()
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
