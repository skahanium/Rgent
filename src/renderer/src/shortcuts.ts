/**
 * 全局快捷键层。围栏 docs/frontend.md §顶栏与侧栏：
 * 搜索笔记用 ⌘K／Ctrl+K；⌘F／Ctrl+F 留给当前笔记的篇内查找。
 *
 * 这一层是 window 级的：编辑器有焦点时按键照样冒泡到这里，所以键位只有一处定义。
 * 编辑器里的 Mod-s 也搬到这里，免得两处都能触发保存。
 * 人发起抓页／搜索对话框用 ⌘⇧U／Ctrl+Shift+U，与应用菜单「抓取网页…」共用同一个打开入口。
 * 提问块用 ⌘⇧↵／Ctrl+Shift+Enter，与应用菜单「问 AI」共用同一个入口。编辑器里没有按钮或提示。
 */

export type ShortcutAction = 'search' | 'save' | 'fetchWeb' | 'ask'

export type Shortcut = {
  action: ShortcutAction
  /** 展示用的平台相关写法，例如 ⌘K 或 Ctrl+K。 */
  label: string
}

/** 用 UA 判断平台，不动 preload，也不加 IPC 通道。 */
export function isApple(): boolean {
  if (typeof navigator === 'undefined') return false
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  const platform = data?.platform ?? navigator.platform ?? navigator.userAgent ?? ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

export function shortcutLabel(key: string, apple = isApple()): string {
  return apple ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`
}

/** 提问块的展示标签；应用菜单显示同一个组合，键盘仍由渲染层处理。 */
export function askShortcutLabel(apple = isApple()): string {
  return apple ? '⌘⇧↵' : 'Ctrl+Shift+Enter'
}

/** 事件 → 动作。不认的键一律不管，交回浏览器与编辑器。 */
export function shortcutFor(event: KeyboardEvent, apple = isApple()): ShortcutAction | null {
  const mod = apple ? event.metaKey : event.ctrlKey
  if (!mod || event.altKey) return null
  const key = event.key.toLowerCase()
  // 抓页／搜索对话框与应用菜单「抓取网页…」共用 ⌘⇧U／Ctrl+Shift+U；不带 Shift 的
  // Mod+U 留给输入法与浏览器，不在这里抢。
  if (key === 'u' && event.shiftKey) return 'fetchWeb'
  // 提问块要求 Shift；无 Shift 的 Mod+Enter 不抢，普通 Enter 仍归编辑器。
  // 输入法组合中的 Enter 属于确认候选词，不能当成创建指令。
  if (key === 'enter' && event.shiftKey) {
    if (event.isComposing || event.keyCode === 229) return null
    return 'ask'
  }
  if (key === 'k') return 'search'
  if (key === 's') return 'save'
  return null
}

export type ShortcutHandlers = {
  onSearch: () => void
  onSave: () => void
  /** 打开人发起抓页／搜索的对话框；外发授权发生在对话框的提交上，不在这一层。 */
  onFetchWeb: () => void
  /** 在光标处创建提问块（已存在草稿时聚焦它）；只由快捷键与菜单触发。 */
  onAsk: () => void
}

export function installShortcuts(handlers: ShortcutHandlers, target: Window = window): () => void {
  const listener = (event: Event): void => {
    const action = shortcutFor(event as KeyboardEvent)
    if (!action) return
    ;(event as KeyboardEvent).preventDefault()
    if (action === 'search') handlers.onSearch()
    else if (action === 'save') handlers.onSave()
    else if (action === 'fetchWeb') handlers.onFetchWeb()
    else handlers.onAsk()
  }
  target.addEventListener('keydown', listener)
  return () => target.removeEventListener('keydown', listener)
}
