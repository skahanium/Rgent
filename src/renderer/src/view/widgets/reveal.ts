import type { EditorView } from '@codemirror/view'
import { sourceOf } from '../source.ts'

/** 把光标打回磁盘偏移对应的视图像素。索引范围是原文，装饰走 toView。 */
export function revealSourceRange(view: EditorView, rawStart: number, rawEnd = rawStart + 1): void {
  view.dispatch({
    selection: { anchor: sourceOf(view.state).toView(Math.min(rawStart + 1, rawEnd)) }
  })
  view.focus()
}

function isWidgetControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, summary, a, input, textarea, select'))
}

/** 普通单击回源码；⌘／Ctrl+单击留给打开／加载。控件（按钮、摘要）自己吞事件。 */
export function attachRevealSource(element: HTMLElement, view: EditorView | undefined, rawStart: number, rawEnd?: number): HTMLElement {
  if (!view) return element
  element.addEventListener('mousedown', (event) => {
    if (event.metaKey || event.ctrlKey) return
    if (isWidgetControl(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    revealSourceRange(view, rawStart, rawEnd)
  })
  return element
}
