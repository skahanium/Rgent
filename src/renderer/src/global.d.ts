import type { RgentApi } from '../../preload/index.ts'

declare global {
  interface Window {
    rgent: RgentApi
  }
}

export {}
