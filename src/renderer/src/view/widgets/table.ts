import { WidgetType } from '@codemirror/view'
import type { TableRef } from '@markdown'
import type { NoteHost } from '../host.ts'
import { renderReadOnlyNode } from '../read-only.ts'

export class TableWidget extends WidgetType {
  constructor(readonly table: TableRef, readonly host?: NoteHost) {
    super()
  }

  eq(other: TableWidget): boolean {
    return this.table.range.start === other.table.range.start
      && this.table.range.end === other.table.range.end
      && this.host === other.host
      && this.table.source?.slice(this.table.range.start, this.table.range.end) === other.table.source?.slice(other.table.range.start, other.table.range.end)
      && JSON.stringify(this.table.header) === JSON.stringify(other.table.header)
      && JSON.stringify(this.table.rows) === JSON.stringify(other.table.rows)
  }

  toDOM(): HTMLElement {
    const table = document.createElement('table')
    table.className = 'md-table'
    table.setAttribute('aria-label', '表格')
    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const [index, cell] of this.table.header.entries()) {
      const th = document.createElement('th')
      const alignment = this.table.node?.align?.[index]
      if (alignment) th.style.textAlign = alignment
      const ast = this.table.node?.children[0]?.children[index]
      if (ast) th.append(...ast.children.map((child) => renderReadOnlyNode(child, this.table.source ?? '', this.host)))
      else th.textContent = cell
      headRow.append(th)
    }
    thead.append(headRow)
    table.append(thead)
    const tbody = document.createElement('tbody')
    for (const [rowIndex, row] of this.table.rows.entries()) {
      const tr = document.createElement('tr')
      for (const [cellIndex, cell] of row.entries()) {
        const td = document.createElement('td')
        const alignment = this.table.node?.align?.[cellIndex]
        if (alignment) td.style.textAlign = alignment
        const ast = this.table.node?.children[rowIndex + 1]?.children[cellIndex]
        if (ast) td.append(...ast.children.map((child) => renderReadOnlyNode(child, this.table.source ?? '', this.host)))
        else td.textContent = cell
        tr.append(td)
      }
      tbody.append(tr)
    }
    table.append(tbody)
    return table
  }

  ignoreEvent(): boolean {
    return true
  }
}
