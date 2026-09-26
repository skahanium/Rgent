/** 应用自己刚落盘的一次记录。 */
export type RecentWrite = {
  revision: string
  at: number
}

/** 自家写盘的回声窗口。目录扫描是 1 秒一次，2 秒足够覆盖一次落盘后的回扫。 */
export const ECHO_WINDOW_MS = 2000

/**
 * 是不是应用自己刚写下的那一版。
 *
 * 判据用**修订值**而不是整篇内容：内容比较在「读盘与查记录之间有一次 await」时
 * 会把自家存盘误判成外部改动。调用方必须先取记录、再读盘——顺序反了就会拿新记录
 * 去比旧内容，把旧内容当成外部改动推给画布，把用户的稿回退掉。
 */
export function isOwnEcho(
  recent: RecentWrite | undefined,
  revision: string,
  now: number,
  windowMs: number = ECHO_WINDOW_MS
): boolean {
  return recent != null && recent.revision === revision && now - recent.at < windowMs
}
