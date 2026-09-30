import { compileFragment, type ImageRef } from '@markdown'
import type { Nodes, Root } from 'mdast'
import { joinVaultRel } from '../../../shared/vault-rel.ts'
import type { NoteHost } from './host.ts'
import { renderSafeHtmlFragment } from './safe-html.ts'
import { MathWidget } from './widgets/math.ts'
import { MermaidWidget } from './widgets/mermaid.ts'
import { createImageElement, createVaultImageElement, disposeImageElement } from './widgets/image.ts'

type ExtendedNode = Nodes & { children?: Nodes[]; value?: string; label?: string; title?: string; url?: string; lang?: string; depth?: number; ordered?: boolean; start?: number; checked?: boolean | null; align?: Array<'left' | 'right' | 'center' | null>; kind?: string; target?: string; display?: string }

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw, document.baseURI)
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null
  } catch { return null }
}

function text(value: string): Text { return document.createTextNode(value) }

export function renderReadOnlyNode(node: Nodes, source: string, host?: NoteHost): Node {
  const result = compileFragment(source)
  return render(node as ExtendedNode, source, host, false, 'body', result.index.images)
}

function render(node: ExtendedNode, source: string, host?: NoteHost, standaloneImage = false, region: 'body' | 'ledger' = 'body', images: ImageRef[] = []): Node {
  const children = (): Node[] => (node.children ?? []).map((child) =>
    render(child as ExtendedNode, source, host,
      node.type === 'paragraph' && node.children?.length === 1 && child.type === 'image', region, images))
  const element = (name: string, className?: string): HTMLElement => {
    const el = document.createElement(name)
    if (className) el.className = className
    el.append(...children())
    return el
  }
  switch (node.type) {
    case 'root': {
      const fragment = document.createDocumentFragment()
      fragment.append(...children())
      return fragment
    }
    case 'text': return text(node.value ?? '')
    case 'paragraph': {
      if (!node.children?.some((child) => child.type === 'html')) return element('p')
      const paragraph = document.createElement('p')
      // mdast keeps opening/closing inline HTML as separate nodes. Join only this
      // paragraph's already-parsed children, then let DOMPurify parse and filter
      // the HTML as a single fragment. Markdown siblings come from the same AST.
      const replacements = new Map<string, Node>()
      const raw = node.children.map((child) => {
        if (child.type === 'html') return child.value
        const token = `rgent-inline-${crypto.randomUUID()}`
        replacements.set(token, render(child as ExtendedNode, source, host, false, region, images))
        return token
      }).join('')
      const fragment = renderSafeHtmlFragment(raw)
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT)
      const textNodes: Text[] = []
      while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
      for (const original of textNodes) {
        let remaining = original.data
        const pieces: Node[] = []
        while (remaining) {
          let nearest: { token: string; at: number; node: Node } | undefined
          for (const [token, node] of replacements) {
            const at = remaining.indexOf(token)
            if (at >= 0 && (!nearest || at < nearest.at)) nearest = { token, at, node }
          }
          if (!nearest) { pieces.push(text(remaining)); break }
          if (nearest.at > 0) pieces.push(text(remaining.slice(0, nearest.at)))
          pieces.push(nearest.node)
          remaining = remaining.slice(nearest.at + nearest.token.length)
        }
        original.replaceWith(...pieces)
      }
      paragraph.append(fragment)
      return paragraph
    }
    case 'heading': return element(`h${Math.min(6, Math.max(1, node.depth ?? 1))}`)
    case 'strong': return element('strong')
    case 'emphasis': return element('em')
    case 'delete': return element('del')
    case 'inlineCode': {
      const code = document.createElement('code')
      code.textContent = node.value ?? ''
      return code
    }
    case 'code': {
      if (node.lang?.toLowerCase() === 'mermaid') return new MermaidWidget({ range: { start: 0, end: 0 }, value: node.value ?? '' }, document.documentElement.dataset.theme === 'night').toDOM()
      const wrapper = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = node.value ?? ''
      if (node.lang) code.dataset.language = node.lang
      wrapper.append(code)
      return wrapper
    }
    case 'blockquote': return element('blockquote')
    case 'list': {
      const list = element(node.ordered ? 'ol' : 'ul')
      if (node.ordered && node.start != null) list.setAttribute('start', String(node.start))
      return list
    }
    case 'listItem': {
      const item = element('li')
      if (node.checked != null) {
        const check = document.createElement('input')
        check.type = 'checkbox'
        check.checked = node.checked
        check.disabled = true
        item.prepend(check)
      }
      return item
    }
    case 'thematicBreak': return document.createElement('hr')
    case 'break': return document.createElement('br')
    case 'link': {
      const link = element('a') as HTMLAnchorElement
      const href = safeHref(node.url ?? '')
      if (href) { link.href = href; link.rel = 'noopener noreferrer'; link.target = '_blank' }
      return link
    }
    case 'image': {
      const range = { start: node.position?.start.offset ?? -1, end: node.position?.end.offset ?? -1 }
      const original = images.find(image => image.range.start === range.start && image.range.end === range.end && image.url === node.url)
      const imageSource = region === 'ledger' ? 'ledger' : original?.source
      if (/^https?:\/\//i.test(node.url ?? '')) {
        return createImageElement(node.alt ?? '', node.url ?? '', standaloneImage, host?.remoteImageGet, undefined, {
          source: imageSource,
          getContext: () => host?.imageContext?.(range, region) ?? (host ? {noteRelPath: host.noteRelPath, region, ...range} : undefined)
        })
      }
      const image = document.createElement('img')
      image.alt = node.alt ?? ''
      const rel = host && joinVaultRel(host.noteRelPath, node.url ?? '')
      if (rel && host?.vaultHas(rel)) return createVaultImageElement(node.alt ?? '', rel, standaloneImage, imageSource)
      image.dataset.unavailable = node.url ?? ''
      return image
    }
    case 'table': {
      const table = element('table')
      const first = table.querySelector('tr')
      if (first) for (const cell of [...first.children]) {
        const heading = document.createElement('th')
        heading.append(...cell.childNodes)
        cell.replaceWith(heading)
      }
      if (node.align) {
        for (const row of table.querySelectorAll('tr')) {
          ;[...row.children].forEach((cell, index) => {
            const alignment = node.align?.[index]
            if (alignment && cell instanceof HTMLElement) cell.style.textAlign = alignment
          })
        }
      }
      return table
    }
    case 'tableRow': return element('tr')
    case 'tableCell': return element('td')
    case 'html': return renderSafeHtmlFragment(node.value ?? '')
    case 'inlineMath': return new MathWidget({ range: { start: 0, end: 0 }, value: node.value ?? '', block: false }).toDOM()
    case 'math': return new MathWidget({ range: { start: 0, end: 0 }, value: node.value ?? '', block: true }).toDOM()
    case 'callout': {
      const callout = element('aside', `md-callout md-callout-${node.kind ?? 'note'}`)
      const heading = document.createElement('p')
      heading.className = 'md-callout-title'
      heading.textContent = node.title ?? '提示'
      callout.prepend(heading)
      return callout
    }
    case 'wikilink': {
      const link = document.createElement('a')
      link.className = 'md-wikilink'
      link.href = '#'
      link.textContent = node.display ?? node.value ?? ''
      link.addEventListener('click', (event) => {
        event.preventDefault()
        if (node.target && host?.vaultHas(node.target)) host.openNote(node.target)
      })
      return link
    }
    case 'yaml': {
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      summary.textContent = '属性'
      details.append(summary, text(node.value ?? ''))
      return details
    }
    default: {
      // An unknown extension must never disappear silently or be interpreted as HTML.
      const start = node.position?.start.offset ?? 0
      const end = node.position?.end.offset ?? start
      return text(source.slice(start, end))
    }
  }
}

export function disposeReadOnlyImages(root: HTMLElement): void {
  if (root.classList.contains('md-image-slot')) disposeImageElement(root)
  for (const image of root.querySelectorAll<HTMLElement>('.md-image-slot')) disposeImageElement(image)
}

/** Read-only projection of the same mdast pipeline used by editable notes. */
export function renderReadOnlyMarkdown(host: HTMLElement, source: string, noteHost?: NoteHost): void {
  const result = compileFragment(source)
  disposeReadOnlyImages(host)
  host.replaceChildren()
  if (result.stale) {
    host.classList.add('md-source-fallback')
    host.textContent = source
    host.setAttribute('data-render-error', result.error ?? 'Markdown 解析失败')
    return
  }
  host.classList.remove('md-source-fallback')
  host.removeAttribute('data-render-error')
  try { host.append(render(result.tree as Root, source, noteHost, false, 'ledger', result.index.images)) }
  catch (error) {
    disposeReadOnlyImages(host)
    host.replaceChildren(text(source))
    host.classList.add('md-source-fallback')
    host.setAttribute('data-render-error', error instanceof Error ? error.message : String(error))
  }
}
