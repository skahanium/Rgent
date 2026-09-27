import type { ThemeMode, ThemeSetResult } from '../../shared/ipc.ts'
import { openOverlay, type Overlay } from './overlay.ts'

export type SettingsHandlers = {
  getMode: () => Promise<ThemeMode>
  setMode: (mode: ThemeMode) => Promise<ThemeSetResult>
}

export type SettingsOverlay = {
  open: () => void
  close: () => void
  isOpen: () => boolean
}

const CHOICES: Array<{ mode: ThemeMode; name: string; detail: string }> = [
  { mode: 'day', name: '日间', detail: '明亮、清晰的阅读画布' },
  { mode: 'night', name: '夜间', detail: '柔和的深蓝灰工作区' },
  { mode: 'system', name: '跟随系统', detail: '随设备外观自动切换' }
]

export function createSettingsOverlay(handlers: SettingsHandlers): SettingsOverlay {
  let overlay: Overlay | null = null
  let request = 0

  const close = (): void => overlay?.close()
  const open = (): void => {
    if (overlay?.isOpen()) return
    const current = openOverlay({
      label: '设置',
      initialFocus: () => current.root.querySelector<HTMLElement>('.settings-page-title'),
      onClose: () => {
        if (overlay !== current) return
        request += 1
        overlay = null
      }
    })
    overlay = current
    const root = current.root
    root.classList.add('overlay-settings')

    const header = document.createElement('div')
    header.className = 'settings-header'
    const heading = document.createElement('strong')
    heading.textContent = '设置'
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'settings-close'
    dismiss.setAttribute('aria-label', '关闭设置')
    dismiss.textContent = '×'
    dismiss.addEventListener('click', close)
    header.append(heading, dismiss)

    const layout = document.createElement('div')
    layout.className = 'settings-layout'
    const nav = document.createElement('nav')
    nav.className = 'settings-nav'
    nav.setAttribute('aria-label', '设置页面')
    const page = document.createElement('span')
    page.className = 'settings-nav-current'
    page.textContent = '界面'
    page.setAttribute('aria-current', 'page')
    nav.append(page)
    const main = document.createElement('section')
    main.className = 'settings-main'
    const title = document.createElement('h2')
    title.className = 'settings-page-title'
    title.tabIndex = -1
    title.textContent = '界面'
    const intro = document.createElement('p')
    intro.className = 'settings-intro'
    intro.textContent = '选择适合当下阅读与写作的外观。'
    const group = document.createElement('fieldset')
    group.className = 'settings-theme-group'
    const legend = document.createElement('legend')
    legend.textContent = '主题'
    const choices = document.createElement('div')
    choices.className = 'settings-choices'
    const error = document.createElement('p')
    error.className = 'settings-error'
    error.setAttribute('role', 'alert')
    error.hidden = true
    group.append(legend, choices, error)
    main.append(title, intro, group)
    layout.append(nav, main)
    root.append(header, layout)

    let selected: ThemeMode | null = null
    let busy = false
    const inputs: HTMLInputElement[] = []
    const paint = (): void => {
      for (const input of inputs) {
        input.checked = input.value === selected
        input.disabled = busy || selected === null
      }
    }
    const setError = (message: string): void => {
      error.textContent = message
      error.hidden = !message
    }
    for (const item of CHOICES) {
      const label = document.createElement('label')
      label.className = 'settings-choice'
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = 'theme-mode'
      input.value = item.mode
      input.disabled = true
      const copy = document.createElement('span')
      copy.className = 'settings-choice-copy'
      const preview = document.createElement('span')
      preview.className = `settings-choice-preview settings-preview-${item.mode}`
      preview.setAttribute('aria-hidden', 'true')
      const name = document.createElement('strong')
      name.textContent = item.name
      const detail = document.createElement('small')
      detail.textContent = item.detail
      copy.append(name, detail)
      label.append(input, preview, copy)
      choices.append(label)
      inputs.push(input)
      input.addEventListener('change', () => {
        if (!input.checked || busy || selected === item.mode) return
        const mine = ++request
        busy = true
        paint()
        setError('')
        void handlers.setMode(item.mode).then((result) => {
          if (!current.isOpen() || mine !== request) return
          if (result.ok) selected = result.mode
          else setError(result.error === 'IO_ERROR' ? '主题设置保存失败，请重试。' : '无法使用这个主题选项。')
        }).catch(() => {
          if (current.isOpen() && mine === request) setError('主题设置保存失败，请重试。')
        }).finally(() => {
          if (current.isOpen() && mine === request) {
            busy = false
            paint()
          }
        })
      })
    }
    const mine = ++request
    void handlers.getMode().then((mode) => {
      if (!current.isOpen() || mine !== request) return
      selected = mode
      paint()
    }).catch(() => {
      if (current.isOpen() && mine === request) setError('暂时无法读取主题设置。')
    })
  }

  return { open, close, isOpen: () => overlay?.isOpen() ?? false }
}
