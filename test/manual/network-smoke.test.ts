import { describe, expect, it } from 'vitest'
import { fetchText } from '../../src/main/text-fetch.ts'

/** 真机联网烟测（不进普通门）：只有显式 `RGENT_NETWORK_SMOKE=1` 才发真实请求。
 *  普通 `pnpm test` 里整组显示 skipped；结果只打印，不作 CI 判据。
 *  合同见 docs/decisions.md「2026-10-20 联网只读合同」的证据边界。 */
const enabled = process.env.RGENT_NETWORK_SMOKE === '1'

describe.skipIf(!enabled)('联网只读真机烟测', () => {
  it('抓取 example.com 的公开文本', async () => {
    const result = await fetchText('https://example.com/', { signal: new AbortController().signal })
    expect(result.text.trim().length).toBeGreaterThan(0)
    // 该站 2026-10 起只返回一段说明文字（无 h1）；断言标题与稳定关键词，别绑死旧版正文。
    expect(result.title ?? '').toBe('Example Domain')
    expect(result.text).toContain('documentation examples')
    expect(result.bytes).toBeGreaterThan(0)
    expect(typeof result.truncated).toBe('boolean')
    process.stdout.write(`联网烟测：${new URL(result.finalUrl).host} · ${result.bytes} 字节 · 标题 ${result.title ?? '(无)'} · 截断=${result.truncated}\n`)
  }, 60_000)

  it('抓取 IANA 的示例域名说明页', async () => {
    const result = await fetchText('https://www.iana.org/help/example-domains', { signal: new AbortController().signal })
    expect(result.text.trim().length).toBeGreaterThan(0)
    expect(result.text).toContain('Example Domains')
    expect(result.bytes).toBeGreaterThan(0)
    expect(typeof result.truncated).toBe('boolean')
    process.stdout.write(`联网烟测：${new URL(result.finalUrl).host} · ${result.bytes} 字节 · 标题 ${result.title ?? '(无)'} · 截断=${result.truncated}\n`)
  }, 60_000)
})
