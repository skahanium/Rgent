/**
 * 状态栏通知（非模态）。围栏 docs/decisions.md §2026-10-23 交互减负 第 5 条：
 * 正常路径不再用原生 `alert`/`confirm`，提示落在状态栏区域、可关闭、最多排队 3 条。
 *
 * 这里刻意不碰 overlay.ts：通知不是浮层，不抢焦点、不拦快捷键、不进模态栈。
 * 真正的模态（删除落点不符、放弃窗口稿、删库登记）仍走 overlay.ts 的 `<dialog>`。
 *
 * 挂载点：状态栏 `.status` 的父容器里、`.status` 之前（外壳里就是 `.app`）；
 * 找不到状态栏时退回 `document.body`。容器 `position: fixed`，不参与布局。
 */

export type NoticeTone = 'info' | 'warning' | 'error'

export type NoticeAction = {
  label: string
  run: () => void
}

export type NoticeInput = {
  /** 首行：发生了什么（≤40 汉字），该做什么放 detail。 */
  title: string
  /** 详情：原文、路径、机器码都放这里。 */
  detail?: string
  /** 渲染成一个按钮；点了不自动关，由调用方决定何时撤。 */
  action?: NoticeAction
  tone?: NoticeTone
  /**
   * 合并键。同一个键的提示只保留一条（默认用 tone＋标题＋详情）。
   * 冲突横幅按笔记路径给键，这样两篇笔记的冲突不会并成一条。
   */
  key?: string
}

type Card = {
  key: string
  root: HTMLElement
  actions: HTMLElement
  action: NoticeAction | null
  dismiss: () => void
}

type Overflow = {
  card: Card
  keys: Set<string>
  detail: HTMLElement
}

/** 同时最多几条通知；超出合并成「另有多条提示」。 */
const MAX_NOTICES = 3
const OVERFLOW_KEY = '\u0000overflow'
const OVERFLOW_TITLE = '另有多条提示'

let stack: HTMLElement | null = null
let cards: Card[] = []
let overflow: Overflow | null = null

function ensureStack(): HTMLElement {
  if (stack?.isConnected) return stack
  // 旧挂载点已经不在文档里（页面重载、外壳重建、测试换文档）：旧卡片一起作废，
  // 免得下一次 pushNotice 把上一轮的提示带回新状态栏。
  if (stack) {
    cards = []
    overflow = null
  }
  const made = document.createElement('div')
  made.className = 'notice-stack'
  // 通知不抢焦点：靠 live region 播报，鼠标/键盘仍留在编辑器里。
  made.setAttribute('role', 'status')
  made.setAttribute('aria-live', 'polite')
  made.setAttribute('aria-label', '提示')
  const status = document.querySelector('.status')
  if (status?.parentElement) status.parentElement.insertBefore(made, status)
  else document.body.append(made)
  stack = made
  return made
}

function buildCard(title: string, detail: string, tone: NoticeTone, key: string): Card {
  const root = document.createElement('div')
  root.className = 'notice'
  root.dataset.tone = tone
  root.dataset.noticeKey = key

  const heading = document.createElement('p')
  heading.className = 'notice-title'
  heading.textContent = title
  const copy = document.createElement('p')
  copy.className = 'notice-detail'
  copy.textContent = detail
  copy.hidden = detail === ''

  const actions = document.createElement('div')
  actions.className = 'notice-actions'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'notice-close'
  close.setAttribute('aria-label', '关闭提示')
  close.textContent = '×'
  actions.append(close)
  root.append(heading, copy, actions)

  const card: Card = { key, root, actions, action: null, dismiss: () => {} }
  close.addEventListener('click', () => card.dismiss())
  return card
}

function applyAction(card: Card, action: NoticeAction | null): void {
  card.action = action
  card.root.querySelector('.notice-action')?.remove()
  if (!action) return
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'notice-action'
  button.textContent = action.label
  // 点的时候再取最新的 action：合并会替换闭包捕获的会话/对象。
  button.addEventListener('click', () => card.action?.run())
  card.actions.prepend(button)
}

function paintStack(): void {
  if (!stack) return
  const nodes = cards.map((card) => card.root)
  if (overflow) nodes.push(overflow.card.root)
  const same = stack.children.length === nodes.length && nodes.every((node, index) => stack!.children[index] === node)
  if (!same) stack.replaceChildren(...nodes)
}

function paintOverflow(): void {
  if (!overflow) return
  if (overflow.keys.size === 0) {
    const card = overflow.card
    overflow = null
    card.root.remove()
    paintStack()
    return
  }
  overflow.detail.textContent = `另有 ${overflow.keys.size} 条提示没有展开。`
  overflow.detail.hidden = false
}

function dismissHidden(key: string): void {
  if (!overflow?.keys.delete(key)) return
  paintOverflow()
}

function appendCard(key: string, title: string, detail: string, tone: NoticeTone, action: NoticeAction | null): Card {
  const card = buildCard(title, detail, tone, key)
  card.dismiss = () => {
    const at = cards.indexOf(card)
    if (at < 0) return
    cards.splice(at, 1)
    card.root.remove()
    paintStack()
  }
  applyAction(card, action)
  cards.push(card)
  paintStack()
  return card
}

function showOverflow(keys: readonly string[]): void {
  const card = buildCard(OVERFLOW_TITLE, '', 'info', OVERFLOW_KEY)
  const detail = card.root.querySelector<HTMLElement>('.notice-detail')!
  card.dismiss = () => {
    if (!overflow) return
    const root = overflow.card.root
    overflow = null
    root.remove()
    paintStack()
  }
  overflow = { card, keys: new Set(keys), detail }
  paintOverflow()
  paintStack()
}

/**
 * 摆一条通知，返回「撤掉这条」的函数（可安全重复调用）。
 * 相同合并键的重复提示只更新动作、不叠卡片；同一篇笔记的冲突反复触发时保持一条。
 */
export function pushNotice(input: NoticeInput): () => void {
  const tone = input.tone ?? 'info'
  const detail = input.detail ?? ''
  const key = input.key ?? `${tone}\u0000${input.title}\u0000${detail}`
  ensureStack()

  const merged = cards.find((card) => card.key === key)
  if (merged) {
    applyAction(merged, input.action ?? null)
    return merged.dismiss
  }
  if (overflow?.keys.has(key)) return () => dismissHidden(key)

  // 合并卡自己占一格：有它时最多两张个体卡，没有时最多三张。
  const capacity = overflow ? MAX_NOTICES - 1 : MAX_NOTICES
  if (cards.length < capacity) {
    return appendCard(key, input.title, detail, tone, input.action ?? null).dismiss
  }

  // 已满：优先挤出「没有动作按钮」的那张（动作常常是「核对」，不能先丢），
  // 只剩有动作的卡片时才丢最早的一张。被挤出的进「另有多条提示」。
  // 不变量：出现合并卡后个体卡最多 MAX_NOTICES-1 张（合并卡自己占一格）。
  while (cards.length >= (overflow ? MAX_NOTICES - 1 : MAX_NOTICES)) {
    const victim = cards.find((card) => !card.action) ?? cards[0]
    cards.splice(cards.indexOf(victim), 1)
    victim.root.remove()
    // 持旧卡片撤函数的人（例如冲突横幅）仍能把它从合并计数里去掉。
    victim.dismiss = () => dismissHidden(victim.key)
    if (overflow) {
      overflow.keys.add(victim.key)
      paintOverflow()
    } else {
      showOverflow([victim.key])
    }
  }
  return appendCard(key, input.title, detail, tone, input.action ?? null).dismiss
}

/** 清空全部通知（测试与换库时用）。 */
export function clearNotices(): void {
  for (const card of cards) card.root.remove()
  overflow?.card.root.remove()
  cards = []
  overflow = null
  stack?.remove()
  stack = null
}

/** 当前通知区域的全部可读文本（标题、可见详情、合并计数），供测试断言。 */
export function noticeText(): string {
  if (!stack?.isConnected) return ''
  return [...stack.querySelectorAll('.notice')]
    .map((card) => {
      const title = card.querySelector('.notice-title')?.textContent ?? ''
      const detail = card.querySelector('.notice-detail:not([hidden])')?.textContent ?? ''
      return detail ? `${title}\n${detail}` : title
    })
    .join('\n')
}
