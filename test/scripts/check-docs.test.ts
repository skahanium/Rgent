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
    writeFileSync(build, readFileSync(build, 'utf8').replace(/^## 笔记库文件生命周期.*$/m, '### 笔记库文件生命周期'))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('当前阶段节')
  })

  it('rejects a current stage omitted from the dependency order', () => {
    const { build, run } = fixture()
    writeFileSync(build, readFileSync(build, 'utf8').replace(/^  → 笔记库文件生命周期.*\n/m, ''))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('依赖顺序')
  })

  it('rejects a stage switch without exactly one current matrix row', () => {
    const { build, run } = fixture()
    writeFileSync(build, readFileSync(build, 'utf8').replace(/(\| 库与文件 \|[^\n]*)\*\*当前\*\*/, '$1**已交**'))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('对象矩阵')
  })
})
