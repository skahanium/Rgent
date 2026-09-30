import { openOverlay, type Overlay } from './overlay.ts'
import type { LifecycleRetryRequest, LifecycleStatus } from '../../shared/ipc.ts'

const recoveryReasons = {
  'journal-invalid': '恢复记录损坏，原记录已保留。请人工检查库根的 .rgent-lifecycle。',
  'journal-unreadable': '恢复记录无法读取，原记录已保留。请检查访问权限。',
  'object-changed': '部分对象、内容或目录成员发生变化，尚不能安全续跑。',
  'policy-changed': '权限名单与操作记录不一致，尚不能安全续跑。',
  'recovery-required': '操作尚未完成。重新核验身份、内容和权限后才能续跑。'
} as const

export function openLifecycleStatus(initial: LifecycleStatus,
  retry: (request: LifecycleRetryRequest) => Promise<{ status: LifecycleStatus; message?: string }>,
  fallbackFocus?: () => HTMLElement | null): Overlay {
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const overlay = openOverlay({ label: '文件操作恢复状态', initialFocus: () => close,
    returnFocus: () => trigger?.isConnected && !trigger.closest('[hidden]') ? trigger : fallbackFocus?.() ?? null })
  overlay.root.classList.add('lifecycle-dialog', 'lifecycle-recovery')
  const heading = document.createElement('h2'); heading.textContent = '文件操作恢复状态'
  const description = document.createElement('p')
  const operation = document.createElement('p')
  const list = document.createElement('ul'); list.className = 'lifecycle-progress'
  const notice = document.createElement('p'); notice.setAttribute('role', 'status')
  const actions = document.createElement('div'); actions.className = 'lifecycle-actions'
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'
  close.addEventListener('click', () => overlay.close())
  const again = document.createElement('button'); again.type = 'button'; again.className = 'lifecycle-retry'; again.textContent = '核验并重试'
  actions.append(close)
  overlay.root.append(heading, description, operation, list, notice, actions)
  let current = initial
  function render(status: LifecycleStatus): void {
    current = status
    description.textContent = status.status === 'ready' ? '没有未完成的文件操作。' : recoveryReasons[status.reason ?? 'recovery-required']
    operation.textContent = status.operation ? `${status.operation.kind === 'note' ? '笔记' : '文件夹'}：${status.operation.source} → ${status.operation.target}` : ''
    list.replaceChildren(...status.items.map((item) => {
      const row = document.createElement('li')
      row.dataset.state = item.state
      row.textContent = `${{ source: '待移动', moved: '已移动', blocked: '无法核验' }[item.state]} · ${item.from} → ${item.to}`
      return row
    }))
    if (status.status === 'pending' && status.revision) {
      if (!again.isConnected) actions.append(again)
    } else {
      if (document.activeElement === again) close.focus()
      again.remove()
    }
  }
  again.addEventListener('click', () => {
    if (!current.revision || again.disabled) return
    const wasFocused = document.activeElement === again
    again.disabled = true
    notice.textContent = '正在核验并保存…'
    void retry({ sessionId: current.sessionId, revision: current.revision }).then((result) => {
      if (!overlay.isOpen()) return
      render(result.status)
      notice.textContent = result.message ?? (result.status.status === 'ready' ? '文件操作已完成。' : '恢复记录仍保留。')
    }).catch(() => { if (overlay.isOpen()) notice.textContent = '无法完成重试。恢复记录仍保留，请重新查看状态。' })
      .finally(() => {
        again.disabled = false
        if (overlay.isOpen() && wasFocused && (document.activeElement === document.body || document.activeElement === overlay.root)) {
          (again.isConnected ? again : close).focus()
        }
      })
  })
  render(initial)
  return overlay
}

export function promptNewNote(): Promise<string | null> {
  return promptText('新建笔记', '笔记名', '', '创建')
}

export function promptText(title: string, field: string, initial = '', confirm = '确定'): Promise<string | null> {
  return modal({
    title,
    body: (root) => {
      const label = document.createElement('label')
      label.textContent = field
      label.setAttribute('for', 'new-note-name')
      const input = document.createElement('input')
      input.id = 'new-note-name'
      input.type = 'text'
      input.required = true
      input.autocomplete = 'off'
      input.value = initial
      label.append(input)
      root.append(label)
      queueMicrotask(() => input.focus())
      return () => input.value
    },
    confirm,
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
