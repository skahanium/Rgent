/**
 * Host 任务失败时给人看的文案。
 *
 * 机读错误码与中文说明分开：`agent:event` 只带码，界面在这里翻译。
 * 新增可上报的错误码时，把它加进 `HOST_ERROR_CODES`——`host-errors.test.ts`
 * 会强制每个码都有说明，避免状态栏直接显示内部码。
 */
export const HOST_ERROR_CODES = [
  'NO_API_KEY',
  'ENCRYPTION_UNAVAILABLE',
  'KEY_DECRYPT_FAILED',
  'PERMISSIONS_INVALID',
  'FORBIDDEN',
  'TOOLS_UNAVAILABLE',
  'OUTSIDE_TASK_SCOPE',
  'AUTHORIZATION_REVOKED',
  'ACTION_NOT_ALLOWED',
  'SOURCE_CHANGED',
  'SOURCE_REPLACED',
  'SOURCE_PERMISSION_CHANGED',
  'SOURCE_BUSY',
  'SOURCE_PARSE_FAILED',
  'SOURCE_METADATA_TOO_LARGE',
  'TOOL_CALL_LIMIT',
  'TOOL_ARGUMENT_LIMIT',
  'TOOL_RESULT_LIMIT',
  'MODEL_PROTOCOL_ERROR',
  'MODEL_STEP_LIMIT',
  'MODEL_CONTEXT_LIMIT',
  'MODEL_OUTPUT_LIMIT',
  'MODEL_REQUEST_FAILED',
  'NOTE_NOT_REFERENCE',
  'NOTE_BUSY',
  'NOTE_REPLACED',
  'NOTE_UNREADABLE',
  'PREVIOUS_TASK_UNSAVED',
  'OBJECT_BINDING_REQUIRED',
  'LEDGER_BOUNDARY_INVALID',
  'HISTORICAL_SOURCE_CONFLICT',
  'CONFLICT',
  'VAULT_CHANGED',
  'NO_VAULT',
  'IO_ERROR'
] as const

const MESSAGES: Record<string, string> = {
  NO_API_KEY: '请先在设置的「模型」页保存当前供应商的密钥。',
  ENCRYPTION_UNAVAILABLE: '系统密钥保护当前不可用。',
  KEY_DECRYPT_FAILED: '已保存的模型密钥无法解密，请在设置中替换。',
  PERMISSIONS_INVALID: '权限名单无法核对，请先修复库根名单。',
  FORBIDDEN: '这篇笔记禁止 AI 触碰。',
  TOOLS_UNAVAILABLE: '本场读库与搜库工具不可用，请重新发起。',
  OUTSIDE_TASK_SCOPE: '本场范围之外的资料不可读取，任务已停止。',
  AUTHORIZATION_REVOKED: '本场授权已失效，任务已停止。',
  ACTION_NOT_ALLOWED: '本场未获准该操作，任务已停止。',
  SOURCE_CHANGED: '参考来源已变化，本场已停止，回答已保留。',
  SOURCE_REPLACED: '参考来源对象已替换，本场已停止。',
  SOURCE_PERMISSION_CHANGED: '参考来源权限已变化，本场已停止。',
  SOURCE_BUSY: '参考来源连续核验未通过，本场已停止。',
  SOURCE_PARSE_FAILED: '参考来源的正文无法解析，本场已停止。',
  SOURCE_METADATA_TOO_LARGE: '参考来源的路径或标题过长，无法分页返回。',
  TOOL_CALL_LIMIT: '本场工具次数已达上限。',
  TOOL_ARGUMENT_LIMIT: '模型工具参数已超出上限。',
  TOOL_RESULT_LIMIT: '工具结果超出单页上限，本场已停止。',
  MODEL_PROTOCOL_ERROR: '模型返回的工具协议无效，本场已停止。',
  MODEL_STEP_LIMIT: '本场模型步数已达上限。',
  MODEL_CONTEXT_LIMIT: '本场上下文已达上限。',
  MODEL_OUTPUT_LIMIT: '本场生成内容已达上限。',
  MODEL_REQUEST_FAILED: '模型请求失败，请检查接口、密钥和网络。',
  NOTE_NOT_REFERENCE: '这篇笔记当前不允许发起 AI 任务。',
  NOTE_BUSY: '这篇笔记已有正在运行的任务。',
  NOTE_REPLACED: '原对象已被替换，本场已停止。',
  NOTE_UNREADABLE: '笔记暂时无法读取，窗口稿和账本已保留。',
  PREVIOUS_TASK_UNSAVED: '上一场生成内容尚未保存，请先处理保存失败。',
  OBJECT_BINDING_REQUIRED: '无法核对这篇笔记的对象身份，本场已停止。',
  LEDGER_BOUNDARY_INVALID: '正文语法遮住了账本边界，尚未保存。请闭合代码块或注释，并在 HTML 块后保留空行；修好语法保存本笔记后会再试一次。',
  HISTORICAL_SOURCE_CONFLICT: '历史章对同一来源给出了不同记录，本场已停止。',
  CONFLICT: '笔记已变化，请先处理冲突。',
  VAULT_CHANGED: '笔记库已切换，本场已停止。',
  NO_VAULT: '当前没有打开的笔记库。',
  IO_ERROR: '写盘失败，生成内容已保留待保存。'
}

/** 未收录的码原样返回：计划层已经给出中文原因，不再二次翻译。 */
export const hostErrorText = (error: string): string => MESSAGES[error] ?? error
