import { openOverlay, type Overlay } from './overlay.ts'
import type { LifecycleRetryRequest, LifecycleStatus } from '../../shared/ipc.ts'

const recoveryReasons = {
  'journal-invalid': '恢复记录损坏，请人工检查。原记录仍保留，文件在库根 .rgent-lifecycle。',
  'journal-unreadable': '恢复记录读不到，请检查文件访问权限。原记录仍保留。',
  'object-changed': '对象、内容或目录成员已变，请重新核验。暂不能安全续跑。',
  'policy-changed': '权限名单和操作记录对不上，请重新核验。暂不能安全续跑。',
  'recovery-required': '操作还没完成，请重新核验身份、内容和权限。核验通过后才能续跑。'
} as const

export function openLifecycleStatus(initial: LifecycleStatus,
  retry: (request: LifecycleRetryRequest) => Promise<{ status: LifecycleStatus; message?: string }>,
  fallbackFocus?: () => HTMLElement | null): Overlay {
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let busy = false
  const overlay = openOverlay({ label: '文件操作恢复状态', className: 'lifecycle-dialog lifecycle-recovery', initialFocus: () => close,
    canDismiss: () => !busy,
    returnFocus: () => trigger?.isConnected && !trigger.closest('[hidden]') ? trigger : fallbackFocus?.() ?? null })
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
    if (!current.revision || again.disabled || busy) return
    const wasFocused = document.activeElement === again
    busy = true
    // Disabling the focused retry control moves focus to body. Chromium then
    // may fire a CloseWatcher and dismiss the modal (Windows Electron).
    if (wasFocused) close.focus()
    again.disabled = true
    notice.textContent = '正在核验并保存…'
    void retry({ sessionId: current.sessionId, revision: current.revision }).then((result) => {
      if (!overlay.isOpen()) return
      render(result.status)
      notice.textContent = result.message ?? (result.status.status === 'ready' ? '文件操作已完成。' : '恢复记录仍保留。')
    }).catch(() => { if (overlay.isOpen()) notice.textContent = '无法完成重试。恢复记录仍保留，请重新查看状态。' })
      .finally(() => {
        busy = false
        again.disabled = false
        if (overlay.isOpen() && wasFocused) (again.isConnected ? again : close).focus()
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
      // 空值由 modal 自己校验并给消息，不用原生 required（那会在取消时也弹气泡）
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
      className: 'modal',
      onClose: () => finish(null)
    })
    const dialog = overlay.root
    const heading = document.createElement('h2')
    heading.textContent = opts.title
    const form = document.createElement('form')
    form.method = 'dialog'
    // 关掉原生约束校验：它会在点「取消」时也弹「请填写此字段」，把取消变成关不掉。
    // 空值校验改由下面自己给消息，取消永远能关。
    form.noValidate = true
    const getter = opts.body(form)
    const message = document.createElement('p')
    message.className = 'modal-error'
    message.setAttribute('role', 'alert')
    message.hidden = true
    const actions = document.createElement('div')
    actions.className = 'modal-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.value = 'cancel'
    cancel.textContent = opts.cancel
    cancel.addEventListener('click', () => {
      finish(null)
      overlay.close()
    })
    // 唯一的提交按钮：回车也就落到「确认」上，不会像两个 submit 时那样被当成取消。
    const ok = document.createElement('button')
    ok.type = 'submit'
    ok.value = 'ok'
    ok.textContent = opts.confirm
    actions.append(cancel, ok)
    form.append(message, actions)
    dialog.append(heading, form)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const value = getter().trim()
      if (!value) {
        message.textContent = '请填写名称。'
        message.hidden = false
        form.querySelector('input')?.focus()
        return
      }
      finish(value)
      overlay.close()
    })
    // 打开时聚焦输入框，不是确认按钮：破坏性动作不该是默认。
    queueMicrotask(() => form.querySelector('input')?.focus())
  })
}
