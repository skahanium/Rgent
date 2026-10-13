import { openOverlay, type Overlay } from './overlay.ts'
import { renderReadOnlyMarkdown } from './view/read-only.ts'
import type { AgentWriteDecision, AgentWritePreview } from '../../shared/ipc.ts'

/** 「建」的人确认：模型提议新建一篇笔记，落点与正文先摆给人看，点一下才建。
 *  合同见 decisions.md「写类 AI 工具局部授权」——落点固定为发起篇所在目录，
 *  预览只给这两样（路径与正文），不提供改路径的入口。 */

export type WriteConfirmHost = {
  onRequest: (handler: (preview: AgentWritePreview) => void) => () => void
  decide: (decision: AgentWriteDecision) => Promise<unknown> | unknown
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
    // 同一时刻只摆一个：上一张还没答就当作不建，避免两个都点出问题。
    if (current && !current.decided) settle(false)
    const overlay = openOverlay({
      label: '确认新建笔记',
      initialFocus: () => overlay.root.querySelector<HTMLElement>('.write-confirm-accept'),
      // 不管怎么关掉（Esc、点面板外、程序关闭），没答过就当「不建」：
      // 人没点头就绝不落盘，也不能让主进程干等到超时。
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
    overlay.root.classList.add('overlay-write-confirm')
    // 建给「落点＋正文」，改名／挪给「旧路径 → 新路径＋影响面」；两种都是预览＋一次点击。
    const structural = preview.kind !== 'create'
    const heading = preview.kind === 'create' ? '新建这篇笔记吗？' : preview.kind === 'rename' ? '给这篇笔记改名吗？' : '把这篇笔记挪走吗？'
    const path = preview.kind === 'create'
      ? `将新建：${preview.relPath}`
      : `${preview.kind === 'rename' ? '将改名' : '将移动'}：${preview.source} → ${preview.target}`
    const note = structural
      ? `会影响 ${preview.linkChanges} 处引用、${preview.permissionChanges} 处权限；引用在授权范围内的会被一并修好。不同意就什么都不动。`
      : '它只在当前库、发起篇所在目录里新建；正文内容由模型给出。不同意就什么都不写。'
    const cancel = preview.kind === 'create' ? '不建' : '不'
    const acceptLabel = preview.kind === 'create' ? '建' : preview.kind === 'rename' ? '改名' : '移动'
    overlay.root.innerHTML = `<h2>${heading}</h2><p class="write-confirm-path" aria-live="polite"></p><div class="write-confirm-body"></div><p class="write-confirm-note settings-hint">${note}</p><footer><button type="button" class="write-confirm-cancel">${cancel}</button><button type="button" class="write-confirm-accept">${acceptLabel}</button></footer>`
    overlay.root.querySelector('.write-confirm-path')!.textContent = path
    if (preview.kind === 'create') renderReadOnlyMarkdown(overlay.root.querySelector<HTMLElement>('.write-confirm-body')!, preview.body)
    else overlay.root.querySelector<HTMLElement>('.write-confirm-body')!.remove()
    overlay.root.querySelector('.write-confirm-cancel')!.addEventListener('click', () => settle(false))
    const accept = overlay.root.querySelector<HTMLElement>('.write-confirm-accept')!
    accept.addEventListener('click', () => settle(true))
    // 内容是在浮层打开之后才装进去的：这里显式把焦点放到「建」，不靠浮层的兜底查找。
    accept.focus()
    current = { overlay, requestId: preview.requestId, decided: false }
  })

  return () => {
    stop()
    if (current && !current.decided) settle(false)
    current = null
  }
}
