import {
  compile,
  DEFAULT_STAGES,
  lineStartOf,
  planIdentityEdit,
  planWidgets,
  rangesOverlap,
  recoverCompile,
  type CompileResult,
  type EditChange
} from '@markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { Compartment, EditorState, Facet, StateField, Transaction, type Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap
} from '@codemirror/view'
import { emptyNoteHost, type NoteHost } from './host.ts'
import { decorationForWidget } from './widgets/decorate.ts'

const noteHostFacet = Facet.define<NoteHost, NoteHost>({
  combine: (values) => values[0] ?? emptyNoteHost
})

/**
 * 主题是不是夜间。装饰要跟着它重建——mermaid 的 SVG 自带主题，不重建就还是旧色。
 */
const themeFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? false
})

/**
 * 装饰必须由 **StateField** 提供，不能由 ViewPlugin 提供。
 *
 * CM6 明确禁止插件产生块装饰（`Block decorations may not be specified via plugins`），
 * 而表格 / callout / mermaid / 块级公式都是整块替换。原先这些挂在 ViewPlugin 上，
 * `view.dispatch` 一渲染就抛 RangeError，异常又被 `openNote` 的 catch 吞掉——
 * 结果是「含表格的笔记点不开，界面毫无提示」。
 *
 * 顺带的好处：事务过滤可以直接读这个字段判「未采纳的 AI 块不能改字」。
 */
type MarkdownState = {
  result: CompileResult
  decorations: DecorationSet
}

function computeState(source: string, host: NoteHost, dark: boolean, previous?: CompileResult): MarkdownState {
  try {
    const result = compile(source, previous ? { prev: previous } : {})
    return { result, decorations: decorationsFor(result, source, host, dark) }
  } catch (err) {
    const result = recoverCompile(
      source,
      previous?.stages ?? DEFAULT_STAGES,
      err instanceof Error ? err.message : String(err),
      previous
    )
    try {
      return { result, decorations: decorationsFor(result, source, host, dark) }
    } catch {
      return { result, decorations: Decoration.none }
    }
  }
}

/**
 * 编译结果与装饰都由这一个字段提供（块装饰只能来自 StateField，见上面的注释）。
 *
 * 导出它和 `identityLock` 是为了能在没有 DOM 的情况下单测状态层：执法逻辑以前
 * 零覆盖，绕过与光标错位都藏在这条缝里（`test/renderer/identity-guard.test.ts`）。
 */
export const markdownField = StateField.define<MarkdownState>({
  // 注意：这里不能 `state.field(markdownField)` 读自己——CM6 会报
  // 「Cyclic dependency between fields and/or facets」，代价是整个界面渲染不出来。
  // 上一代结果由 update 的 value 参数直接带过来。
  create: (state) =>
    computeState(state.doc.toString(), state.facet(noteHostFacet), state.facet(themeFacet)),
  update: (value, tr) => {
    const hostChanged = tr.startState.facet(noteHostFacet) !== tr.state.facet(noteHostFacet)
    const themeChanged = tr.startState.facet(themeFacet) !== tr.state.facet(themeFacet)
    if (!tr.docChanged && !hostChanged && !themeChanged) return value
    return computeState(
      tr.state.doc.toString(),
      tr.state.facet(noteHostFacet),
      tr.state.facet(themeFacet),
      value.result
    )
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

function decorationsFor(
  result: CompileResult,
  source: string,
  host: NoteHost,
  dark: boolean
): DecorationSet {
  const decos: Range<Decoration>[] = []
  const docLen = source.length
  // 整篇一次算完：CM6 只会为可见范围建 DOM，所以这里不必再按视口裁一遍。
  const widgets = planWidgets(result.index, source, [{ from: 0, to: docLen }])
  // 同一行可能既是标题又是 AI 块，行装饰必须合并成一条，不能挤两条。
  const lineClasses = new Map<number, string[]>()

  const addLine = (pos: number, className: string): void => {
    if (pos < 0 || pos > docLen) return
    const current = lineClasses.get(pos)
    if (current) {
      if (!current.includes(className)) current.push(className)
      return
    }
    lineClasses.set(pos, [className])
  }

  for (const widget of widgets) {
    if (widget.range.start < 0 || widget.range.end > docLen || widget.range.end <= widget.range.start) continue
    try {
      decos.push(decorationForWidget(widget, host, dark).range(widget.range.start, widget.range.end))
    } catch {
      continue
    }
  }

  for (const heading of result.index.headings) {
    if (heading.range.start < 0 || heading.range.start >= docLen) continue
    if (widgets.some((widget) => rangesOverlap(heading.range, widget.range))) continue
    addLine(lineStartOf(source, heading.range.start), `md-heading md-h${heading.depth}`)
  }

  // 两种样子：人写的没有任何装饰；未采纳的 AI 块与口令各挂一种行样式。
  for (const block of result.index.blocks) {
    if (!block.identity) continue
    if (block.range.start < 0 || block.range.start >= docLen) continue
    const className = block.identity === 'ai' ? 'rgent-block-ai' : 'rgent-block-command'
    let line = lineStartOf(source, block.range.start)
    for (;;) {
      addLine(line, className)
      const next = source.indexOf('\n', line)
      if (next < 0 || next + 1 > block.range.end) break
      line = next + 1
    }
  }

  for (const [pos, classes] of lineClasses) {
    try {
      decos.push(Decoration.line({ class: classes.join(' ') }).range(pos))
    } catch {
      continue
    }
  }

  for (const mark of result.index.marks) {
    if (widgets.some((widget) => rangesOverlap(mark.range, widget.range))) continue
    const start = clamp(mark.range.start, 0, docLen)
    const end = clamp(mark.range.end, 0, docLen)
    if (end <= start) continue
    try {
      decos.push(Decoration.mark({ class: `md-${mark.type}` }).range(start, end))
    } catch {
      continue
    }
  }

  return Decoration.set(decos, true)
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function changesOf(tr: { changes: { iterChanges: (fn: (fromA: number, toA: number, fromB: number, toB: number, inserted: { toString: () => string }) => void) => void } }): EditChange[] {
  const changes: EditChange[] = []
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({ from: fromA, to: toA, insert: inserted.toString() })
  })
  return changes
}

/**
 * 围栏：未采纳的 AI 块不能改字（先采纳再改，或删掉再问）。
 *
 * 默认**拦下所有改文档的事务**，而不是只认 input / delete 两类用户事件——
 * 后者会被 Alt-上下移行、拖动搬字、Ctrl-T 换位、缩进重排整批绕过（实测 Ctrl-T
 * 能把 AI 块里的字换位），因为它们报的是 `move.*`。只有明确属于我们自己的动作
 * （chip 上的删标记 / 丢弃 / 搬家、切 tab 的整篇替换）才放行，靠 `rgent` 前缀的
 * userEvent 认领。
 *
 * 另两条改写（都在 planIdentityEdit 里算）：
 * - 整块删掉未采纳的 AI 块时，把它的标记行一起删，否则标记会就近标到下一段人写的字上；
 * - 在锁定块**下方那行**打字时先补一个断段符——Markdown 里相邻两行同段，不补的话
 *   用户刚打的字会被并进 AI 块，然后被自己锁住。
 */
export const identityLock = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr
  if (tr.isUserEvent('rgent')) return tr
  const index = tr.startState.field(markdownField).result.index
  const changes = changesOf(tr)
  const plan = planIdentityEdit(tr.startState.doc.toString(), changes, index)
  if (plan.blocked) return []
  if (!plan.changes) return tr
  // 补过断段符的插入点要让光标一起右移，否则下一键会插在断段符之前。
  // 注意这里是「原位置 + 前面补过的断段符个数」，不是那个个数本身。
  const shifted = (position: number): number =>
    position + plan.prefixed.filter((at) => at <= position).length
  const selection = tr.selection ?? tr.startState.selection
  return {
    changes: plan.changes,
    selection: {
      anchor: shifted(selection.main.anchor),
      head: shifted(selection.main.head)
    },
    userEvent: 'rgent.adjust'
  }
})


// 颜色一律走 token（围栏：颜色只有一个来源），这里不写死任何色值。
const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--text-body)',
    fontSize: '17px'
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-body)',
    lineHeight: '1.65'
  },
  '.cm-content': {
    caretColor: 'var(--accent-focus)',
    padding: '28px 8px 48px',
    maxWidth: '42rem',
    margin: '0 auto'
  },
  '.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent-focus)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft)'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-muted)',
    border: 'none'
  }
})

export type EditorHost = {
  view: EditorView
  getText: () => string
  setText: (text: string, host?: NoteHost) => void
  setNoteHost: (host: NoteHost) => void
  /** 只跟着系统主题走；不写盘、不进撤销栈。 */
  setTheme: (night: boolean) => void
  focus: () => void
  destroy: () => void
}

export type { NoteHost }

export function mountEditor(
  parent: HTMLElement,
  onChange: (text: string) => void,
  onSave: () => void
): EditorHost {
  let applying = false
  const hostCompartment = new Compartment()
  // 撤销历史按笔记隔离：整篇替换若留在历史里，切 tab 之后按撤销会把上一篇的文本
  // 填进当前篇（随后还会被自动保存写盘）——实测过。
  const historyCompartment = new Compartment()
  // 主题：CM6 自带的默认样式跟 darkTheme 走，装饰跟 themeFacet 走。
  const themeCompartment = new Compartment()
  let dark = false
  const state = EditorState.create({
    doc: '',
    extensions: [
      historyCompartment.of(history()),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        {
          key: 'Mod-s',
          run: () => {
            onSave()
            return true
          }
        }
      ]),
      EditorView.lineWrapping,
      theme,
      themeCompartment.of([EditorView.darkTheme.of(false), themeFacet.of(false)]),
      hostCompartment.of(noteHostFacet.of(emptyNoteHost)),
      markdownField,
      identityLock,
      EditorView.updateListener.of((update) => {
        if (applying || !update.docChanged) return
        onChange(update.state.doc.toString())
      })
    ]
  })
  const view = new EditorView({ state, parent })
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText: (text, host) => {
      applying = true
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        // 换一篇笔记 = 换一份撤销历史，外加这次替换本身不进历史。
        effects: [
          historyCompartment.reconfigure(history()),
          ...(host ? [hostCompartment.reconfigure(noteHostFacet.of(host))] : [])
        ],
        annotations: Transaction.addToHistory.of(false),
        userEvent: 'rgent.setText'
      })
      applying = false
    },
    setNoteHost: (host) => {
      view.dispatch({ effects: hostCompartment.reconfigure(noteHostFacet.of(host)) })
    },
    setTheme: (night) => {
      if (night === dark) return
      dark = night
      // 只重配置，不产生文档事务：主题不该进撤销栈、也不该触发保存。
      view.dispatch({
        effects: themeCompartment.reconfigure([
          EditorView.darkTheme.of(night),
          themeFacet.of(night)
        ])
      })
    },
    focus: () => view.focus(),
    destroy: () => view.destroy()
  }
}
