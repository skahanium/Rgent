import { openOverlay, type Overlay } from './overlay.ts'
import { renderReadOnlyMarkdown } from './view/read-only.ts'
import type { AgentWriteDecision, AgentWritePreview } from '../../shared/ipc.ts'

/** AI 写操作的人确认：模型提议补／建／改名／挪／删，先摆一张卡给人看，点「允许」才动。
 *  合同见 decisions.md「交互减负」：卡是**非模态**的——不遮整屏、不抢焦点、不拦编辑器输入，
 *  位置固定右下角；「逐次确认」与「拒绝／关闭／超时都算不允许」不变。
 *  正文预览默认只露 3 行，全文与路径、影响面数字都在「详情」里，不拿机器信息占首屏。 */

export type WriteConfirmHost = {
  onRequest: (handler: (preview: AgentWritePreview) => void) => () => void
  decide: (decision: AgentWriteDecision) => Promise<unknown> | unknown
}

/** 首行（发生了什么的标题）硬上限，与合同「首行 ≤40 汉字」一致。 */
const TITLE_LIMIT = 40
/** 正文预览默认露几行。 */
const PREVIEW_LINES = 3

/** 卡片标题只认「笔记名」，路径全文进详情：标题要一眼能读完，不能变成第二个路径行。 */
function noteName(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

function titleOf(preview: AgentWritePreview): string {
  // 现有写工具没有独立的「补写」载荷：补写不经这张卡（它由写入门按追加块直接执行）。
  switch (preview.kind) {
    case 'create': return `AI 想新建《${noteName(preview.relPath)}》`
    case 'rename': return `AI 想改名《${noteName(preview.source)}》`
    case 'move': return `AI 想挪走《${noteName(preview.source)}》`
    case 'delete': return `AI 想删除《${noteName(preview.relPath)}》`
  }
}

/** 路径很长时标题截到上限，宁缺字也不让首行换成两行。 */
function clampTitle(title: string): string {
  return title.length <= TITLE_LIMIT ? title : `${title.slice(0, TITLE_LIMIT - 1)}…`
}

/** 卡片实际标题（已截到 40 字）；窗口专项按这句原文断言，改文案前先查 scripts/verify-ui.mjs。 */
export const writeConfirmTitle = (preview: AgentWritePreview): string => clampTitle(titleOf(preview))

/** 首句只说「发生什么」；引用数与权限数这类细节留到第二句。
 *  「移入废纸篓」「链接会失效」「不会代为改字」「同名附件夹」是窗口专项依赖的原话。 */
export function writeConfirmLead(preview: AgentWritePreview): string {
  switch (preview.kind) {
    case 'create': return '只在这个目录里新建，正文由模型给出。'
    case 'rename':
    case 'move': return `会影响 ${preview.linkChanges} 处引用、${preview.permissionChanges} 处权限。`
    case 'delete': return `${preview.hasAttachments ? '这篇（连同名附件夹）' : '这篇'}会移入废纸篓，也就是系统废纸篓。`
  }
}

function previewNote(preview: AgentWritePreview): string {
  const lead = writeConfirmLead(preview)
  switch (preview.kind) {
    case 'create': return `${lead}不同意就什么都不写。`
    case 'rename':
    case 'move': return `${lead}引用在授权范围内的会被一并修好；不同意就什么都不动。`
    case 'delete': return `${lead}其他笔记里的链接会失效，不会代为改字；不同意就什么都不动。`
  }
}

function previewPath(preview: AgentWritePreview): string {
  switch (preview.kind) {
    case 'create': return `将新建：${preview.relPath}`
    case 'rename': return `将改名：${preview.source} → ${preview.target}`
    case 'move': return `将移动：${preview.source} → ${preview.target}`
    case 'delete': return `将删除：${preview.relPath}`
  }
}

export function installWriteConfirm(host: WriteConfirmHost): () => void {
  let current: { overlay: Overlay; requestId: string; decided: boolean } | null = null

  const settle = (approved: boolean): void => {
    const pending = current
    if (!pending || pending.decided) return
    pending.decided = true
    void host.decide({ requestId: pending.requestId, approved })
    pending.overlay.close()
  }

  const stop = host.onRequest(preview => {
    // 同一时刻只摆一个：上一张还没答就当作不允许，避免两个都点出问题。
    if (current && !current.decided) settle(false)
    const title = writeConfirmTitle(preview)
    const overlay = openOverlay({
      label: title,
      // 非模态：show() 而不是 showModal()，不拿焦点、不拦快捷键。也不能给 initialFocus。
      modal: false,
      // 不管怎么关掉（Esc、程序关闭），没答过就当不允许：人没点头就绝不落盘，
      // 也不能让主进程干等到超时（主进程 120 秒兜底也回不允许）。
      onClose: () => {
        const pending = current
        if (!pending || pending.overlay !== overlay) return
        current = null
        if (!pending.decided) {
          pending.decided = true
          void host.decide({ requestId: pending.requestId, approved: false })
        }
      }
    })
    overlay.root.classList.add('overlay-write-confirm', 'write-confirm')
    // 右下角的常驻卡片：定位与尺寸在 styles.css 的 `.write-confirm`，内容多了在卡内滚动。
    // 非模态卡片是状态更新，不是模态对话框：用 role="status" 让读屏播报，但不抢焦点。
    overlay.root.setAttribute('role', 'status')
    overlay.root.setAttribute('aria-live', 'polite')
    overlay.root.innerHTML = '<button type="button" class="write-confirm-close" aria-label="关闭，不允许这次操作">×</button><h2 class="write-confirm-title"></h2><div class="write-confirm-body"></div><button type="button" class="write-confirm-expand" aria-expanded="false">展开</button><details class="write-confirm-details"><summary>详情</summary><p class="write-confirm-path"></p><p class="write-confirm-note settings-hint"></p></details><footer><button type="button" class="write-confirm-cancel">不允许</button><button type="button" class="write-confirm-accept">允许</button></footer>'
    const titleEl = overlay.root.querySelector<HTMLElement>('.write-confirm-title')!
    titleEl.textContent = title
    // 路径与影响面数字是「详情」：首屏只留一句发生了什么。
    overlay.root.querySelector('.write-confirm-path')!.textContent = previewPath(preview)
    overlay.root.querySelector('.write-confirm-note')!.textContent = previewNote(preview)
    const body = overlay.root.querySelector<HTMLElement>('.write-confirm-body')!
    const expand = overlay.root.querySelector<HTMLButtonElement>('.write-confirm-expand')!
    if (preview.kind === 'create') {
      renderReadOnlyMarkdown(body, preview.body)
      body.style.overflow = 'hidden'
      body.style.overflowWrap = 'anywhere'
      const collapse = (): void => {
        body.dataset.collapsed = 'true'
        body.style.display = '-webkit-box'
        body.style.setProperty('-webkit-box-orient', 'vertical')
        // 新旧两种写法都留：老 Chromium 只认 `-webkit-`，新写法留给以后的浏览器。
        body.style.setProperty('-webkit-line-clamp', String(PREVIEW_LINES))
        body.style.setProperty('line-clamp', String(PREVIEW_LINES))
        expand.textContent = '展开'
        expand.setAttribute('aria-expanded', 'false')
      }
      const expandBody = (): void => {
        body.dataset.collapsed = 'false'
        body.style.display = 'block'
        body.style.removeProperty('-webkit-box-orient')
        body.style.removeProperty('-webkit-line-clamp')
        body.style.removeProperty('line-clamp')
        expand.textContent = '收起'
        expand.setAttribute('aria-expanded', 'true')
      }
      collapse()
      expand.addEventListener('click', () => {
        if (body.dataset.collapsed === 'true') expandBody()
        else collapse()
      })
      // 正文为空时没什么可折的，就不留一个点了没反应的按钮。
      if (!body.textContent?.trim()) {
        body.remove()
        expand.remove()
      }
    } else {
      body.remove()
      expand.remove()
    }
    const close = overlay.root.querySelector<HTMLElement>('.write-confirm-close')!
    // 关闭就是不允许：和 Esc、程序关闭同一条结清路径。
    close.addEventListener('click', () => settle(false))
    const cancel = overlay.root.querySelector<HTMLElement>('.write-confirm-cancel')!
    cancel.addEventListener('click', () => settle(false))
    const accept = overlay.root.querySelector<HTMLElement>('.write-confirm-accept')!
    accept.addEventListener('click', () => settle(true))
    // 不调 focus()：卡出现时编辑器的焦点与输入都不动。
    current = { overlay, requestId: preview.requestId, decided: false }
  })

  return () => {
    stop()
    if (current && !current.decided) settle(false)
    current = null
  }
}
