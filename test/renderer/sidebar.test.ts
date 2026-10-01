// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computeSidebarLayout, createSidebarSizer } from '../../src/renderer/src/sidebar.ts'

const geometry = (viewportWidth = 1200, preferredWidth: number | null = 360, readingMaxWidth = 768) => ({
  viewportWidth, bodyWidth: viewportWidth, backlinksWidth: viewportWidth === 800 ? 176 : 204,
  readingMaxWidth, preferredWidth
})

let resize: () => void
beforeEach(() => {
  document.body.innerHTML = '<main><aside id="tree-panel"><button>note</button></aside><div id="handle"></div><button id="toggle"></button><aside id="backlinks"></aside></main>'
  document.documentElement.style.cssText = '--reading-max-width: 768px'
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1200 })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

function setup(initialCollapsed = false) {
  const body = document.querySelector('main')!
  const panel = document.querySelector<HTMLElement>('#tree-panel')!
  const handle = document.querySelector<HTMLElement>('#handle')!
  const toggle = document.querySelector<HTMLElement>('#toggle')!
  const backlinks = document.querySelector<HTMLElement>('#backlinks')!
  let bodyWidth: number | null = null
  Object.defineProperty(body, 'clientWidth', { configurable: true, get: () => bodyWidth ?? window.innerWidth })
  backlinks.getBoundingClientRect = () => ({ width: window.innerWidth === 800 ? 176 : 204 } as DOMRect)
  handle.setPointerCapture = vi.fn()
  handle.releasePointerCapture = vi.fn()
  panel.classList.toggle('is-collapsed', initialCollapsed)
  let preferred: number | null = 360
  const save = vi.fn((value: number | null) => { preferred = value })
  const sizer = createSidebarSizer({ body, panel, handle, toggle, backlinks,
    getPreferredWidth: () => preferred, setPreferredWidth: save })
  const pointer = (type: string, x: number) => handle.dispatchEvent(Object.assign(
    new Event(type, { bubbles: true, cancelable: true }), { button: 0, pointerId: 1, clientX: x }))
  const key = (key: string, shiftKey = false) => handle.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey }))
  return { body, panel, handle, toggle, save, sizer, pointer, key,
    setBodyWidth: (value: number) => { bodyWidth = value } }
}

describe('sidebar layout', () => {
  it('protects the default expanded text width at narrow and wide windows', () => {
    expect(computeSidebarLayout(geometry())).toEqual({ width: 320, min: 192, max: 320, gap: 24, baselineContentWidth: 628 })
    expect(computeSidebarLayout(geometry(800, null))).toMatchObject({ width: 208, max: 256, baselineContentWidth: 320 })
    expect(computeSidebarLayout(geometry(1800))).toMatchObject({ width: 360, max: 360 })
    expect(computeSidebarLayout(geometry(1800, 360, 960)).baselineContentWidth).toBe(960)
  })

  it('reserves physical reading margins around a classic scrollbar', () => {
    expect(computeSidebarLayout({ ...geometry(), scrollbarWidth: 15 })).toEqual({
      width: 305, min: 192, max: 305, gap: 31.5, baselineContentWidth: 628
    })
    const { body, handle, sizer } = setup()
    const scroller = document.createElement('div')
    scroller.className = 'cm-scroller'
    Object.defineProperties(scroller, { offsetWidth: { value: 700 }, clientWidth: { value: 685 } })
    body.append(scroller)
    sizer.refresh()
    expect(handle.getAttribute('aria-valuemax')).toBe('305')
    expect(body.style.getPropertyValue('--reading-side-gap')).toBe('31.5px')
  })
})

describe('sidebar interaction', () => {
  it('restores a temporarily clamped preference and uses actual width for keyboard changes', () => {
    const { body, handle, save, sizer, key } = setup()
    expect(body.style.getPropertyValue('--sidebar-width')).toBe('320px')
    window.innerWidth = 1800
    sizer.refresh()
    expect(body.style.getPropertyValue('--sidebar-width')).toBe('360px')
    window.innerWidth = 1200
    sizer.refresh()
    key('ArrowLeft')
    expect(save).toHaveBeenLastCalledWith(312)
    key('ArrowLeft', true)
    expect(save).toHaveBeenLastCalledWith(280)
    key('Home')
    expect(save).toHaveBeenLastCalledWith(192)
    key('End')
    expect(save).toHaveBeenLastCalledWith(320)
    key('ArrowRight', true)
    expect(save).toHaveBeenLastCalledWith(320)
    handle.dispatchEvent(new MouseEvent('dblclick'))
    expect(save).toHaveBeenLastCalledWith(null)
    expect(handle.getAttribute('aria-valuenow')).toBe('224')
  })

  it('commits only a changed pointer release and preserves the preferred width on saturation or return', () => {
    const { handle, save, pointer } = setup()
    pointer('pointerdown', 100)
    pointer('pointerup', 100)
    pointer('pointerdown', 100)
    pointer('pointermove', 200)
    pointer('pointerup', 200)
    pointer('pointerdown', 100)
    pointer('pointermove', 80)
    pointer('pointermove', 100)
    pointer('pointerup', 100)
    expect(save).not.toHaveBeenCalled()
    pointer('pointerdown', 100)
    pointer('pointermove', 90)
    expect(handle.getAttribute('aria-valuenow')).toBe('310')
    expect(save).not.toHaveBeenCalled()
    pointer('pointerup', 90)
    expect(save).toHaveBeenCalledExactlyOnceWith(310)
  })

  it('Escape cancels and prevents later document capture listeners from cancelling a host task', () => {
    const { body, handle, pointer } = setup()
    body.style.userSelect = 'text'
    body.style.cursor = 'help'
    pointer('pointerdown', 100)
    pointer('pointermove', 80)
    const hostEscape = vi.fn()
    document.addEventListener('keydown', hostEscape, true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.removeEventListener('keydown', hostEscape, true)
    expect(hostEscape).not.toHaveBeenCalled()
    expect(handle.getAttribute('aria-valuenow')).toBe('320')
    expect(body.style.userSelect).toBe('text')
    expect(body.style.cursor).toBe('help')
  })

  it('cancels on pointer cancellation, capture loss, resize and explicit library refresh', () => {
    const { pointer, save, handle, sizer } = setup()
    for (const type of ['pointercancel', 'lostpointercapture', 'resize', 'refresh']) {
      pointer('pointerdown', 100)
      pointer('pointermove', 80)
      if (type === 'resize') window.dispatchEvent(new Event('resize'))
      else if (type === 'refresh') sizer.refresh()
      else pointer(type, 80)
      pointer('pointerup', 80)
      expect(handle.getAttribute('aria-valuenow')).toBe('320')
    }
    expect(save).not.toHaveBeenCalled()
  })

  it('restores temporary styles after pointer capture fails', () => {
    const { body, handle, pointer, save } = setup()
    body.style.userSelect = 'text'
    body.style.cursor = 'help'
    handle.setPointerCapture = () => { throw new Error('capture unavailable') }
    pointer('pointerdown', 100)
    pointer('pointermove', 80)
    pointer('pointerup', 80)
    expect(body.style.userSelect).toBe('text')
    expect(body.style.cursor).toBe('help')
    expect(save).not.toHaveBeenCalled()
  })

  it('preserves initial collapse and restores normal reading gap while collapsed', () => {
    const { body, panel, handle, toggle, save, sizer, pointer } = setup(true)
    expect(handle.hidden).toBe(true)
    expect(body.style.getPropertyValue('--reading-side-gap')).toBe('72px')
    sizer.setExpanded(true)
    panel.querySelector('button')!.focus()
    pointer('pointerdown', 100)
    pointer('pointermove', 80)
    sizer.setExpanded(false)
    expect(document.activeElement).toBe(toggle)
    expect(handle.hidden).toBe(true)
    expect(handle.tabIndex).toBe(-1)
    expect(save).not.toHaveBeenCalled()
    expect(body.style.getPropertyValue('--reading-side-gap')).toBe('72px')
    sizer.setExpanded(true)
    expect(handle.getAttribute('aria-valuenow')).toBe('320')
  })

  it('ignores hidden zero-size notifications without changing preference or previous width', () => {
    const { body, setBodyWidth, save, sizer } = setup()
    const previous = body.style.cssText
    setBodyWidth(0)
    resize()
    sizer.refresh()
    expect(body.style.cssText).toBe(previous)
    expect(save).not.toHaveBeenCalled()
  })

  it('recomputes for valid reading widths and cancels a draft on root preference change', async () => {
    const { handle, pointer, save, sizer } = setup()
    window.innerWidth = 1400
    document.documentElement.style.setProperty('--reading-max-width', '640px')
    await Promise.resolve()
    sizer.refresh()
    expect(handle.getAttribute('aria-valuemax')).toBe('360')
    pointer('pointerdown', 100)
    pointer('pointermove', 80)
    document.documentElement.style.setProperty('--reading-max-width', '960px')
    await Promise.resolve()
    expect(handle.getAttribute('aria-valuemax')).toBe('324')
    pointer('pointerup', 80)
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps current layout when storage throws after retaining the preference', () => {
    const { body, panel, toggle } = setup()
    const backlinks = document.querySelector<HTMLElement>('#backlinks')!
    const handle = document.createElement('div')
    let width: number | null = 224
    createSidebarSizer({ body, panel, handle, toggle, backlinks,
      getPreferredWidth: () => width,
      setPreferredWidth: value => { width = value; throw new Error('storage') } })
    expect(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))).not.toThrow()
    expect(body.style.getPropertyValue('--sidebar-width')).toBe('232px')
  })
})
