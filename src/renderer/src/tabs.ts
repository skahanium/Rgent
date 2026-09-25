import { composeSource } from '../../markdown/partition.ts'

export type Tab = {
  relPath: string
  /** 正文。只进画布。 */
  content: string
  /** 旁路账本，画布不碰。没有锚点时为 null。 */
  ledger: string | null
  /** 上次成功写盘时的正文。 */
  saved: string
  /** 上次读盘或成功写盘的整文件修订值。 */
  revision: string
  dirty: boolean
}

export type PendingWrite = {
  relPath: string
  /** 要收进 tab 的正文。 */
  body: string
  /** 磁盘整文件：composeSource(body, ledger)。 */
  content: string
  expectedRevision: string
}

export function diskOf(tab: Pick<Tab, 'content' | 'ledger'>, body = tab.content): string {
  return composeSource(body, tab.ledger)
}

/**
 * 要写盘的是**所有**脏 tab，不只是当前这一个。
 *
 * 切 tab 只把上一篇的正文收进内存，并不清防抖定时器。若写盘只看 current()，
 * 在防抖窗口内改 A、切到 B、然后退出，A 的最后一截就只活在内存里。
 * 当前这篇用编辑器里的实时正文，后台那些用各自 tab 里存的正文；账本从旁路拼回去。
 */
export function pendingWrites(
  tabs: readonly Tab[],
  active: string | null,
  activeText: string
): PendingWrite[] {
  const out: PendingWrite[] = []
  for (const tab of tabs) {
    if (!tab.dirty) continue
    const body = tab.relPath === active ? activeText : tab.content
    out.push({
      relPath: tab.relPath,
      body,
      content: composeSource(body, tab.ledger),
      expectedRevision: tab.revision
    })
  }
  return out
}

export function applySaved(tab: Tab, body: string, revision: string): void {
  tab.saved = body
  tab.revision = revision
  tab.dirty = tab.content !== body
}
