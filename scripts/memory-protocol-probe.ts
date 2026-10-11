/** 协议剥离对照探针（方案 C）：Electron 主进程，只读 safeStorage 取凭据，只发自由文本问答。
 *
 * 不读真实笔记、不写库、不改配置；每次调用前核上限；逐例原子落盘，可安全续跑。
 * 用法见 scripts/check-probe.mjs（`pnpm probe:check -- --print-prompts` 可零调用预览题面）。 */
import { app, safeStorage } from 'electron'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { loadModelCredentialReadOnly } from '../src/main/model-config.ts'
import { streamModelStep } from '../src/main/model-stream.ts'
import { PROBE_CALL_LIMIT, PROBE_CASES, PROBE_MAX_OUTPUT_TOKENS, PROBE_SYSTEM, probePrompt, type ProbeCase } from './memory-probe-cases.ts'

type Options = { root: string; profile: string; report: string; models: string[]; cases: string[]; limit: number; printPrompts?: boolean }

const options: Options = JSON.parse(process.env.RGENT_PROBE_OPTIONS ?? '{}')
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// 与评测跑器同一身份：macOS safeStorage 按应用名取钥匙串条目，改名就读不到同一份凭据。
// 进程自身的 userData 落在报告目录内，不碰默认 Electron 目录，也不写用户配置。
app.setName('rgent')
app.setPath('userData', path.join(options.report ?? '.', 'electron-profile'))

function atomicReport(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value, null, 2))
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temporary, file)
  } catch (error) {
    if (fd !== null) closeSync(fd)
    try { if (existsSync(temporary)) renameSync(temporary, `${temporary}.orphan`) } catch { /* 保留现场 */ }
    throw error
  }
}

/** 与评测跑器同一把尺子：只接受已授权模型、HTTPS、主机与模型名匹配、恰好两个模型。 */
function modelMetadata(profile: string, recordIds: string[]) {
  const raw = readFileSync(path.join(profile, 'model-config.json'))
  const config = JSON.parse(raw.toString())
  const models = recordIds.map((id) => {
    const model = config.models?.find((m: { id: string }) => m.id === id)
    const connection = config.connections?.find((c: { id: string }) => c.id === model?.connectionId)
    if (!model || !connection) throw Error('PROBE_MODELS_NOT_AUTHORIZED')
    const url = new URL(connection.baseURL)
    const expected = model.modelId === 'MiniMax-M3' ? 'api.minimax.cn' : model.modelId === 'deepseek-flash' ? 'api.deepseek.com' : null
    if (url.protocol !== 'https:' || url.host !== expected || url.username || url.password || url.search || url.hash) throw Error('PROBE_MODELS_NOT_AUTHORIZED')
    return { recordId: id as string, modelId: model.modelId as string, host: url.host, baseURL: connection.baseURL as string, contextTokens: model.contextTokens as number }
  })
  if (models.length !== 2 || new Set(models.map((m) => m.modelId)).size !== 2) throw Error('PROBE_MODELS_NOT_AUTHORIZED')
  return { configuration: fingerprint(raw.toString()), models }
}

async function main(): Promise<void> {
  if (!options.profile || !options.report || !options.models?.length) throw Error('PROBE_PROFILE_REQUIRED')
  const selected = PROBE_CASES.filter((item) => (options.cases?.length ? options.cases.includes(item.id) : true))
  if (!selected.length) throw Error('PROBE_CASES_REQUIRED')
  const meta = modelMetadata(options.profile, options.models)
  const total = selected.length * meta.models.length
  const limit = options.limit ?? PROBE_CALL_LIMIT
  if (total > limit || limit > PROBE_CALL_LIMIT) throw Error(`PROBE_CALL_LIMIT:${total}>${limit}`)

  if (options.printPrompts) {
    for (const model of meta.models) for (const item of selected) console.log(`=== ${model.modelId} / ${item.id} ===\n${probePrompt(item)}\n`)
    // 零调用预检：凭据必须能解密、且主机与模型名匹配，否则带着问题去花钱。
    const preflight = meta.models.map((model) => {
      const credential = loadModelCredentialReadOnly(options.profile, safeStorage, model.recordId)
      return { modelId: credential.modelId, host: new URL(credential.baseURL).host, keyPresent: credential.apiKey.length > 0 }
    })
    console.log(JSON.stringify({ wouldCall: total, limit, system: PROBE_SYSTEM, maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS, encryptionAvailable: safeStorage.isEncryptionAvailable(), preflight }))
    return
  }

  mkdirSync(options.report, { recursive: true, mode: 0o700 })
  const ledger = path.join(options.report, 'calls.json')
  const calls: { key: string; at: string; model: string; caseId: string; promptHash: string }[] = existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')) : []
  atomicReport(path.join(options.report, 'manifest.json'), {
    at: new Date().toISOString(),
    system: PROBE_SYSTEM,
    question: probePrompt({ id: '', prompt: '', body: '', context: '', selection: '' }).split('\n').at(-1),
    promptTemplateHash: fingerprint(selected.map((item) => [item.id, probePrompt(item)])),
    maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
    limit,
    planned: total,
    configuration: meta.configuration,
    models: meta.models.map((m) => ({ recordId: m.recordId, modelId: m.modelId, host: m.host })),
    cases: selected.map((item) => ({ id: item.id, selection: item.selection, promptHash: fingerprint(probePrompt(item)) }))
  })

  const rows: unknown[] = []
  for (const model of meta.models) {
    const credential = loadModelCredentialReadOnly(options.profile, safeStorage, model.recordId)
    for (const item of selected) {
      const file = path.join(options.report, `probe-${model.modelId}-${item.id}.json`)
      if (existsSync(file)) { rows.push(JSON.parse(readFileSync(file, 'utf8'))); continue }
      if (calls.length >= limit) throw Error(`PROBE_CALL_LIMIT_REACHED:${calls.length}`)
      const user = probePrompt(item)
      const started = Date.now()
      let body = ''
      let finishReason: string | null = null
      let usage: unknown = null
      let reason: string | null = null
      try {
        for await (const event of streamModelStep({
          provider: credential.provider,
          baseURL: credential.baseURL,
          apiKey: credential.apiKey,
          modelId: credential.modelId,
          contextTokens: credential.contextTokens,
          system: PROBE_SYSTEM,
          messages: [{ role: 'user', content: user }],
          maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
          signal: AbortSignal.timeout(120_000)
        })) {
          if (event.type === 'text') body += event.text
          if (event.type === 'finish') { finishReason = event.reason; usage = event.usage ?? null }
        }
      } catch (error) {
        reason = error instanceof Error && /^[A-Z_]{3,80}$/.test(error.message) ? error.message : 'PROBE_REQUEST_FAILED'
      }
      const row = { caseId: item.id, model: model.modelId, host: model.host, promptHash: fingerprint(user), body, finishReason, usage, reason, latencyMs: Date.now() - started, at: new Date().toISOString() }
      atomicReport(file, row)
      calls.push({ key: `probe/${model.modelId}/${item.id}`, at: row.at, model: model.modelId, caseId: item.id, promptHash: row.promptHash })
      atomicReport(ledger, calls)
      rows.push(row)
    }
  }
  atomicReport(path.join(options.report, 'summary.json'), {
    at: new Date().toISOString(),
    calls: calls.length,
    planned: total,
    limit,
    rows: rows.map((row) => { const r = row as { caseId: string; model: string; reason: string | null; body: string }; return { caseId: r.caseId, model: r.model, reason: r.reason, chars: r.body.length } })
  })
  console.log(JSON.stringify({ calls: calls.length, planned: total, report: options.report }))
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
  })
