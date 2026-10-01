const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
export interface SidebarLayoutInput {
  viewportWidth: number
  bodyWidth: number
  backlinksWidth: number
  readingMaxWidth: number
  preferredWidth: number | null
  scrollbarWidth?: number
}
export function computeSidebarLayout(input: SidebarLayoutInput) {
  const { viewportWidth, bodyWidth, backlinksWidth, readingMaxWidth, preferredWidth } = input
  const scrollbarWidth = Math.max(0, input.scrollbarWidth ?? 0)
  const defaultWidth = viewportWidth <= 820 ? 208 : 224
  const standardGap = clamp(viewportWidth * .06, 28, 74)
  const baselineContentWidth = Math.min(readingMaxWidth, Math.max(0, bodyWidth - backlinksWidth - defaultWidth - 2 * standardGap))
  const max = Math.max(192, Math.floor(Math.min(360, bodyWidth - backlinksWidth - Math.max(280, baselineContentWidth + 48 + scrollbarWidth))))
  const width = clamp(preferredWidth ?? defaultWidth, 192, max)
  const gap = Math.min(standardGap, Math.max(24 + scrollbarWidth / 2, (bodyWidth - backlinksWidth - width - baselineContentWidth) / 2))
  return { width, min: 192, max, gap, baselineContentWidth }
}
interface SidebarSizerOptions {
  body: HTMLElement
  panel: HTMLElement
  handle: HTMLElement
  toggle: HTMLElement
  backlinks: HTMLElement
  getPreferredWidth(): number | null
  setPreferredWidth(width: number | null): void
}
export function createSidebarSizer(options: SidebarSizerOptions) {
  const { body, panel, handle, toggle, backlinks } = options
  const root = document.documentElement
  let expanded = !panel.classList.contains('is-collapsed')
  let layout: ReturnType<typeof computeSidebarLayout>
  let drag: { id: number; x: number; width: number; draft: number; moved: boolean; userSelect: string; cursor: string } | null = null
  const persist = (width: number | null) => { try { options.setPreferredWidth(width) } catch { /* The shell retains the in-memory preference if storage fails. */ } }
  const readingWidth = () => {
    const raw = getComputedStyle(root).getPropertyValue('--reading-max-width').trim()
    const match = raw.match(/^(\d+(?:\.\d+)?)(px|rem)$/)
    if (!match) return 768
    const value = Number(match[1]) * (match[2] === 'rem' ? parseFloat(getComputedStyle(root).fontSize) || 16 : 1)
    return Number.isFinite(value) && value > 0 ? value : 768
  }
  const setStyle = (name: string, value: string) => { if (body.style.getPropertyValue(name) !== value) body.style.setProperty(name, value) }
  const observer = new ResizeObserver(() => relayout())
  let observedScroller: HTMLElement | null = null
  const relayout = () => {
    if (body.clientWidth <= 0) return
    const scroller = body.querySelector<HTMLElement>('.cm-scroller')
    if (scroller && scroller !== observedScroller) {
      if (observedScroller) observer.unobserve(observedScroller)
      observer.observe(scroller)
      observedScroller = scroller
    }
    const scrollbarWidth = scroller ? Math.max(0, scroller.offsetWidth - scroller.clientWidth) : 0
    layout = computeSidebarLayout({ viewportWidth: window.innerWidth, bodyWidth: body.clientWidth, backlinksWidth: backlinks.getBoundingClientRect().width, readingMaxWidth: readingWidth(), scrollbarWidth, preferredWidth: drag?.draft ?? options.getPreferredWidth() })
    if (drag) drag.draft = layout.width
    setStyle('--sidebar-width', `${layout.width}px`)
    setStyle('--reading-side-gap', `${expanded ? layout.gap : clamp(window.innerWidth * .06, 28, 74)}px`)
    handle.setAttribute('aria-valuemin', `${layout.min}`)
    handle.setAttribute('aria-valuemax', `${layout.max}`)
    handle.setAttribute('aria-valuenow', `${layout.width}`)
    handle.setAttribute('aria-valuetext', `${layout.width} px`)
  }
  const endDrag = () => {
    if (!drag) return
    const previous = drag; drag = null
    body.style.userSelect = previous.userSelect; body.style.cursor = previous.cursor
    try { handle.releasePointerCapture(previous.id) } catch { /* Capture may already have been lost. */ }
  }
  const cancelDrag = () => { if (drag) { endDrag(); relayout() } }
  const refresh = () => { cancelDrag(); relayout() }
  const setExpanded = (open: boolean) => {
    if (!open && (panel.contains(document.activeElement) || handle === document.activeElement)) toggle.focus({ preventScroll: true })
    cancelDrag(); expanded = open
    panel.classList.toggle('is-collapsed', !open)
    toggle.setAttribute('aria-expanded', String(open))
    handle.hidden = !open; handle.tabIndex = open ? 0 : -1
    relayout()
  }
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.setAttribute('aria-controls', panel.id || 'tree-panel')
  handle.addEventListener('pointerdown', event => {
    if (!expanded || event.button !== 0 || drag) return
    relayout()
    if (!layout || body.clientWidth <= 0) return
    drag = { id: event.pointerId, x: event.clientX, width: layout.width, draft: layout.width, moved: false, userSelect: body.style.userSelect, cursor: body.style.cursor }
    body.style.userSelect = 'none'; body.style.cursor = 'col-resize'
    try { handle.setPointerCapture(event.pointerId) } catch { cancelDrag(); return }
    event.preventDefault()
  })
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return
    if (event.clientX !== drag.x) drag.moved = true
    drag.draft = Math.round(clamp(drag.width + event.clientX - drag.x, layout.min, layout.max)); relayout()
  })
  handle.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return
    const { draft, moved, width } = drag; endDrag()
    if (moved && draft !== width) persist(Math.round(draft))
    relayout()
  })
  handle.addEventListener('pointercancel', cancelDrag)
  handle.addEventListener('lostpointercapture', cancelDrag)
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopImmediatePropagation(); cancelDrag() }
  }, true)
  handle.addEventListener('keydown', event => {
    if (!expanded) return
    relayout()
    if (!layout || body.clientWidth <= 0) return
    let value: number
    if (event.key === 'Home') value = layout.min
    else if (event.key === 'End') value = layout.max
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') value = layout.width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 32 : 8)
    else return
    event.preventDefault(); cancelDrag(); persist(Math.round(clamp(value, layout.min, layout.max))); relayout()
  })
  handle.addEventListener('dblclick', () => { cancelDrag(); persist(null); relayout() })
  observer.observe(body)
  observer.observe(backlinks)
  new MutationObserver(refresh).observe(root, { attributes: true, attributeFilter: ['style'] })
  window.addEventListener('resize', refresh)
  setExpanded(expanded)
  return { refresh, setExpanded }
}
