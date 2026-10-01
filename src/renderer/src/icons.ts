/**
 * 图标：一套内联 SVG，统一 16×16 网格、1.5 线宽、currentColor 描边。
 * 尺寸可小，可点区域由外面的行负责；图标本身一律 aria-hidden，
 * 语义交给所在控件的文字与 aria-label。
 *
 * 不引图标库：多一个依赖不值当，协议只要求同一套网格与线重。
 */

const NS = 'http://www.w3.org/2000/svg'

export type IconName =
  | 'folder'
  | 'folder-open'
  | 'note'
  | 'pdf'
  | 'image'
  | 'file'
  | 'plus'
  | 'settings'
  | 'close'
  | 'appearance'
  | 'assistant'
  | 'model'
  | 'run'

const PATHS: Record<IconName, string[]> = {
  folder: ['M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z'],
  'folder-open': ['M6 4l4 4-4 4'],
  note: ['M4 2h5l3 3v9H4z', 'M9 2v3h3', 'M6 8h4', 'M6 11h4'],
  pdf: ['M4 2h5l3 3v9H4z', 'M9 2v3h3', 'M6 12V9h1.2a1 1 0 0 1 0 2H6'],
  image: ['M3 3h10v10H3z', 'M3 10l3-3 3 3 2-2 2 2', 'M6.5 6.5h.01'],
  file: ['M4 2h5l3 3v9H4z', 'M9 2v3h3'],
  plus: ['M8 3.5v9', 'M3.5 8h9'],
  // 连续的八齿轮廓与中心孔，区别于「界面」的太阳图标。
  settings: ['M12.44 6.81L14.3 6.89L14.3 9.11L12.44 9.19L11.98 10.3L13.24 11.67L11.67 13.24L10.3 11.98L9.19 12.44L9.11 14.3L6.89 14.3L6.81 12.44L5.7 11.98L4.33 13.24L2.76 11.67L4.02 10.3L3.56 9.19L1.7 9.11L1.7 6.89L3.56 6.81L4.02 5.7L2.76 4.33L4.33 2.76L5.7 4.02L6.81 3.56L6.89 1.7L9.11 1.7L9.19 3.56L10.3 4.02L11.67 2.76L13.24 4.33L11.98 5.7z', 'M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5'],
  close: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
  appearance: ['M8 2v1.5', 'M8 12.5V14', 'M2 8h1.5', 'M12.5 8H14', 'M3.8 3.8l1.1 1.1', 'M11.1 11.1l1.1 1.1', 'M12.2 3.8l-1.1 1.1', 'M4.9 11.1l-1.1 1.1', 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6'],
  assistant: ['M8 3.1a2.55 2.55 0 1 1 0 5.1 2.55 2.55 0 0 1 0-5.1', 'M3.1 13.4c0-2.4 2.2-4.2 4.9-4.2s4.9 1.8 4.9 4.2'],
  model: ['M8 2.2l4.8 2.9v5.8L8 13.8l-4.8-2.9V5.1z', 'M3.2 5.1L8 8l4.8-2.9', 'M8 8v5.8'],
  run: ['M5 3.4l7 4.6-7 4.6z']
}

export function icon(name: IconName, className = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('class', className ? `icon ${className}` : 'icon')
  for (const d of PATHS[name]) {
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'])

/** 按扩展名挑图标；没有扩展名或认不出来一律用通用文件图标。 */
export function iconForFile(name: string): IconName {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (ext === 'md' || ext === 'markdown') return 'note'
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_EXT.has(ext)) return 'image'
  return 'file'
}
