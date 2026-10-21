import type {
  EgressLogEntry,
  HumanFetchResult,
  HumanSearchResult,
  NetworkProvider
} from '../shared/ipc.ts'
import type { NetworkStatEvent } from './network-stats.ts'

/**
 * 人发起的抓页／搜索（应用菜单 → 对话框 → 主进程）。
 *
 * 与 AI 工具走同一个出口核心（`fetchText`／`createSearchProvider`），本模块只做四件事：
 * 1. **总闸**：`enabled()` 每次现读设备配置，关闭即拒绝 `NETWORK_NOT_AUTHORIZED`；
 * 2. **取消**：每次请求有自己的 `AbortController`；`abort(requestId)`／`abortAll()` 中止
 *    在途请求，结束时清理（关闭总闸时由入口调用 `abortAll()`）；
 * 3. **审计**：成功与失败都向设备级 `network-egress.jsonl` 追加一条，只写主机／字节／
 *    条数／结果码——**不写 URL、查询串、正文与错误消息**；写盘失败如实标 `degraded`，
 *    不把「抓到了但没记上」说成完整成功；
 * 4. **形状**：把出口结果收窄成人发起专用的返回联合，失败交给 IPC 层统一包。
 *
 * 依赖全部注入，测试用假 fetch／假搜索／假日志，不碰真网络与真磁盘。
 */
export type HumanFetchText = {
  text: string
  title?: string
  finalUrl: string
  bytes: number
  truncated: boolean
}

export type HumanSearchService = {
  provider: NetworkProvider
  host: string
  search(query: string, options: { maxResults?: number; signal: AbortSignal }): Promise<{
    results: { title: string; url: string; snippet: string }[]
    truncated?: boolean
  }>
}

export type HumanNetworkDependencies = {
  /** 总闸：生产是设备配置的现读值，关闭时人发起同样拒绝。 */
  enabled(): boolean
  fetchText(url: string, options: { signal: AbortSignal }): Promise<HumanFetchText>
  /** 搜索服务：没有凭据时抛 `SEARCH_NOT_CONFIGURED`；凭据只在主进程内使用。 */
  searchProvider(): Promise<HumanSearchService>
  log: { append(entry: EgressLogEntry): void }
  /** 设备级外发统计（可选）：同样只收次数／字节／拒绝码，不改变返回形状。 */
  stats?: { record(kind: 'humanFetch' | 'humanSearch', event: NetworkStatEvent): void }
}

/** 渲染层生成、随请求带上并可用来停止的标识；与 IPC 校验同一套字符集。 */
export type HumanNetworkRequest = { requestId?: string }

export type HumanNetwork = {
  fetchPage(url: string, options?: HumanNetworkRequest): Promise<HumanFetchResult>
  search(query: string, maxResults?: number, options?: HumanNetworkRequest): Promise<HumanSearchResult>
  /** 中止一个在途请求；没有这个 id 时返回 false。 */
  abort(requestId: string): boolean
  /** 中止所有在途请求，返回实际中止的个数。 */
  abortAll(): number
}

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,63}$/u
const now = (): string => new Date().toISOString()

/** 错误只取机读码：消息不是码就按「无法访问」处理，绝不把原文写进日志或返回给渲染层。 */
function codeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return CODE_SHAPE.test(message) ? message : 'EGRESS_UNAVAILABLE'
}

/** 从 URL 尽力取主机；取不到就给空串（日志允许）。 */
function hostOf(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

export function createHumanNetwork(deps: HumanNetworkDependencies): HumanNetwork {
  /** requestId → 控制器，以及没带 id 的请求（abortAll 也要能停）。 */
  const byId = new Map<string, AbortController>()
  const active = new Set<AbortController>()

  const register = (requestId?: string): AbortController => {
    const controller = new AbortController()
    active.add(controller)
    // 同 id 并发时以最后一次为准；旧的仍可被 abortAll 停掉。
    if (requestId) byId.set(requestId, controller)
    return controller
  }
  const release = (controller: AbortController, requestId?: string): void => {
    active.delete(controller)
    if (requestId && byId.get(requestId) === controller) byId.delete(requestId)
  }

  /** 审计写盘失败不抛：调用方据返回值在成功结果上标 `degraded`。 */
  const record = (entry: EgressLogEntry): boolean => {
    try { deps.log.append(entry); return true }
    catch { return false }
  }
  /** 统计是旁路：写统计失败不能把一次已经发生（或已经拒绝）的外发变成新的失败。 */
  const stat = (kind: 'humanFetch' | 'humanSearch', event: NetworkStatEvent): void => {
    try { deps.stats?.record(kind, event) } catch { /* stats are best effort */ }
  }
  const refuse = (action: 'fetch' | 'search', host: string, code: string): void => {
    record({ at: now(), action, host, outcome: 'refused', code })
    stat(action === 'fetch' ? 'humanFetch' : 'humanSearch', { outcome: 'refused', code })
  }
  const gate = (): boolean => {
    try { return deps.enabled() === true } catch { return false }
  }

  return {
    async fetchPage(url: string, options: HumanNetworkRequest = {}): Promise<HumanFetchResult> {
      const requestId = options.requestId
      const controller = register(requestId)
      const fallbackHost = hostOf(url)
      try {
        if (!gate()) {
          refuse('fetch', fallbackHost, 'NETWORK_NOT_AUTHORIZED')
          return { ok: false, error: 'NETWORK_NOT_AUTHORIZED' }
        }
        if (controller.signal.aborted) throw Error('EGRESS_ABORTED')
        const result = await deps.fetchText(url, { signal: controller.signal })
        // 停止和完成可能同时在路上：停止优先，不把已经不要的结果交回去。
        if (controller.signal.aborted) throw Error('EGRESS_ABORTED')
        const host = hostOf(result.finalUrl) || fallbackHost
        const fetchedAt = now()
        const logged = record({ at: fetchedAt, action: 'fetch', host, bytes: result.bytes, outcome: 'ok' })
        // 日志写失败只降级 `degraded`；外发本身成功，统计照实记 ok＋字节。
        stat('humanFetch', { outcome: 'ok', bytes: result.bytes })
        return {
          ok: true,
          url: result.finalUrl,
          host,
          ...(result.title ? { title: result.title } : {}),
          text: result.text,
          bytes: result.bytes,
          truncated: result.truncated,
          fetchedAt,
          ...(logged ? {} : { degraded: 'log-failed' as const })
        }
      } catch (error) {
        const code = controller.signal.aborted ? 'EGRESS_ABORTED' : codeOf(error)
        refuse('fetch', fallbackHost, code)
        return { ok: false, error: code }
      } finally {
        release(controller, requestId)
      }
    },

    async search(query: string, maxResults?: number, options: HumanNetworkRequest = {}): Promise<HumanSearchResult> {
      const requestId = options.requestId
      const controller = register(requestId)
      try {
        if (!gate()) {
          // 总闸关着时不碰密钥，因此拿不到服务主机；空串如实表示「不知道目标」。
          refuse('search', '', 'NETWORK_NOT_AUTHORIZED')
          return { ok: false, error: 'NETWORK_NOT_AUTHORIZED' }
        }
        let service: HumanSearchService
        try {
          service = await deps.searchProvider()
        } catch {
          // 凭据缺失／解不开都按「搜索未配置」：还没有任何外发发生，不把解密错误当出口错误。
          refuse('search', '', 'SEARCH_NOT_CONFIGURED')
          return { ok: false, error: 'SEARCH_NOT_CONFIGURED' }
        }
        try {
          if (controller.signal.aborted) throw Error('EGRESS_ABORTED')
          const result = await service.search(query, {
            ...(maxResults === undefined ? {} : { maxResults }),
            signal: controller.signal
          })
          if (controller.signal.aborted) throw Error('EGRESS_ABORTED')
          if (!result.results.length) throw Error('SEARCH_EMPTY')
          const at = now()
          const logged = record({ at, action: 'search', host: service.host, count: result.results.length, outcome: 'ok' })
          stat('humanSearch', { outcome: 'ok' })
          return {
            ok: true,
            provider: service.provider,
            host: service.host,
            results: result.results,
            ...(result.truncated ? { truncated: true } : {}),
            ...(logged ? {} : { degraded: 'log-failed' as const })
          }
        } catch (error) {
          const code = controller.signal.aborted ? 'EGRESS_ABORTED' : codeOf(error)
          refuse('search', service.host, code)
          return { ok: false, error: code }
        }
      } finally {
        release(controller, requestId)
      }
    },

    abort(requestId: string): boolean {
      const controller = byId.get(requestId)
      if (!controller) return false
      byId.delete(requestId)
      active.delete(controller)
      controller.abort()
      return true
    },

    abortAll(): number {
      const controllers = [...active]
      active.clear()
      byId.clear()
      for (const controller of controllers) controller.abort()
      return controllers.length
    }
  }
}

/**
 * 总开关保存后的接线：关闭时中止所有在途的人发起请求（合同 C11）。
 * 入口 `network:config` 在保存成功后调用；单独导出便于用假对象钉住这条行为。
 */
export function applyHumanNetworkGate(
  network: Pick<HumanNetwork, 'abortAll'> | null,
  enabled: boolean
): void {
  if (!enabled) network?.abortAll()
}
