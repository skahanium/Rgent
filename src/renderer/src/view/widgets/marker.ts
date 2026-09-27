import { WidgetType, type EditorView } from '@codemirror/view'
import type { PlannedWidget } from '@markdown'

type MarkerPlan = Extract<PlannedWidget, { kind: 'marker' }>

/**
 * 身份标记的 chip。围栏 docs/frontend.md §编辑画布与辅助信息：
 * 机器语法在画布上不可见；「采纳」「丢弃」直接可见，其他操作收进「更多」，
 * 控件不压过文字。口令只留一个删标记的出口。
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
    label.textContent = ai ? '尚未采纳' : '口令'
    root.append(label)

    const actions = document.createElement('span')
    actions.className = 'rgent-marker-actions'
    root.append(actions)

    if (!ai) {
      // 口令是自己的字：只留删标记，免得标记被 chip 挡住之后再也没法去掉。
      actions.append(this.button(view, '删标记', 'rgent-marker-discard', this.plan.accept, '去掉口令标记，正文不动'))
      return root
    }

    actions.append(this.button(view, '采纳', 'rgent-marker-accept', this.plan.accept, '采纳这一段，之后可以随便改'))
    actions.append(this.button(view, '丢弃', 'rgent-marker-discard', this.plan.discard, '丢掉这一段和它的标记'))

    const more = this.plan.moveUp || this.plan.moveDown
    if (more) {
      const wrapper = document.createElement('span')
      wrapper.className = 'rgent-marker-more'
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'rgent-marker-more-toggle'
      toggle.setAttribute('aria-haspopup', 'menu')
      toggle.setAttribute('aria-expanded', 'false')
      toggle.textContent = '更多'
      const menu = document.createElement('span')
      menu.className = 'rgent-marker-menu'
      menu.setAttribute('role', 'menu')
      menu.hidden = true
      menu.append(
        this.button(view, '上移一段', 'rgent-marker-move', this.plan.moveUp, undefined, 'menuitem'),
        this.button(view, '下移一段', 'rgent-marker-move', this.plan.moveDown, undefined, 'menuitem')
      )
      const setOpen = (open: boolean): void => {
        menu.hidden = !open
        toggle.setAttribute('aria-expanded', String(open))
        if (open) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
        else toggle.focus()
      }
      toggle.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        setOpen(menu.hidden === true)
      })
      menu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
        }
      })
      wrapper.append(toggle, menu)
      actions.append(wrapper)
    }

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
    title?: string,
    role?: string
  ): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.textContent = text
    if (title) button.title = title
    if (role) button.setAttribute('role', role)
    // 动作在计划里就定好了：这里不重算管线，也不自己拼文本。
    if (!edit) {
      button.disabled = true
      return button
    }
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({
        changes: { from: edit.from, to: edit.to, insert: edit.insert },
        // 认领成我们自己的动作：身份锁定那道闸默认拦下所有改文档的事务。
        userEvent: 'rgent.markerAction'
      })
      view.focus()
    })
    return button
  }
}
