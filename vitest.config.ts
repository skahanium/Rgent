import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

/** Windows CI 并行下真实库夹具会超过 20 秒；断言不变，只放宽等待。 */
export const testTimeoutMs = process.platform === 'win32' ? 60_000 : 20_000

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
    // Windows CI 再慢一截：同样的真实库夹具会顶满 20 秒（run 38911900387 三条超时），
    // 个别用例若自己写了 20000 必须用下面的常量，否则盖不过全局。
    testTimeout: testTimeoutMs
  }
})
