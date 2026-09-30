import { invertedEffects, isolateHistory } from '@codemirror/commands'
import { EditorState, StateEffect, StateField, type TransactionSpec } from '@codemirror/state'

export function normalizeSource(raw: string): string {
  return raw.replace(/\r\n?|\n/g, '\n')
}

/** CM 的一字符换行与磁盘原文之间的单调映射；偏移均按 UTF-16。 */
export class SourceProjection {
  readonly text: string
  private readonly pairs: Array<{ raw: number; view: number }> = []
  constructor(readonly raw: string) {
    this.text = normalizeSource(raw)
    for (let at = raw.indexOf('\r\n'); at >= 0; at = raw.indexOf('\r\n', at + 2)) {
      this.pairs.push({ raw: at, view: at - this.pairs.length })
    }
  }
  toRaw(position: number): number {
    const at = Math.max(0, Math.min(this.text.length, position))
    let low = 0, high = this.pairs.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.pairs[mid]!.view < at) low = mid + 1
      else high = mid
    }
    return at + low
  }
  toView(position: number): number {
    const at = Math.max(0, Math.min(this.raw.length, position))
    let low = 0, high = this.pairs.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.pairs[mid]!.raw < at) low = mid + 1
      else high = mid
    }
    return at - low
  }
  inserted(text: string, viewAt: number): string {
    const at = this.toRaw(viewAt)
    // 优先沿用插入点所在行的结尾；没有后文则沿用前一行。
    const after = /\r\n|\r|\n/.exec(this.raw.slice(at))
    const before = this.raw.slice(0, at).match(/\r\n|\r|\n/g)?.at(-1)
    return normalizeSource(text).replace(/\n/g, after?.[0] ?? before ?? '\n')
  }
}

export const setRawSource = StateEffect.define<string>()
type RawReplacement = { from: number; to: number; insert: string }
const replaceRaw = StateEffect.define<readonly RawReplacement[]>({
  map: (edits, changes) => changes.empty ? edits : edits.map((edit) => ({
    ...edit,
    from: changes.mapPos(edit.from, 1),
    to: changes.mapPos(edit.to, -1)
  }))
})

export const rawSourceField = StateField.define<SourceProjection>({
  create: (state) => new SourceProjection(state.doc.toString()),
  update: (old, tr) => {
    const explicit = tr.effects.find((effect) => effect.is(setRawSource))
    if (explicit) return new SourceProjection(explicit.value as string)
    if (!tr.docChanged) return old
    const exact = tr.effects.flatMap((effect) => effect.is(replaceRaw) ? effect.value : [])
    let raw = '', previous = 0
    tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      raw += old.raw.slice(previous, old.toRaw(from))
      raw += exact.find((edit) => edit.from === from && normalizeSource(edit.insert) === inserted.toString())?.insert ?? old.inserted(inserted.toString(), from)
      previous = old.toRaw(to)
    })
    raw += old.raw.slice(previous)
    return new SourceProjection(raw)
  }
})

export function sourceOf(state: EditorState): SourceProjection {
  return state.field(rawSourceField)
}

export const rawSourceHistory = invertedEffects.of((tr) => {
  if (!tr.docChanged) return []
  const old = sourceOf(tr.startState)
  const edits: RawReplacement[] = []
  tr.changes.iterChanges((from, to, fromB, toB) => {
    edits.push({ from: fromB, to: toB, insert: old.raw.slice(old.toRaw(from), old.toRaw(to)) })
  })
  return [replaceRaw.of(edits)]
})

/** 原文字节作为独立 effect 传递，CM 的 insert 始终只携带 LF 投影。 */
export function rawEditSpec(state: EditorState, edit: { from: number; to: number; insert: string }): TransactionSpec {
  const source = sourceOf(state)
  const from = source.toView(edit.from), to = source.toView(edit.to)
  return {
    changes: { from, to, insert: normalizeSource(edit.insert) },
    effects: replaceRaw.of([{ from, to, insert: edit.insert }]),
    annotations: isolateHistory.of('full')
  }
}
