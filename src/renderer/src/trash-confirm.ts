import { openOverlay } from './overlay.ts'
import type { TrashPreviewView } from '../../shared/ipc.ts'

/** 首句只说会发生什么，第二句只说链接失效；「同名附件夹」「链接会失效」「不会代为改字」
 *  是窗口专项依赖的原话，改写时不能动。 */
export const TRASH_CONFIRM_NOTES = {
  withAttachments: '这篇笔记和同名附件夹会一起进系统废纸篓。其他笔记里的链接会失效，不会代为改字。',
  withoutAttachments: '这篇笔记会进系统废纸篓。没有同名附件夹；其他笔记里的链接会失效，不会代为改字。'
} as const

/** 人删除确认：预览＋一次点击。Esc／点外面＝不删。 */
export function confirmTrash(preview: TrashPreviewView): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false
    const overlay = openOverlay({
      label: '移入系统废纸篓',
      className: 'overlay-write-confirm write-confirm',
      initialFocus: () => overlay.root.querySelector<HTMLElement>('.write-confirm-cancel'),
      onClose: () => { if (!decided) { decided = true; resolve(false) } }
    })
    const note = preview.hasAttachments ? TRASH_CONFIRM_NOTES.withAttachments : TRASH_CONFIRM_NOTES.withoutAttachments
    overlay.root.innerHTML = `<h2>把这篇笔记移入系统废纸篓吗？</h2><p class="write-confirm-path"></p><p class="write-confirm-note settings-hint"></p><footer><button type="button" class="write-confirm-cancel">不删</button><button type="button" class="write-confirm-accept">移入废纸篓</button></footer>`
    overlay.root.querySelector('.write-confirm-path')!.textContent = preview.relPath
    overlay.root.querySelector('.write-confirm-note')!.textContent = note
    const cancel = overlay.root.querySelector<HTMLElement>('.write-confirm-cancel')!
    cancel.addEventListener('click', () => {
      if (decided) return
      decided = true
      overlay.close()
      resolve(false)
    })
    overlay.root.querySelector('.write-confirm-accept')!.addEventListener('click', () => {
      if (decided) return
      decided = true
      overlay.close()
      resolve(true)
    })
    cancel.focus()
  })
}
