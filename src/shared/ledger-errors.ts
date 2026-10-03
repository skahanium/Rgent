export const LEDGER_ERROR_MESSAGES:Record<string,string>={
 LEDGER_OWNERSHIP_UNVERIFIED:'历史归属待核验；未自动认领，也未改写原记录。',
 LEDGER_REGISTRY_INVALID:'账本登记损坏；历史保持，可从已核验的归属描述重建。',
 LEDGER_RECORD_INVALID:'历史记录无法核验；原字节保持。',
 LEDGER_CONFLICT:'历史记录已变化，请重新核对；当前回答仍保留。',
 LEDGER_TASK_CONFLICT:'同一任务的恢复记录已变化，未覆盖已保存的历史。',
 LEDGER_RECORD_LIMIT:'本任务记录超过存储上限，当前回答仍保留。',
 LEDGER_STORAGE_INVALID:'账本内部目录无法核验，未继续写入。',
 LEDGER_BODY_CHANGED:'正文保存结果无法核对，回答检查点仍保留，未自动回填。',
 LEDGER_UNAVAILABLE:'账本暂时不可用，当前内容仍保留。',
 LEDGER_MIGRATION_FAILED:'旧账本迁移未完成，已核验的原始材料仍保留。'
}
export const LEDGER_ERROR_CODES=Object.keys(LEDGER_ERROR_MESSAGES)
