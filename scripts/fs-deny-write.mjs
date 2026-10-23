/**
 * 窗口验收用的目录拒写：挡住「同目录建临时文件再改名」。
 * POSIX 用 chmod；Windows 用当前用户 SID 的显式 Deny (WD,DC)。
 * 失败必须抛错，禁止静默当已拒写。
 */
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || ''}`.trim().slice(0, 400)
    throw new Error(`${label} 失败${detail ? `：${detail}` : ''}`)
  }
  return result
}

function currentUserSid() {
  const result = run('whoami', ['/user', '/fo', 'csv', '/nh'], 'whoami /user')
  const match = /"(S-1-5-[0-9-]+)"/u.exec(result.stdout)
  if (!match) throw new Error(`解析当前用户 SID 失败：${result.stdout.trim().slice(0, 200)}`)
  return match[1]
}

function probeFile(dir) {
  return path.join(dir, `.rgent-deny-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
}

function tryCreate(dir) {
  const probe = probeFile(dir)
  writeFileSync(probe, 'deny-probe')
  rmSync(probe, { force: true })
}

function assertDenied(dir) {
  try {
    tryCreate(dir)
  } catch {
    return
  }
  throw new Error(`目录拒写未生效：仍能在 ${dir} 创建文件`)
}

function assertWritable(dir) {
  try {
    tryCreate(dir)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`目录拒写恢复后仍不可写：${dir}${detail ? `（${detail}）` : ''}`)
  }
}

function denyWindows(dir) {
  const sid = currentUserSid()
  const scratch = mkdtempSync(path.join(tmpdir(), 'rgent-acl-'))
  const saved = path.join(scratch, 'acl.txt')
  run('icacls', [dir, '/save', saved], 'icacls /save')
  try {
    // WD=添文件、DC=删子项：挡住建临时文件和 rename。
    // 不用 (W)：目录上的 Write 过宽，会连 readdir 都挡掉。
    run('icacls', [dir, '/deny', `*${sid}:(WD,DC)`], `icacls /deny ${sid}`)
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
  return () => {
    try {
      try {
        run('icacls', [dir, '/remove:d', `*${sid}`], `icacls /remove:d ${sid}`)
        assertWritable(dir)
      } catch {
        run('icacls', [path.dirname(dir), '/restore', saved], 'icacls /restore')
        assertWritable(dir)
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

function denyPosix(dir, mode) {
  const previous = statSync(dir).mode & 0o777
  chmodSync(dir, mode)
  return () => {
    chmodSync(dir, previous)
    assertWritable(dir)
  }
}

/**
 * @param {string} dir
 * @param {{ mode?: number }} [options] POSIX 目录位，默认 0o500；Host 发布中断用 0o555。
 * @returns {() => void} 恢复函数，必须在 finally 里调用。
 */
export function denyDirectoryWrites(dir, options = {}) {
  if (!statSync(dir).isDirectory()) throw new Error(`拒写目标不是目录：${dir}`)
  const mode = options.mode ?? 0o500
  const restore = process.platform === 'win32' ? denyWindows(dir) : denyPosix(dir, mode)
  try {
    assertDenied(dir)
  } catch (error) {
    try { restore() } catch { /* 保留「拒写未生效」 */ }
    throw error
  }
  let done = false
  return () => {
    if (done) return
    done = true
    restore()
  }
}
