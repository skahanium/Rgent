/** Device-wide reading choices. IDs, rather than CSS strings, cross the IPC boundary. */
export const READING_FONTS = ['literary', 'song', 'system', 'humanist'] as const
export type ReadingFont = (typeof READING_FONTS)[number]

export type ReadingPreference = {
  bodyFont: ReadingFont
  headingFont: ReadingFont
  fontSize: number
  lineHeight: number
  maxWidth: number
}

export const DEFAULT_READING_PREFERENCE: ReadingPreference = {
  bodyFont: 'literary',
  headingFont: 'system',
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
