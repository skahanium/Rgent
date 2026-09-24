import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@markdown': join(root, 'src/markdown/index.ts'),
      '@shared': join(root, 'src/shared/ipc.ts')
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
})
