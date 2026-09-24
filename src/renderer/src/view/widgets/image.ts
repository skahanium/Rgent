import { WidgetType } from '@codemirror/view'
import type { ImageRef } from '@markdown'
import { joinVaultRel, vaultMediaUrl } from '../../../../shared/vault-rel.ts'
import type { NoteHost } from '../host.ts'

export class ImageWidget extends WidgetType {
  constructor(
    readonly image: ImageRef,
    readonly host: NoteHost
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return this.image.url === other.image.url
      && this.image.alt === other.image.alt
      && this.image.base === other.image.base
      && this.host.noteRelPath === other.host.noteRelPath
      && this.resolved() === other.resolved()
  }

  toDOM(): HTMLElement {
    const rel = this.resolved()
    if (!rel || !this.host.vaultHas(rel)) {
      return placeholder(this.image.alt, this.image.url)
    }
    const img = document.createElement('img')
    img.className = 'md-image'
    img.alt = this.image.alt || '图片'
    img.src = vaultMediaUrl(rel)
    img.addEventListener('error', () => {
      img.replaceWith(placeholder(this.image.alt, this.image.url))
    })
    return img
  }

  ignoreEvent(): boolean {
    return true
  }

  private resolved(): string | null {
    return joinVaultRel(this.host.noteRelPath, this.image.url, this.image.base)
  }
}

function placeholder(alt: string, url: string): HTMLElement {
  const figure = document.createElement('span')
  figure.className = 'md-image-ph'
  figure.setAttribute('role', 'img')
  figure.setAttribute('aria-label', alt || '图片')
  const label = document.createElement('span')
  label.textContent = alt || '图片'
  const src = document.createElement('span')
  src.className = 'md-image-src'
  src.textContent = url
  figure.append(label, src)
  return figure
}
