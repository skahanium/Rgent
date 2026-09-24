import type { Partition } from './types.ts'

/** 本刀恒等：全文即正文。账本落盘格式未锁，只留接缝。 */
export function partitionSource(source: string): Partition {
  return { body: source, ledger: null, bodyOffset: 0 }
}
