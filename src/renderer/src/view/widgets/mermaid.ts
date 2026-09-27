import { WidgetType, type EditorView } from '@codemirror/view'
import type { MermaidRef } from '@markdown'
import DOMPurify from 'dompurify'

let mermaidLoader: Promise<{ default: MermaidApi }> | null = null
let seq = 0

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

export class MermaidWidget extends WidgetType {
  private dead = false

  constructor(
    readonly mermaid: MermaidRef,
    readonly dark = false
  ) {
    super()
  }

  eq(other: MermaidWidget): boolean {
    // 主题也算身份：变了就要重建，否则 SVG 还是旧配色。
    return this.mermaid.value === other.mermaid.value && this.dark === other.dark
  }

  toDOM(view?: EditorView): HTMLElement {
    const el = document.createElement('div')
    el.className = 'md-mermaid'
    el.setAttribute('role', 'img')
    el.setAttribute('aria-label', '图表')
    el.textContent = this.mermaid.value
    const token = ++seq
    void paint(el, this.mermaid.value, token, this.dark, () => this.dead, () => view?.requestMeasure())
    return el
  }

  destroy(_dom: HTMLElement): void {
    this.dead = true
  }

  ignoreEvent(): boolean {
    return true
  }
}

async function loadMermaid(dark: boolean): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((mod) => ({ default: mod.default as unknown as MermaidApi }))
  }
  const mod = await mermaidLoader
  // initialize 是全局的，每次渲染前按当前主题设一次即可。
  mod.default.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'neutral',
    fontFamily: 'var(--font-ui)'
  })
  return mod.default
}

async function paint(
  el: HTMLElement,
  value: string,
  token: number,
  dark: boolean,
  isDead: () => boolean,
  measure: () => void
): Promise<void> {
  try {
    const mermaid = await loadMermaid(dark)
    if (isDead() || !el.isConnected) return
    const { svg } = await mermaid.render(`rgtm${token}`, value)
    if (isDead() || !el.isConnected) return
    const safe = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject', 'script', 'iframe'],
      RETURN_DOM_FRAGMENT: true
    })
    if (!safe.querySelector('svg')) throw new Error('Mermaid 图形未通过净化')
    el.replaceChildren(safe)
    measure()
  } catch {
    if (isDead()) return
    el.textContent = value
    measure()
  }
}
