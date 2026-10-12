import { SKILL_LIMITS, SKILL_REASON_TEXT, skillFieldsReason, type SkillUnavailableReason, type SkillsDraft, type SkillsLibraryEntry, type SkillsLibraryView, type SkillsResult, type SkillsEnabledRequest, type SkillsSaveOperation } from '../../shared/skills.ts'
import { renderReadOnlyMarkdown } from './view/read-only.ts'

/** 第七页「技能」：只有人能创建、编辑、启用、停用；模型不能写、不能上架、不能自行加载。
 *  列表即读取（正文随列表返回，不另开通道）；启用属本库，停用对下一场生效。 */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) => { const node = document.createElement(tag); if (className) node.className = className; return node }
const paragraph = (text: string, className = 'settings-hint') => { const node = el('p', className); node.textContent = text; return node }
const button = (text: string, run: () => void) => { const node = el('button', 'settings-action'); node.type = 'button'; node.textContent = text; node.addEventListener('click', run); return node }
const field = (title: string, control: HTMLElement) => { const label = el('label', 'settings-field wide'); const span = el('span'); span.textContent = title; label.append(span, control); return label }

/** 机读码与逐条原因共用一份人话文案；界面绝不显示原始码。 */
const MACHINE_TEXT: Record<string, string> = {
  SKILLS_STORE_INVALID: '技能库文件损坏或无法读取；原文件未被改写。请检查后重新打开本页。',
  SKILLS_STORE_CONFLICT: '技能库刚刚被改动过。已重新载入，请再保存一次。',
  SKILLS_UNKNOWN_ID: '这条技能已经不在了；列表已重新载入。',
  VAULT_CHANGED: '笔记库已切换，请重新打开本页。',
  BAD_REQUEST: '这次操作没被接受，请检查填写内容后重试。'
}
const errorText = (error: string): string => MACHINE_TEXT[error] ?? (SKILL_REASON_TEXT[error as SkillUnavailableReason] ?? '操作没有完成。')

export type SkillsPageHandlers = {
  get: () => Promise<SkillsResult>
  save: (request: SkillsSaveOperation & { expectedRevision: string | null }) => Promise<SkillsResult>
  setEnabled: (request: Omit<SkillsEnabledRequest, 'sessionId'>) => Promise<SkillsResult>
}

export type SkillsPageHost = { body: HTMLElement; isCurrent: () => boolean; onChanged?: (view: SkillsLibraryView) => void }

type Draft = { mode: 'create' | 'edit'; id?: string; name: string; description: string; triggers: string; body: string }

const emptyDraft = (): Draft => ({ mode: 'create', name: '', description: '', triggers: '', body: '' })
const draftOf = (skill: SkillsLibraryEntry): Draft => ({ mode: 'edit', id: skill.id, name: skill.name, description: skill.description, triggers: skill.triggers.join('\n'), body: skill.body })
const draftRecord = (draft: Draft): SkillsDraft => ({
  name: draft.name.trim(),
  description: draft.description.trim(),
  triggers: draft.triggers.split('\n').map(line => line.trim()).filter(line => line.length > 0),
  body: draft.body.trim()
})

export function mountSkillsPage(host: SkillsPageHost, handlers: SkillsPageHandlers): () => void {
  let view: SkillsLibraryView | null = null
  let draft: Draft | null = null
  let notice: string | null = null
  let disposed = false

  const root = el('div', 'skills-page')
  host.body.append(root)

  const accepts = (result: SkillsResult, onView: (view: SkillsLibraryView) => void): void => {
    if (disposed || !host.isCurrent()) return
    if (result.ok) { view = result.view; notice = null; onView(result.view); host.onChanged?.(result.view) }
    else { notice = errorText(result.error); render() }
  }
  const reload = (): void => { void handlers.get().then(result => accepts(result, () => render())) }

  render()
  reload()

  return () => { disposed = true; root.remove() }

  function render(): void {
    if (disposed) return
    root.replaceChildren()
    const title = el('h3', 'settings-section-title'); title.textContent = '技能'
    root.append(title)
    root.append(paragraph('技能是你写给这个助手的说明文，只在当前库启用后、下一场任务里生效。只有你能创建、编辑、启用或停用；模型不能写技能、也不能自己启用。'))
    const actions = el('div', 'settings-actions')
    actions.append(button('新建技能', () => { draft = emptyDraft(); notice = null; render() }))
    actions.append(button('重新载入', reload))
    root.append(actions)
    if (notice) root.append(paragraph(notice, 'settings-error'))
    if (!view) { root.append(paragraph('正在读取技能库…')); return }
    if (view.corrupt) { root.append(paragraph(SKILL_REASON_TEXT['corrupt-store'], 'settings-error')); return }
    if (view.skills.length === 0) root.append(paragraph('还没有技能。新建一条，写上名称、说明、触发条件和正文即可。'))
    if (view.ignored > 0) root.append(paragraph(`另有 ${view.ignored} 条技能超出上限，未列出；请删除不再使用的技能。`))
    const list = el('div', 'skills-list')
    for (const skill of view.skills) list.append(entry(skill))
    root.append(list)
    if (draft) root.append(editor(draft))
  }

  function entry(skill: SkillsLibraryEntry): HTMLElement {
    const row = el('div', 'skill-row')
    const head = el('div', 'skill-head')
    const name = el('span', 'skill-name'); name.textContent = skill.name || '（未命名）'
    head.append(name)
    const toggle = el('input') as HTMLInputElement
    toggle.type = 'checkbox'; toggle.className = 'skill-toggle'; toggle.checked = skill.enabled
    toggle.setAttribute('aria-label', `在当前库启用 ${skill.name || '这条技能'}`)
    toggle.addEventListener('change', () => {
      void handlers.setEnabled({ id: skill.id, enabled: toggle.checked, expectedRevision: view?.revision ?? null }).then(result => accepts(result, () => render()))
    })
    head.append(toggle)
    row.append(head)
    if (skill.reason) row.append(paragraph(SKILL_REASON_TEXT[skill.reason], 'settings-error'))
    else row.append(paragraph(skill.description, 'settings-hint'))
    const meta = el('p', 'settings-hint')
    meta.textContent = `${skill.triggers.length > 0 ? `触发：${skill.triggers.join('、')}；` : ''}正文 ${Math.max(1, Math.round(skill.bytes / 1024))} KiB${skill.enabled ? '；本库已启用，下一场生效' : '；本库未启用'}`
    row.append(meta)
    const rowActions = el('div', 'settings-actions')
    rowActions.append(button('编辑', () => { draft = draftOf(skill); notice = null; render() }))
    rowActions.append(button('删除', () => {
      void handlers.save({ operation: 'remove', id: skill.id, expectedRevision: view?.revision ?? null }).then(result => accepts(result, () => { if (draft?.id === skill.id) draft = null; render() }))
    }))
    row.append(rowActions)
    return row
  }

  function editor(current: Draft): HTMLElement {
    const box = el('div', 'skill-editor')
    const heading = el('h4', 'settings-section-title'); heading.textContent = current.mode === 'create' ? '新建技能' : '编辑技能'
    box.append(heading)
    const name = el('input', 'settings-input') as HTMLInputElement
    name.type = 'text'; name.value = current.name; name.maxLength = SKILL_LIMITS.name * 2
    name.addEventListener('input', () => { current.name = name.value; validate() })
    const description = el('input', 'settings-input') as HTMLInputElement
    description.type = 'text'; description.value = current.description; description.maxLength = SKILL_LIMITS.description * 2
    description.addEventListener('input', () => { current.description = description.value; validate() })
    const triggers = el('textarea', 'settings-input') as HTMLTextAreaElement
    triggers.rows = 2; triggers.value = current.triggers
    triggers.addEventListener('input', () => { current.triggers = triggers.value; validate() })
    const body = el('textarea', 'settings-input skill-body') as HTMLTextAreaElement
    body.rows = 12; body.value = current.body
    body.addEventListener('input', () => { current.body = body.value; validate(); preview() })
    box.append(
      field('名称', name),
      field('说明（一句话，回答"这是什么"）', description),
      field('触发条件（每行一条，可留空）', triggers),
      field(`正文（≤ ${Math.round(SKILL_LIMITS.bodyBytes / 1024)} KiB，真正交给模型的指令）`, body)
    )
    const previewBox = el('div', 'skill-preview')
    box.append(paragraph('预览', 'settings-hint'), previewBox)
    const hint = el('p', 'settings-error')
    box.append(hint)
    const actions = el('div', 'settings-actions')
    const save = button('保存', () => {
      const record = draftRecord(current)
      const request = current.mode === 'create'
        ? { operation: 'create' as const, draft: record, expectedRevision: view?.revision ?? null }
        : { operation: 'update' as const, id: current.id!, draft: record, expectedRevision: view?.revision ?? null }
      void handlers.save(request).then(result => accepts(result, () => { draft = null; render() }))
    })
    actions.append(save, button('取消', () => { draft = null; notice = null; render() }))
    box.append(actions)

    function validate(): void {
      const reason = skillFieldsReason(draftRecord(current))
      hint.textContent = reason ? SKILL_REASON_TEXT[reason] : ''
      save.disabled = reason !== null
    }
    function preview(): void {
      renderReadOnlyMarkdown(previewBox, current.body.trim())
    }
    validate(); preview()
    return box
  }
}
