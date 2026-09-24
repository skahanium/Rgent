import { WidgetType } from '@codemirror/view'
import type { WikiLinkRef } from '@markdown'
import type { NoteHost } from '../host.ts'

export class WikilinkWidget extends WidgetType {
  constructor(
    readonly link: WikiLinkRef,
    readonly host: NoteHost
  ) {
    super()
  }

  eq(other: WikilinkWidget): boolean {
    return this.link.target === other.link.target
      && this.link.display === other.link.display
      && this.link.embed === other.link.embed
      && this.missing() === other.missing()
  }

  toDOM(): HTMLElement {
    const a = document.createElement('a')
    a.className = this.missing() ? 'md-wikilink md-wikilink-missing' : 'md-wikilink'
    a.href = '#'
    a.draggable = false
    a.textContent = this.link.display
    a.title = this.link.target
    a.setAttribute('aria-label', this.missing() ? `失效链接 ${this.link.display}` : this.link.display)
    const open = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!this.link.target.toLowerCase().endsWith('.md')) return
      try {
        this.host.openNote(this.link.target)
      } catch {
        /* broken links stay clickable without throwing */
      }
    }
    a.addEventListener('click', open)
    a.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') open(event)
    })
    return a
  }

  ignoreEvent(): boolean {
    return true
  }

  private missing(): boolean {
    return !this.host.vaultHas(this.link.target)
  }
}
