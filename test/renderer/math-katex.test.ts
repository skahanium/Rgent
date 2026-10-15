// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { compile } from '../../src/markdown/index.ts'
import { MathWidget } from '../../src/renderer/src/view/widgets/math.ts'

const mocks = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('katex', () => ({ default: { render: mocks.render } }))
vi.mock('katex/dist/katex.min.css', () => ({}))

describe('KaTeX rendering', () => {
  it('disables HTML trust when painting math', async () => {
    document.body.append(new MathWidget(compile('$x$').index.maths[0]!).toDOM())
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalled())
    expect(mocks.render.mock.calls[0]![2]).toMatchObject({ trust: false, throwOnError: false })
  })
})
