import { WidgetType, type EditorView } from '@codemirror/view'
import type { ImageRef } from '@markdown'
import type { RemoteImageGetRequest, RemoteImageGetResult } from '../../../../shared/ipc.ts'
import { joinVaultRel, vaultMediaUrl } from '../../../../shared/vault-rel.ts'
import type { NoteHost } from '../host.ts'

type ImageLoader = (request: RemoteImageGetRequest) => Promise<RemoteImageGetResult>

function failureMessage(error: Exclude<RemoteImageGetResult, { ok: true }>['error']): string {
  switch (error) {
    case 'NOT_IMAGE': return '地址没有返回图片'
    case 'TOO_LARGE': return '图片超过大小限制'
    case 'BUSY': return '图片请求繁忙'
    case 'INVALID_URL': return '图片地址无效'
    default: return '图片暂不可用'
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly image: ImageRef,
    readonly host: NoteHost,
    readonly standalone = false
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return this.image.url === other.image.url
      && this.image.alt === other.image.alt
      && this.image.base === other.image.base
      && this.host.noteRelPath === other.host.noteRelPath
      && this.standalone === other.standalone
      && this.resolved() === other.resolved()
  }

  toDOM(view?: EditorView): HTMLElement {
    if (/^https?:\/\//i.test(this.image.url)) {
      return createImageElement(this.image.alt, this.image.url, this.standalone,
        this.host.remoteImageGet, () => view?.requestMeasure())
    }
    const rel = this.resolved()
    if (!rel || !this.host.vaultHas(rel)) {
      return placeholder(this.image.alt, this.standalone)
    }
    const root = container(this.standalone)
    const img = document.createElement('img')
    img.className = 'md-image'
    img.alt = this.image.alt || '图片'
    img.src = vaultMediaUrl(rel)
    img.addEventListener('load', () => view?.requestMeasure(), { once: true })
    img.addEventListener('error', () => {
      root.replaceWith(placeholder(this.image.alt, this.standalone))
      view?.requestMeasure()
    })
    root.append(img)
    return root
  }

  ignoreEvent(): boolean {
    return true
  }

  private resolved(): string | null {
    return joinVaultRel(this.host.noteRelPath, this.image.url, this.image.base)
  }
}

function container(standalone: boolean): HTMLElement {
  const node = document.createElement('span')
  node.className = standalone ? 'md-image-slot md-image-block' : 'md-image-slot md-image-inline'
  return node
}

function placeholder(alt: string, standalone: boolean): HTMLElement {
  const node = container(standalone)
  node.classList.add('md-image-ph')
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', alt || '图片未加载')
  node.textContent = alt ? `${alt} · 图片未加载` : '图片未加载'
  return node
}

/** The editor and the read-only ledger share exactly the same remote-image state. */
export function createImageElement(
  alt: string,
  url: string,
  standalone: boolean,
  load?: ImageLoader,
  measured?: () => void
): HTMLElement {
  const root = container(standalone)
  const label = alt || '图片'
  const show = (message: string, action?: { text: string; run: () => void }): void => {
    root.replaceChildren()
    root.classList.add('md-image-ph')
    root.setAttribute('role', 'status')
    const description = document.createElement('span')
    description.textContent = standalone ? `${label} · ${message}` : message
    root.append(description)
    if (action) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = action.text
      button.addEventListener('click', action.run)
      root.append(button)
    }
    measured?.()
  }
  const begin = (allowHttp: boolean): void => {
    if (!load) {
      show('图片未加载')
      return
    }
    show('正在加载图片…')
    void load({ url, allowHttp }).then((result) => {
      if (!result.ok) {
        if (result.error === 'HTTP_CONFIRM') show('此图片使用 HTTP', { text: '点击加载', run: () => begin(true) })
        else show(failureMessage(result.error), { text: '重试', run: () => begin(allowHttp) })
        return
      }
      const img = document.createElement('img')
      img.className = 'md-image'
      img.alt = label
      img.src = result.src
      img.addEventListener('load', () => measured?.(), { once: true })
      img.addEventListener('error', () => show('图片未加载', { text: '重试', run: () => begin(allowHttp) }), { once: true })
      root.classList.remove('md-image-ph')
      root.removeAttribute('role')
      root.replaceChildren(img)
      measured?.()
    }).catch(() => show('图片未加载', { text: '重试', run: () => begin(allowHttp) }))
  }
  if (url.toLowerCase().startsWith('http://')) show('此图片使用 HTTP', { text: '点击加载', run: () => begin(true) })
  else begin(false)
  return root
}
