import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyChanges, verificationPassed } from '../../scripts/ci-scope.mjs'

test('进度、协议与参考图只跑文档检查', () => {
  assert.deepEqual(classifyChanges(['AGENTS.md', 'docs/build.md', 'docs/frontend/day-workspace.png']),
    { runtime: false, visual: false, trash: false, docsTests: false })
})
test('任意 Markdown 文件不能被误认成文档', () => {
  assert.equal(classifyChanges(['src/renderer/template.md']).runtime, true)
})
test('文档检查器及其用例需要定向测试', () => {
  for (const path of ['scripts/check-docs.mjs', 'test/scripts/check-docs.test.ts']) {
    assert.deepEqual(classifyChanges([path]), { runtime: false, visual: false, trash: false, docsTests: true })
  }
})
test('主进程业务代码保留完整功能窗口门，跳过视觉重复采证', () => {
  assert.deepEqual(classifyChanges(['src/main/vault.ts', 'test/main/vault.test.ts']),
    { runtime: true, visual: false, trash: false, docsTests: false })
})
test('画布、壳、主题与验收脚本会触发视觉采证', () => {
  for (const path of ['src/renderer/src/style.css', 'src/main/index.ts', 'src/preload/index.ts',
    'src/main/theme-preference.ts', 'scripts/verify-ui.mjs']) {
    assert.equal(classifyChanges([path]).visual, true, path)
  }
})
test('构建、依赖、CI 自身与未知路径保守地跑双平台和视觉', () => {
  for (const path of ['package.json', 'pnpm-lock.yaml', 'native/vault.cc', '.github/workflows/verify.yml',
    'scripts/ci-scope.mjs', 'new-component/config.toml']) {
    const result = classifyChanges([path])
    assert.equal(result.runtime, true, path)
    assert.equal(result.visual, true, path)
    assert.equal(result.trash, false, path)
  }
})
test('独立探针改动不触发产品构建，但始终触发探针', () => {
  for (const path of ['scripts/probe-trash.mjs', 'test/native/trash_mac.mm', 'test/native/trash_win.cc']) {
    assert.deepEqual(classifyChanges([path]), { runtime: false, visual: false, trash: true, docsTests: false })
  }
})
test('混合变更不能因其中包含文档或探针而漏掉代码门', () => {
  assert.deepEqual(classifyChanges(['docs/build.md', 'test/native/trash_win.cc', 'src/main/vault.ts']),
    { runtime: true, visual: false, trash: true, docsTests: false })
})
test('手动 full 包括所有门，trash 只做独立实验，standard 保留代码门', () => {
  assert.deepEqual(classifyChanges([], 'full'), { runtime: true, visual: true, trash: true, docsTests: true })
  assert.deepEqual(classifyChanges([], 'trash'), { runtime: false, visual: false, trash: true, docsTests: false })
  assert.deepEqual(classifyChanges([], 'standard'), { runtime: true, visual: false, trash: false, docsTests: false })
})
test('缺失 diff 或未知手动选项不能跳过代码门', () => {
  assert.equal(classifyChanges([]).runtime, true)
  assert.throws(() => classifyChanges([], 'typo'))
})
test('必需门失败、取消或意外跳过不能被 always 汇总为绿灯', () => {
  const scope = classifyChanges(['src/main/vault.ts'])
  const ok = { plan: 'success', docs: 'success', verify: 'success', trash: 'skipped' }
  assert.equal(verificationPassed(scope, ok), true)
  for (const job of ['plan', 'docs', 'verify']) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.equal(verificationPassed(scope, { ...ok, [job]: result }), false)
    }
  }
})
test('只允许计划明确不需要的门跳过，重复 push 必须由成功的分类门确认', () => {
  const scope = classifyChanges(['docs/build.md'])
  const results = { plan: 'success', docs: 'success', verify: 'skipped', trash: 'skipped' }
  assert.equal(verificationPassed(scope, results), true)
  assert.equal(verificationPassed(classifyChanges([], 'full'), results), false)
  assert.equal(verificationPassed(scope, { ...results, docs: 'skipped' }, true), true)
  assert.equal(verificationPassed(scope, { ...results, plan: 'failure' }, true), false)
})

const script = fileURLToPath(new URL('../../scripts/ci-scope.mjs', import.meta.url))
function withRepo(check) {
  const root = mkdtempSync(join(tmpdir(), 'rgent-ci-scope-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const run = event => {
    const eventPath = join(root, 'event.json'), outputPath = join(root, 'output')
    writeFileSync(eventPath, JSON.stringify(event)); writeFileSync(outputPath, '')
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: {
      ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: outputPath,
    } })
    assert.equal(result.status, 0, result.stderr)
    return readFileSync(outputPath, 'utf8')
  }
  try {
    git('init', '-q'); git('config', 'user.email', 'ci-fixture@example.invalid'); git('config', 'user.name', 'CI fixture')
    writeFileSync(join(root, 'README.md'), 'original')
    git('add', 'README.md'); git('commit', '-qm', 'base')
    check({ root, git, run, base: git('rev-parse', 'HEAD') })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('真实 push 差异按全部提交计算，改名从代码到文档不能漏验', () => {
  withRepo(({ root, git, run, base }) => {
    writeFileSync(join(root, 'worker.js'), 'code')
    git('add', 'worker.js'); git('commit', '-qm', 'code')
    git('mv', 'worker.js', 'CONTRIBUTING.md'); git('commit', '-qm', 'rename')
    const output = run({ before: base, after: git('rev-parse', 'HEAD') })
    // 最终树已无 worker.js，但它也从未在基准树存在；最终净差异仅文档。
    assert.match(output, /runtime=false/)
    const renamedBase = git('rev-parse', 'HEAD~1')
    assert.match(run({ before: renamedBase, after: git('rev-parse', 'HEAD') }), /runtime=true/)
  })
})
test('删去代码或带换行的未知路径均保留代码门', () => {
  withRepo(({ root, git, run }) => {
    writeFileSync(join(root, 'odd\nname.js'), 'code')
    git('add', '.'); git('commit', '-qm', 'special file')
    const before = git('rev-parse', 'HEAD')
    git('rm', 'odd\nname.js'); git('commit', '-qm', 'delete')
    assert.match(run({ before, after: git('rev-parse', 'HEAD') }), /runtime=true/)
  })
})
test('新分支或强推丢失基准回退完整代码门，纯文档不装产品依赖', () => {
  withRepo(({ root, git, run, base }) => {
    writeFileSync(join(root, 'README.md'), 'changed')
    git('add', 'README.md'); git('commit', '-qm', 'docs')
    const after = git('rev-parse', 'HEAD')
    assert.match(run({ before: base, after }), /runtime=false/)
    for (const before of ['0'.repeat(40), '1'.repeat(40)]) {
      const output = run({ before, after })
      assert.match(output, /runtime=true/); assert.match(output, /visual=true/)
    }
  })
})
test('PR 只分类分叉后的改动，不把目标分支的更新算进来', () => {
  withRepo(({ root, git, base }) => {
    git('checkout', '-qb', 'feature')
    writeFileSync(join(root, 'README.md'), 'feature docs'); git('add', '.'); git('commit', '-qm', 'docs')
    const head = git('rev-parse', 'HEAD')
    git('checkout', '-q', '--detach', base)
    writeFileSync(join(root, 'runtime.js'), 'base update'); git('add', '.'); git('commit', '-qm', 'base code')
    const eventPath = join(root, 'event.json'), outputPath = join(root, 'output')
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: git('rev-parse', 'HEAD') }, head: { sha: head } } }))
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: {
      ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
    } })
    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(outputPath, 'utf8'), /runtime=false/)
  })
})
test('汇总 CLI 缺失分类输出必须失败，不能把空值当作无需验收', () => {
  const result = spawnSync(process.execPath, [script, 'summary'], { encoding: 'utf8', env: {
    ...process.env, CI_NEEDS: JSON.stringify({
      plan: { result: 'success', outputs: {} }, docs: { result: 'success' },
      verify: { result: 'skipped' }, trash: { result: 'skipped' },
    }),
  } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /分类输出/)
})
