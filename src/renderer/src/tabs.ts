export type Tab = {
  relPath: string
  content: string
  saved: string
  dirty: boolean
}

export type PendingWrite = {
  relPath: string
  content: string
}

/**
 * 要写盘的是**所有**脏 tab，不只是当前这一个。
 *
 * 切 tab 只把上一篇的内容收进内存，并不清防抖定时器。若写盘只看 current()，
 * 在防抖窗口内改 A、切到 B、然后退出，A 的最后一截就只活在内存里。
 * 当前这篇用编辑器里的实时文本，后台那些用各自 tab 里存的内容。
 */
export function pendingWrites(
  tabs: readonly Tab[],
  active: string | null,
  activeText: string
): PendingWrite[] {
  const out: PendingWrite[] = []
  for (const tab of tabs) {
    if (!tab.dirty) continue
    out.push({
      relPath: tab.relPath,
      content: tab.relPath === active ? activeText : tab.content
    })
  }
  return out
}
