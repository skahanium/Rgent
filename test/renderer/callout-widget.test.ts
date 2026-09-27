// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { compile } from '../../src/markdown/pipeline.ts'
import { CalloutWidget } from '../../src/renderer/src/view/widgets/callout.ts'

describe('callout presentation', () => {
  it('keeps Markdown emphasis from the same AST inside the callout', () => {
    const source = '> [!note] 记要\n> **重要** 与 *斜体*。\n'
    const result = compile(source)
    const callout = new CalloutWidget(result.index.callouts[0]!).toDOM()
    expect(callout.querySelector('strong')?.textContent).toBe('重要')
    expect(callout.querySelector('em')?.textContent).toBe('斜体')
  })
  it('rebuilds when inner formatting changes', () => {
    const bold = compile('> [!note] 记要\n> **重要**\n')
    const plain = compile('> [!note] 记要\n> 重要\n')
    expect(new CalloutWidget(bold.index.callouts[0]!).eq(new CalloutWidget(plain.index.callouts[0]!))).toBe(false)
  })
})
