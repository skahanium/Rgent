import { mkdtemp, mkdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

const race = vi.hoisted(() => ({ directory: '', outside: '', followed: false, switched: false }))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      const info = fs.lstatSync(...args)
      if (String(args[0]) === race.directory && !race.switched) {
        race.switched = true
        fs.renameSync(race.directory, `${race.directory}.saved`)
        fs.symlinkSync(race.outside, race.directory)
      }
      return info
    },
    watch: (directory: string) => {
      if (fs.realpathSync(directory) === race.outside) race.followed = true
      return { on: () => {}, close: () => {} }
    }
  }
})

it('does not attach a watcher to a directory replaced by an outside link', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rgent-watch-race-'))
  race.outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rgent-out-')))
  race.directory = path.join(root, 'safe')
  race.followed = false
  race.switched = false
  await mkdir(race.directory)
  const { watchVault } = await import('../../src/main/watch.ts')
  const stop = watchVault(root, () => {})
  stop()
  expect(race.followed).toBe(false)
})
