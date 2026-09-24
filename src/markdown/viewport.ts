export function inViewport(range: { start: number; end: number }, from: number, to: number): boolean {
  return range.end > from && range.start < to
}
