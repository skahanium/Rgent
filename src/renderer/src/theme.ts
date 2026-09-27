/**
 * 主进程在创建窗口前设置 nativeTheme.themeSource；这个媒体查询只负责把
 * 实际生效的日夜外观映射到渲染层 token 和编辑器，不独立保存主题偏好。
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
