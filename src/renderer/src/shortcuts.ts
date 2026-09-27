/**
 * 全局快捷键层。围栏 docs/frontend.md §顶栏与侧栏：
 * 搜索笔记用 ⌘K／Ctrl+K；⌘F／Ctrl+F 留给当前笔记的篇内查找。
 *
 * 这一层是 window 级的：编辑器有焦点时按键照样冒泡到这里，所以键位只有一处定义。
 * 编辑器里的 Mod-s 也搬到这里，免得两处都能触发保存。
 */

export type ShortcutAction = 'search' | 'save'

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

/** 事件 → 动作。不认的键一律不管，交回浏览器与编辑器。 */
export function shortcutFor(event: KeyboardEvent, apple = isApple()): ShortcutAction | null {
  const mod = apple ? event.metaKey : event.ctrlKey
  if (!mod || event.altKey) return null
  const key = event.key.toLowerCase()
  if (key === 'k') return 'search'
  if (key === 's') return 'save'
  return null
}

export type ShortcutHandlers = {
  onSearch: () => void
  onSave: () => void
}

export function installShortcuts(handlers: ShortcutHandlers, target: Window = window): () => void {
  const listener = (event: Event): void => {
    const action = shortcutFor(event as KeyboardEvent)
    if (!action) return
    ;(event as KeyboardEvent).preventDefault()
    if (action === 'search') handlers.onSearch()
    else handlers.onSave()
  }
  target.addEventListener('keydown', listener)
  return () => target.removeEventListener('keydown', listener)
}
