import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        // 渲染进程开着 sandbox，沙箱里的 preload 只能按 CommonJS 执行；
        // package.json 是 "type": "module"，所以必须显式出 .cjs，否则加载直接失败。
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@markdown': resolve(root, 'src/markdown/index.ts'),
        '@shared': resolve(root, 'src/shared/ipc.ts')
      }
    }
  }
})
