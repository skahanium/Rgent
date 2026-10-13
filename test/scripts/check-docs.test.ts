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
  mkdirSync(path.join(root, 'src/main'), { recursive: true })
  cpSync(path.join(process.cwd(), 'src/main/working-memory-consolidation.ts'), path.join(root, 'src/main/working-memory-consolidation.ts'))
  mkdirSync(path.join(root, 'scripts'))
  cpSync(path.join(process.cwd(), 'scripts/check-docs.mjs'), path.join(root, 'scripts/check-docs.mjs'))
  cpSync(path.join(process.cwd(), 'scripts/probe-trash.mjs'), path.join(root, 'scripts/probe-trash.mjs'))
  mkdirSync(path.join(root, 'test/native'), { recursive: true })
  for (const name of ['trash_mac.mm', 'trash_win.cc']) {
    cpSync(path.join(process.cwd(), 'test/native', name), path.join(root, 'test/native', name))
  }
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
  it('preserves headings after inline fence examples and before real fenced blocks', () => {
    const { root, run } = fixture()
    const vision = path.join(root, 'docs/vision.md')
    const source = readFileSync(vision, 'utf8')
    const regression = [
      '', '行内示例：` ```example `。', '', '## 回归测试可见标题', '',
      '```mermaid', 'flowchart LR', '  A --> B', '```', ''
    ].join('\r\n')
    writeFileSync(vision, source.replace(/\r?\n/g, '\r\n') + regression)
    const map = path.join(root, 'docs/README.md')
    writeFileSync(map, readFileSync(map, 'utf8') + '\n[回归入口](vision.md#回归测试可见标题)\n')
    const result = run()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('rejects links to headings inside real fenced code', () => {
    const { root, run } = fixture()
    const vision = path.join(root, 'docs/vision.md')
    writeFileSync(vision, readFileSync(vision, 'utf8') + '\n```markdown\n## 围栏内测试标题\n```\n')
    const map = path.join(root, 'docs/README.md')
    writeFileSync(map, readFileSync(map, 'utf8') + '\n[无效入口](vision.md#围栏内测试标题)\n')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('锚点不存在：vision.md#围栏内测试标题')
  })

  it.each(['\n', '\r\n'])('rejects a current stage without its own section (%j)', (newline) => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8').replace(/\r?\n/g, newline)
    const stage = source.match(/^## 当前阶段\s*\n+\*\*([^*]+)\*\*/m)![1]!.replace(/[。.!！\s]+$/u, '')
    const changed = source.split('\n').map(line => line.replace(/\r$/, '') === `## ${stage}` ? `#${line}` : line).join('\n')
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
    const stage = source.match(/^## 当前阶段\s*\n+\*\*([^*]+)\*\*/m)![1]!.replace(/[。.!！\s]+$/u, '')
    const changed = source.split('\r\n').filter(line => !line.trim().startsWith(`→ ${stage}`)).join('\r\n')
    expect(changed).not.toBe(source)
    writeFileSync(build, changed)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('依赖顺序')
  })

  it('rejects a stage switch without exactly one current matrix row', () => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    const changed = source.replace(/(\|[^\n]+)\*\*当前\*\*/, '$1**已交**')
    expect(changed).not.toBe(source)
    writeFileSync(build, changed)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('对象矩阵')
  })

  it('rejects a current matrix row whose object is not in the dependency order', () => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    const changed = source.replace(/^\|([^|\n]+)\|([^\n]*\*\*当前\*\*)/m, '| 不存在的对象 |$2')
    expect(changed).not.toBe(source)
    writeFileSync(build, changed)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('「当前」行')
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
    const changed = source.replace(/^\| 库内记忆 \|/m, '| 未列入依赖图的记忆阶段 |')
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

  it('rejects a current matrix object that names a different existing stage', () => {
    const { root, build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    // 当前阶段会随施工推进而改；这里动态挑一个**不是**当前的已有阶段，避免把阶段名写死。
    const stage = /^## 当前阶段\s*\n+\*\*([^*]+)\*\*/m.exec(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'))?.[1]
    const order = /^## 依赖顺序\s*\n[\s\S]*?```text\s*\n([\s\S]*?)\n```/m.exec(source)?.[1] ?? ''
    const others = order.split(/\r?\n/).map(line => line.trim().replace(/^→\s*/, '').split('（')[0]!.trim()).filter(Boolean)
    const other = others.find(name => name && name !== stage)
    expect(other, '依赖顺序里应当有当前阶段之外的阶段').toBeTruthy()
    const changed = source.replace(/^(\| )[^|\n]+( \|[^\n]*\*\*当前\*\*)/m, `$1${other}$2`)
    expect(changed).not.toBe(source)
    writeFileSync(build, changed)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('当前阶段与矩阵当前行不一致')
  })

  it('accepts pending delivery rows and historical commit references', () => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    const row = /\| 文档校准及检查规则 \| [^|]+ \|/
    expect(source).toMatch(row)
    writeFileSync(build, source.replace(row, '| 文档校准及检查规则 | 待提交 |'))
    const result = run()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('rejects a delivery row without a commit or explicit pending marker', () => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    const row = /\| 文档校准及检查规则 \| [^|]+ \|/
    expect(source).toMatch(row)
    writeFileSync(build, source.replace(row, '| 文档校准及检查规则 | HEAD |'))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('交付对照提交引用无效')
  })

  it('rejects an unstructured evidence claim in the delivery table', () => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    const row = /\| 文档校准及检查规则 \| [^|]+ \| [^|]+ \|/
    expect(source).toMatch(row)
    writeFileSync(build, source.replace(row, '| 文档校准及检查规则 | 待提交 | 应该通过 |'))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('交付对照证据状态无效')
  })

  it('rejects a missing current delivery table', () => {
    const { build, run } = fixture()
    const source = readFileSync(build, 'utf8')
    writeFileSync(build, source.replace('### 本轮交付对照', '### 临时交付说明'))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('交付对照表缺少施工包')
  })

})

it('rejects a v2 delivery claim lacking a date or tested commit',()=>{
 const {build,run}=fixture(),s=readFileSync(build,'utf8')
 writeFileSync(build,s.replace(/^\| 5 集成 .*$/m,'| 5 集成 | 已开 | 当前运行 | 通过 |'))
 expect(run().stderr).toContain('v2 交付证据缺少日期或受验提交')
})
