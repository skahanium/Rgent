#!/usr/bin/env node
// 只读评审转储：给定冻结报告目录 + 案例 id + 模型，打印试卷期望与该例的终态记忆，供语义标注逐项核对。
// 不写任何评测文件、不发任何调用。用法：
//   node scripts/memory-quality-review-dump.mjs --report <dir> --case v6-standing-01 --model deepseek-flash [--round 0]
import {readFileSync, readdirSync} from 'node:fs'
import path from 'node:path'
import {V6_QUALITY_CASES} from '../test/fixtures/v6-memory-quality.ts'

const args = process.argv.slice(2)
const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const report = value('--report'), caseId = value('--case'), model = value('--model'), round = Number(value('--round') ?? 0)
if (!report || !caseId || !model) { console.error('usage: --report DIR --case ID --model M [--round 0|1]'); process.exit(1) }
const spec = V6_QUALITY_CASES.find((item) => item.id === caseId)
if (!spec) { console.error('unknown case', caseId); process.exit(1) }

let hit = null
for (const name of readdirSync(report).filter((entry) => entry.startsWith('result-'))) {
  const raw = JSON.parse(readFileSync(path.join(report, name), 'utf8'))
  const parts = String(raw.key ?? '').split('/')
  if (parts.at(-1) === caseId && parts.at(-3) === model && Number(parts.at(-2)) === round) { hit = raw; break }
}
console.log('=== 试卷期望 ===')
console.log(JSON.stringify({
  id: spec.id, direction: spec.direction, weight: spec.weight, kind: spec.kind, chain: spec.chain ?? null, step: spec.step ?? null,
  prompt: spec.prompt, body: spec.body, seed: spec.seed?.content ?? null,
  units: spec.expected.units, forbidden: spec.expected.forbidden, action: spec.expected.action ?? null,
  semantic: spec.expected.semantic ?? null, targetCategory: spec.expected.targetCategory ?? null, maxActive: spec.expected.maxActive ?? null,
  safety: spec.safety ?? null, condition: spec.expected.condition ?? null
}, null, 2))
if (!hit) { console.log('=== 结果：尚未派发 ==='); process.exit(0) }
const result = hit.result ?? {}
console.log('=== 终态 ===')
console.log(JSON.stringify({
  status: hit.status ?? null, frozenHashMatch: hit.frozenHash ?? null,
  receipt: {outcome: result.receipt?.outcome ?? null, reason: result.receipt?.reason ?? null, results: result.receipt?.results ?? null},
  actionVerified: result.actionVerified ?? null, actionEvidence: result.actionEvidence ?? null,
  category: result.category ?? null, failureOrigin: result.candidate?.failureOrigin ?? null,
  entries: (result.entries ?? []).map((e) => ({semantic: e.semantic, layer: e.layer, category: e.category, status: e.status, scope: e.scope, content: String(e.content ?? '').slice(0, 300)})),
  recent: (result.recent ?? []).map((e) => ({category: e.category, status: e.status, sections: e.recent?.sections ?? null, assistantDraft: e.recent?.assistantDraft ?? null})),
  before: (result.before ?? []).map((e) => ({semantic: e.semantic, status: e.status, content: String(e.content ?? '').slice(0, 160)})),
  dispatches: (result.evidence?.dispatches ?? []).map((d) => ({phase: d.phase, finishReason: d.finishReason, reason: d.reason})),
  proposals: (hit.responses ?? []).flatMap((response) => {
    const raw = String(response?.body ?? '').trim().replace(/^```json\s*/, '').replace(/\s*```$/, '')
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return (parsed.proposals ?? []).map((item) => ({action: item.action, target: item.target ?? null, semantic: item.semantic ?? null, scope: item.scope ?? null, content: String(item.content ?? '').slice(0, 260), attribution: String(item.attribution ?? '').slice(0, 120), value: item.value ? {action: item.value.action, target: item.value.target ?? null, semantic: item.value.semantic ?? null, content: String(item.value.content ?? '').slice(0, 200)} : null}))
    } catch { return [{unparsed: raw.slice(0, 200)}] }
  })
}, null, 2))
