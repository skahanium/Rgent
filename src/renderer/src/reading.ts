import { DEFAULT_READING_PREFERENCE, type ChromeTextPreference, type ReadingFont, type ReadingPreference } from '../../shared/reading-preference.ts'

const FONT_STACKS: Record<ReadingFont, string> = {
  literary: "'Iowan Old Style', Palatino, 'Palatino Linotype', Georgia, 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC', SimSun, serif",
  song: "'Songti SC', 'Source Han Serif SC', 'Noto Serif CJK SC', SimSun, Georgia, serif",
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  humanist: "'Avenir Next', Avenir, 'Helvetica Neue', 'PingFang SC', 'Noto Sans CJK SC', sans-serif"
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
