import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
// @ts-ignore 夹具脚本为 .mjs：可被 node 直接运行，不参与 tsc 类型检查
import { denyDirectoryWrites } from '../../scripts/fs-deny-write.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* restore 之后再清 */ }
  }
})

const fixture = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'rgent-deny-'))
  roots.push(root)
  writeFileSync(path.join(root, '已有.md'), '可读原文')
  return root
}

it('blocks creating a new file and still lets existing files be read', () => {
  const root = fixture()
  const restore = denyDirectoryWrites(root)
  try {
    expect(readFileSync(path.join(root, '已有.md'), 'utf8')).toBe('可读原文')
    expect(readdirSync(root)).toContain('已有.md')
    expect(() => writeFileSync(path.join(root, '新文件.md'), '不该落盘')).toThrow()
    expect(readFileSync(path.join(root, '已有.md'), 'utf8')).toBe('可读原文')
  } finally {
    restore()
  }
  writeFileSync(path.join(root, '新文件.md'), '恢复后可写')
  expect(readFileSync(path.join(root, '新文件.md'), 'utf8')).toBe('恢复后可写')
})

it('restores even when the caller never created extra files', () => {
  const root = fixture()
  const restore = denyDirectoryWrites(root, { mode: 0o555 })
  restore()
  mkdirSync(path.join(root, '子目录'))
  writeFileSync(path.join(root, '子目录', 'ok.md'), 'ok')
  expect(readFileSync(path.join(root, '子目录', 'ok.md'), 'utf8')).toBe('ok')
})

it('blocks temp-file create the way native writes do, then rename works after restore', () => {
  const root = fixture()
  const restore = denyDirectoryWrites(root)
  const temp = path.join(root, '.tmp-native')
  const committed = path.join(root, 'committed.md')
  try {
    expect(() => writeFileSync(temp, 'x')).toThrow()
  } finally {
    restore()
  }
  writeFileSync(temp, 'x')
  renameSync(temp, committed)
  expect(readFileSync(committed, 'utf8')).toBe('x')
})

it('copied tree after restore can create files', () => {
  const root = fixture()
  const hidden = path.join(root, '.rgent')
  mkdirSync(hidden)
  writeFileSync(path.join(hidden, 'registry.json'), '{"ok":true}')
  const restore = denyDirectoryWrites(hidden, { mode: 0o555 })
  restore()
  const copy = `${root}-copy`
  cpSync(root, copy, { recursive: true })
  roots.push(copy)
  writeFileSync(path.join(copy, '.rgent', 'new.json'), 'after-copy')
  expect(readFileSync(path.join(copy, '.rgent', 'new.json'), 'utf8')).toBe('after-copy')
  writeFileSync(path.join(hidden, 'after-restore.json'), 'ok')
})
