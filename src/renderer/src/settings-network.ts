import type { NetworkConfigResult, NetworkConfigView, NetworkProvider, NetworkProviderSaveRequest } from '../../shared/ipc.ts'
import { confirmAction } from './settings-model.ts'

/**
 * 「模型」页末尾的「联网只读」卡片：总开关、搜索服务二选一、密钥（保存后清空）、清除。
 *
 * 只写设备配置：**不发任何测试请求**（代价是坏密钥要等首次使用才暴露），
 * 密钥只进本机加密存储，界面只显示「已配置／未配置」，不回显密钥或密文。
 * 不新增设置页或导航项；挂在既有「模型」页，围栏见 docs/decisions.md 的 2026-10-20 合同。
 */
export type NetworkCardHandlers = {
  get: () => Promise<NetworkConfigResult>
  setEnabled: (enabled: boolean) => Promise<NetworkConfigResult>
  saveProvider: (request: NetworkProviderSaveRequest) => Promise<NetworkConfigResult>
  clearProvider: () => Promise<NetworkConfigResult>
}
export type NetworkCardHost = {
  body: HTMLElement
  isCurrent: () => boolean
}

const PROVIDERS: NetworkProvider[] = ['brave', 'tavily']
const PROVIDER_NAMES: Record<NetworkProvider, string> = { brave: 'Brave', tavily: 'Tavily' }
const PROVIDER_HOSTS: Record<NetworkProvider, string> = { brave: 'api.search.brave.com', tavily: 'api.tavily.com' }
const NETWORK_ERRORS: Record<string, string> = {
  BAD_NETWORK_CONFIG: '本机联网配置无法读取，请检查后重试；笔记仍可正常使用。',
  SECURE_STORAGE_UNAVAILABLE: '系统密钥保护当前不可用，密钥未保存。',
  BAD_NETWORK_PROVIDER: '无法使用这个搜索服务，请重新选择。',
  BAD_NETWORK_KEY: '搜索密钥须非空且不超过 4096 字。',
  BAD_REQUEST: '请求不合法，未保存。',
  IO_ERROR: '写入本机配置失败，原配置保持不变。'
}
export const networkErrorText = (error: string): string => Object.hasOwn(NETWORK_ERRORS, error)
  ? NETWORK_ERRORS[error]!
  : '操作未完成，请重试；仍然失败时请检查联网配置。'

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

export function mountNetworkCard(host: NetworkCardHost, handlers: NetworkCardHandlers): () => void {
  const body = host.body
  let config: NetworkConfigView | null = null
  let selected: NetworkProvider = 'brave'
  let busy = false
  let disposed = false

  const heading = element('h3', 'settings-section-title')
  heading.textContent = '联网只读'
  const intro = element('p', 'settings-hint')
  intro.textContent = '内置只读抓页与搜索。默认关闭；关闭时不再外发。'
  const toggleLabel = element('label', 'settings-network-toggle')
  const enabled = element('input')
  enabled.type = 'checkbox'
  enabled.dataset.network = 'enabled'
  toggleLabel.append(enabled, document.createTextNode('允许联网只读（总开关，保存即生效）'))
  const scope = element('p', 'settings-hint')
  scope.textContent = '每场任务还需要单独勾选授权；这里只决定设备级总闸。'
  const providerGroup = element('fieldset', 'settings-network-provider')
  const legend = element('legend')
  legend.textContent = '搜索服务（同一时间只接一家）'
  providerGroup.append(legend)
  const radios = new Map<NetworkProvider, HTMLInputElement>()
  for (const provider of PROVIDERS) {
    const label = element('label')
    const radio = element('input')
    radio.type = 'radio'
    radio.name = 'network-provider'
    radio.value = provider
    radio.dataset.network = 'provider'
    radio.dataset.provider = provider
    label.append(radio, document.createTextNode(PROVIDER_NAMES[provider]))
    providerGroup.append(label)
    radios.set(provider, radio)
  }
  const hostHint = element('p', 'settings-hint')
  const fieldLabel = element('label', 'settings-field')
  const fieldName = element('span')
  fieldName.textContent = '搜索密钥（保存后清空，不再显示）'
  const key = element('input')
  key.type = 'password'
  key.autocomplete = 'new-password'
  key.maxLength = 4096
  key.dataset.network = 'key'
  fieldLabel.append(fieldName, key)
  const status = element('p', 'settings-hint')
  status.dataset.network = 'status'
  status.setAttribute('role', 'status')
  const actions = element('div', 'settings-actions')
  const save = element('button', 'settings-action')
  save.type = 'button'
  save.textContent = '保存服务与密钥'
  save.dataset.network = 'save'
  const clear = element('button', 'settings-action')
  clear.type = 'button'
  clear.textContent = '清除服务配置'
  clear.dataset.network = 'clear'
  actions.append(save, clear)
  const error = element('p', 'settings-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  error.dataset.network = 'error'
  const note = element('p', 'settings-hint')
  note.textContent = '只保存配置，不会发测试请求；密钥只存本机加密，不显示。'
  body.append(heading, intro, toggleLabel, scope, providerGroup, hostHint, fieldLabel, status, actions, error, note)

  const showError = (message: string): void => { error.textContent = message; error.hidden = !message }
  const paint = (): void => {
    const ready = config !== null
    enabled.checked = config?.enabled === true
    for (const [provider, radio] of radios) radio.checked = provider === selected
    hostHint.textContent = `目标主机：${PROVIDER_HOSTS[selected]}（写死，不可自定义）`
    status.textContent = !ready
      ? '读取中…'
      : config!.hasKey
        ? `${config!.provider ? PROVIDER_NAMES[config!.provider] : '搜索服务'} · 已配置`
        : '未配置'
    for (const control of [enabled, ...radios.values(), key, save, clear]) control.disabled = busy || !ready
    // 保存必须有新密钥：已保存的密钥不回显、不重复使用。
    if (ready) save.disabled = busy || !key.value.trim()
    if (ready) clear.disabled = busy || (!config!.hasKey && config!.provider === null)
  }
  const adopt = (next: NetworkConfigView): void => {
    config = next
    if (next.provider) selected = next.provider
  }
  const settle = (result: NetworkConfigResult): boolean => {
    if (disposed || !host.isCurrent()) return false
    if (!result.ok) { showError(networkErrorText(result.error)); return false }
    adopt(result.config)
    return true
  }

  enabled.addEventListener('change', () => {
    if (busy || !config) return
    // 先取值再重绘：paint() 会按已保存的配置重置勾选。
    const next = enabled.checked
    busy = true
    showError('')
    paint()
    void handlers.setEnabled(next).then(result => {
      settle(result)
    }).catch(() => { if (!disposed) showError('保存失败，请重试。') })
      .finally(() => { if (!disposed) { busy = false; paint() } })
  })
  for (const [provider, radio] of radios) {
    radio.addEventListener('change', () => {
      if (!radio.checked || busy) return
      selected = provider
      showError('')
      paint()
    })
  }
  key.addEventListener('input', () => { showError(''); paint() })
  save.addEventListener('click', () => {
    if (busy || !config) return
    const value = key.value.trim()
    if (!value) { showError('请填写搜索密钥；保存后输入框会清空。'); return }
    busy = true
    showError('')
    paint()
    void handlers.saveProvider({ provider: selected, key: value }).then(result => {
      if (!settle(result)) return
      // 主进程回执只带摘要；输入框清空，密钥不在界面上留下副本。
      key.value = ''
    }).catch(() => { if (!disposed) showError('保存失败，请重试。') })
      .finally(() => { if (!disposed) { busy = false; paint() } })
  })
  confirmAction(clear, '清除服务配置', () => {
    if (busy || !config) return
    busy = true
    showError('')
    paint()
    void handlers.clearProvider().then(result => {
      if (settle(result)) key.value = ''
    }).catch(() => { if (!disposed) showError('清除失败，请重试。') })
      .finally(() => { if (!disposed) { busy = false; paint() } })
  }, '确认清除？')

  paint()
  void handlers.get().then(result => {
    if (disposed || !host.isCurrent()) return
    if (!result.ok) { showError(networkErrorText(result.error)); return }
    adopt(result.config)
    paint()
  }).catch(() => { if (!disposed && host.isCurrent()) showError('暂时无法读取联网配置。') })

  return () => { disposed = true }
}
