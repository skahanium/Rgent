import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IPC } from '../../src/shared/ipc.ts'

/**
 * IPC handler 与 preload 都是依赖 electron 的薄包装，不方便直接单测；
 * 这里按管线测试的既有做法扫源码，钉住「通道名只有一处定义、没人偷偷加通道」。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const sources = ['src/main/index.ts', 'src/preload/index.ts'].map((file) => ({
  file,
  text: readFileSync(path.join(root, file), 'utf8')
}))

function usedChannels(source: string): string[] {
  return [...source.matchAll(/\bIPC\.([A-Za-z0-9_]+)/g)].map((match) => match[1])
}

describe('ipc channels', () => {
  it('only references channels declared in shared/ipc.ts', () => {
    const declared = new Set(Object.keys(IPC))
    const unknown = sources.flatMap(({ file, text }) =>
      usedChannels(text).filter((name) => !declared.has(name)).map((name) => `${file}: IPC.${name}`)
    )
    expect(unknown).toEqual([])
  })

  it('leaves no declared channel unused by both main and preload', () => {
    const used = new Set(sources.flatMap(({ text }) => usedChannels(text)))
    expect(Object.keys(IPC).filter((name) => !used.has(name))).toEqual([])
  })
})
