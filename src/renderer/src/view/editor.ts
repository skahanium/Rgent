import {
  compile,
  DEFAULT_STAGES,
  expandToLineBlock,
  identityUnits,
  type HeadingRef,
  type MarkerRef,
  lineStartOf,
  planIdentityEdit,
  parseMarker,
  planPresentation,
  planWidgets,
  rangesOverlap,
  recoverCompile,
  type CompileResult,
  type PresentationPlan,
  type EditChange
} from '@markdown'
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands'
import { Compartment, EditorState, Facet, StateField, Transaction, type Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  WidgetType
} from '@codemirror/view'
import { SourceProjection, normalizeSource, sourceOf, rawSourceField, rawSourceHistory, setRawSource } from './source.ts'
import { emptyNoteHost, type NoteHost } from './host.ts'
import { decorationForWidget } from './widgets/decorate.ts'
import { renderSafeHtmlFragment } from './safe-html.ts'
import { renderReadOnlyNode } from './read-only.ts'
import { joinVaultRel } from '../../../shared/vault-rel.ts'
import type { Root } from 'mdast'
import type { PresentationBlock, PresentationSyntax } from '../../../markdown/presentation.ts'

class SyntaxMarkerWidget extends WidgetType {
  constructor(readonly marker: PresentationSyntax) { super() }

  eq(other: SyntaxMarkerWidget): boolean {
    return this.marker.kind === other.marker.kind && this.marker.text === other.marker.text && this.marker.checked === other.marker.checked
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = `md-syntax-marker md-syntax-${this.marker.kind}`
    if (this.marker.kind === 'task') {
      span.textContent = this.marker.checked ? '☑' : '☐'
      span.setAttribute('aria-label', this.marker.checked ? '已完成' : '未完成')
    } else span.textContent = this.marker.text ?? ''
    return span
  }
}

class PresentationBlockWidget extends WidgetType {
  constructor(readonly block: PresentationBlock) { super() }

  eq(other: PresentationBlockWidget): boolean {
    return this.block.kind === other.block.kind
      && this.block.range.start === other.block.range.start
      && this.block.range.end === other.block.range.end
      && this.block.value === other.block.value
      && this.block.language === other.block.language
  }

  toDOM(view: EditorView): HTMLElement {
    const reveal = (element: HTMLElement): HTMLElement => {
      // CM6 把整块替换后，落在 widget 上的鼠标坐标可能映射到块尾的下一行。
      // 明确把光标放回当前源码范围，保证点摘要/代码/HTML 都能进入编辑。
      element.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        view.dispatch({ selection: { anchor: sourceOf(view.state).toView(Math.min(this.block.range.start + 1, this.block.range.end)) } })
        view.focus()
      })
      return element
    }
    if (this.block.kind === 'rule') {
      const rule = document.createElement('hr')
      rule.className = 'md-rule'
      return reveal(rule)
    }
    if (this.block.kind === 'frontmatter') {
      const summary = document.createElement('div')
      summary.className = 'md-frontmatter'
      const entries = this.block.value.split('\n').map((line) => line.trim()).filter(Boolean)
      const label = document.createElement('span')
      label.className = 'md-frontmatter-label'
      label.textContent = '属性'
      const preview = document.createElement('span')
      preview.textContent = entries.slice(0, 3).join(' · ') || '空属性'
      summary.append(label, preview)
      return reveal(summary)
    }
    if (this.block.kind === 'html') {
      const wrapper = document.createElement('div')
      wrapper.className = 'md-html'
      wrapper.append(this.block.node
        ? renderReadOnlyNode(this.block.node, this.block.source ?? this.block.value)
        : renderSafeHtmlFragment(this.block.value))
      return reveal(wrapper)
    }
    const wrapper = document.createElement('div')
    wrapper.className = 'md-code-block'
    if (this.block.language) {
      const label = document.createElement('div')
      label.className = 'md-code-language'
      label.textContent = this.block.language
      wrapper.append(label)
    }
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = this.block.value
    pre.append(code)
    wrapper.append(pre)
    return reveal(wrapper)
  }
}

const noteHostFacet = Facet.define<NoteHost, NoteHost>({
  combine: (values) => values[0] ?? emptyNoteHost
})

/**
 * 主题是不是夜间。装饰要跟着它重建——mermaid 的 SVG 自带主题，不重建就还是旧色。
 */
const themeFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? false
})

const activeTaskIdsFacet = Facet.define<ReadonlySet<string>, ReadonlySet<string>>({
  combine: (values) => values[0] ?? new Set<string>()
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
  presentation: PresentationPlan
  decorations: DecorationSet
  editing: boolean
}

function computeState(projection: SourceProjection, host: NoteHost, dark: boolean, selection: { from: number; to: number }, editing: boolean, previous?: CompileResult): MarkdownState {
  const source = projection.raw
  const rawSelection = { from: projection.toRaw(selection.from), to: projection.toRaw(selection.to) }
  try {
    const result = compile(source, previous ? { prev: previous } : {})
    const presentation = result.stale ? planPresentation(null, source) : planPresentation(result.tree, result.partition.body)
    return { result, presentation, decorations: decorationsFor(result, presentation, projection, host, dark, rawSelection, editing), editing }
  } catch (err) {
    const result = recoverCompile(
      source,
      previous?.stages ?? DEFAULT_STAGES,
      err instanceof Error ? err.message : String(err),
      previous
    )
    try {
      const presentation = planPresentation(null, source)
      return { result, presentation, decorations: decorationsFor(result, presentation, projection, host, dark, rawSelection, editing), editing }
    } catch {
      return { result, presentation: planPresentation(null, source), decorations: Decoration.none, editing }
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
    computeState(sourceOf(state), state.facet(noteHostFacet), state.facet(themeFacet), state.selection.main, false),
  update: (value, tr) => {
    const hostChanged = tr.startState.facet(noteHostFacet) !== tr.state.facet(noteHostFacet)
    const themeChanged = tr.startState.facet(themeFacet) !== tr.state.facet(themeFacet)
    const sourceChanged = sourceOf(tr.startState) !== sourceOf(tr.state)
    if (!sourceChanged && !hostChanged && !themeChanged && !tr.selection) return value
    const editing = tr.isUserEvent('rgent.setText') ? false : value.editing || Boolean(tr.selection) || (tr.docChanged && !tr.isUserEvent('rgent'))
    if (!sourceChanged && !hostChanged && !themeChanged) {
      return {
        ...value,
        editing,
        decorations: decorationsFor(value.result, value.presentation, sourceOf(tr.state), tr.state.facet(noteHostFacet), tr.state.facet(themeFacet), { from: sourceOf(tr.state).toRaw(tr.state.selection.main.from), to: sourceOf(tr.state).toRaw(tr.state.selection.main.to) }, editing)
      }
    }
    return computeState(
      sourceOf(tr.state),
      tr.state.facet(noteHostFacet),
      tr.state.facet(themeFacet),
      tr.state.selection.main,
      editing,
      value.result
    )
  },
  provide: (field) => [rawSourceField, rawSourceHistory, EditorView.decorations.from(field, (value) => value.decorations)]
})

function decorationsFor(
  result: CompileResult,
  presentation: PresentationPlan,
  projection: SourceProjection,
  host: NoteHost,
  dark: boolean,
  selection: { from: number; to: number },
  editing: boolean
): DecorationSet {
  const source = projection.raw
  const at = (position: number): number => projection.toView(position)
  const decos: Range<Decoration>[] = []
  const docLen = source.length
  if (result.stale) return Decoration.none
  // 阅读投影块与原文编辑单位不同：进入图片后的文字不应把图片也切成源码。
  const projectedBlocks = (result.tree as Root).children.flatMap((node) => {
    const start = node.position?.start.offset, end = node.position?.end.offset
    return start == null || end == null ? [] : [{ range: { start, end } }]
  })
  const active = editing ? projectedBlocks.filter((block) =>
    selection.from === selection.to
      ? block.range.start <= selection.from && selection.from < block.range.end
      : rangesOverlap(block.range, { start: selection.from, end: selection.to })
  ) : []
  const isActive = (range: { start: number; end: number }): boolean =>
    active.some((block) => rangesOverlap(block.range, range))
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
    if (isActive(widget.range)) continue
    try {
      decos.push(decorationForWidget(widget, host, dark).range(at(widget.range.start), at(widget.range.end)))
    } catch {
      continue
    }
  }

  for (const block of presentation.blocks) {
    if (isActive(block.range) || widgets.some((widget) => rangesOverlap(widget.range, block.range))) continue
    const range = expandToLineBlock(source, block.range)
    if (range.end <= range.start || range.end > docLen) continue
    try {
      decos.push(Decoration.replace({ widget: new PresentationBlockWidget(block), block: true, rgentBlock: block.kind }).range(at(range.start), at(range.end)))
    } catch {
      continue
    }
  }

  for (const heading of result.index.headings) {
    if (heading.range.start < 0 || heading.range.start >= docLen) continue
    if (widgets.some((widget) => rangesOverlap(heading.range, widget.range))) continue
    addLine(lineStartOf(source, heading.range.start), `md-heading md-h${heading.depth}`)
  }

  for (const line of presentation.lines) addLine(line.at, line.className)

  // 两种样子：人写的没有任何装饰；未采纳的 AI 块与口令各挂一种行样式。
  for (const block of result.index.blocks) {
    if (!block.identity) continue
    if (block.range.start < 0 || block.range.start >= docLen) continue
    const className = block.identity === 'ai' ? 'rgent-block-ai' : 'rgent-block-command'
    let line = lineStartOf(source, block.range.start)
    if (block.identity === 'command') addLine(line, 'rgent-block-command-first')
    for (;;) {
      addLine(line, className)
      const offset = source.slice(line).search(/[\r\n]/)
      if (offset < 0) break
      const next = line + offset
      const after = next + (source.startsWith('\r\n', next) ? 2 : 1)
      if (after > block.range.end) break
      line = after
    }
  }

  for (const [pos, classes] of lineClasses) {
    try {
      decos.push(Decoration.line({ class: classes.join(' ') }).range(at(pos)))
    } catch {
      continue
    }
  }

  const renderedWidgets = [
    ...widgets.filter((widget) => !isActive(widget.range)),
    ...presentation.blocks.filter((block) => !isActive(block.range)).map((block) => ({ range: expandToLineBlock(source, block.range) }))
  ]
  for (const mark of presentation.styles) {
    if (renderedWidgets.some((widget) => rangesOverlap(mark.range, widget.range))) continue
    const start = clamp(mark.range.start, 0, docLen)
    const end = clamp(mark.range.end, 0, docLen)
    if (end <= start) continue
    try {
      const link = mark.className === 'md-link'
        ? presentation.links.find((item) => item.range.start === start && item.range.end === end)
        : undefined
      decos.push(Decoration.mark({ class: mark.className, ...(link ? { attributes: { 'data-md-url': link.url } } : {}) }).range(at(start), at(end)))
    } catch {
      continue
    }
  }

  for (const syntax of presentation.syntax) {
    if (isActive(syntax.range) || renderedWidgets.some((widget) => rangesOverlap(syntax.range, widget.range))) continue
    const start = clamp(syntax.range.start, 0, docLen)
    const end = clamp(syntax.range.end, 0, docLen)
    if (end <= start) continue
    try {
      if (syntax.kind === 'hide') decos.push(Decoration.replace({ rgentSyntax: 'hide' }).range(at(start), at(end)))
      else decos.push(Decoration.replace({ widget: new SyntaxMarkerWidget(syntax), rgentSyntax: syntax.kind }).range(at(start), at(end)))
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
  const result = tr.startState.field(markdownField).result
  if (result.stale) return []
  const index = result.index
  const projection = sourceOf(tr.startState)
  const changes = changesOf(tr).map((change) => ({ ...change, from: projection.toRaw(change.from), to: projection.toRaw(change.to) }))
  const activeIds = tr.startState.facet(activeTaskIdsFacet)
  if (activeIds.size) {
    const source = projection.raw
    for (const unit of identityUnits(index)) {
      if (!unit.marker) continue
      const taskId = parseMarker(source.slice(unit.marker.range.start, unit.marker.range.end))?.attrs['task-id']
      if (!taskId || !activeIds.has(taskId)) continue
      const start = lineStartOf(source, unit.marker.range.start)
      const end = unit.block.end
      if (changes.some((change) => change.from <= end && change.to >= start)) return []
    }
  }
  const plan = planIdentityEdit(projection.raw, changes, index)
  if (plan.blocked) return []
  if (!plan.changes) return tr
  // 补过断段符的插入点要让光标一起右移，否则下一键会插在断段符之前。
  // 注意这里是「原位置 + 前面补过的断段符个数」，不是那个个数本身。
  const shifted = (position: number): number =>
    position + plan.prefixed.filter((at) => projection.toView(at) <= position).length
  const selection = tr.selection ?? tr.startState.selection
  return {
    changes: plan.changes.map((change) => ({ ...change, from: projection.toView(change.from), to: projection.toView(change.to), insert: normalizeSource(change.insert ?? '') })),
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
    fontSize: 'var(--reading-font-size)'
  },
  '.cm-scroller': {
    fontFamily: 'var(--reading-font-family)',
    lineHeight: 'var(--reading-line-height)'
  },
  '.cm-content': {
    caretColor: 'var(--accent-focus)',
    flex: '0 0 auto',
    // 宽窗按参考图留出页眉呼吸感；窄窗由语义布局 token 缩小顶部留白。
    padding: 'var(--editor-top-padding) 8px 48px',
    width: 'calc(100cqw - var(--reading-side-gap) - var(--reading-side-gap))',
    maxWidth: 'var(--reading-max-width)',
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
  setText: (text: string, host?: NoteHost, selection?: { anchor: number; head: number }) => void
  /** Apply a saved Host change without replacing this tab's history or scroll position. */
  applyExternalText: (text: string) => void
  setActiveTaskIds: (ids: ReadonlySet<string>) => void
  setNoteHost: (host: NoteHost) => void
  /** 应用主进程选择后的实际日夜外观；不写笔记、不进撤销栈。 */
  setTheme: (night: boolean) => void
  /** 行列（1 起）、标题与可视起点，供底栏与标题索引消费。 */
  selectionInfo: () => { line: number; column: number }
  selectionRange: () => { anchor: number; head: number }
  headings: () => HeadingRef[]
  markers: () => MarkerRef[]
  /** 当前可视范围（文档偏移）；索引靠它算「读到哪了」。 */
  viewport: () => { from: number; to: number }
  /** 光标位置；不在可视范围内时返回 null。 */
  caret: () => number | null
  /** 跳过去：滚动到该处并把光标也放过去。 */
  scrollTo: (position: number) => void
  /** 选区或可视范围变化时回调；返回取消订阅。 */
  onStateChange: (listener: () => void) => () => void
  focus: () => void
  destroy: () => void
}

export type { NoteHost }

export function mountEditor(
  parent: HTMLElement,
  onChange: (text: string) => void
): EditorHost {
  let applying = false
  const warning = document.createElement('div')
  warning.className = 'md-render-warning md-parse-error'
  warning.setAttribute('role', 'alert')
  warning.hidden = true
  parent.append(warning)
  const hostCompartment = new Compartment()
  // 撤销历史按笔记隔离：整篇替换若留在历史里，切 tab 之后按撤销会把上一篇的文本
  // 填进当前篇（随后还会被自动保存写盘）——实测过。
  const historyCompartment = new Compartment()
  // 主题：CM6 自带的默认样式跟 darkTheme 走，装饰跟 themeFacet 走。
  const themeCompartment = new Compartment()
  const activeTaskCompartment = new Compartment()
  let dark = false
  const state = EditorState.create({
    doc: '',
    extensions: [
      historyCompartment.of(history()),
      EditorState.transactionExtender.of((tr) => {
        if (!tr.docChanged) return null
        const old = sourceOf(tr.startState)
        let separatorChanged = false
        tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
          if (/\n/.test(inserted.toString()) || /[\r\n]/.test(old.raw.slice(old.toRaw(from), old.toRaw(to)))) separatorChanged = true
        })
        return separatorChanged ? { annotations: isolateHistory.of('full') } : null
      }),
      // Mod-s 不在这里：保存的键位统一由 shortcuts.ts 定义，免得两处都能触发。
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      theme,
      themeCompartment.of([EditorView.darkTheme.of(false), themeFacet.of(false)]),
      activeTaskCompartment.of(activeTaskIdsFacet.of(new Set<string>())),
      hostCompartment.of(noteHostFacet.of(emptyNoteHost)),
      markdownField,
      identityLock,
      EditorView.domEventHandlers({
        click: (event, view) => {
          if (!event.metaKey && !event.ctrlKey) return false
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.md-link[data-md-url]') : null
          const href = target?.dataset.mdUrl
          if (!href) return false
          event.preventDefault()
          const host = view.state.facet(noteHostFacet)
          const rel = joinVaultRel(host.noteRelPath, href)
          if (rel?.toLowerCase().endsWith('.md') && host.vaultHas(rel)) host.openNote(rel)
          else {
            try {
              const url = new URL(href)
              if (url.protocol === 'https:' || url.protocol === 'http:') window.location.assign(url.href)
            } catch { /* malformed links stay visible but inert */ }
          }
          return true
        }
      }),
      EditorView.updateListener.of((update) => {
        const result = update.state.field(markdownField).result
        warning.hidden = !result.stale
        warning.textContent = result.stale ? `阅读呈现失败，以下是当前原文：${result.error ?? '解析错误'}` : ''
        if (update.docChanged || update.selectionSet || update.viewportChanged || sourceOf(update.startState) !== sourceOf(update.state)) {
          for (const listener of stateListeners) listener()
        }
        if (applying || !update.docChanged) return
        onChange(sourceOf(update.state).raw)
      })
    ]
  })
  const stateListeners = new Set<() => void>()
  const view = new EditorView({ state, parent })
  return {
    view,
    getText: () => sourceOf(view.state).raw,
    setText: (text, host, selection) => {
      const projection = new SourceProjection(text)
      applying = true
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: projection.text },
        // 换一篇笔记 = 换一份撤销历史 + 光标回到篇首；不归零的话上一篇的行列会被
        // 映射进新篇（实测：切过去停在「第 7 行」）。
        selection: {
          anchor: projection.toView(selection?.anchor ?? 0),
          head: projection.toView(selection?.head ?? selection?.anchor ?? 0)
        },
        effects: [
          historyCompartment.reconfigure(history()),
          setRawSource.of(text),
          ...(host ? [hostCompartment.reconfigure(noteHostFacet.of(host))] : []),
          EditorView.scrollIntoView(projection.toView(selection?.head ?? 0), { y: selection?.head ? 'center' : 'start' })
        ],
        annotations: Transaction.addToHistory.of(false),
        userEvent: 'rgent.setText'
      })
      applying = false
    },
    applyExternalText: (text) => {
      if (sourceOf(view.state).raw === text) return
      const old = view.state.doc.toString()
      const projected = normalizeSource(text)
      let from = 0
      while (from < old.length && from < projected.length && old[from] === projected[from]) from += 1
      let oldEnd = old.length
      let newEnd = projected.length
      while (oldEnd > from && newEnd > from && old[oldEnd - 1] === projected[newEnd - 1]) {
        oldEnd -= 1
        newEnd -= 1
      }
      applying = true
      try {
        view.dispatch({
          changes: { from, to: oldEnd, insert: projected.slice(from, newEnd) },
          effects: setRawSource.of(text),
          annotations: Transaction.addToHistory.of(false),
          userEvent: 'rgent.host'
        })
      } finally { applying = false }
    },
    setActiveTaskIds: (ids) => {
      view.dispatch({ effects: activeTaskCompartment.reconfigure(activeTaskIdsFacet.of(new Set(ids))) })
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
    selectionInfo: () => {
      const head = view.state.selection.main.head
      const line = view.state.doc.lineAt(head)
      return { line: line.number, column: head - line.from + 1 }
    },
    selectionRange: () => ({ anchor: sourceOf(view.state).toRaw(view.state.selection.main.anchor), head: sourceOf(view.state).toRaw(view.state.selection.main.head) }),
    headings: () => {
      const result = view.state.field(markdownField).result
      return result.stale ? [] : result.index.headings.filter((heading) => heading.depth <= 3)
    },
    markers: () => {
      const result = view.state.field(markdownField).result
      return result.stale ? [] : result.index.markers
    },
    viewport: () => ({
      from: sourceOf(view.state).toRaw(view.visibleRanges[0]?.from ?? 0),
      to: sourceOf(view.state).toRaw(view.visibleRanges[view.visibleRanges.length - 1]?.to ?? view.state.doc.length)
    }),
    caret: () => {
      const head = view.state.selection.main.head
      const [first] = view.visibleRanges
      if (!first) return null
      const last = view.visibleRanges[view.visibleRanges.length - 1]!
      return head >= first.from && head <= last.to ? sourceOf(view.state).toRaw(head) : null
    },
    scrollTo: (position) => {
      position = sourceOf(view.state).toView(position)
      view.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: 'start' })
      })
    },
    onStateChange: (listener) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    focus: () => view.focus(),
    destroy: () => { view.destroy(); warning.remove() }
  }
}
