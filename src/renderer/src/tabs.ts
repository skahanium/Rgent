import type { NoteAvailability } from '../../shared/ipc.ts'

export type Tab = {
  relPath: string
  /** 下一场模型覆盖：只活在这个已核验对象的 tab 内，不写设备配置。 */
  temporaryModelId?: string
  /** 正文。只进画布。 */
  content: string
  /** 旁路账本，画布不碰。没有锚点时为 null。 */
  ledger: string | null
  ledgerStatus?:import('../../shared/ipc.ts').NoteSnapshot['ledger']
  /** 上次成功写盘时的正文。 */
  saved: string
  /** 上次读盘或成功写盘的整文件修订值。 */
  revision: string
  dirty: boolean
  sessionId?: string
  objectVersion?: string
  availability?: NoteAvailability
  /** Editor selection kept per open tab; document bytes remain the only persisted content. */
  scrollTop?: number
  selection?: { anchor: number; head: number }
}

export type PendingWrite = {
  relPath: string
  /** 要收进 tab 的正文。 */
  body: string
  /** 磁盘正文；账本只由主进程保存。 */
  content: string
  expectedRevision: string
}

export function diskOf(tab: Pick<Tab, 'content' | 'ledger'>, body = tab.content): string {
  return body
}

/** Recovery may exempt only clean paths supplied by the verified main-process journal. */
export function hasUnavailableDraft(tabs: readonly Tab[], cleanRecoveryPaths: readonly string[] = []): boolean {
  return tabs.some(tab => !!tab.availability && (tab.dirty || !cleanRecoveryPaths.includes(tab.relPath)))
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
      content: body,
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

/** 临时选择失效时仍返回该 ID，由调用方显错，绝不回退默认。 */
export function taskModelId(tab: Tab | undefined, defaultModelId: string | null): string | null {
  return tab ? tab.temporaryModelId ?? defaultModelId : null
}
