export const LEDGER_ERROR_MESSAGES:Record<string,string>={
 SUMMARY_FORMAT_INVALID:'历史摘要格式无法核验，原记录未改变。',
 SUMMARY_CACHE_LIMIT:'历史摘要缓存已达上限，原记录未改变。',
 LEDGER_OWNERSHIP_UNVERIFIED:'历史归属待核验；未自动认领，也未改写原记录。',
 LEDGER_RECOVERY_AMBIGUOUS:'归属描述、路径或历史任务存在重复，不能自动合并；原文件保留，请在笔记库设置中核查恢复范围。',
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

export const ledgerErrorText=(code:string):string=>LEDGER_ERROR_MESSAGES[code]??'账本暂时无法核验；原记录保留，请在笔记库设置中检查恢复状态。'
