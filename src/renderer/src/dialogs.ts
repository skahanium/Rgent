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

export function promptConflict(): Promise<'window' | 'disk' | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'modal'
    const heading = document.createElement('h2')
    heading.textContent = '稿不一样了'
    const p = document.createElement('p')
    p.textContent = '窗口里的稿和磁盘上这份文件不一样了。听谁的？'
    const actions = document.createElement('div')
    actions.className = 'modal-actions'
    const windowBtn = document.createElement('button')
    windowBtn.type = 'button'
    windowBtn.textContent = '听窗口'
    const diskBtn = document.createElement('button')
    diskBtn.type = 'button'
    diskBtn.textContent = '听磁盘'
    const finish = (value: 'window' | 'disk') => {
      dialog.close()
      dialog.remove()
      resolve(value)
    }
    windowBtn.addEventListener('click', () => finish('window'))
    diskBtn.addEventListener('click', () => finish('disk'))
    actions.append(windowBtn, diskBtn)
    dialog.append(heading, p, actions)
    document.body.append(dialog)
    dialog.showModal()
  })
}

function modal(opts: {
  title: string
  body: (root: HTMLElement) => () => string
  confirm: string
  cancel: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'modal'
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
      dialog.close()
      dialog.remove()
      resolve(value && value.length > 0 ? value : null)
    })
    document.body.append(dialog)
    dialog.showModal()
  })
}
