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
