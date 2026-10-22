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
  /** 动态阻止用户关闭；程序提交新状态后仍可 close。 */
  canDismiss?: () => boolean
  /** 打开时聚焦的元素；不给就找浮层里第一个可聚焦项。仅模态浮层使用。 */
  initialFocus?: () => HTMLElement | null
  /** 触发元素消失时，调用方可提供仍可见的返回位置。仅模态浮层使用。 */
  returnFocus?: () => HTMLElement | null
  onClose?: () => void
  /**
   * 是否模态，默认 true。
   * 非模态用于「人需要随时可继续编辑」的卡片（本场授权、写操作确认）：不遮背景、不抢焦点、
   * 不拦快捷键；它们同样进栈，但 `modalOpen()` 只把模态算作"挡住快捷键的浮层"。
   */
  modal?: boolean
}

export type Overlay = {
  root: HTMLDialogElement
  close: () => void
  isOpen: () => boolean
}

const stack: Overlay[] = []

export function openOverlay(options: OverlayOptions): Overlay {
  const modal = options.modal !== false
  const root = document.createElement('dialog')
  root.className = 'overlay'
  root.dataset.modal = modal ? 'true' : 'false'
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
    if (options.dismissable !== false && options.canDismiss?.() !== false) overlay.close()
  })

  // 原生 cancel 会被浮层里的 search 输入框吃掉（它自己用 Esc 清空），
  // 所以自己再拦一层 keydown——Esc 必须一按就关。
  const handleEscape = (event: KeyboardEvent): void => {
    // Disabling a focused action can move focus to body. Catch Escape before
    // Chromium dispatches a close-watcher cancel that may be non-cancelable.
    if (!root.open || stack.at(-1) !== overlay || event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
    // 非模态卡片只在焦点进入卡片时接管 Esc；否则 Esc 仍归编辑器/搜索框。
    if (!modal && !root.contains(document.activeElement)) return
    event.preventDefault()
    event.stopPropagation()
    if (options.dismissable !== false && options.canDismiss?.() !== false) overlay.close()
  }
  document.addEventListener('keydown', handleEscape, true)

  root.addEventListener('close', () => {
    document.removeEventListener('keydown', handleEscape, true)
    root.remove()
    options.onClose?.()
    // 关掉之后把焦点还给触发它的地方（只对模态：非模态从未把焦点拿走）。
    // close 事件可能在下一帧才到；若已有新模态打开，旧浮层不能把焦点抢回底层。
    if (!modal) return
    const target = options.returnFocus?.() ?? previouslyFocused
    if (target?.isConnected && !stack.some((item) => item.isOpen())) target.focus()
  })

  // 模态打开时收掉已开的浮层（保持"同时只有一个模态"）；非模态卡片不挤掉别人。
  if (modal) {
    const top = stack[stack.length - 1]
    if (top?.isOpen()) top.close()
  }
  stack.push(overlay)

  if (modal) {
    root.showModal()
    queueMicrotask(() => {
      const target = options.initialFocus?.() ?? firstFocusable(root)
      target?.focus()
    })
  } else {
    root.show()
  }

  return overlay
}

/** 只有模态浮层会挡住快捷键与提交；非模态卡片不该拦编辑器。 */
export function modalOpen(): boolean {
  return document.querySelector('dialog[open][data-modal="true"]') !== null
}

function firstFocusable(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )
}
