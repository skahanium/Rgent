/**
 * 主题：只跟随系统。
 *
 * 围栏（docs/frontend.md §设计语言）要日夜两套值；「自动切换方式」仍是未锁项，
 * 所以这一刀只做跟随系统，不做手动开关（设置面板未开，开关归它）。
 *
 * 主题不碰文档：这里只改根元素属性与订阅者，不产生任何编辑器事务、不触发保存。
 */

export type Theme = 'day' | 'night'

const QUERY = '(prefers-color-scheme: dark)'

export function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia(QUERY).matches ? 'night' : 'day'
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme
}

/** 应用当前主题并在系统切换时跟随；返回取消订阅。 */
export function watchTheme(onChange: (theme: Theme) => void): () => void {
  const apply = (): void => {
    const theme = systemTheme()
    applyTheme(theme)
    onChange(theme)
  }
  apply()
  if (typeof matchMedia !== 'function') return () => {}
  const media = matchMedia(QUERY)
  media.addEventListener('change', apply)
  return () => media.removeEventListener('change', apply)
}
