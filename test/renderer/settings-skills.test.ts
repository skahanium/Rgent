// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mountSkillsPage } from '../../src/renderer/src/settings-skills.ts'
import { SKILL_LIMITS, SKILL_REASON_TEXT, type SkillsLibraryView, type SkillsResult } from '../../src/shared/skills.ts'

afterEach(() => document.body.replaceChildren())

const view = (over: Partial<SkillsLibraryView> = {}): SkillsLibraryView => ({
  sessionId: 's',
  revision: 'rev-1',
  corrupt: false,
  ignored: 0,
  skills: [
    { id: 'grade', name: '答案批改', description: '按规则给客观题判分', triggers: ['批改'], body: '先核对题号。', bytes: 8, reason: null, enabled: true },
    { id: 'broken', name: '过期规则', description: '', triggers: [], body: '', bytes: 0, reason: 'too-large', enabled: false }
  ],
  ...over
})

function mount(viewOr: SkillsLibraryView, save = vi.fn(async (): Promise<SkillsResult> => ({ ok: true, view: view() })), setEnabled = vi.fn(async (): Promise<SkillsResult> => ({ ok: true, view: view() }))) {
  const body = document.createElement('section')
  document.body.append(body)
  const dispose = mountSkillsPage({ body, isCurrent: () => true }, {
    get: async () => ({ ok: true, view: viewOr }),
    save,
    setEnabled
  })
  return { body, dispose, save, setEnabled }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

it('lists skills with their enablement and shows the human reason for anything unusable', async () => {
  const { body } = mount(view())
  await tick()
  expect(body.textContent).toContain('答案批改')
  expect(body.textContent).toContain('按规则给客观题判分')
  expect(body.textContent).toContain(SKILL_REASON_TEXT['too-large'])
  expect(body.textContent).toContain('本库已启用，下一场生效')
  const toggles = body.querySelectorAll<HTMLInputElement>('.skill-toggle')
  expect(toggles[0]!.checked).toBe(true)
  expect(toggles[1]!.checked).toBe(false)
})

it('says so when the library is empty or unreadable instead of pretending there are no skills', async () => {
  const empty = mount(view({ skills: [] }))
  await tick()
  expect(empty.body.textContent).toContain('还没有技能')
  const corrupt = mount(view({ corrupt: true, skills: [] }))
  await tick()
  expect(corrupt.body.textContent).toContain(SKILL_REASON_TEXT['corrupt-store'])
  expect(corrupt.body.textContent).not.toContain('还没有技能')
})

it('toggles enablement for this vault against the current revision', async () => {
  const { body, setEnabled } = mount(view())
  await tick()
  const toggle = body.querySelectorAll<HTMLInputElement>('.skill-toggle')[1]!
  toggle.checked = true
  toggle.dispatchEvent(new Event('change'))
  await tick()
  expect(setEnabled).toHaveBeenCalledWith({ id: 'broken', enabled: true, expectedRevision: 'rev-1' })
})

it('edits a skill in a sub-page, validating fields before saving trimmed values', async () => {
  const { body, save } = mount(view())
  await tick()
  Array.from(body.querySelectorAll<HTMLButtonElement>('.settings-action')).find(node => node.textContent === '编辑')!.click()
  await tick()
  const inputs = body.querySelectorAll<HTMLInputElement>('.skill-editor input')
  expect(inputs[0]!.value).toBe('答案批改')
  const bodyText = body.querySelector<HTMLTextAreaElement>('.skill-body')!
  expect(bodyText.value).toBe('先核对题号。')

  // 超长名称：给出人话原因并禁用保存。
  inputs[0]!.value = 'x'.repeat(SKILL_LIMITS.name + 1)
  inputs[0]!.dispatchEvent(new Event('input'))
  expect(body.textContent).toContain(SKILL_REASON_TEXT['invalid-name'])
  const saveButton = Array.from(body.querySelectorAll<HTMLButtonElement>('.settings-action')).find(node => node.textContent === '保存')!
  expect(saveButton.disabled).toBe(true)

  inputs[0]!.value = '  答案批改 v2  '
  inputs[0]!.dispatchEvent(new Event('input'))
  expect(saveButton.disabled).toBe(false)
  saveButton.click()
  await tick()
  expect(save).toHaveBeenCalledWith({ operation: 'update', id: 'grade', draft: { name: '答案批改 v2', description: '按规则给客观题判分', triggers: ['批改'], body: '先核对题号。' }, expectedRevision: 'rev-1' })
})

it('creates a skill with an empty triggers list and reads errors as human text', async () => {
  const save = vi.fn(async (): Promise<SkillsResult> => ({ ok: false, error: 'SKILLS_STORE_CONFLICT' }))
  const { body } = mount(view({ skills: [] }), save)
  await tick()
  Array.from(body.querySelectorAll<HTMLButtonElement>('.settings-action')).find(node => node.textContent === '新建技能')!.click()
  const inputs = body.querySelectorAll<HTMLInputElement>('.skill-editor input')
  inputs[0]!.value = '新技能'
  inputs[0]!.dispatchEvent(new Event('input'))
  inputs[1]!.value = '一句话说明'
  inputs[1]!.dispatchEvent(new Event('input'))
  const area = body.querySelector<HTMLTextAreaElement>('.skill-body')!
  area.value = '正文内容'
  area.dispatchEvent(new Event('input'))
  Array.from(body.querySelectorAll<HTMLButtonElement>('.settings-action')).find(node => node.textContent === '保存')!.click()
  await tick()
  expect(save).toHaveBeenCalledWith({ operation: 'create', draft: { name: '新技能', description: '一句话说明', triggers: [], body: '正文内容' }, expectedRevision: 'rev-1' })
  expect(body.textContent).toContain('技能库刚刚被改动过')
  expect(body.textContent).not.toContain('SKILLS_STORE_CONFLICT')
})
