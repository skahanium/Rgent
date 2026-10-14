#!/usr/bin/env node
/**
 * 全卷人工语义复核包（零模型调用）。
 *
 * 背景与出题纪律：首版目标化复核把英文口令原样摆出、又问需要评分口径才答得出的抽象问题，
 * 用户明确表示看不懂（见 test/fixtures/v6-outcome-review.json 的 protocolFlaws）。之后的
 * 人工复核一律：中文重述、二选一问题、给「对的样子／错的样子」对照、且**不给试卷期望、不给 Agent 判定**。
 *
 * 只用冻结产物（.cache/memory-quality/<run>/result-*.json）：
 *   node scripts/memory-review-pack.mjs [--run DIR] [--out artifacts/memory-review]
 *   node scripts/memory-review-pack.mjs --answers answers.json --out artifacts/memory-review
 *
 * 第一种模式产出一张 index.html（人直接在里面作答并导出答案 JSON）＋ answers.template.json。
 * 第二种模式把答案转成评测 CLI 接受的 --annotation 文件（人工标注者身份，humanReviewed:true）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 逐字保留的人工判词 → 机读计数的映射。写在题面上，人看得见自己的一句话会怎么被算。 */
export const MAPPING_NOTE = [
  '「可以接受」且没列遗漏、没列不该留 → 期望单元全部记为正确。',
  '「不可以接受」或列了遗漏 → 遗漏条数＝遗漏栏里非空的行数（不超过期望单元数），正确＝期望单元数−遗漏数。',
  '列了「不该留」→ 不该留条数＝该栏里非空的行数。',
  '「看不懂」的行不转换，也不会被当成已复核。',
  '人工判词原样存进 humanVerdict 字段，映射只是把它换算成机读计数，改不了原话。'
].join('\n')

export function latestRun() {
  const base = path.join(root, '.cache', 'memory-quality')
  if (!existsSync(base)) throw Error('没有评测产物目录')
  const found = readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ dir: path.join(base, entry.name), names: readdirSync(path.join(base, entry.name)) }))
    .filter(item => item.names.some(name => name.startsWith('result-')))
  if (!found.length) throw Error('没有找到含 result-*.json 的评测产物目录')
  // 取最近改动的那个：结果文件每次追加标注都会更新目录 mtime。
  found.sort((a, b) => statSync(a.dir).mtimeMs - statSync(b.dir).mtimeMs)
  return found[found.length - 1].dir
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const isChinese = text => /[\u4e00-\u9fff]/u.test(text)
const lines = value => String(value ?? '').split('\n').map(line => line.trim()).filter(Boolean)

/** 一张复核卡：只给材料与「系统最后留下了什么」，不给试卷期望、不给 Agent 判定。 */
export function cardOf(result, gloss = {}) {
  const entry = result.result ?? {}
  const receipt = entry.receipt ?? {}
  const spec = result.case ?? {}
  const recent = (entry.recent ?? []).map(item => ({
    goal: item.recent?.goal ?? '', completed: item.recent?.completed ?? '',
    blocked: item.recent?.blocked ?? '', next: item.recent?.next ?? ''
  }))
  const stored = (entry.entries ?? []).map(item => ({
    semantic: item.semantic ?? '', scope: item.scope ?? '', content: item.content ?? ''
  }))
  const prompt = String(spec.prompt ?? '')
  return {
    key: result.key,
    caseId: spec.id ?? null,
    round: result.round ?? null,
    // 真实产物里 model 是对象（{modelId, host, ...}）；夹具当年用的是字符串，所以这里必须显式归一，
    // 否则卡片表头会整列渲染成 [object Object]。
    model: (() => {
      const raw = result.model
      if (typeof raw === 'string') return raw
      if (!raw || typeof raw !== 'object') return null
      const value = raw
      const id = typeof value.modelId === 'string' ? value.modelId : typeof value.recordId === 'string' ? value.recordId : null
      const host = typeof value.host === 'string' ? value.host : null
      return id ? (host ? `${id} · ${host}` : id) : null
    })(),
    chineseMaterial: isChinese(prompt),
    /** 中文重述由人写（不机器翻译）：材料是英文的行必须在 gloss 里有对应条目。 */
    gloss: gloss[result.key] ?? gloss[spec.id] ?? null,
    prompt,
    context: String(spec.body ?? '').replace(/\s+/gu, ' ').slice(0, 400),
    stored,
    recent,
    storedNothing: stored.length === 0 && recent.length === 0,
    receipt: { outcome: receipt.outcome ?? null, reason: receipt.reason ?? null }
  }
}

/** 载入"已复核（导入）"的三行：判词逐字来自目标化复核夹具，不重问。 */
export function loadImported(file = path.join(root, 'test', 'fixtures', 'memory-review-imported.json')) {
  if (!existsSync(file)) return {}
  const fixture = readJson(file), out = {}
  for (const row of fixture.rows ?? []) out[`${row.caseId}/${row.round}`] = { ...row, source: fixture.source, importedAt: fixture.importedAt }
  return out
}

/** 出题纪律的机读告警：材料原文是英文的行必须有中文重述（`gloss`），没有就说出来。
 *  只说，不改行：题面照出、已复核（导入）行照旧不重问——纪律问题要人自己回去补重述。 */
export function glossWarnings(cards) {
  const missing = cards.filter(card => !card.chineseMaterial && !card.gloss)
  if (!missing.length) return []
  return [`警告：${missing.length} 行材料是英文但没有中文重述（${missing.map(card => card.caseId).join('、')}）——按题面纪律不该这样出题。`]
}

export function buildCards(runDir, gloss = {}, imported = {}) {
  const files = readdirSync(runDir).filter(name => name.startsWith('result-') && name.endsWith('.json')).sort()
  const annotated = new Set()
  for (const name of readdirSync(runDir).filter(name => /^annotation-.*\.json$/u.test(name))) {
    const value = readJson(path.join(runDir, name))
    if (typeof value?.key === 'string') annotated.add(value.key)
  }
  return files.map(name => {
    const result = readJson(path.join(runDir, name))
    const card = cardOf(result, gloss)
    const id = `${result.case?.id ?? ''}/${result.round ?? ''}`
    return { ...card, annotated: annotated.has(result.key), imported: imported[id] ?? null }
  })
}

/** 答案 → 评测标注。计数由 mapping 决定，判词原样保留，标注者身份固定为人工。
 *  units（期望单元数）来自试卷，不在给人看的卡片里——人只按自己的判断作答。 */
export function annotationOf(card, answer, bindings, rubricVersion, units = 0) {
  const missing = lines(answer.missing).length
  const shouldNot = lines(answer.shouldNot).length
  const acceptable = answer.acceptable
  if (!['yes', 'no'].includes(acceptable)) return null
  const omitted = Math.min(missing, units)
  const correct = acceptable === 'yes' && !missing && !shouldNot ? units : Math.max(0, units - omitted)
  return {
    key: card.key,
    review: {
      correct, omitted, wrongNew: shouldNot,
      hardViolations: [],
      checks: { attributionAndScope: true, noUnsupportedContent: true, noForbiddenContent: true },
      evidenceComplete: true,
      uncertainty: [],
      annotator: { identity: 'owner-human', kind: 'human', participatedInDesign: false, modelNameMasked: true, humanReviewed: true },
      rulesHash: bindings.rulesHash, resultHash: bindings.resultHash, frozenHash: bindings.frozenHash,
      rubricVersion,
      humanVerdict: { acceptable, missing: answer.missing ?? '', shouldNot: answer.shouldNot ?? '', note: answer.note ?? '', ...(answer.importedFrom ? { importedFrom: answer.importedFrom } : {}) }
    }
  }
}

export function convertAnswers(runDir, answers, gloss = {}, imported = loadImported()) {
  const cards = new Map(buildCards(runDir, gloss, imported).map(card => [card.key, card]))
  const units = new Map()
  for (const name of readdirSync(runDir).filter(name => name.startsWith('result-') && name.endsWith('.json'))) {
    const result = readJson(path.join(runDir, name))
    units.set(result.key, result.case?.expected?.units?.length ?? 0)
  }
  const bindings = new Map()
  let rubricVersion = 1
  for (const name of readdirSync(runDir).filter(name => name.startsWith('annotation') && name.endsWith('.json'))) {
    const value = readJson(path.join(runDir, name))
    if (!value?.review || typeof value.key !== 'string') continue
    bindings.set(value.key, { rulesHash: value.review.rulesHash, resultHash: value.review.resultHash, frozenHash: value.review.frozenHash })
    if (Number.isSafeInteger(value.review.rubricVersion)) rubricVersion = value.review.rubricVersion
  }
  const converted = [], skipped = []
  const rows = [...(answers.rows ?? [])]
  // 导入行即使答案文件里没有，也要按已复核转换，否则会看起来"没人复核过"。
  for (const card of cards.values()) if (card.imported && !rows.some(row => row.key === card.key)) rows.push({ key: card.key, ...card.imported, importedFrom: card.imported.source })
  for (const answer of rows) {
    const card = cards.get(answer.key)
    const binding = bindings.get(answer.key)
    if (!card || !binding) { skipped.push({ key: answer.key, why: card ? '没有该行的标注绑定' : '没有该行的评测产物' }); continue }
    const annotation = annotationOf(card, answer, binding, rubricVersion, units.get(answer.key) ?? 0)
    if (!annotation) { skipped.push({ key: answer.key, why: '未作答或答「看不懂」' }); continue }
    converted.push(annotation)
  }
  return { converted, skipped, rubricVersion }
}

/** 题面用的中文提示：二选一 + 「对的样子／错的样子」对照（首版失败教训的直接产物）。 */
const QUESTIONS = [
  ['acceptable', '这样收尾可以接受吗？', '可以接受／不可以接受／看不懂', '对的样子：该记的记了、不该记的没记。错的样子：把临时要求当成了长期约定、漏掉明确事实、或留下没依据的话。'],
  ['missing', '有没有该留下、但没留下的？', '一行一条，没有就留空', '错的样子：材料里明确说了的事实或约定，系统最后什么都没留。'],
  ['shouldNot', '有没有不该留下、却留下了的？', '一行一条，没有就留空', '对的样子：临时要求不进长期条目。错的样子：助手自己没被采纳的草稿被当成人的决定。'],
  ['note', '还有别的想说的吗？', '一句话即可，可留空', '']
]

export function renderPack(cards, meta) {
  const row = (card, index) => {
    const recent = card.recent.map(item => ['goal', 'completed', 'blocked', 'next']
      .filter(field => item[field]).map(field => `<li>${field}：${escapeHtml(item[field])}</li>`).join('')).join('')
    const stored = card.stored.map(item => `<li>[${escapeHtml(item.semantic)}／${escapeHtml(item.scope)}] ${escapeHtml(item.content)}</li>`).join('')
    return `<section class="card" data-key="${escapeHtml(card.key)}" data-imported="${escapeHtml(JSON.stringify(card.imported ? { acceptable: card.imported.acceptable, missing: card.imported.missing ?? '', shouldNot: card.imported.shouldNot ?? '', note: card.imported.note ?? '', source: card.imported.source ?? '' } : null))}">
  <h2>第 ${index + 1} 行 · ${escapeHtml(card.caseId ?? '')}${card.round === null ? '' : ` · 第 ${card.round + 1} 轮`}</h2>
  <p class="meta">${escapeHtml(card.model ?? '')} · 收据：${escapeHtml(card.receipt.outcome ?? '')}${card.receipt.reason ? `（${escapeHtml(card.receipt.reason)}）` : ''}</p>
  ${card.annotated ? '' : '<p class="warn">这一行此前没有主标注（补录行）：你的判断会成为它的第一份人工标注。</p>'}
  <h3>这一场人在说什么</h3>
  ${card.chineseMaterial ? '' : '<p class="warn">这一行材料原文是英文，下面给了中文重述。</p>'}
  <blockquote>${escapeHtml(card.prompt)}</blockquote>
  ${card.gloss ? `<p>中文重述：${escapeHtml(card.gloss)}</p>` : ''}
  <h3>系统最后留下了什么</h3>
  ${card.storedNothing ? '<p><strong>什么都没留。</strong></p>' : ''}
  ${stored ? `<ul>${stored}</ul>` : ''}
  ${recent ? `<ul>${recent}</ul>` : ''}
  ${card.imported ? `<div class="imported"><strong>已复核（导入，${escapeHtml(String(card.imported.importedAt ?? ''))}）</strong>
    <p>判词：${escapeHtml(card.imported.note ?? '')}</p>${card.imported.missing ? `<p>遗漏：${escapeHtml(card.imported.missing)}</p>` : ''}${card.imported.shouldNot ? `<p>不该留：${escapeHtml(card.imported.shouldNot)}</p>` : ''}
    <p class="hint">这一行不重问：判词逐字来自<code>${escapeHtml(card.imported.source ?? '')}</code>，导出答案时原样带上。</p></div>` : ''}
  <div class="answers"${card.imported ? ' hidden' : ''}>${QUESTIONS.map(([field, title, hint, contrast]) => `
    <label>${title}<span class="hint">${hint}</span>
      ${field === 'acceptable'
        ? `<span class="choices">${['yes', 'no', 'unsure'].map(value => `<label><input type="radio" name="${escapeHtml(card.key)}-acceptable" value="${value}">${value === 'yes' ? '可以接受' : value === 'no' ? '不可以接受' : '看不懂'}</label>`).join('')}</span>`
        : `<textarea rows="2" data-field="${field}"></textarea>`}
      ${contrast ? `<span class="contrast">${contrast}</span>` : ''}
    </label>`).join('')}</div>
</section>`
  }
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>记忆全卷人工复核</title>
<style>
 body{font:15px/1.7 system-ui,-apple-system,'PingFang SC',sans-serif;margin:0;padding:24px;background:#111;color:#eee}
 header{max-width:900px;margin:0 auto 24px}.card{max-width:900px;margin:0 auto 20px;padding:16px 20px;border:1px solid #333;border-radius:12px;background:#1a1a1a}
 h2{font-size:17px;margin:.2em 0}h3{font-size:14px;color:#9ad;margin:1em 0 .3em}
 blockquote{margin:.4em 0;padding:8px 12px;border-left:3px solid #555;background:#151515}
 .meta,.hint,.contrast{color:#999;font-size:13px}.warn{color:#fc6}
 label{display:block;margin:.6em 0}.choices label{display:inline-block;margin-right:12px}
 textarea{width:100%;background:#0f0f0f;color:#eee;border:1px solid #444;border-radius:6px;padding:6px}
 .contrast{display:block;margin-top:2px}.imported{margin:.6em 0;padding:8px 12px;border:1px dashed #4a6;border-radius:8px}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #555;background:#222;color:#eee}
 #progress{position:sticky;top:0;background:#111;padding:8px 0;display:flex;gap:12px;align-items:center;justify-content:center;z-index:2}
</style>
<header><h1>记忆全卷人工复核（${cards.length} 行）</h1>
<p>看材料与系统最后留下的东西，逐行回答三个问题即可。<strong>题库期望与 Agent 判定都不在这里</strong>，你答的是自己的判断。</p>
<p class="meta">你的回答会这样变成机读计数：<br>${escapeHtml(MAPPING_NOTE).replace(/\n/g, '<br>')}</p>
<p class="meta">来源：${escapeHtml(meta.run)}（冻结 ${escapeHtml(meta.frozenHash ?? '')}）</p>
<div id="progress"><span id="count">已答 0/${cards.length}</span><button id="export">导出答案 JSON</button></div></header>
${cards.map(row).join('\n')}
<script>
const cards=[...document.querySelectorAll('.card')]
const read=card=>{
 const imported=JSON.parse(card.dataset.imported||'null')
 if(imported)return {key:card.dataset.key,acceptable:imported.acceptable,missing:imported.missing??'',shouldNot:imported.shouldNot??'',note:imported.note??'',importedFrom:imported.source??''}
 return {key:card.dataset.key,acceptable:card.querySelector('input[type=radio]:checked')?.value??'',missing:card.querySelector('[data-field=missing]')?.value??'',shouldNot:card.querySelector('[data-field=shouldNot]')?.value??'',note:card.querySelector('[data-field=note]')?.value??''}}
const refresh=()=>{document.getElementById('count').textContent='已答 '+cards.filter(c=>read(c).acceptable).length+'/'+cards.length}
document.addEventListener('input',refresh);refresh()
document.getElementById('export').onclick=()=>{
 const payload={version:1,protocol:'全卷人工语义复核：只看材料与系统终态，不看试卷期望与 Agent 判定',at:new Date().toISOString(),rows:cards.map(read)}
 const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})
 const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='answers.json';link.click()
}
</script></html>`
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function main() {
  const args = process.argv.slice(2), value = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
  const runDir = value('--run') ? path.resolve(value('--run')) : latestRun()
  const outDir = path.resolve(value('--out') ?? path.join('artifacts', 'memory-review'))
  const glossFile = value('--gloss') ?? path.join(root, 'test', 'fixtures', 'memory-review-gloss.json')
  const gloss = existsSync(glossFile) ? readJson(glossFile) : {}
  mkdirSync(outDir, { recursive: true })
  const answers = value('--answers')
  if (answers) {
    const { converted, skipped, rubricVersion } = convertAnswers(runDir, readJson(path.resolve(answers)), gloss)
    const dir = path.join(outDir, 'annotations')
    mkdirSync(dir, { recursive: true })
    for (const item of converted) writeFileSync(path.join(dir, `${item.key.replace(/[^\w.-]+/gu, '_')}.json`), JSON.stringify(item, null, 2))
    writeFileSync(path.join(outDir, 'convert-report.json'), JSON.stringify({ run: runDir, rubricVersion, converted: converted.length, skipped }, null, 2))
    process.stdout.write(`已转换 ${converted.length} 行，跳过 ${skipped.length} 行；标注在 ${dir}\n`)
    return
  }
  const cards = buildCards(runDir, gloss, loadImported())
  const annotation = readdirSync(runDir).find(name => name.startsWith('annotation') && name.endsWith('.json'))
  const frozenHash = annotation ? readJson(path.join(runDir, annotation)).frozenHash : null
  // 英文材料行缺中文重述：真的告警——标准输出一行一条，同时写进跟随产物留下的生成日志。
  const warnings = glossWarnings(cards)
  for (const warning of warnings) process.stdout.write(`${warning}\n`)
  if (warnings.length) writeFileSync(path.join(outDir, 'generation.log'), `${warnings.join('\n')}\n`)
  writeFileSync(path.join(outDir, 'index.html'), renderPack(cards, { run: runDir, frozenHash }))
  writeFileSync(path.join(outDir, 'answers.template.json'), JSON.stringify({
    version: 1, protocol: '全卷人工语义复核：只看材料与系统终态，不看试卷期望与 Agent 判定',
    mapping: MAPPING_NOTE,
    rows: cards.map(card => card.imported
      ? { key: card.key, caseId: card.caseId, round: card.round, acceptable: card.imported.acceptable, missing: card.imported.missing ?? '', shouldNot: card.imported.shouldNot ?? '', note: card.imported.note ?? '', importedFrom: card.imported.source }
      : { key: card.key, caseId: card.caseId, round: card.round, acceptable: '', missing: '', shouldNot: '', note: '' })
  }, null, 2))
  process.stdout.write(`复核包已生成：${path.join(outDir, 'index.html')}（${cards.length} 行${warnings.length ? `；${warnings.length} 行材料是英文但没有中文重述，见 generation.log` : ''}）\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
