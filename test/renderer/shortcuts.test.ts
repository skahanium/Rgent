// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { askShortcutLabel, installShortcuts, shortcutFor, type ShortcutHandlers } from '../../src/renderer/src/shortcuts.ts'

/** 窗口级快捷键：抓页／搜索对话框与应用菜单共用 ⌘⇧U／Ctrl+Shift+U。 */

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init } as KeyboardEvent
}

/** 同时带 Meta 与 Ctrl，测试不依赖跑测试的机器是 macOS 还是别的系统。 */
function bothModifiers(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { ctrlKey: true, metaKey: true, ...init })
}

function handlers(): ShortcutHandlers {
  return { onSearch: vi.fn(), onSave: vi.fn(), onFetchWeb: vi.fn(), onAsk: vi.fn() }
}

describe('抓页／搜索快捷键', () => {
  it('⌘⇧U 与 Ctrl+Shift+U 都命中 fetchWeb', () => {
    expect(shortcutFor(key({ key: 'u', metaKey: true, shiftKey: true }), true)).toBe('fetchWeb')
    expect(shortcutFor(key({ key: 'U', metaKey: true, shiftKey: true }), true)).toBe('fetchWeb')
    expect(shortcutFor(key({ key: 'u', ctrlKey: true, shiftKey: true }), false)).toBe('fetchWeb')
  })

  it('没有 Shift 的 Mod+U 不命中（不抢输入法与浏览器）', () => {
    expect(shortcutFor(key({ key: 'u', metaKey: true }), true)).toBeNull()
    expect(shortcutFor(key({ key: 'u', ctrlKey: true }), false)).toBeNull()
  })

  it('别的键或带 Alt 都不命中', () => {
    expect(shortcutFor(key({ key: 'x', metaKey: true, shiftKey: true }), true)).toBeNull()
    expect(shortcutFor(key({ key: 'u', metaKey: true, shiftKey: true, altKey: true }), true)).toBeNull()
    expect(shortcutFor(key({ key: 'u', shiftKey: true }), true)).toBeNull()
    // 原有的两件不能被新键挤掉。
    expect(shortcutFor(key({ key: 'k', metaKey: true }), true)).toBe('search')
    expect(shortcutFor(key({ key: 's', metaKey: true }), true)).toBe('save')
  })

  it('installShortcuts 触发 onFetchWeb，卸载后不再触发', () => {
    const calls = handlers()
    const uninstall = installShortcuts(calls)
    const event = new KeyboardEvent('keydown', {
      key: 'u', shiftKey: true, ctrlKey: true, metaKey: true, cancelable: true
    })
    window.dispatchEvent(event)

    expect(calls.onFetchWeb).toHaveBeenCalledTimes(1)
    expect(calls.onSearch).not.toHaveBeenCalled()
    expect(calls.onSave).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)

    uninstall()
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'u', shiftKey: true, ctrlKey: true, metaKey: true, cancelable: true
    }))
    expect(calls.onFetchWeb).toHaveBeenCalledTimes(1)
  })

  it('installShortcuts 不给无 Shift 的 Mod+U 开对话框', () => {
    const calls = handlers()
    const uninstall = installShortcuts(calls)
    window.dispatchEvent(bothModifiers({ key: 'u' }))
    expect(calls.onFetchWeb).not.toHaveBeenCalled()
    uninstall()
  })
})

describe('提问块快捷键', () => {
  it('⌘⇧↵ 与 Ctrl+Shift+Enter 都命中 ask', () => {
    expect(shortcutFor(key({ key: 'Enter', metaKey: true, shiftKey: true }), true)).toBe('ask')
    expect(shortcutFor(key({ key: 'Enter', ctrlKey: true, shiftKey: true }), false)).toBe('ask')
  })

  it('没有 Shift 的 Mod+Enter、普通 Enter 与带 Alt 都不命中', () => {
    expect(shortcutFor(key({ key: 'Enter', metaKey: true }), true)).toBeNull()
    expect(shortcutFor(key({ key: 'Enter', shiftKey: true }), true)).toBeNull()
    expect(shortcutFor(key({ key: 'Enter', metaKey: true, shiftKey: true, altKey: true }), true)).toBeNull()
  })

  it('输入法组合中的 Enter（isComposing 或 229）不命中', () => {
    const composing = key({ key: 'Enter', metaKey: true, shiftKey: true })
    Object.defineProperty(composing, 'isComposing', { value: true })
    expect(shortcutFor(composing, true)).toBeNull()
    expect(shortcutFor(key({ key: 'Enter', metaKey: true, shiftKey: true, keyCode: 229 }), true)).toBeNull()
  })

  it('标签按平台给 ⌘⇧↵ 或 Ctrl+Shift+Enter', () => {
    expect(askShortcutLabel(true)).toBe('⌘⇧↵')
    expect(askShortcutLabel(false)).toBe('Ctrl+Shift+Enter')
  })

  it('installShortcuts 触发 onAsk，卸载后不再触发', () => {
    const calls = handlers()
    const uninstall = installShortcuts(calls)
    const event = new KeyboardEvent('keydown', {
      key: 'Enter', shiftKey: true, ctrlKey: true, metaKey: true, cancelable: true
    })
    window.dispatchEvent(event)
    expect(calls.onAsk).toHaveBeenCalledTimes(1)
    expect(calls.onSearch).not.toHaveBeenCalled()
    expect(calls.onSave).not.toHaveBeenCalled()
    expect(calls.onFetchWeb).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)

    uninstall()
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', shiftKey: true, ctrlKey: true, metaKey: true, cancelable: true
    }))
    expect(calls.onAsk).toHaveBeenCalledTimes(1)
  })
})
