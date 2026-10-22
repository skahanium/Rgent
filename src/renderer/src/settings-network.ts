import type {
  EgressLogResult,
  EgressLogView,
  NetworkConfigResult,
  NetworkConfigView,
  NetworkProvider,
  NetworkProviderSaveRequest,
  NetworkStatKind,
  NetworkStatsClearResult,
  NetworkStatsResult,
  NetworkStatsView
} from '../../shared/ipc.ts'
import { confirmAction } from './settings-model.ts'

/**
 * 「模型」页末尾的「联网只读」卡片：总开关、搜索服务二选一、密钥（保存后清空）、清除，
 * 以及只读的「外发统计」区。
 *
 * 配置只写设备文件：**不发任何测试请求**（代价是坏密钥要等首次使用才暴露），
 * 密钥只进本机加密存储，界面只显示「已配置／未配置」，不回显密钥或密文。
 * 统计区只展示计数、字节、时间、主机与拒绝码；**不显示 URL、查询串或正文**。
 * 不新增设置页或导航项；挂在既有「模型」页，围栏见 docs/decisions.md 的 2026-10-20／21 合同。
 */
export type NetworkCardHandlers = {
  get: () => Promise<NetworkConfigResult>
  setEnabled: (enabled: boolean) => Promise<NetworkConfigResult>
  saveProvider: (request: NetworkProviderSaveRequest) => Promise<NetworkConfigResult>
  clearProvider: () => Promise<NetworkConfigResult>
  /** 设备级外发统计（可选：测试或旧宿主没接时，卡片如实显示不可用）。 */
  stats?: () => Promise<NetworkStatsResult>
  /** 清空统计并同时清外发日志；主进程保证「日志失败则统计不动」。 */
  clearStats?: () => Promise<NetworkStatsClearResult>
  /** 最近的人发起外发；只读形状里没有 URL 与查询。 */
  egressLog?: (limit: number) => Promise<EgressLogResult>
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

const STATS_ERRORS: Record<string, string> = {
  BAD_SENDER: '请求来源不受信任，统计未读取。',
  IO_ERROR: '读取外发统计失败；不影响联网使用。'
}
/** 统计请求失败只给人话，不把内部错误码摆到设置卡上。 */
export const networkStatsErrorText = (error: string): string => Object.hasOwn(STATS_ERRORS, error)
  ? STATS_ERRORS[error]!
  : '暂时无法读取外发统计；不影响联网使用。'
const STATS_READ_FAILED = '暂时无法读取外发统计；不影响联网使用。'
const STATS_CLEAR_FAILED = '清空未完成：统计与外发日志可能未全部清除，请重试。'
const EGRESS_READ_FAILED = '读取最近外发记录失败；不影响联网使用。'

/** 计数里的字节按人话显示（二进制单位）；0 与非法值一律 0 B。 */
export function formatStatsBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.floor(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/u, '')
  return `${text} ${units[unit]}`
}

const pad = (value: number): string => String(value).padStart(2, '0')
/** 稳定、本地时区的可读时间；不依赖 ICU 的 locale 数据，测试与真机一致。 */
function formatMoment(iso: string | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const STAT_KINDS: readonly { kind: NetworkStatKind; label: string }[] = [
  { kind: 'fetch', label: '抓页(AI)' },
  { kind: 'search', label: '搜索(AI)' },
  { kind: 'mcp', label: 'MCP（未启用）' },
  { kind: 'humanFetch', label: '抓页(人)' },
  { kind: 'humanSearch', label: '搜索(人)' }
]

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
  intro.textContent = '内置只读抓页与搜索，默认关闭。开启后才会外发，关闭即停止。'
  const toggleLabel = element('label', 'settings-network-toggle')
  const enabled = element('input')
  enabled.type = 'checkbox'
  enabled.dataset.network = 'enabled'
  toggleLabel.append(enabled, document.createTextNode('允许联网只读（总开关，保存即生效）'))
  const scope = element('p', 'settings-hint')
  scope.textContent = '每场任务还要单独授权。这里只管设备总闸。'
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
  const error = element('p', 'settings-network-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  error.dataset.network = 'error'
  const note = element('p', 'settings-hint')
  note.textContent = '只保存配置，不会发测试请求；密钥只存本机加密，不显示。'

  // ---- 外发统计（只读） ----
  const statsSection = element('section', 'settings-network-stats')
  const statsHeading = element('h4', 'settings-network-stats-title')
  statsHeading.textContent = '外发统计'
  const statsIntro = element('p', 'settings-hint')
  statsIntro.textContent = '只记次数、字节与失败码。不显示 URL、查询、正文或凭据。'
  const corruptNote = element('p', 'settings-network-warning')
  corruptNote.dataset.networkStats = 'corrupt'
  corruptNote.setAttribute('role', 'alert')
  corruptNote.textContent = '统计文件损坏，已保留原文件'
  corruptNote.hidden = true
  const rowsBox = element('div', 'settings-network-stat-rows')
  rowsBox.dataset.networkStats = 'rows'
  const lastOk = element('p', 'settings-hint')
  lastOk.dataset.networkStats = 'last-ok'
  const codesTitle = element('p', 'settings-network-stats-caption')
  codesTitle.textContent = '最近失败码（最多 5 条）'
  const codesBox = element('div', 'settings-network-codes')
  codesBox.dataset.networkStats = 'codes'
  const humanHeading = element('h4', 'settings-network-stats-title')
  humanHeading.textContent = '最近人发起外发'
  const logNote = element('p', 'settings-hint')
  logNote.dataset.networkStats = 'log-note'
  const logBox = element('ul', 'settings-network-log')
  logBox.dataset.networkStats = 'log'
  const statsErrorEl = element('p', 'settings-network-error')
  statsErrorEl.setAttribute('role', 'alert')
  statsErrorEl.hidden = true
  statsErrorEl.dataset.networkStats = 'error'
  const statsNotice = element('p', 'settings-hint')
  statsNotice.setAttribute('role', 'status')
  statsNotice.dataset.networkStats = 'notice'
  statsNotice.hidden = true
  const statsActions = element('div', 'settings-network-stats-actions')
  const clearStats = element('button', 'settings-action')
  clearStats.type = 'button'
  clearStats.textContent = '清空统计与外发日志'
  clearStats.dataset.networkStats = 'clear'
  statsActions.append(clearStats)
  statsSection.append(
    statsHeading, statsIntro, corruptNote, rowsBox, lastOk,
    codesTitle, codesBox, humanHeading, logNote, logBox, statsErrorEl, statsNotice, statsActions
  )
  body.append(heading, intro, toggleLabel, scope, providerGroup, hostHint, fieldLabel, status, actions, error, note, statsSection)

  // 统计与日志各自独立读取：统计坏了不影响外发记录，反过来也一样。
  let statsView: NetworkStatsView | null = null
  let egressView: EgressLogView | null = null
  let statsError = ''
  let egressError = ''
  let statsBusy = false
  let armedAt = 0
  let armTimer: ReturnType<typeof setTimeout> | null = null

  const showError = (message: string): void => { error.textContent = message; error.hidden = !message }
  const disarmClear = (): void => {
    armedAt = 0
    if (armTimer !== null) { clearTimeout(armTimer); armTimer = null }
    clearStats.textContent = '清空统计与外发日志'
    clearStats.classList.remove('is-confirming')
  }
  const renderStats = (): void => {
    const corrupt = statsView?.corrupt === true
    const unavailable = !!statsError || !handlers.stats
    corruptNote.hidden = !corrupt
    rowsBox.hidden = false
    rowsBox.replaceChildren()
    for (const { kind, label } of STAT_KINDS) {
      const row = element('div', 'settings-network-stat-row')
      row.dataset.networkStats = 'row'
      row.dataset.kind = kind
      const name = element('span', 'settings-network-stat-name')
      name.textContent = label
      const metrics = element('span', 'settings-network-stat-metrics')
      const counts = statsView?.kinds[kind]
      metrics.textContent = corrupt || unavailable
        ? '—'
        : counts
          ? `成功 ${counts.ok} · 拒绝 ${counts.refused} · 字节 ${formatStatsBytes(counts.bytes)}`
          : '读取中…'
      row.append(name, metrics)
      rowsBox.append(row)
    }
    lastOk.hidden = corrupt || unavailable || statsView === null
    lastOk.textContent = statsView?.lastOkAt
      ? `最近成功：${formatMoment(statsView.lastOkAt)}`
      : '还没有成功记录。'
    codesTitle.hidden = corrupt || unavailable || statsView === null
    codesBox.hidden = corrupt || unavailable || statsView === null
    codesBox.replaceChildren()
    if (statsView && !corrupt && !unavailable) {
      const codes = statsView.lastCodes.slice(0, 5)
      if (!codes.length) {
        const empty = element('p', 'settings-hint')
        empty.textContent = '还没有失败码记录。'
        codesBox.append(empty)
      }
      for (const item of codes) {
        const line = element('div', 'settings-network-code')
        line.dataset.networkStats = 'code'
        line.textContent = `${formatMoment(item.at)} · ${item.code}`
        codesBox.append(line)
      }
    }
    statsErrorEl.textContent = statsError
    statsErrorEl.hidden = !statsError
    clearStats.disabled = statsBusy || !handlers.clearStats
    clearStats.title = handlers.clearStats ? '' : '外发统计当前不可用。'
  }

  const renderEgress = (): void => {
    logBox.replaceChildren()
    const unavailable = !!egressError || !handlers.egressLog
    if (unavailable) {
      logNote.textContent = egressError || '外发记录当前不可用。'
    } else if (egressView === null) {
      logNote.textContent = '读取中…'
    } else if (!egressView.entries.length) {
      logNote.textContent = egressView.skipped
        ? `还没有人发起的外发记录（另有 ${egressView.skipped} 条无法读取）。`
        : '还没有人发起的外发记录。'
    } else {
      logNote.textContent = `最近 ${egressView.entries.length} 条外发记录。只显示时间、类型、主机与结果，不含 URL 或查询。`
      if (egressView.skipped) logNote.textContent += `（跳过 ${egressView.skipped} 条无法读取的记录）`
    }
    if (!egressView || unavailable) return
    for (const entry of egressView.entries) {
      const item = element('li', 'settings-network-log-entry')
      item.dataset.networkStats = 'log-entry'
      const action = entry.action === 'fetch' ? '抓页' : '搜索'
      // 只按固定字段重建：日志里就算混进 URL／查询，也不会经这里显示出去。
      const outcome = entry.outcome === 'ok' ? '成功' : `拒绝${entry.code ? ` ${entry.code}` : ''}`
      item.textContent = `${formatMoment(entry.at)} · ${action} · ${entry.host || '（未知主机）'} · ${outcome}`
      logBox.append(item)
    }
  }

  const loadStats = async (): Promise<void> => {
    if (disposed || !host.isCurrent()) return
    if (!handlers.stats) { statsError = ''; renderStats(); return }
    try {
      const result = await handlers.stats()
      if (disposed || !host.isCurrent()) return
      if (!result.ok) { statsView = null; statsError = networkStatsErrorText(result.error) }
      else { statsView = result.stats; statsError = '' }
    } catch {
      if (disposed || !host.isCurrent()) return
      statsView = null
      statsError = STATS_READ_FAILED
    }
    renderStats()
  }

  const loadEgress = async (): Promise<void> => {
    if (disposed || !host.isCurrent()) return
    if (!handlers.egressLog) { egressError = ''; renderEgress(); return }
    try {
      const result = await handlers.egressLog(10)
      if (disposed || !host.isCurrent()) return
      if (!result.ok) { egressView = null; egressError = EGRESS_READ_FAILED }
      else { egressView = result.view; egressError = '' }
    } catch {
      if (disposed || !host.isCurrent()) return
      egressView = null
      egressError = EGRESS_READ_FAILED
    }
    renderEgress()
  }

  const runClear = (): void => {
    if (statsBusy || !handlers.clearStats) return
    disarmClear()
    statsBusy = true
    statsError = ''
    statsNotice.hidden = true
    statsNotice.textContent = ''
    renderStats()
    void handlers.clearStats().then(result => {
      if (disposed || !host.isCurrent()) return
      if (!result.ok) { statsError = STATS_CLEAR_FAILED; renderStats(); return }
      statsView = null
      egressView = null
      statsNotice.textContent = '已清空统计与外发日志。'
      statsNotice.hidden = false
      // 清空成功后再按主进程的真实状态重读，不拿本地零值假装刷新完毕。
      void loadStats()
      void loadEgress()
    }).catch(() => {
      if (disposed || !host.isCurrent()) return
      statsError = STATS_CLEAR_FAILED
      renderStats()
    }).finally(() => {
      if (disposed) return
      statsBusy = false
      renderStats()
    })
  }

  clearStats.addEventListener('click', () => {
    if (statsBusy || !handlers.clearStats) return
    const now = Date.now()
    if (now - armedAt > 3000) {
      armedAt = now
      clearStats.textContent = '确认清空？'
      clearStats.classList.add('is-confirming')
      if (armTimer !== null) clearTimeout(armTimer)
      armTimer = setTimeout(() => {
        armTimer = null
        if (Date.now() - armedAt < 3000) return
        disarmClear()
      }, 3000)
      return
    }
    runClear()
  })

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
  renderStats()
  renderEgress()
  void loadStats()
  void loadEgress()
  void handlers.get().then(result => {
    if (disposed || !host.isCurrent()) return
    if (!result.ok) { showError(networkErrorText(result.error)); return }
    adopt(result.config)
    paint()
  }).catch(() => { if (!disposed && host.isCurrent()) showError('暂时无法读取联网配置。') })

  return () => {
    disposed = true
    disarmClear()
  }
}
