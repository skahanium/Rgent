import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md', ...[
  'README.md', 'architecture.md', 'build.md', 'decisions.md', 'handbook.md',
  'opensource.md', 'topics.md', 'vision.md'
].map((name) => `docs/${name}`)]
const errors = []

for (const file of files) {
  const source = readFileSync(path.join(root, file), 'utf8')
  const withoutCode = source.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  for (const match of withoutCode.matchAll(/!?\[[^\]\n]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '').split('#')[0]
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue
    if (!existsSync(path.resolve(root, path.dirname(file), decodeURIComponent(target)))) {
      errors.push(`${file}: 相对链接不存在：${match[1]}`)
    }
  }
}

const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
const build = readFileSync(path.join(root, 'docs/build.md'), 'utf8')
const stageOf = (source) => source.match(/^## 当前阶段\s*\n+\*\*([^*]+)\*\*/m)?.[1]
const agentsStage = stageOf(agents)
const buildStage = stageOf(build)
if (!agentsStage || !buildStage || agentsStage !== buildStage) {
  errors.push(`当前阶段不一致：AGENTS.md=${agentsStage ?? '缺失'}；docs/build.md=${buildStage ?? '缺失'}`)
}
if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`文档检查通过：${files.length} 个文件，当前阶段「${buildStage}」。\n`)
}
