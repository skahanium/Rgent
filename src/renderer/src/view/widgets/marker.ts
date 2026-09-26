import { WidgetType, type EditorView } from '@codemirror/view'
import type { PlannedWidget } from '@markdown'

type MarkerPlan = Extract<PlannedWidget, { kind: 'marker' }>

/**
 * 身份标记的 chip：替掉整行 `<!-- rgent:…:v1 -->`。
 * 机器语法在画布上不该看得见，但「这一段是未采纳的 AI 块」要看得见——
 * 这块 chip 就是围栏说的第二种样子，也是采纳 / 丢弃 / 搬家的唯一入口。
 */
export class MarkerWidget extends WidgetType {
  constructor(readonly plan: MarkerPlan) {
    super()
  }

  eq(other: MarkerWidget): boolean {
    return other.plan.range.start === this.plan.range.start
      && other.plan.marker.identity === this.plan.marker.identity
      && other.plan.accept?.from === this.plan.accept?.from
      && other.plan.discard?.insert === this.plan.discard?.insert
      && other.plan.moveUp !== null === (this.plan.moveUp !== null)
      && other.plan.moveDown !== null === (this.plan.moveDown !== null)
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('span')
    const ai = this.plan.marker.identity === 'ai'
    root.className = ai ? 'rgent-marker rgent-marker-ai' : 'rgent-marker rgent-marker-command'
    const label = document.createElement('span')
    label.className = 'rgent-marker-label'
    label.textContent = ai ? '未采纳的 AI 块' : '口令'
    root.append(label)
    if (!ai) {
      // 口令是自己的字：只留一个删标记的出口，免得标记行被 chip 挡住后再也去不掉。
      root.append(this.button(view, '删标记', 'rgent-marker-discard', this.plan.accept, '去掉口令标记，正文不动'))
      return root
    }

    root.append(this.button(view, '采纳', 'rgent-marker-accept', this.plan.accept))
    root.append(this.button(view, '丢弃', 'rgent-marker-discard', this.plan.discard))
    root.append(this.button(view, '↑', 'rgent-marker-move', this.plan.moveUp, '上移这一段'))
    root.append(this.button(view, '↓', 'rgent-marker-move', this.plan.moveDown, '下移这一段'))
    return root
  }

  ignoreEvent(): boolean {
    return true
  }

  private button(
    view: EditorView,
    text: string,
    className: string,
    edit: { from: number; to: number; insert: string } | null,
    title?: string
  ): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.textContent = text
    if (title) button.title = title
    // 动作在计划里就定好了：这里不重算管线，也不自己拼文本。
    if (!edit) {
      button.disabled = true
      return button
    }
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert } })
      view.focus()
    })
    return button
  }
}
