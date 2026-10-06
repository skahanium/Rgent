import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import { createHash } from 'node:crypto'

const root = dirname(fileURLToPath(import.meta.url))

const sourceFiles=(dir:string):string[]=>readdirSync(resolve(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?sourceFiles(dir+'/'+e.name):[dir+'/'+e.name])
const runtimeFingerprint=createHash('sha256').update(JSON.stringify(['src/main','src/shared','src/markdown'].flatMap(sourceFiles).sort().map(f=>[f,readFileSync(resolve(root,f),'utf8')]))).digest('hex')
const scoringFingerprint=createHash('sha256').update(readFileSync(resolve(root,'scripts/memory-quality-support.ts'),'utf8')).digest('hex')

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
    define: {__RGENT_RUNTIME_FINGERPRINT__:JSON.stringify(runtimeFingerprint),__RGENT_SCORING_FINGERPRINT__:JSON.stringify(scoringFingerprint)},
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
