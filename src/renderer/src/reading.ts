import { DEFAULT_READING_PREFERENCE, type ChromeTextPreference, type ReadingFont, type ReadingPreference } from '../../shared/reading-preference.ts'

export const FONT_STACKS: Record<ReadingFont, string> = {
  literary: "'Rgent Serif', serif",
  song: "'Songti SC', 'STSong', 'Rgent Serif', serif",
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif",
  humanist: "'Rgent Sans', sans-serif"
}

/** Apply only validated, enumerated values; no user supplied CSS crosses into a stylesheet. */
export function applyReadingPreference(reading: ReadingPreference, element: HTMLElement = document.documentElement): void {
  element.style.setProperty('--reading-font-family', FONT_STACKS[reading.bodyFont])
  element.style.setProperty('--heading-font-family', FONT_STACKS[reading.headingFont])
  element.style.setProperty('--reading-font-size', `${reading.fontSize}px`)
  element.style.setProperty('--reading-line-height', String(reading.lineHeight))
  element.style.setProperty('--reading-max-width', `${reading.maxWidth}px`)
}

export { DEFAULT_READING_PREFERENCE }

export function applyChromeTextPreference(value: ChromeTextPreference, element: HTMLElement = document.documentElement): void {
  const size = (base: string, choice: ChromeTextPreference['tabs']): string =>
    choice === 'default' ? base : choice === 'small' ? `max(12px, calc(${base} - 1px))` : `calc(${base} + 1px)`
  element.style.setProperty('--tab-name-font-size', size('0.84rem', value.tabs))
  element.style.setProperty('--sidebar-name-font-size', size('calc(0.86rem - 1px)', value.sidebar))
}
