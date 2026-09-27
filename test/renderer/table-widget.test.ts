// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { compile } from '../../src/markdown/pipeline.ts'
import { TableWidget } from '../../src/renderer/src/view/widgets/table.ts'

describe('table widget', () => {
  it('renders inline formatting from the original table AST', () => {
    const source = '| **标题** | 内容 |\n| :--- | ---: |\n| *斜体* | ~~删线~~ |\n'
    const result = compile(source)
    const table = new TableWidget(result.index.tables[0]!).toDOM()
    expect(table.querySelector('th strong')?.textContent).toBe('标题')
    expect(table.querySelector('td em')?.textContent).toBe('斜体')
    expect(table.querySelector('td del')?.textContent).toBe('删线')
    expect(table.textContent).not.toContain('**')
    expect(table.querySelector('th')?.style.textAlign).toBe('left')
    expect(table.querySelectorAll('th')[1]?.style.textAlign).toBe('right')
    expect(table.querySelectorAll('td')[1]?.style.textAlign).toBe('right')
  })
  it('rebuilds when formatting changes but cell text stays the same', () => {
    const bold = compile('| **标题** |\n| --- |\n')
    const plain = compile('| 标题 |\n| --- |\n')
    expect(new TableWidget(bold.index.tables[0]!).eq(new TableWidget(plain.index.tables[0]!))).toBe(false)
  })
})
