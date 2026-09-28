type Change = { start: number; end: number; insert: string }

function singleChange(base: string, next: string): Change | null {
  if (base === next) return null
  let start = 0
  while (start < base.length && start < next.length && base[start] === next[start]) start += 1
  let baseEnd = base.length
  let nextEnd = next.length
  while (baseEnd > start && nextEnd > start && base[baseEnd - 1] === next[nextEnd - 1]) {
    baseEnd -= 1
    nextEnd -= 1
  }
  return { start, end: baseEnd, insert: next.slice(start, nextEnd) }
}

/** Only merge when one contiguous draft edit and one Host edit are provably disjoint. */
export function mergeHostBody(base: string, draft: string, disk: string): string | null {
  const human = singleChange(base, draft)
  const host = singleChange(base, disk)
  if (!human) return disk
  if (!host) return draft
  if (human.start < host.end && host.start < human.end) return null
  if (human.start === host.start || human.end === host.start || host.end === human.start) {
    // Adjacent insertions can change Markdown block identity; ask the user.
    if (human.start === human.end || host.start === host.end) return null
  }
  const changes = [human, host].sort((a, b) => b.start - a.start)
  let merged = base
  for (const change of changes) merged = merged.slice(0, change.start) + change.insert + merged.slice(change.end)
  return merged
}
