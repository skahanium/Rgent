import type { LedgerProvenance } from '../../main/ledger-provenance.ts'

/** 账本要能看见「这一场用了哪条技能」：名称 ＋ 内容哈希前 8 位。
 *  这是外发可见性取舍下**唯一可审证据**的呈现面：发送确认只给名称，这里给名称与哈希。
 *  没有技能时也要明确写「无」，不留空白让人猜。 */
export function skillsEvidenceText(provenance: Pick<LedgerProvenance, 'skills'> | null | undefined): string {
  const skills = provenance?.skills ?? []
  if (skills.length === 0) return '本场技能：无'
  return `本场技能：${skills.map(skill => `${skill.name}（${skill.hash.slice(0, 8)}）`).join('、')}`
}
