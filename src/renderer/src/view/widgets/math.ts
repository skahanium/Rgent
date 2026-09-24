import { WidgetType } from '@codemirror/view'
import type { MathRef } from '@markdown'

export class MathWidget extends WidgetType {
  private dead = false

  constructor(readonly math: MathRef) {
    super()
  }

  eq(other: MathWidget): boolean {
    return this.math.value === other.math.value && this.math.block === other.math.block
  }

  toDOM(): HTMLElement {
    const el = document.createElement(this.math.block ? 'div' : 'span')
    el.className = this.math.block ? 'md-math md-math-block' : 'md-math'
    el.textContent = this.math.value
    void paint(el, this.math.value, this.math.block, () => this.dead)
    return el
  }

  destroy(_dom: HTMLElement): void {
    this.dead = true
  }

  ignoreEvent(): boolean {
    return true
  }
}

async function paint(
  el: HTMLElement,
  value: string,
  displayMode: boolean,
  isDead: () => boolean
): Promise<void> {
  try {
    const [{ default: katex }] = await Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css')
    ])
    if (isDead() || !el.isConnected) return
    katex.render(value, el, { displayMode, throwOnError: false })
  } catch {
    if (isDead()) return
    el.textContent = value
  }
}
