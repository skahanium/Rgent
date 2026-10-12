import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** 包 4：合同里几条「不能怎样」的边界，用可复算的判据钉住。
 *  纯函数判据先对违反样例返回 true（红），再对真实源码返回 false（绿）——
 *  这样判据本身不会写成一个永远为真的摆设。 */

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8')

/** 写入技能库的路径只该出现在 IPC 与存储层，不该被模型面（宿主、工具）触达。 */
const writesSkills = (source: string): boolean => /createSkillsStore|skills-store|\.setEnabled\(/.test(source)

/** 技能内容不得进入记忆体系（合同：技能不进记忆存储，记忆整理也不得把它当材料）。 */
const referencesSkills = (source: string): boolean => /SkillRecord|SkillView|FrozenSkills|skills-store|'\.\/skills\.ts'/.test(source)

/** 模型拿到的工具清单里不得出现技能写入类工具。 */
const exposesSkillTool = (source: string): boolean => /\b(write_skill|create_skill|enable_skill|update_skill)\b/.test(source)

describe('skill boundaries', () => {
  it('keeps the skill write path out of the model-facing host and tools', () => {
    // 红：违反样例必须被抓住。
    expect(writesSkills("import {createSkillsStore} from './skills-store.ts'")).toBe(true)
    expect(writesSkills('store.setEnabled(key, ids, rev)')).toBe(true)
    // 绿：真实的宿主与工具层都不含写入路径（宿主只接收冻结结果）。
    expect(writesSkills(read('src/main/agent-host.ts'))).toBe(false)
    expect(writesSkills(read('src/main/scoped-agent-tools.ts'))).toBe(false)
    expect(exposesSkillTool(read('src/main/scoped-agent-tools.ts'))).toBe(false)
    expect(exposesSkillTool("tools.push({name:'write_skill'})")).toBe(true)
  })

  it('keeps skills out of the memory pipeline entirely', () => {
    const memoryFiles = readdirSync(path.join(root, 'src/main'))
      .filter(name => /^(working-memory|memory-|host-material|reasoning-store)/.test(name) && name.endsWith('.ts'))
    expect(memoryFiles.length).toBeGreaterThan(3)
    for (const name of memoryFiles) expect(referencesSkills(read(`src/main/${name}`)), name).toBe(false)
    // 红：把技能类型塞进记忆文件就必须被同一判据抓住。
    expect(referencesSkills("import type {SkillRecord} from '../shared/skills.ts'")).toBe(true)
  })

  it('never puts a skill body into the send-confirmation payload', () => {
    const source = read('src/main/index.ts')
    const mapping = /skills:skills\.record\.map\([^)]*\)/u.exec(source)?.[0]
    expect(mapping, 'preview must map the frozen record explicitly').toBeTruthy()
    expect(mapping!).toContain('id:skill.id')
    expect(mapping!).toContain('name:skill.name')
    expect(mapping!).not.toMatch(/body|bytes|triggers|description/u)
    // 红：把整条记录摊进预览的写法会被同一断言拒掉。
    const leaky = 'skills:skills.record.map(skill=>({id:skill.id,name:skill.name,body:skill.body}))'
    expect(/body|bytes/u.test(leaky)).toBe(true)
  })

  it('records only id, name and hash in the ledger, never the body', () => {
    const host = read('src/main/agent-host.ts')
    expect(host).toContain('skills: skills.record')
    expect(/skills:.*\bbody\b/u.test(host)).toBe(false)
    const frozen = read('src/main/skills.ts')
    const record = /record: snapshot\.entries\.map\([^)]*\)/u.exec(frozen)?.[0]
    expect(record).toBeTruthy()
    expect(record!).not.toMatch(/\bbody\b/u)
  })
})
