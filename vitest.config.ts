import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

/** Windows CI 并行下真实库夹具会超过本机预算；断言不变，只放宽等待。 */
export const testTimeoutMs = process.platform === 'win32' ? 90_000 : 20_000

/** 用例自己写的时限：Windows 上至少提到全局预算，避免写死 20s/30s 盖过全局。 */
export function testTimeoutAtLeast(ms: number): number {
  return Math.max(ms, testTimeoutMs)
}

/** 去掉文件开头的 `#!` 解释器行（含 CRLF）。
 *  Vite SSR 转译只把 `#!…\n` 当 hashbang；Windows Git 默认 autocrlf 会变成 `#!…\r\n`，
 *  shebang 被留在模块中间，vitest 一加载就是 `SyntaxError: Invalid or unexpected token`。 */
export function stripHashbang(code: string): string {
  if (!code.startsWith('#!')) return code
  const match = /^#![^\n\r]*(?:\r\n|\n|\r)/.exec(code)
  return match ? code.slice(match[0].length) : ''
}

export default defineConfig({
  plugins: [{
    name: 'strip-hashbang',
    enforce: 'pre',
    transform(code) {
      if (!code.startsWith('#!')) return
      return { code: stripHashbang(code), map: null }
    }
  }],
  resolve: {
    alias: {
      '@markdown': join(root, 'src/markdown/index.ts'),
      '@shared': join(root, 'src/shared/ipc.ts')
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 少数集成用例（1000 条召回秩评、五步链、真实账本边界）单跑 3–11 秒，
    // 在默认 100 路并行下会超过 vitest 默认 5 秒；断言不变，只放宽时限。
    // Windows CI 再慢一截：真实库夹具会顶满 20 秒（run 38911900387）乃至写死的 30 秒
    // （run 38914442628）。用例自己写的毫秒必须走 testTimeoutAtLeast，否则盖过全局。
    testTimeout: testTimeoutMs
  }
})
