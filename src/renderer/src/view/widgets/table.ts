import { WidgetType } from '@codemirror/view'
import type { TableRef } from '@markdown'

export class TableWidget extends WidgetType {
  constructor(readonly table: TableRef) {
    super()
  }

  eq(other: TableWidget): boolean {
    return JSON.stringify(this.table.header) === JSON.stringify(other.table.header)
      && JSON.stringify(this.table.rows) === JSON.stringify(other.table.rows)
  }

  toDOM(): HTMLElement {
    const table = document.createElement('table')
    table.className = 'md-table'
    table.setAttribute('aria-label', '表格')
    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const cell of this.table.header) {
      const th = document.createElement('th')
      th.textContent = cell
      headRow.append(th)
    }
    thead.append(headRow)
    table.append(thead)
    const tbody = document.createElement('tbody')
    for (const row of this.table.rows) {
      const tr = document.createElement('tr')
      for (const cell of row) {
        const td = document.createElement('td')
        td.textContent = cell
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
