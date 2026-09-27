import type { HeadingRef } from '@markdown'

/**
 * 标题索引。围栏 docs/frontend.md §编辑画布与辅助信息：
 * 只取正文的一级、二级、三级标题；通常显示紧凑短横线、右对齐，一级最长、三级最短；
 * 悬停或键盘聚焦显示完整标题，激活后跳到对应标题；当前阅读位置有清楚的状态。
 *
 * 这里只有「算」的部分，DOM 由 shell 渲染。间距按早期过疏稿的 40%。
 */

export type OutlineMark = {
  heading: HeadingRef
  /** 短横线相对长度：一级 1、二级 0.72、三级 0.5。 */
  scale: number
  current: boolean
}

const SCALE: Record<number, number> = { 1: 1, 2: 0.72, 3: 0.5 }

/**
 * 把标题算成索引短横线。
 *
 * 「当前」的判据：光标在可视范围内时以**光标**为准（点了索引或正在哪一节里写就指哪一节），
 * 否则以**视口起点**为准（滚动阅读时指读到的那一节）。
 * 只看视口不够：点完一节，视口顶部常停在上一节的末尾，会指错。
 */
export function outlineMarks(
  headings: readonly HeadingRef[],
  viewport: { from: number; to: number },
  caret: number | null = null
): OutlineMark[] {
  const visible = headings.filter((heading) => heading.depth >= 1 && heading.depth <= 3)
  const anchor =
    caret != null && caret >= viewport.from && caret <= viewport.to ? caret : viewport.from
  let currentAt = -1
  for (let index = 0; index < visible.length; index += 1) {
    if (visible[index]!.range.start <= anchor) currentAt = index
    else break
  }
  return visible.map((heading, index) => ({
    heading,
    scale: SCALE[heading.depth] ?? 0.5,
    current: index === currentAt
  }))
}

export function outlineLabel(heading: HeadingRef): string {
  const text = heading.text.trim()
  return text === '' ? '（无标题）' : text
}
