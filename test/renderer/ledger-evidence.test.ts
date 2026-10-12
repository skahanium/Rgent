import { describe, expect, it } from 'vitest'
import { skillsEvidenceText } from '../../src/renderer/src/ledger-evidence.ts'

/** 账本要能看见这一场用了哪条技能：发送确认只给名称，证据在账本。 */
describe('ledger skill evidence', () => {
  it('lists the frozen names with the first eight hash characters', () => {
    const text = skillsEvidenceText({ skills: [{ id: 'grade', name: '答案批改', hash: 'ab12cd34' + 'f'.repeat(56) }] })
    expect(text).toBe('本场技能：答案批改（ab12cd34）')
  })

  it('joins several skills and keeps the order the ledger recorded', () => {
    const text = skillsEvidenceText({ skills: [
      { id: 'a', name: '答案批改', hash: '1'.repeat(64) },
      { id: 'b', name: '周报提纲', hash: '2'.repeat(64) }
    ] })
    expect(text).toBe('本场技能：答案批改（11111111）、周报提纲（22222222）')
  })

  it('says so explicitly when the session froze no skills', () => {
    expect(skillsEvidenceText({ skills: [] })).toBe('本场技能：无')
    expect(skillsEvidenceText({})).toBe('本场技能：无')
    expect(skillsEvidenceText(null)).toBe('本场技能：无')
  })
})
