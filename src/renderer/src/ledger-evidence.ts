import type { LedgerProvenance } from '../../main/ledger-provenance.ts'
import type { LedgerNetworkEntry } from '../../main/host-source.ts'

/** 账本要能看见「这一场用了哪条技能」：名称 ＋ 内容哈希前 8 位。
 *  这是外发可见性取舍下**唯一可审证据**的呈现面：发送确认只给名称，这里给名称与哈希。
 *  没有技能时也要明确写「无」，不留空白让人猜。 */
export function skillsEvidenceText(provenance: Pick<LedgerProvenance, 'skills'> | null | undefined): string {
  const skills = provenance?.skills ?? []
  if (skills.length === 0) return '本场技能：无'
  return `本场技能：${skills.map(skill => `${skill.name}（${skill.hash.slice(0, 8)}）`).join('、')}`
}

/** 账本 network[] 的只读证据行：只写主机、体积、低信任与结果码。
 *  正文、抓取路径与完整查询串都不在这里——查询只显示账本已截断的那一份。
 *  MCP 只显示 `<server>/<tool>` 与结果；参数与结果正文一律不出现。 */
export type NetworkEvidenceEntry = Pick<LedgerNetworkEntry, 'action' | 'host' | 'query' | 'count' | 'bytes' | 'truncated' | 'outcome' | 'server' | 'tool'>

const queryLimit = 120
/** 账本已校验过长度；这里再截一次，防止有人把多余字段塞进条目。 */
const nameLimit = 128

function oneLine(value: string): string {
  // 查询与第三方名字都是模型／服务器给的字符串；压成一行，免得一条证据把账本版面撑开。
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function kbText(bytes: number): string {
  return `${(Math.max(0, bytes) / 1024).toFixed(1)} KB`
}

function entryText(entry: NetworkEvidenceEntry): string {
  if (entry.action === 'mcp') {
    const server = oneLine(entry.server ?? '').slice(0, nameLimit) || '未知服务器'
    const tool = oneLine(entry.tool ?? '').slice(0, nameLimit) || '未知工具'
    const target = `MCP ${server}/${tool}`
    // outcome 只有 'ok' 才算已执行；其余一律写未执行，去掉记账用的 refused: 前缀。
    if (entry.outcome !== 'ok') return `${target}（未执行：${entry.outcome.replace(/^refused:/, '')}）`
    const size = typeof entry.bytes === 'number' ? `${kbText(entry.bytes)}，` : ''
    return `${target}（${size}低信任${entry.truncated ? '，已截断' : ''}）`
  }
  const search = entry.action === 'search'
  const query = search ? oneLine(entry.query ?? '').slice(0, queryLimit) : ''
  const target = search ? `搜索${query ? `「${query}」` : ''}${entry.host}` : `抓网页 ${entry.host}`
  // outcome 只有 'ok' 才算已执行；其余一律写未执行，去掉记账用的 refused: 前缀。
  if (entry.outcome !== 'ok') return `${target}（未执行：${entry.outcome.replace(/^refused:/, '')}）`
  if (search) {
    // 旧记录的 search 条目没有 count；有就照账本显示条数，没有就不猜。
    const count = typeof entry.count === 'number' && Number.isSafeInteger(entry.count) && entry.count >= 1 && entry.count <= 10
      ? `${entry.count} 条，`
      : ''
    return `${target}（${count}低信任${entry.truncated ? '，已截断' : ''}）`
  }
  const size = typeof entry.bytes === 'number' ? `${kbText(entry.bytes)}，` : ''
  return `${target}（${size}低信任${entry.truncated ? '，已截断' : ''}）`
}

/** 一场的外发记录：没有条目也明确写「无」；多条按发生顺序用分号连接。 */
export function networkEvidenceText(entries: readonly NetworkEvidenceEntry[] | null | undefined): string {
  const list = entries ?? []
  if (list.length === 0) return '本场外发：无'
  return `本场外发：${list.map(entryText).join('；')}`
}
