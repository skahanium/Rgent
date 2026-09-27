/**
 * 浮层原语。围栏 docs/frontend.md §浮层与特殊状态 与 architecture 的「浮层只有一个栈」：
 * 同时最多一个模态；打开时焦点进入浮层，关闭回到触发元素；模态期间焦点不落到底层。
 *
 * 用原生 `<dialog>` + `showModal()`：焦点containment、Esc、惰性背景都由浏览器给，
 * 我们只补「栈」「回到触发点」「不可关闭的浮层」这三件。
 */

export type OverlayOptions = {
  /** 无障碍名称。 */
  label: string
  /** 不可 Esc 关闭（选库那种必须给个答复的）。 */
  dismissable?: boolean
  /** 打开时聚焦的元素；不给就找浮层里第一个可聚焦项。 */
  initialFocus?: () => HTMLElement | null
  onClose?: () => void
}

export type Overlay = {
  root: HTMLDialogElement
  close: () => void
  isOpen: () => boolean
}

const stack: Overlay[] = []

export function openOverlay(options: OverlayOptions): Overlay {
  const root = document.createElement('dialog')
  root.className = 'overlay'
  root.setAttribute('aria-label', options.label)
  document.body.append(root)

  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null

  const overlay: Overlay = {
    root,
    isOpen: () => root.open,
    close: () => {
      if (!root.open) return
      const at = stack.indexOf(overlay)
      if (at >= 0) stack.splice(at, 1)
      root.close()
    }
  }

  root.addEventListener('cancel', (event) => {
    // Esc 默认会关；不可关闭的浮层拦下它。
    event.preventDefault()
    if (options.dismissable !== false) overlay.close()
  })

  // 原生 cancel 会被浮层里的 search 输入框吃掉（它自己用 Esc 清空），
  // 所以自己再拦一层 keydown——Esc 必须一按就关。
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (options.dismissable !== false) overlay.close()
  })

  root.addEventListener('close', () => {
    root.remove()
    options.onClose?.()
    // 关掉之后把焦点还给触发它的地方。
    if (previouslyFocused?.isConnected) previouslyFocused.focus()
  })

  // 模态之上再开一个模态：拒绝，栈里永远只有一个。
  const top = stack[stack.length - 1]
  if (top?.isOpen()) top.close()
  stack.push(overlay)

  root.showModal()
  queueMicrotask(() => {
    const target = options.initialFocus?.() ?? firstFocusable(root)
    target?.focus()
  })

  return overlay
}

function firstFocusable(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )
}

export function openOverlayCount(): number {
  return stack.filter((overlay) => overlay.isOpen()).length
}
