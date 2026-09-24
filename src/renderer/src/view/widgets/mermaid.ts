import { WidgetType } from '@codemirror/view'
import type { MermaidRef } from '@markdown'

let mermaidLoader: Promise<{ default: MermaidApi }> | null = null
let seq = 0

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

export class MermaidWidget extends WidgetType {
  private dead = false

  constructor(readonly mermaid: MermaidRef) {
    super()
  }

  eq(other: MermaidWidget): boolean {
    return this.mermaid.value === other.mermaid.value
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'md-mermaid'
    el.setAttribute('role', 'img')
    el.setAttribute('aria-label', '图表')
    el.textContent = this.mermaid.value
    const token = ++seq
    void paint(el, this.mermaid.value, token, () => this.dead)
    return el
  }

  destroy(_dom: HTMLElement): void {
    this.dead = true
  }

  ignoreEvent(): boolean {
    return true
  }
}

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((mod) => {
      const api = mod.default as unknown as MermaidApi
      api.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif'
      })
      return { default: api }
    })
  }
  const mod = await mermaidLoader
  return mod.default
}

async function paint(el: HTMLElement, value: string, token: number, isDead: () => boolean): Promise<void> {
  try {
    const mermaid = await loadMermaid()
    if (isDead() || !el.isConnected) return
    const { svg } = await mermaid.render(`rgtm${token}`, value)
    if (isDead() || !el.isConnected) return
    el.innerHTML = svg
  } catch {
    if (isDead()) return
    el.textContent = value
  }
}
