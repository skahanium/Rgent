import { WidgetType } from '@codemirror/view'
import type { CalloutRef } from '@markdown'
import type { NoteHost } from '../host.ts'
import { renderReadOnlyNode, disposeReadOnlyImages } from '../read-only.ts'

export class CalloutWidget extends WidgetType {
  constructor(readonly callout: CalloutRef, readonly host?: NoteHost) {
    super()
  }

  eq(other: CalloutWidget): boolean {
    return this.host === other.host
      && this.host?.imageEpoch === other.host?.imageEpoch
      && this.callout.range.start === other.callout.range.start
      && this.callout.range.end === other.callout.range.end
      && this.callout.source?.slice(this.callout.range.start, this.callout.range.end) === other.callout.source?.slice(other.callout.range.start, other.callout.range.end)
      && this.callout.kind === other.callout.kind
      && this.callout.title === other.callout.title
      && this.callout.body === other.callout.body
  }

  toDOM(): HTMLElement {
    if (this.callout.node) {
      const el = renderReadOnlyNode(this.callout.node, this.callout.source ?? '', this.host) as HTMLElement
      el.setAttribute('role', 'note')
      return el
    }
    const el = document.createElement('aside')
    el.className = `md-callout md-callout-${this.callout.kind}`
    el.setAttribute('role', 'note')
    const title = document.createElement('p')
    title.className = 'md-callout-title'
    title.textContent = this.callout.title
    el.append(title)
    if (this.callout.body.trim()) {
      const body = document.createElement('p')
      body.className = 'md-callout-body'
      body.textContent = this.callout.body
      el.append(body)
    }
    return el
  }

  destroy(dom: HTMLElement): void { disposeReadOnlyImages(dom) }

  ignoreEvent(): boolean {
    return true
  }
}
