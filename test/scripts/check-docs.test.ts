import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const fixtures: string[] = []
function fixture(): { root: string; build: string; run: () => { status: number | null; stderr: string } } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rgent-doc-check-'))
  fixtures.push(root)
  for (const name of ['AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'LICENSE']) cpSync(path.join(process.cwd(), name), path.join(root, name))
  cpSync(path.join(process.cwd(), 'docs'), path.join(root, 'docs'), { recursive: true })
  mkdirSync(path.join(root, 'scripts'))
  cpSync(path.join(process.cwd(), 'scripts/check-docs.mjs'), path.join(root, 'scripts/check-docs.mjs'))
  return {
    root,
    build: path.join(root, 'docs/build.md'),
    run: () => {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-docs.mjs')], { cwd: root, encoding: 'utf8' })
      return { status: result.status, stderr: result.stderr }
    }
  }
}
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('docs stage invariants', () => {
  it('rejects a current stage without its own section', () => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    const changed = source.replace(/^## 笔记库文件生命周期.*$/m, '### 笔记库文件生命周期')
    expect(changed).not.toBe(source)
    writeFileSync(build, changed)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('当前阶段节')
  })

  it('rejects a current stage omitted from the dependency order', () => {
    const { build, run } = fixture()
    // Exercise the same CRLF checkout Git produces on Windows.
    const source = readFileSync(build, 'utf8').replace(/\r?\n/g, '\r\n')
    const changed = source.replace(/^  → 笔记库文件生命周期[^\r\n]*(?:\r?\n|$)/m, '')
    expect(changed).not.toBe(source)
    writeFileSync(build, changed)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('依赖顺序')
  })

  it('rejects a stage switch without exactly one current matrix row', () => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    const changed = source.replace(/(\| 库与文件 \|[^\n]*)\*\*当前\*\*/, '$1**已交**')
    expect(changed).not.toBe(source)
    writeFileSync(build, changed)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('对象矩阵')
  })

  it('rejects a matrix status outside the three phase states', () => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    const changed = source.replace(/(\| 界面改造 \|[^\n]*?)\*\*已交\*\*/, '$1**冻结**')
    expect(changed).not.toBe(source)
    writeFileSync(build, changed)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('阶段状态')
  })

  it('rejects a handoff stage missing from the dependency graph', () => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    const changed = source.replace('| 库内人工记忆 | 文件身份', '| 未列入依赖图的记忆阶段 | 文件身份')
    expect(changed).not.toBe(source)
    writeFileSync(build, changed)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('交接表阶段')
  })

  it('does not accept a handoff stage that is only a prefix of a graph node', () => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    const changed = source.replace('| Host 最小环 | 身份标记', '| Host | 身份标记')
    expect(changed).not.toBe(source)
    writeFileSync(build, changed)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('交接表阶段')
  })
})
