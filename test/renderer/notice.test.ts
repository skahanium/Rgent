// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearNotices, noticeText, pushNotice } from '../../src/renderer/src/notice.ts'

beforeEach(() => {
  clearNotices()
  document.body.replaceChildren()
})

afterEach(() => {
  clearNotices()
  document.body.replaceChildren()
})

describe('status bar notices', () => {
  it('mounts a polite, non-modal stack next to the status bar and shows title/detail', () => {
    const app = document.createElement('div')
    app.className = 'app'
    const status = document.createElement('footer')
    status.className = 'status'
    app.append(status)
    document.body.append(app)
    const editor = document.createElement('textarea')
    document.body.append(editor)
    editor.focus()

    pushNotice({ title: '这篇笔记和磁盘不一致', detail: '保存已暂缓；核对后再继续。', tone: 'warning' })

    const stack = app.querySelector<HTMLElement>('.notice-stack')
    expect(stack).not.toBeNull()
    expect(stack!.getAttribute('aria-live')).toBe('polite')
    expect(status.previousElementSibling).toBe(stack)
    // 非模态：没有 dialog，也没有拿走焦点。
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.activeElement).toBe(editor)
    const card = stack!.querySelector<HTMLElement>('.notice')!
    expect(card.dataset.tone).toBe('warning')
    expect(card.querySelector('.notice-title')!.textContent).toBe('这篇笔记和磁盘不一致')
    expect(card.querySelector('.notice-detail')!.textContent).toBe('保存已暂缓；核对后再继续。')
    expect(noticeText()).toContain('这篇笔记和磁盘不一致')
    expect(noticeText()).toContain('保存已暂缓；核对后再继续。')
  })

  it('falls back to the document body when no status bar exists and keeps multiline details', () => {
    pushNotice({ title: '文件已移动，部分引用没有修复', detail: 'a.md\nb.md' })
    const stack = document.querySelector<HTMLElement>('.notice-stack')!
    expect(stack.parentElement).toBe(document.body)
    expect(stack.querySelector('.notice-detail')!.textContent).toBe('a.md\nb.md')
  })

  it('renders an action button, runs the latest action and dismisses from the close button', () => {
    const stale = { calls: 0 }
    const fresh = { calls: 0 }
    const dismiss = pushNotice({
      title: '这篇笔记和磁盘不一致',
      detail: '保存已暂缓；核对后再继续。',
      action: { label: '核对', run: () => { stale.calls += 1 } }
    })
    // 合并时动作换成最新一次（闭包可能捕获了新的会话）。
    pushNotice({
      title: '这篇笔记和磁盘不一致',
      detail: '保存已暂缓；核对后再继续。',
      action: { label: '核对', run: () => { fresh.calls += 1 } }
    })
    const action = document.querySelector<HTMLButtonElement>('.notice-action')!
    expect(action.textContent).toBe('核对')
    action.click()
    expect(stale.calls).toBe(0)
    expect(fresh.calls).toBe(1)

    document.querySelector<HTMLButtonElement>('.notice-close')!.click()
    expect(document.querySelectorAll('.notice')).toHaveLength(0)
    // 返回的撤函数可重复调用。
    dismiss()
    expect(document.querySelectorAll('.notice')).toHaveLength(0)
  })

  it('caps the queue at three and folds overflow into one “另有多条提示” card', () => {
    for (let index = 1; index <= 3; index += 1) pushNotice({ title: `提示 ${index}` })
    expect(document.querySelectorAll('.notice')).toHaveLength(3)

    pushNotice({ title: '提示 4' })
    expect(document.querySelectorAll('.notice')).toHaveLength(3)
    expect(noticeText()).toContain('另有多条提示')
    // 没有可保留的动作卡时，与旧行为一致：挤出最早两张，最新一条始终可见。
    expect(noticeText()).toContain('另有 2 条提示没有展开。')
    expect(noticeText()).not.toContain('提示 1')
    expect(noticeText()).not.toContain('提示 2')
    expect(noticeText()).toContain('提示 3')
    expect(noticeText()).toContain('提示 4')

    // 同一情形重复触发只加计数一次，不叠卡片。
    pushNotice({ title: '提示 4' })
    pushNotice({ title: '提示 4' })
    expect(document.querySelectorAll('.notice')).toHaveLength(3)
    expect(noticeText()).toContain('另有 2 条提示没有展开。')

    pushNotice({ title: '提示 5' })
    expect(document.querySelectorAll('.notice')).toHaveLength(3)
    expect(noticeText()).toContain('另有 3 条提示没有展开。')
  })

  it('never drops a notice that carries an action while an action-less one can go', () => {
    pushNotice({ title: '只读提示 1' })
    pushNotice({ title: '有动作的提示', action: { label: '核对', run: () => {} } })
    pushNotice({ title: '只读提示 3' })
    pushNotice({ title: '只读提示 4' })
    expect(document.querySelectorAll('.notice')).toHaveLength(3)
    expect(noticeText()).toContain('有动作的提示')
    expect([...document.querySelectorAll('.notice-action')].map((node) => node.textContent)).toContain('核对')
    // 最早的一条只读提示被挤出；有动作的那张和最新一条都还在。
    expect(noticeText()).not.toContain('只读提示 1')
    expect(noticeText()).toContain('只读提示 4')

    // 关掉合并卡就丢掉被合并的那些提示。
    const overflow = [...document.querySelectorAll<HTMLElement>('.notice')].find(card =>
      card.textContent?.includes('另有多条提示'))
    overflow!.querySelector<HTMLButtonElement>('.notice-close')!.click()
    expect(document.querySelectorAll('.notice')).toHaveLength(2)
    expect(noticeText()).not.toContain('另有多条提示')
  })

  it('merges identical notices but keeps two notes’ conflicts apart by key', () => {
    pushNotice({ title: '保存失败', detail: '磁盘忙。' })
    pushNotice({ title: '保存失败', detail: '磁盘忙。' })
    expect(document.querySelectorAll('.notice')).toHaveLength(1)

    pushNotice({ key: 'conflict:a.md', title: '这篇笔记和磁盘不一致', detail: '保存已暂缓；核对后再继续。' })
    pushNotice({ key: 'conflict:a.md', title: '这篇笔记和磁盘不一致', detail: '保存已暂缓；核对后再继续。' })
    expect(document.querySelectorAll('.notice')).toHaveLength(2)
    pushNotice({ key: 'conflict:b.md', title: '这篇笔记和磁盘不一致', detail: '保存已暂缓；核对后再继续。' })
    expect(document.querySelectorAll('.notice')).toHaveLength(3)
  })
})

describe('renderer native dialogs', () => {
  it('no renderer source file calls window.alert/window.confirm', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer/src')
    const offenders = readdirSync(dir)
      .filter(file => file.endsWith('.ts'))
      .filter(file => /window\.(?:alert|confirm)\(/u.test(readFileSync(path.join(dir, file), 'utf8')))
    expect(offenders).toEqual([])
  })
})
