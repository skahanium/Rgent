import { describe, expect, it } from 'vitest'
import { mergeHostBody } from '../../src/renderer/src/host-merge.ts'

describe('Host and human draft merge', () => {
  it('keeps a human edit after a generated block and the Host insertion', () => {
    const base = '前文\n\n/问\n\n后文'
    const local = '前文\n\n/问\n\n后文修改'
    const remote = '前文\n\n<!-- rgent:prompt:v1 task-id="x" -->\n问\n\n<!-- rgent:ai:v1 task-id="x" -->\n答\n\n后文'
    expect(mergeHostBody(base, local, remote)).toBe(remote + '修改')
  })

  it('returns null when both parties edit the same span', () => {
    expect(mergeHostBody('前/问后', '前/新问后', '前问答后')).toBeNull()
  })
})
