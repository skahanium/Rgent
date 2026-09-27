import { WidgetType } from '@codemirror/view'
import type { CalloutRef } from '@markdown'
import { renderReadOnlyNode } from '../read-only.ts'

export class CalloutWidget extends WidgetType {
  constructor(readonly callout: CalloutRef) {
    super()
  }

  eq(other: CalloutWidget): boolean {
    return this.callout.range.start === other.callout.range.start
      && this.callout.range.end === other.callout.range.end
      && this.callout.source?.slice(this.callout.range.start, this.callout.range.end) === other.callout.source?.slice(other.callout.range.start, other.callout.range.end)
      && this.callout.kind === other.callout.kind
      && this.callout.title === other.callout.title
      && this.callout.body === other.callout.body
  }

  toDOM(): HTMLElement {
    const el = document.createElement('aside')
    el.className = `md-callout md-callout-${this.callout.kind}`
    el.setAttribute('role', 'note')
    const title = document.createElement('p')
    title.className = 'md-callout-title'
    title.textContent = this.callout.title
    el.append(title)
    if (this.callout.node) el.append(...this.callout.node.children.map((child) => renderReadOnlyNode(child, this.callout.source ?? '')))
    else if (this.callout.body.trim()) {
      const body = document.createElement('p')
      body.className = 'md-callout-body'
      body.textContent = this.callout.body
      el.append(body)
    }
    return el
  }

  ignoreEvent(): boolean {
    return true
  }
}
