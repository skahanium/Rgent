import { WidgetType, type EditorView } from '@codemirror/view'
import type { ImageRef } from '@markdown'
import type { RemoteImageGetRequest, RemoteImageGetResult } from '../../../../shared/ipc.ts'
import { joinVaultRel, vaultMediaUrl } from '../../../../shared/vault-rel.ts'
import type { NoteHost } from '../host.ts'

export type ImagePresentation = { source?: 'human' | 'adopted' | 'ai' | 'ledger'; context?: RemoteImageGetRequest['context']; getContext?: () => RemoteImageGetRequest['context'] }
const disposeImages = new WeakMap<HTMLElement, () => void>()

export function disposeImageElement(dom: HTMLElement): void {
  disposeImages.get(dom)?.()
  disposeImages.delete(dom)
}

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
      && this.image.source === other.image.source
      && this.image.range.start === other.image.range.start
      && this.image.range.end === other.image.range.end
      && this.host.noteRelPath === other.host.noteRelPath
      && this.host.imageEpoch === other.host.imageEpoch
      && this.standalone === other.standalone
      && this.resolved() === other.resolved()
  }

  toDOM(view?: EditorView): HTMLElement {
    if (/^https?:\/\//i.test(this.image.url)) {
      return createImageElement(this.image.alt, this.image.url, this.standalone,
        this.host.remoteImageGet, () => view?.requestMeasure(), { source: this.image.source, getContext: () => this.host.imageContext?.(this.image.range, 'body') ?? {
          noteRelPath: this.host.noteRelPath, region: 'body', start: this.image.range.start, end: this.image.range.end
        } })
    }
    const rel = this.resolved()
    if (!rel || !this.host.vaultHas(rel)) {
      return placeholder(this.image.alt, this.standalone)
    }
    return createVaultImageElement(this.image.alt, rel, this.standalone, this.image.source, () => view?.requestMeasure())
  }

  destroy(dom: HTMLElement): void {
    disposeImageElement(dom)
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

/** Library media keeps its existing secure protocol; consent delays creating its img src. */
export function createVaultImageElement(
  alt: string,
  rel: string,
  standalone: boolean,
  source: ImagePresentation['source'],
  measured?: () => void
): HTMLElement {
  const root = container(standalone)
  let disposed = false
  disposeImages.set(root, () => { disposed = true })
  const begin = (): void => {
    if (disposed) return
    const img = document.createElement('img')
    img.className = 'md-image'
    img.alt = alt || '图片'
    img.src = vaultMediaUrl(rel)
    img.addEventListener('load', () => { if (!disposed) measured?.() }, { once: true })
    img.addEventListener('error', () => {
      if (disposed) return
      root.replaceChildren(placeholder(alt, false))
      measured?.()
    }, { once: true })
    root.classList.remove('md-image-ph')
    root.removeAttribute('role')
    root.replaceChildren(img)
    measured?.()
  }
  if (source === 'human' || source === 'adopted') begin()
  else {
    root.classList.add('md-image-ph')
    root.setAttribute('role', 'status')
    const label = document.createElement('span')
    label.textContent = alt ? `${alt} · 图片未加载` : '图片未加载'
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = '查看路径与来源'
    const address = document.createElement('span')
    details.addEventListener('toggle', () => {
      address.textContent = details.open ? `${sourceDescription(source)} · ${rel}` : ''
      measured?.()
    })
    details.append(summary, address)
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = '点击加载'
    button.addEventListener('click', begin)
    root.append(label, details, button)
  }
  return root
}

function sourceDescription(source: ImagePresentation['source']): string {
  return source === 'ai' ? '未采纳 AI 正文'
    : source === 'ledger' ? '账本'
    : source === 'adopted' ? '已采纳正文'
    : source === 'human' ? '人的正文' : '尚未核验的来源'
}

/** Source labels control presentation only; the main process independently proves request context. */
export function createImageElement(
  alt: string,
  url: string,
  standalone: boolean,
  load?: ImageLoader,
  measured?: () => void,
  presentation: ImagePresentation = {}
): HTMLElement {
  const root = container(standalone)
  const label = alt || '图片'
  let disposed = false
  let generation = 0
  disposeImages.set(root, () => { disposed = true; generation += 1 })
  const sourceLabel = sourceDescription(presentation.source)
  const show = (message: string, action?: { text: string; run: () => void }, target = url): void => {
    if (disposed) return
    root.replaceChildren()
    root.classList.add('md-image-ph')
    root.setAttribute('role', 'status')
    const description = document.createElement('span')
    description.textContent = standalone ? `${label} · ${message}` : message
    root.append(description)
    if (action) {
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      summary.textContent = '查看地址与来源'
      const address = document.createElement('span')
      details.addEventListener('toggle', () => {
        address.textContent = details.open ? `${sourceLabel} · ${target}` : ''
        measured?.()
      })
      details.append(summary, address)
      root.append(details)
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = action.text
      button.addEventListener('click', action.run)
      root.append(button)
    }
    measured?.()
  }
  const begin = (mode: 'auto' | 'explicit', allowHttp: boolean, continuation?: string): void => {
    if (disposed) return
    if (!load) { show('图片未加载'); return }
    const current = ++generation
    show('正在加载图片…')
    const context = presentation.getContext?.() ?? presentation.context
    const request: RemoteImageGetRequest = { url, mode, allowHttp,
      ...(context ? { context } : {}),
      ...(continuation ? { continuation } : {}) }
    void load(request).then((result) => {
      if (disposed || current !== generation) return
      if (!result.ok) {
        if (result.error === 'HTTP_CONFIRM' || result.error === 'REDIRECT_CONFIRM') {
          show(result.error === 'HTTP_CONFIRM' ? '目标图片使用 HTTP' : '图片将转向另一来源', {
            text: '确认加载', run: () => begin('explicit', result.error === 'HTTP_CONFIRM', result.continuation)
          }, result.url)
        } else show(failureMessage(result.error), { text: '重试', run: () => begin('explicit', allowHttp) })
        return
      }
      const img = document.createElement('img')
      img.className = 'md-image'
      img.alt = label
      img.src = result.src
      img.addEventListener('load', () => { if (!disposed) measured?.() }, { once: true })
      img.addEventListener('error', () => show('图片未加载', { text: '重试', run: () => begin('explicit', allowHttp) }), { once: true })
      root.classList.remove('md-image-ph')
      root.removeAttribute('role')
      root.replaceChildren(img)
      measured?.()
    }).catch(() => {
      if (!disposed && current === generation) show('图片未加载', { text: '重试', run: () => begin('explicit', allowHttp) })
    })
  }
  const http = url.toLowerCase().startsWith('http://')
  if (http || !['human', 'adopted'].includes(presentation.source ?? '')) {
    show(http ? '此图片使用 HTTP' : '图片未加载', { text: '点击加载', run: () => begin('explicit', http) })
  } else begin('auto', false)
  return root
}
