#!/usr/bin/env bash
# 开发用薄封装：只把既有的 memory:check 命令拼出来，不复制任何评测逻辑。
# 用法（在仓库根目录）：. scripts/dev-round.sh
#   dispatch <caseId> [model]                 派发一例
#   dumpcase <caseId> [model]                 只读转储该例的期望与终态
#   annotate <caseId> <correct> <omitted> <wrongNew> <attrScope 0|1> <noUnsup 0|1> <noForbid 0|1> [identity] [double]
#   annotate_veto <caseId> <veto...> [identity] [double]
#   summary                                   打印当前轮次判定摘要
# 变量：RGENT_PROFILE / RGENT_MODELS / RGENT_REPORT 可用环境变量覆盖。
RGENT_PROFILE="${RGENT_PROFILE:-$HOME/Library/Application Support/rgent}"
RGENT_MODELS="${RGENT_MODELS:-f372c75e-4a91-490c-9f03-93265d1be478,5e5b7773-5d7f-4b81-b939-519c641d1a9a}"
RGENT_REPORT="${RGENT_REPORT:-.cache/memory-quality/2026-10-11-rev12-router}"
RGENT_ROUND="${RGENT_ROUND:-1}"

_rgent_run() { ELECTRON_DISABLE_SANDBOX=1 pnpm memory:check -- "$@" --report "$RGENT_REPORT" --profile "$RGENT_PROFILE" --models "$RGENT_MODELS"; }

dispatch() {
  local case_id="$1" model="${2:-deepseek-flash}"
  _rgent_run --v6 --live --round "$RGENT_ROUND" --cases "$case_id" --only "$model" 2>&1 | tail -1
}

dumpcase() {
  local case_id="$1" model="${2:-deepseek-flash}"
  node scripts/memory-quality-review-dump.mjs --report "$RGENT_REPORT" --case "$case_id" --model "$model" --round "$((RGENT_ROUND - 1))"
}

_wrap() {
  local case_id="$1" model="$2" identity="$3" double="$4" review_json="$5"
  local hashes; hashes=$(ELECTRON_DISABLE_SANDBOX=1 pnpm memory:check -- --v6 --hashes --round "$RGENT_ROUND" --cases "$case_id" --only "$model" --report "$RGENT_REPORT" --profile "$RGENT_PROFILE" --models "$RGENT_MODELS" 2>&1 | tail -1)
  local out="/tmp/ann-${case_id}-${identity}.json"
  HASHES="$hashes" REVIEW="$review_json" OUT="$out" IDENTITY="$identity" node -e '
    const h=JSON.parse(process.env.HASHES), review=JSON.parse(process.env.REVIEW)
    review.annotator={identity:process.env.IDENTITY,kind:"agent",participatedInDesign:true,modelNameMasked:true,humanReviewed:false}
    review.rulesHash=h.rulesHash; review.resultHash=h.resultHash; review.frozenHash=h.frozenHash; review.rubricVersion=1
    require("node:fs").writeFileSync(process.env.OUT, JSON.stringify({key:h.key,frozenHash:h.frozenHash,resultHash:h.resultHash,rulesHash:h.rulesHash,review},null,2))
    console.log(h.key)
  '
  local extra=(); [ "$double" = "double" ] && extra=(--double)
  _rgent_run --v6 --review "${extra[@]}" --round "$RGENT_ROUND" --cases "$case_id" --only "$model" --annotation "$out" 2>&1 | tail -1 | head -c 120; echo
}

annotate() {
  local case_id="$1" correct="$2" omitted="$3" wrongNew="$4" attr="$5" unsup="$6" forbid="$7" identity="${8:-rev12-primary-agent}" double="${9:-}"
  _wrap "$case_id" deepseek-flash "$identity" "$double" "{\"correct\":$correct,\"omitted\":$omitted,\"wrongNew\":$wrongNew,\"hardViolations\":[],\"checks\":{\"attributionAndScope\":$([ "$attr" = 1 ] && echo true || echo false),\"noUnsupportedContent\":$([ "$unsup" = 1 ] && echo true || echo false),\"noForbiddenContent\":$([ "$forbid" = 1 ] && echo true || echo false)},\"evidenceComplete\":true,\"uncertainty\":[]}"
}

summary() {
  # 只读：不带 --live，程序直接打印当前摘要，不派发。
  _rgent_run --v6 --review --round "$RGENT_ROUND" --cases v6-standing-01 --only deepseek-flash 2>&1 | tail -1
}
