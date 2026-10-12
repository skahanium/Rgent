import path from 'node:path'
import { secureFsFor } from './secure-fs.ts'
import { hasHiddenSegment, isNotePath, resolveInVault } from './paths.ts'
import { SKILL_LIMITS, type SkillRegistration, type SkillsView, type SkillUnavailableReason, type SkillView } from '../shared/skills.ts'

/** 只读发现与校验：把「按库注册」的技能逐条核成可用／不可用。
 *  读库内文件走原生安全层（`secureFsFor` 的 list／readSnapshot）：符号链接、越界与非常规文件在这里就被挡住，
 *  不靠字符串比较兜底。失败一律给原因，不降级成「没有这个技能」。零写入、零模型调用。 */
export function readRegisteredSkills(root: string, registrations: readonly SkillRegistration[]): SkillsView {
  const fs = secureFsFor(root)
  const skills: SkillView[] = []
  for (const registration of registrations.slice(0, SKILL_LIMITS.maxCount)) {
    const unavailable = (reason: SkillUnavailableReason): SkillView => ({ id: registration.id, relPath: registration.relPath, state: 'unavailable', reason })
    const relPath = registration.relPath
    // 顺序即原因精度：越界（含 `..`、绝对路径）比「隐藏段」更该被说清楚，而两者都必须拒绝。
    // 隐藏路径不加载是刻意的：点号路径是本应用自己的地盘（权限名单等），把它的正文送去模型
    // 比露给画布更严重，所以按失败关闭处理。
    if (!isNotePath(relPath)) { skills.push(unavailable('not-a-note')); continue }
    if (!resolveInVault(root, relPath)) { skills.push(unavailable('outside-vault')); continue }
    if (hasHiddenSegment(relPath)) { skills.push(unavailable('hidden-path')); continue }
    const parent = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath)
    const name = path.posix.basename(relPath)
    let size: number
    try {
      const entry = fs.list(parent).find(candidate => candidate.name === name)
      if (!entry) { skills.push(unavailable('missing')); continue }
      // 目录、符号链接与其他非常规文件都不是可加载的技能。
      if (entry.kind !== 'file') { skills.push(unavailable('not-ordinary-file')); continue }
      size = entry.size
    } catch (error) {
      if (error instanceof Error && error.message === 'ENOENT') { skills.push(unavailable('missing')); continue }
      throw error
    }
    if (size === 0) { skills.push(unavailable('empty')); continue }
    if (size > SKILL_LIMITS.maxBytes) { skills.push(unavailable('too-large')); continue }
    let bytes: Buffer, objectVersion: string
    try {
      const snapshot = fs.readSnapshot(relPath)
      bytes = snapshot.bytes
      objectVersion = snapshot.objectVersion
    } catch (error) {
      if (error instanceof Error && (error.message === 'ENOENT' || error.message === 'UNSAFE_PATH')) { skills.push(unavailable(error.message === 'ENOENT' ? 'missing' : 'not-ordinary-file')); continue }
      throw error
    }
    const content = bytes.toString('utf8')
    // 与账本同一处做法：解码后再编码必须逐字节相同，否则不是合法 UTF-8 文本。
    if (!Buffer.from(content, 'utf8').equals(bytes)) { skills.push(unavailable('not-utf8')); continue }
    skills.push({ id: registration.id, relPath, state: 'available', title: titleOf(content, name), bytes: size, objectVersion, content })
  }
  return { skills, ignored: Math.max(0, registrations.length - SKILL_LIMITS.maxCount) }
}

/** 标题取首个一级标题；没有就用首个非空行；再不行退回文件名。截断只影响显示名，不改正文。 */
function titleOf(content: string, fileName: string): string {
  const heading = content.split('\n').find(line => /^#\s+\S/.test(line))
  const fallback = content.split('\n').map(line => line.trim()).find(line => line.length > 0)
  const raw = (heading ? heading.replace(/^#\s+/, '') : fallback ?? fileName.replace(/\.md$/i, '')).trim()
  return raw.length > SKILL_LIMITS.maxTitleChars ? `${raw.slice(0, SKILL_LIMITS.maxTitleChars)}…` : raw
}
