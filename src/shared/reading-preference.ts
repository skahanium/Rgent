/** Device-wide reading choices. IDs, rather than CSS strings, cross the IPC boundary. */
export const READING_FONTS = ['literary', 'song', 'system', 'humanist'] as const
export type ReadingFont = (typeof READING_FONTS)[number]

/** Device-wide UI names only; never scales the editor or root font. */
export const CHROME_TEXT_SIZES = ['small', 'default', 'large'] as const
export type ChromeTextSize = (typeof CHROME_TEXT_SIZES)[number]
export type ChromeTextPreference = { tabs: ChromeTextSize; sidebar: ChromeTextSize }
export const DEFAULT_CHROME_TEXT: ChromeTextPreference = { tabs: 'default', sidebar: 'default' }
export function isChromeTextPreference(value: unknown): value is ChromeTextPreference {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ChromeTextPreference>
  return Object.keys(value).length === 2 && CHROME_TEXT_SIZES.includes(item.tabs!) && CHROME_TEXT_SIZES.includes(item.sidebar!)
}

export type ReadingPreference = {
  bodyFont: ReadingFont
  headingFont: ReadingFont
  fontSize: number
  lineHeight: number
  maxWidth: number
}

export const DEFAULT_READING_PREFERENCE: ReadingPreference = {
  bodyFont: 'literary',
  headingFont: 'humanist',
  fontSize: 17,
  lineHeight: 1.65,
  maxWidth: 768
}

export function isReadingPreference(value: unknown): value is ReadingPreference {
  if (!value || typeof value !== 'object') return false
  const keys = Object.keys(value)
  if (keys.length !== 5 || keys.some((key) => !['bodyFont', 'headingFont', 'fontSize', 'lineHeight', 'maxWidth'].includes(key))) return false
  const item = value as Partial<ReadingPreference>
  return READING_FONTS.some((font) => font === item.bodyFont)
    && READING_FONTS.some((font) => font === item.headingFont)
    && Number.isInteger(item.fontSize) && item.fontSize! >= 15 && item.fontSize! <= 21
    && typeof item.lineHeight === 'number' && Number.isFinite(item.lineHeight)
    && item.lineHeight >= 1.4 && item.lineHeight <= 2
    && Number.isInteger(item.maxWidth) && item.maxWidth! >= 640 && item.maxWidth! <= 960
}
