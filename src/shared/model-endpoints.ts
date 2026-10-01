import type { ModelProvider } from './ipc.ts'

/** 已知端点只是数据：新增厂商或端点只加这里，不加控件、不加界面分支。 */
export type ModelEndpoint = { baseURL: string; label: string; note?: string }

/** 一个供应商的预置：候选端点 + 新建连接时预填的首个模型。 */
export type ProviderPreset = {
  endpoints: readonly ModelEndpoint[]
  modelId: string
  contextTokens: number
}

export const MODEL_PRESETS: Record<ModelProvider, ProviderPreset> = {
  deepseek: {
    endpoints: [{ baseURL: 'https://api.deepseek.com', label: '官方' }],
    modelId: 'deepseek-flash',
    contextTokens: 1048576
  },
  minimax: {
    endpoints: [
      { baseURL: 'https://api.minimax.io/v1', label: '国际站点' },
      { baseURL: 'https://api.minimaxi.com/v1', label: '国内站点', note: '国内 Token Plan 密钥须用国内站点' }
    ],
    modelId: 'MiniMax-M2.7',
    contextTokens: 204800
  },
  custom: { endpoints: [], modelId: '', contextTokens: 0 }
}

export const MODEL_ENDPOINTS: Record<ModelProvider, readonly ModelEndpoint[]> = {
  deepseek: MODEL_PRESETS.deepseek.endpoints,
  minimax: MODEL_PRESETS.minimax.endpoints,
  custom: MODEL_PRESETS.custom.endpoints
}

/** 预置的接口地址取该供应商的第一个已知端点；自定义供应商没有预置。 */
export function defaultBaseURL(provider: ModelProvider): string {
  return MODEL_ENDPOINTS[provider][0]?.baseURL ?? ''
}
