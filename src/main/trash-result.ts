/**
 * 删除收据的纯判据：不读写磁盘，`stat`／`resolve` 由调用方注入，便于单测。
 *
 * 原生层已经做过「送篓前再核一次身份」，但最后核验与系统调用之间仍有窗口；
 * 这两个函数补的是**送篓之后**能证明什么、不能证明什么，而不是再赌一次。
 */

/** 落点核验结果：`unverified` 只表示系统没给可核对的收据，不等于删除失败。 */
export type LandingVerdict = 'verified' | 'unverified'

/**
 * 核验系统废纸篓的落点是否仍是刚送出的那个对象。
 * - 空落点：系统没给收据，只能记 `unverified`，不冒充证明；
 * - `dev:ino` 对不上：删的不是确认过的对象，抛 `LANDING_MISMATCH`（不可悄悄当成功）。
 */
export function verifyLanding(
  landing: string | null | undefined,
  expectedId: string,
  stat: (path: string) => { dev: number; ino: number }
): LandingVerdict {
  if (!landing) return 'unverified'
  const { dev, ino } = stat(landing)
  if (`${dev}:${ino}` !== expectedId) throw new Error('LANDING_MISMATCH')
  return 'verified'
}

/**
 * 送篓后原路径必须不再解析到任何对象：`ENOENT`（或解析不到）才算 `gone`。
 * 还有对象——无论是不是同一身份——都说明删除期间有人写回，抛 `TRASH_CONFLICT`；
 * 其它异常原样抛出，由既有错误通道处理。
 */
export function postTrashOutcome(resolve: () => { id: string } | null): 'gone' {
  let current: { id: string } | null
  try { current = resolve() }
  catch (error) {
    if (error instanceof Error && error.message === 'ENOENT') return 'gone'
    throw error
  }
  if (!current) return 'gone'
  throw new Error('TRASH_CONFLICT')
}
