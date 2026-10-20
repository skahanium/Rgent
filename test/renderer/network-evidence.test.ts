import { describe, expect, it } from 'vitest'
import { networkEvidenceText, type NetworkEvidenceEntry } from '../../src/renderer/src/ledger-evidence.ts'

/** 账本外发证据：只写主机、体积、低信任与结果码；正文与完整查询串都不出现。 */
const entry = (over: Partial<NetworkEvidenceEntry> = {}): NetworkEvidenceEntry => ({
  action: 'fetch', host: 'example.com', outcome: 'ok', ...over
})

describe('ledger network evidence', () => {
  it('says so explicitly when the session sent nothing out', () => {
    expect(networkEvidenceText([])).toBe('本场外发：无')
    expect(networkEvidenceText(undefined)).toBe('本场外发：无')
    expect(networkEvidenceText(null)).toBe('本场外发：无')
  })

  it('formats executed fetches, searches and refused attempts in ledger order', () => {
    const text = networkEvidenceText([
      entry({ bytes: 1234, truncated: false }),
      entry({ action: 'search', host: 'api.search.brave.com', query: '小猫 研究', count: 5, outcome: 'ok' }),
      entry({ host: 'bad.example', bytes: 0, truncated: true, outcome: 'refused:EGRESS_TIMEOUT' })
    ])
    expect(text).toBe('本场外发：抓网页 example.com（1.2 KB，低信任）；搜索「小猫 研究」api.search.brave.com（5 条，低信任）；抓网页 bad.example（未执行：EGRESS_TIMEOUT）')
  })

  it('falls back to no result count for old search entries that do not have one', () => {
    const text = networkEvidenceText([entry({ action: 'search', host: 'api.search.brave.com', query: '旧查询', outcome: 'ok' })])
    expect(text).toBe('本场外发：搜索「旧查询」api.search.brave.com（低信任）')
  })

  it('uses one decimal for KB and marks truncation; refused lines carry no size', () => {
    expect(networkEvidenceText([entry({ bytes: 0 })]).endsWith('（0.0 KB，低信任）')).toBe(true)
    expect(networkEvidenceText([entry({ bytes: 1024 })]).endsWith('（1.0 KB，低信任）')).toBe(true)
    expect(networkEvidenceText([entry({ bytes: 10240, truncated: true })]).endsWith('（10.0 KB，低信任，已截断）')).toBe(true)
    expect(networkEvidenceText([entry({ bytes: 999, truncated: true, outcome: 'refused:EGRESS_TOO_LARGE' })]))
      .toBe('本场外发：抓网页 example.com（未执行：EGRESS_TOO_LARGE）')
  })

  it('shows at most the truncated query and no refusal prefix', () => {
    const text = networkEvidenceText([
      entry({ action: 'search', host: 'api.search.brave.com', query: 'x'.repeat(200), outcome: 'refused:SEARCH_EMPTY' })
    ])
    const query = text.slice(text.indexOf('「') + 1, text.indexOf('」'))
    expect(query).toHaveLength(120)
    expect(text).toBe(`本场外发：搜索「${'x'.repeat(120)}」api.search.brave.com（未执行：SEARCH_EMPTY）`)
  })

  it('never leaks a body, the URL path or the full URL query string', () => {
    // 即使未来有人把多余字段塞进条目，呈现面也只认这里列出的几个字段。
    const text = networkEvidenceText([{
      ...entry({ bytes: 0 }),
      path: '/page?token=TOP-SECRET',
      text: 'BODY-SECRET',
      body: 'BODY-SECRET',
      url: 'https://example.com/page?token=TOP-SECRET'
    } as unknown as NetworkEvidenceEntry])
    expect(text).toBe('本场外发：抓网页 example.com（0.0 KB，低信任）')
    expect(text).not.toContain('BODY-SECRET')
    expect(text).not.toContain('TOP-SECRET')
    expect(text).not.toContain('/page')
  })
})
