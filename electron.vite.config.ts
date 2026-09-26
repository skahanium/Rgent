import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))

const nativeModule = resolve(root, 'build/Release/rgent_fs.node')

/**
 * 主进程要就近加载原生模块（`src/main/secure-fs.ts` 按 import.meta.url 解析）。
 * electron-vite 每次构建（含 dev 的首次构建与每次重建）都会清空产物目录，
 * 所以放在这里跟着每次构建复制，而不是在脚本里复制一次。
 */
function copyNativeModule(): Plugin {
  let outDir = resolve(root, 'out/main')
  return {
    name: 'rgent-copy-native',
    configResolved(config) {
      outDir = resolve(root, config.build.outDir)
    },
    writeBundle() {
      mkdirSync(outDir, { recursive: true })
      copyFileSync(nativeModule, resolve(outDir, 'rgent_fs.node'))
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyNativeModule()]
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
