// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { applyResolvedTheme } from '../../src/renderer/src/theme.ts'

afterEach(() => {
  delete document.documentElement.dataset.theme
})

it('applies a saved day or night preference immediately, without waiting for the media query', () => {
  applyResolvedTheme('night')
  expect(document.documentElement.dataset.theme).toBe('night')
  applyResolvedTheme('day')
  expect(document.documentElement.dataset.theme).toBe('day')
})
