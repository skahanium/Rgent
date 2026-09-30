import { WidgetType } from '@codemirror/view'
import type { TableRef } from '@markdown'
import type { NoteHost } from '../host.ts'
import { renderReadOnlyNode, disposeReadOnlyImages } from '../read-only.ts'

export class TableWidget extends WidgetType {
  constructor(readonly table: TableRef, readonly host?: NoteHost) {
    super()
  }

  eq(other: TableWidget): boolean {
    return this.table.range.start === other.table.range.start
      && this.table.range.end === other.table.range.end
      && this.host === other.host
      && this.host?.imageEpoch === other.host?.imageEpoch
      && this.table.source?.slice(this.table.range.start, this.table.range.end) === other.table.source?.slice(other.table.range.start, other.table.range.end)
      && JSON.stringify(this.table.header) === JSON.stringify(other.table.header)
      && JSON.stringify(this.table.rows) === JSON.stringify(other.table.rows)
  }

  toDOM(): HTMLElement {
    if (this.table.node) {
      const table = renderReadOnlyNode(this.table.node, this.table.source ?? '', this.host) as HTMLElement
      table.classList.add('md-table')
      table.setAttribute('aria-label', '表格')
      return table
    }
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

  destroy(dom: HTMLElement): void { disposeReadOnlyImages(dom) }

  ignoreEvent(): boolean {
    return true
  }
}
