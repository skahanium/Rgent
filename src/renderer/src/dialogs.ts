import { openOverlay } from './overlay.ts'

export function promptNewNote(): Promise<string | null> {
  return modal({
    title: '新建笔记',
    body: (root) => {
      const label = document.createElement('label')
      label.textContent = '笔记名'
      label.setAttribute('for', 'new-note-name')
      const input = document.createElement('input')
      input.id = 'new-note-name'
      input.type = 'text'
      input.required = true
      input.autocomplete = 'off'
      label.append(input)
      root.append(label)
      queueMicrotask(() => input.focus())
      return () => input.value
    },
    confirm: '创建',
    cancel: '取消'
  })
}

/**
 * 冲突决策。围栏（decisions.md §库、文件、窗口）要求给出两份可读预览、
 * 写明各自会舍弃什么；双预览与差异高亮在下一刀接上，这里先把流程与焦点做对：
 * 关闭（含被上层浮层顶掉）一律按「继续编辑」处理，不留悬空的 Promise。
 */
export function promptConflict(): Promise<'window' | 'disk' | 'continue'> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: 'window' | 'disk' | 'continue'): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const overlay = openOverlay({
      label: '稿不一样了',
      // 聚焦「继续编辑」——破坏性选项不当默认。
      initialFocus: () => overlay.root.querySelector<HTMLElement>('[data-action="continue"]'),
      onClose: () => finish('continue')
    })
    const dialog = overlay.root
    dialog.classList.add('modal')
    const heading = document.createElement('h2')
    heading.textContent = '稿不一样了'
    const p = document.createElement('p')
    p.textContent = '窗口里的稿和磁盘上这份文件不一样了。听谁的？'
    const actions = document.createElement('div')
    actions.className = 'modal-actions'
    const windowBtn = document.createElement('button')
    windowBtn.type = 'button'
    windowBtn.dataset.action = 'window'
    windowBtn.textContent = '听窗口'
    const diskBtn = document.createElement('button')
    diskBtn.type = 'button'
    diskBtn.dataset.action = 'disk'
    diskBtn.textContent = '听磁盘'
    const continueBtn = document.createElement('button')
    continueBtn.type = 'button'
    continueBtn.dataset.action = 'continue'
    continueBtn.textContent = '继续编辑'
    const pick = (value: 'window' | 'disk' | 'continue') => () => {
      overlay.close()
      finish(value)
    }
    windowBtn.addEventListener('click', pick('window'))
    diskBtn.addEventListener('click', pick('disk'))
    continueBtn.addEventListener('click', pick('continue'))
    actions.append(windowBtn, diskBtn, continueBtn)
    dialog.append(heading, p, actions)
  })
}

function modal(opts: {
  title: string
  body: (root: HTMLElement) => () => string
  confirm: string
  cancel: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const overlay = openOverlay({
      label: opts.title,
      onClose: () => finish(null)
    })
    const dialog = overlay.root
    dialog.classList.add('modal')
    const heading = document.createElement('h2')
    heading.textContent = opts.title
    const form = document.createElement('form')
    form.method = 'dialog'
    const getter = opts.body(form)
    const actions = document.createElement('div')
    actions.className = 'modal-actions'
    const cancel = document.createElement('button')
    cancel.type = 'submit'
    cancel.value = 'cancel'
    cancel.textContent = opts.cancel
    const ok = document.createElement('button')
    ok.type = 'submit'
    ok.value = 'ok'
    ok.textContent = opts.confirm
    actions.append(cancel, ok)
    form.append(actions)
    dialog.append(heading, form)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null
      const value = submitter?.value === 'ok' ? getter().trim() : null
      overlay.close()
      finish(value && value.length > 0 ? value : null)
    })
    // 打开时聚焦输入框，不是确认按钮：破坏性动作不该是默认。
    queueMicrotask(() => form.querySelector('input')?.focus())
  })
}
