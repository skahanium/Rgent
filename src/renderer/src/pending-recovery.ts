import type { AgentPendingDecision, AgentPendingPreview } from '@shared'
import { promptConflict } from './conflict.ts'
import { openOverlay } from './overlay.ts'

export type PendingChoice = AgentPendingDecision | 'later'

/** Keep the unwritten answer selectable even when its original task marker is gone. */
export function promptPending(preview: AgentPendingPreview): Promise<PendingChoice> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (choice: PendingChoice): void => {
      if (settled) return
      settled = true
      overlay.close()
      resolve(choice)
    }
    const overlay = openOverlay({
      label: '处理未保存的生成回答',
      initialFocus: () => overlay.root.querySelector<HTMLElement>('[data-action="later"]'),
      onClose: () => finish('later')
    })
    overlay.root.classList.add('pending-recovery')
    const title = document.createElement('h2')
    title.textContent = '生成回答尚未保存'
    const description = document.createElement('p')
    description.textContent = `${preview.relPath}：${preview.reason}。回答仍在本次应用运行期间保留。`
    const label = document.createElement('label')
    label.textContent = '生成回答（可选中复制）'
    const answer = document.createElement('textarea')
    answer.readOnly = true
    answer.value = preview.answer
    answer.rows = 8
    label.append(answer)
    const actions = document.createElement('div')
    actions.className = 'pending-actions'
    actions.append(button('retry', '重试保存', () => finish('retry')))
    if (preview.modelBody !== null) {
      actions.append(button('compare', '比较两份稿', () => {
        settled = true
        overlay.close()
        void promptConflict({
          title: preview.relPath,
          windowText: preview.modelBody!,
          diskText: preview.diskBody,
          labels: {
            heading: '选择这次生成回答的去留',
            description: `${preview.relPath}：只会替换这次任务标记的 AI 块；其它正文保留。做出选择前会再次核对磁盘修订值。`,
            window: '采用模型回答后的正文',
            disk: '当前磁盘正文',
            windowAction: '采用模型回答',
            diskAction: '保留磁盘稿',
            windowHint: '只替换本任务的 AI 块；其它正文不动。',
            diskHint: '保留当前正文；账本如实记录未采用的生成回答。'
          }
        }).then((choice) => {
          resolve(choice === 'window' ? 'model' : choice === 'disk' ? 'disk' : 'later')
        })
      }))
    } else {
      const warning = document.createElement('p')
      warning.setAttribute('role', 'status')
      warning.textContent = '任务标记已变化或当前权限不可写，不能自动采用模型回答。可复制上方文字，或保留磁盘稿。'
      overlay.root.append(warning)
      actions.append(button('disk', '保留磁盘稿', () => finish('disk')))
    }
    actions.append(button('later', '稍后处理', () => finish('later')))
    overlay.root.append(title, description, label, actions)
  })
}

function button(action: string, text: string, run: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.dataset.action = action
  element.textContent = text
  element.addEventListener('click', run)
  return element
}
